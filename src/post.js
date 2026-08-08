'use strict';


const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { goals, Movements } = require('mineflayer-pathfinder');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function createPost({ settings, log = console } = {}) {
  const cfg = (settings && settings.post) || {};
  const filePath = String(cfg.file || path.join(process.cwd(), 'data', 'anchor.json'));
  let anchor = null;
  let holdTimer = null;
  let afkTimer = null;
  let walkingBack = false;

  function load() {
    try {
      const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const x = Number(json.x), y = Number(json.y), z = Number(json.z);
      if ([x, y, z].every(Number.isFinite)) {
        anchor = { x, y, z, setBy: String(json.setBy || ''), at: Number(json.at) || 0 };
        log.info(`post loaded: ${describe(anchor)}${anchor.setBy ? ` (set by ${anchor.setBy})` : ''}`);
      }
    } catch (e) {
      if (e && e.code !== 'ENOENT') log.warn(`anchor file unreadable: ${(e && e.message) || e}`);
      anchor = null;
    }
    return anchor;
  }

  function save(position, setBy) {
    const x = Number(position && position.x);
    const y = Number(position && position.y);
    const z = Number(position && position.z);
    if (![x, y, z].every(Number.isFinite)) return { ok: false, reason: 'bad-position' };
    anchor = { x, y, z, setBy: String(setBy || ''), at: Date.now() };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(anchor, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (e) {
      log.warn(`anchor save failed: ${(e && e.message) || e}`);
      return { ok: false, reason: 'write-failed', anchor };
    }
    log.event(`post set to ${describe(anchor)} by ${anchor.setBy || 'unknown'}`);
    return { ok: true, anchor };
  }

  function clear() {
    anchor = null;
    try { fs.unlinkSync(filePath); } catch (_) {}
  }

  function distanceFrom(position) {
    if (!anchor || !position) return Infinity;
    return Math.hypot(
      Number(position.x) - anchor.x,
      Number(position.y) - anchor.y,
      Number(position.z) - anchor.z,
    );
  }

  // Stop everything that could move the bot. Called the moment it lands on the
  // post and again whenever it is nudged off.
  function freeze(bot) {
    if (!bot) return;
    try { if (bot.pathfinder) bot.pathfinder.stop(); } catch (_) {}
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (_) {}
    try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch (_) {}
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      try { bot.setControlState(control, false); } catch (_) {}
    }
  }

  // Pathfinder defaults to Movements that dig and place blocks. A bot that
  // tunnels through someone's base wall to get back to its block is both
  // obvious and destructive, so it may only walk.
  function quietMovements(bot) {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scaffoldingBlocks = [];
    movements.canOpenDoors = false;
    return movements;
  }

  async function walkTo(bot, target, timeoutMs = 20000) {
    if (!bot || !bot.pathfinder || !target) return false;
    try { bot.pathfinder.setMovements(quietMovements(bot)); } catch (_) {}
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bot.removeListener('goal_reached', onGoal);
        bot.removeListener('path_stop', onStop);
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        resolve(ok);
      };
      const onGoal = () => finish(true);
      const onStop = () => finish(distanceFrom(bot.entity && bot.entity.position) <= 2);
      const timer = setTimeout(() => {
        try { bot.pathfinder.stop(); } catch (_) {}
        finish(distanceFrom(bot.entity && bot.entity.position) <= 2);
      }, Math.max(2000, timeoutMs));
      if (timer.unref) timer.unref();
      bot.once('goal_reached', onGoal);
      bot.once('path_stop', onStop);
      try {
        bot.pathfinder.setGoal(new goals.GoalBlock(
          Math.floor(target.x), Math.floor(target.y), Math.floor(target.z),
        ));
      } catch (_) {
        finish(false);
      }
    });
  }

  // Called once the bot is on main. Walks back to the post if it woke up near
  // it, then keeps it there.
  async function resume(bot) {
    if (!anchor || !bot || !bot.entity) return { ok: false, reason: 'no-anchor' };
    const away = distanceFrom(bot.entity.position);
    const maxWalk = Math.max(0, Number(cfg.walkBackMaxBlocks) || 96);
    if (away > maxWalk) {
      log.warn(
        `woke up ${Math.round(away)} blocks from the post at ${describe(anchor)} `
        + `(walk-back limit is ${maxWalk}); watching from here instead. `
        + 'Whisper ?setup again to re-anchor.',
      );
      return { ok: false, reason: 'too-far', distance: away };
    }
    if (away > Math.max(1, Number(cfg.holdToleranceBlocks) || 3)) {
      log.info(`walking back to the post at ${describe(anchor)} (${Math.round(away)} blocks)`);
      await walkTo(bot, anchor);
    }
    freeze(bot);
    return { ok: true, distance: distanceFrom(bot.entity.position) };
  }

  // Drift guard: knockback, a mob, or a piston can shove the bot off its block.
  // Walk back rather than silently watching from somewhere else.
  function startHolding(bot, isReady) {
    stopHolding();
    const tolerance = Math.max(1, Number(cfg.holdToleranceBlocks) || 3);
    const checkMs = Math.max(1000, Number(cfg.holdCheckMs) || 4000);
    holdTimer = setInterval(async () => {
      if (walkingBack || !anchor || !bot || !bot.entity) return;
      if (typeof isReady === 'function' && !isReady()) return;
      const away = distanceFrom(bot.entity.position);
      if (!Number.isFinite(away) || away <= tolerance) return;
      const maxWalk = Math.max(0, Number(cfg.walkBackMaxBlocks) || 96);
      if (away > maxWalk) return;
      walkingBack = true;
      try {
        log.info(`drifted ${Math.round(away)} blocks off the post; returning`);
        await walkTo(bot, anchor, 15000);
        freeze(bot);
      } catch (_) {
      } finally {
        walkingBack = false;
      }
    }, checkMs);
    if (holdTimer.unref) holdTimer.unref();

    // Anti-AFK: turn the head only. The bot never leaves its block.
    if (cfg.antiAfk) {
      const afkMs = Math.max(10000, Number(cfg.antiAfkMs) || 45000);
      let yaw = 0;
      afkTimer = setInterval(() => {
        if (walkingBack || !bot || !bot.entity) return;
        if (typeof isReady === 'function' && !isReady()) return;
        yaw = (yaw + Math.PI / 2) % (Math.PI * 2);
        try { bot.look(yaw, 0, false); } catch (_) {}
      }, afkMs);
      if (afkTimer.unref) afkTimer.unref();
    }
  }

  function stopHolding() {
    if (holdTimer) clearInterval(holdTimer);
    if (afkTimer) clearInterval(afkTimer);
    holdTimer = null;
    afkTimer = null;
    walkingBack = false;
  }

  return {
    load,
    save,
    clear,
    resume,
    freeze,
    walkTo,
    startHolding,
    stopHolding,
    distanceFrom,
    sleep,
    get anchor() { return anchor; },
    get isSet() { return !!anchor; },
    get vec() { return anchor ? new Vec3(anchor.x, anchor.y, anchor.z) : null; },
    get filePath() { return filePath; },
    describe: () => describe(anchor),
  };
};

function describe(pos) {
  return pos ? `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}` : 'not set';
}

module.exports.describe = describe;
