'use strict';

// Watches for players around the post and reports them to Discord.
//
// Ported from mc-kitbot2's VisitorManager suite:
//   VisitorManagerParts/VisitorScanTick.ts  — the scan tick and the
//                                             close/long-range notify decision
//   VisitorManagerScheduler.ts              — the scan timer and online tracker
//   VisitorManagerParts/*Helpers.ts         — the ignore set
//
// Differences from kitbot: no bed anywhere (distance is measured from the
// ?setup anchor), no delivery/economy fields, and admins are filtered out
// unless a ?test window is open for them.

module.exports = function createWatcher({ settings, conn, post, discord, stats, log = console } = {}) {
  const cfg = (settings && settings.watch) || {};
  const debug = !!(settings && settings.debug && settings.debug.watcher);

  const adminSet = new Set((settings.admins || []).map((n) => String(n).toLowerCase()));
  const ignoreSet = new Set((cfg.ignore || []).map((n) => String(n).toLowerCase()));

  // name(lower) -> { until, fired } for ?test
  const testWindows = new Map();
  // name(lower) -> ms of the last scan tick that saw them (presence accrual)
  const seenNow = Object.create(null);

  let scanTimer = null;
  let onlineTimer = null;
  let scanning = false;
  let bot = null;
  let onDeath = null;
  let warnedAt = 0;
  let warnedReason = '';

  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  const scanRadius = Math.max(4, num(cfg.scanRadius, 128));
  const closeRadius = Math.max(1, Math.min(scanRadius, num(cfg.closeRadius, 32)));
  const closeRepeatMs = Math.max(10000, num(cfg.closeRepeatMs, 5 * 60 * 1000));
  const farCooldownMs = Math.max(60000, num(cfg.farCooldownMs, 60 * 60 * 1000));
  const awayResetMs = Math.max(30000, num(cfg.awayResetMs, 15 * 60 * 1000));
  const intervalMs = Math.max(200, num(cfg.scanIntervalMs, 1000));

  const spawnRadius = Math.max(0, num(cfg.spawnRadius, 5000));
  const spawn = { x: num(cfg.spawnX, 0), z: num(cfg.spawnZ, 0) };
  // Past this distance from the post the bot is not watching the base any
  // more. It matches the walk-back limit, so anything the drift guard can
  // recover from still counts as being on post.
  const maxOffPost = Math.max(8, num(settings.post && settings.post.walkBackMaxBlocks, 96));

  const spawnDistance = (position) => Math.hypot(
    Number(position.x) - spawn.x,
    Number(position.z) - spawn.z,
  );

  // ── is this bot in a position to report anything? ─────────────────────────
  // The bot has no bed, so a death drops it at world spawn — the busiest place
  // on the server and nowhere near the post. Anything it sees while it is in
  // there is spawn traffic, not a base visit.
  //
  // This is a MUTE, not a fault: the bot is also legitimately near spawn while
  // it transits the lobby/proxy hops or travels back to its post. So nothing
  // latches. The check re-runs every tick and reporting resumes by itself the
  // moment the bot is back out past the ring and standing on its post again —
  // no ?setup, no restart, no manual reset.
  function validity(position) {
    const here = position || (bot && bot.entity && bot.entity.position);
    if (!here) return { ok: false, reason: 'no-position', detail: 'no position yet' };
    if (!conn || conn.state !== 'main') {
      return { ok: false, reason: 'not-main', detail: `connection state is ${conn ? conn.state : 'unknown'}` };
    }
    if (!post.isSet) return { ok: false, reason: 'no-post', detail: 'no post set - whisper ?setup' };

    const fromSpawn = spawnRadius > 0 ? spawnDistance(here) : null;
    if (spawnRadius > 0 && fromSpawn < spawnRadius) {
      return {
        ok: false,
        reason: 'at-spawn',
        detail: `bot is ${Math.round(fromSpawn)} blocks from spawn, inside the ${spawnRadius} block ring `
          + '(died, or still travelling back); staying quiet until it is out past it again',
        fromSpawn,
      };
    }
    const offPost = post.distanceFrom(here);
    if (Number.isFinite(offPost) && offPost > maxOffPost) {
      return {
        ok: false,
        reason: 'off-post',
        detail: `bot is ${Math.round(offPost)} blocks from the post (limit ${maxOffPost}); `
          + 'staying quiet until it is back on it',
        fromSpawn,
        offPost,
      };
    }
    return { ok: true, reason: 'ok', fromSpawn, offPost };
  }

  function warnInvalid(state) {
    const now = Date.now();
    if (state.reason === warnedReason && now - warnedAt < 300000) return;
    warnedAt = now;
    warnedReason = state.reason;
    log.warn(`muted: ${state.detail}`);
  }

  // ── test windows ──────────────────────────────────────────────────────────
  function openTestWindow(name, windowMs) {
    const key = String(name || '').toLowerCase();
    if (!key) return null;
    const until = Date.now() + Math.max(5000, num(windowMs, cfg.testWindowMs) || 60000);
    const window = { until, fired: false, name: String(name) };
    testWindows.set(key, window);
    log.event(`test window open for ${name} until ${new Date(until).toLocaleTimeString()} (one alert max)`);
    return window;
  }

  function activeTestWindow(key) {
    const window = testWindows.get(key);
    if (!window) return null;
    if (Date.now() > window.until) {
      testWindows.delete(key);
      log.info(`test window for ${window.name} expired${window.fired ? '' : ' without a sighting'}`);
      return null;
    }
    return window;
  }

  function testWindowFor(name) {
    return activeTestWindow(String(name || '').toLowerCase());
  }

  // ── who counts ────────────────────────────────────────────────────────────
  // Admins are never reported. The single exception is an open ?test window
  // that has not fired yet — that is the whole point of the command.
  function skipReason(nameLower) {
    if (!nameLower) return 'blank';
    if (bot && bot.username && nameLower === String(bot.username).toLowerCase()) return 'self';
    if (ignoreSet.has(nameLower)) return 'ignored';
    if (adminSet.has(nameLower)) {
      const window = activeTestWindow(nameLower);
      if (!window) return 'admin';
      if (window.fired) return 'admin-test-already-fired';
      return '';
    }
    return '';
  }

  // ── notify decision (kitbot decideVisitorNotification, trimmed) ───────────
  function decide(record, now, distance, prevLastSeen, isTest) {
    const isClose = distance <= closeRadius;
    if (isTest) return { isClose, notify: true, isTest: true };

    const wasClose = !!record.lastIsClose;
    const lastCloseWebhookAt = num(record.lastCloseWebhookAt, 0) || 0;
    const lastWebhookAt = num(record.lastWebhookAt, 0) || 0;
    // Gone long enough that this counts as a brand new visit.
    const awayTooLong = prevLastSeen > 0 && now - prevLastSeen > awayResetMs;

    if (isClose) {
      // First step inside the close ring always reports; after that, at most
      // once per closeRepeatMs for as long as they hang around.
      return {
        isClose,
        notify: !wasClose || awayTooLong || now - lastCloseWebhookAt >= closeRepeatMs,
        isTest: false,
      };
    }
    return {
      isClose,
      notify: awayTooLong || lastWebhookAt <= 0 || now - lastWebhookAt >= farCooldownMs,
      isTest: false,
    };
  }

  // ── one scan tick ─────────────────────────────────────────────────────────
  async function tick() {
    if (!bot || !bot.entity || !bot.entity.position) return;

    const me = bot.entity.position;
    // Nothing is recorded or reported unless the bot is genuinely standing at
    // its post. This is what stops a death from turning the spawn crowd into
    // a page of "visitors" — and ?test is gated too, so a test can never pass
    // while the bot is somewhere it should not be.
    const valid = validity(me);
    if (!valid.ok) {
      warnInvalid(valid);
      return;
    }
    if (warnedReason) {
      log.info(`unmuted: back on the post${valid.fromSpawn == null ? '' : `, ${Math.round(valid.fromSpawn)} blocks from spawn`}; reporting again`);
      warnedReason = '';
    }

    // Everything is measured from the post, not from the bot, so a couple of
    // blocks of drift cannot change who counts as close.
    const reference = post.anchor;
    const now = Date.now();
    const key = stats.dayKey(now);

    const entities = bot.entities && typeof bot.entities === 'object' ? bot.entities : {};
    for (const id of Object.keys(entities)) {
      const entity = entities[id];
      if (!entity || entity.type !== 'player' || !entity.username || !entity.position) continue;

      const name = String(entity.username).trim();
      const nameLower = name.toLowerCase();
      const skip = skipReason(nameLower);
      if (skip) {
        if (debug && skip !== 'self') log.info(`skip ${name}: ${skip}`);
        continue;
      }

      const distance = Math.hypot(
        Number(entity.position.x) - Number(reference.x),
        Number(entity.position.y) - Number(reference.y),
        Number(entity.position.z) - Number(reference.z),
      );
      if (!(distance <= scanRadius)) continue;

      const testWindow = testWindowFor(name);
      const record = { ...stats.get(name) };
      const prevLastSeen = num(record.lastSeen, 0) || 0;
      stats.rollDay(record, key);

      // Presence time: credit the real gap between ticks when it is small
      // enough to have been continuous, otherwise one interval.
      const lastPresenceAt = num(record.lastPresenceAt, 0) || 0;
      const graceMs = intervalMs * 3;
      let addMs = intervalMs;
      if (lastPresenceAt > 0) {
        const gap = now - lastPresenceAt;
        if (gap > 0 && gap <= graceMs) addMs = gap;
      }

      const firstTickForThem = !seenNow[nameLower] || now - seenNow[nameLower] > graceMs;
      seenNow[nameLower] = now;

      record.name = name;
      record.firstSeen = num(record.firstSeen, 0) || now;
      record.lastSeen = now;
      record.lastPresenceAt = now;
      record.totalPresenceMs = (num(record.totalPresenceMs, 0) || 0) + Math.max(0, addMs);
      record.todayPresenceMs = (num(record.todayPresenceMs, 0) || 0) + Math.max(0, addMs);
      if (firstTickForThem) {
        record.totalSeen = (num(record.totalSeen, 0) || 0) + 1;
        record.todaySeen = (num(record.todaySeen, 0) || 0) + 1;
      }

      const decision = decide(record, now, distance, prevLastSeen, !!testWindow);
      record.lastIsClose = decision.isClose;
      if (decision.notify) {
        record.lastWebhookAt = now;
        if (decision.isClose) record.lastCloseWebhookAt = now;
      }
      stats.put(name, record);
      stats.maybeFlush('sighting');

      if (!decision.notify) continue;
      // A ?test window is allowed exactly one alert, so mark it before the
      // await — the next tick is only a second away.
      if (testWindow) testWindow.fired = true;

      log.event(
        `${decision.isTest ? 'TEST ' : ''}sighting: ${name} at `
        + `${Math.round(entity.position.x)},${Math.round(entity.position.y)},${Math.round(entity.position.z)} `
        + `(${Math.round(distance)} blocks, ${decision.isClose ? 'close' : 'long'} range)`,
      );
      try {
        await discord.sendSighting({
          name,
          stats: record,
          prevLastSeen,
          isClose: decision.isClose,
          isTest: decision.isTest,
          distance,
          position: entity.position,
          botName: bot.username,
        });
        // The avatar lookup can write a uuid onto the record; keep it.
        stats.put(name, record);
        stats.markDirty();
      } catch (e) {
        log.warn(`sighting alert failed for ${name}: ${(e && e.message) || e}`);
      }
    }
  }

  // seenNow only exists to spot gaps between ticks, so anything older than a
  // few seconds is dead weight. Left unpruned it grows for every player the
  // bot ever sees and never shrinks.
  function pruneSeenNow() {
    const cutoff = Date.now() - Math.max(60000, intervalMs * 60);
    for (const key of Object.keys(seenNow)) {
      if (seenNow[key] < cutoff) delete seenNow[key];
    }
  }

  // ── online time (tab list) ────────────────────────────────────────────────
  // Someone can be online without being in render distance; kitbot tracks that
  // separately so "total time online" and "total time seen" stay distinct.
  function onlineTick(tickMs) {
    if (!bot || !bot.players || conn.state !== 'main') return;
    const now = Date.now();
    const key = stats.dayKey(now);
    for (const [nameLower, record] of Object.entries(stats.all)) {
      if (!record || typeof record !== 'object') continue;
      const name = String(record.name || nameLower);
      if (!bot.players[name]) continue;
      if (String(record.onlineDayKey || '') !== key) record.onlineDayKey = key;
      record.totalOnlineMs = (num(record.totalOnlineMs, 0) || 0) + tickMs;
      record.lastOnlineAt = now;
      stats.markDirty();
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  function attach(nextBot) {
    detach();
    bot = nextBot;
    if (!bot) return false;

    // Death is the main way the bot ends up near spawn, so say so rather than
    // leaving the admin to wonder why it went quiet.
    onDeath = () => {
      log.warn('bot died - it respawns at spawn and stays muted until it is back on the post');
      discord.sendText(
        post.isSet
          ? `**Bot died.** It respawned at spawn, so it is muted until it is back at \`${post.describe()}\`.`
          : '**Bot died.** It respawned at spawn.',
      ).catch(() => {});
    };
    bot.on('death', onDeath);

    scanTimer = setInterval(() => {
      if (scanning) return; // never overlap two ticks
      scanning = true;
      Promise.resolve()
        .then(tick)
        .catch((e) => log.warn(`scan tick failed: ${(e && e.message) || e}`))
        .finally(() => {
          scanning = false;
          stats.maybeFlush('interval');
          pruneSeenNow();
        });
    }, intervalMs);
    if (scanTimer.unref) scanTimer.unref();

    const onlineMs = Math.max(5000, num(cfg.onlineTickMs, 10000));
    onlineTimer = setInterval(() => {
      try { onlineTick(onlineMs); } catch (e) { log.warn(`online tick failed: ${(e && e.message) || e}`); }
    }, onlineMs);
    if (onlineTimer.unref) onlineTimer.unref();

    log.info(
      `watching: scan radius ${scanRadius}, close radius ${closeRadius}, `
      + `close repeat ${Math.round(closeRepeatMs / 1000)}s, long-range cooldown ${Math.round(farCooldownMs / 60000)}m`,
    );
    if (adminSet.size) log.info(`admins never reported: ${[...adminSet].join(', ')}`);
    return true;
  }

  function detach() {
    if (scanTimer) clearInterval(scanTimer);
    if (onlineTimer) clearInterval(onlineTimer);
    if (bot && onDeath) { try { bot.removeListener('death', onDeath); } catch (_) {} }
    scanTimer = null;
    onlineTimer = null;
    onDeath = null;
    scanning = false;
    bot = null;
  }

  return {
    attach,
    detach,
    openTestWindow,
    testWindowFor,
    decide,
    skipReason,
    validity,
    spawnDistance,
    get radii() { return { scanRadius, closeRadius, spawnRadius, maxOffPost }; },
    get testWindowCount() { return testWindows.size; },
  };
};
