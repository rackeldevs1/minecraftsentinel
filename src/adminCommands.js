'use strict';

// Admin whisper commands.
//
// Command surface (whisper them to the bot in game):
//   ?setup   send a /tpa to the admin who asked; wherever the bot lands
//            becomes the post it stands on and watches from
//   ?test    for one minute, scan the admin like an ordinary player and send
//            exactly one alert when they come into range
//   ?status  connection state, post coordinates, players tracked
//
// Command shape is from base-hunter's ownerCommands.js. The whisper detection
// is widened: mineflayer's own 'whisper' event only fires for the vanilla chat
// format, and 6b6t does not use it, so server chat lines are also parsed.

const { requestTpaAndWait } = require('./tpa');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Formats a private message can arrive in. First capture is the sender, second
// is the body.
const WHISPER_PATTERNS = [
  /^(?:\[)?([A-Za-z0-9_]{1,16})(?:\])?\s+whispers?(?:\s+to\s+you)?\s*:\s*(.+)$/i,
  /^\[?([A-Za-z0-9_]{1,16})\s*(?:->|→|»)\s*(?:me|you)\]?\s*:?\s*(.+)$/i,
  /^From\s+([A-Za-z0-9_]{1,16})\s*:\s*(.+)$/i,
  /^\[msg\]\s*([A-Za-z0-9_]{1,16})\s*:\s*(.+)$/i,
];

function parseWhisperLine(text) {
  const line = String(text || '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .trim();
  if (!line) return null;
  for (const pattern of WHISPER_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return { username: match[1], message: match[2].trim() };
  }
  return null;
}

function parseCommand(message, prefix = '?') {
  const text = String(message || '').trim();
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length).trim();
  if (!body) return null;
  const space = body.search(/\s/);
  const command = (space < 0 ? body : body.slice(0, space)).toLowerCase();
  const arg = space < 0 ? '' : body.slice(space + 1).trim();
  return { command, arg };
}

module.exports = function createAdminCommands({ settings, conn, post, watcher, stats, discord, log = console } = {}) {
  const prefix = String(settings.commandPrefix || '?');
  const admins = new Set((settings.admins || []).map((n) => String(n).toLowerCase()));
  const recent = new Map(); // dedupe the 'whisper' event against the chat fallback
  let bot = null;
  let onWhisper = null;
  let onMessage = null;
  let setupInFlight = false;

  const isAdmin = (username) => admins.has(String(username || '').trim().toLowerCase());

  function reply(username, message) {
    try { bot.chat(`/w ${username} ${message}`); } catch (_) {}
    log.info(`-> ${username}: ${message}`);
  }

  function seenAlready(username, message) {
    const key = `${String(username).toLowerCase()}|${message}`;
    const now = Date.now();
    for (const [k, at] of recent) if (now - at > 5000) recent.delete(k);
    if (recent.has(key)) return true;
    recent.set(key, now);
    return false;
  }

  // ── ?setup ────────────────────────────────────────────────────────────────
  async function handleSetup(username) {
    if (setupInFlight) {
      reply(username, 'a setup is already running - wait for it to finish');
      return { ok: false, reason: 'busy' };
    }
    if (conn.state !== 'main') {
      reply(username, `not on the main server yet (state: ${conn.state})`);
      return { ok: false, reason: 'not-main' };
    }
    setupInFlight = true;
    try {
      reply(username, 'sending you a tpa - accept it and I will stand where I land');
      post.stopHolding();

      const result = await requestTpaAndWait({
        conn,
        bot,
        username,
        log,
        timeoutMs: Math.max(15000, Number(settings.post.setupTpaTimeoutMs) || 105000),
        onReminder: (who) => reply(who, 'accept the tpa when you can - still waiting'),
      });

      if (!result.ok) {
        reply(username, `setup failed: ${result.reason}${result.response ? ` (${result.response})` : ''}`);
        log.warn(`?setup failed for ${username}: ${result.reason}`);
        // Go back to guarding the previous post rather than wandering.
        if (post.isSet) {
          await post.resume(bot);
          post.startHolding(bot, () => conn.state === 'main');
        }
        return { ok: false, reason: result.reason };
      }

      // Let the server settle the landing position before reading it.
      await sleep(1500);
      const landed = bot.entity && bot.entity.position;
      if (!landed) {
        reply(username, 'setup failed: no position after the teleport');
        return { ok: false, reason: 'no-position' };
      }

      post.freeze(bot);
      const saved = post.save(landed, username);
      if (!saved.ok) {
        reply(username, `teleported, but the post could not be saved (${saved.reason})`);
        return { ok: false, reason: saved.reason };
      }
      post.startHolding(bot, () => conn.state === 'main');

      const radii = watcher.radii;
      reply(username, `post set at ${post.describe()} - watching ${radii.scanRadius} blocks (${radii.closeRadius} close)`);
      log.event(`?setup complete: standing at ${post.describe()} (${result.reason})`);

      // A post inside the spawn radius can never pass the death check, so the
      // bot would sit there silently forever. Say so instead of letting them
      // find out by getting no alerts.
      const check = watcher.validity(landed);
      if (!check.ok && check.reason === 'at-spawn') {
        const warning = `this post is only ${Math.round(check.fromSpawn)} blocks from spawn, `
          + `inside the ${radii.spawnRadius} block spawn mute - NOTHING will be reported from here. `
          + 'Move further out, or lower BW_SPAWN_RADIUS.';
        reply(username, warning);
        log.warn(`?setup: ${warning}`);
      }

      await discord.sendText(
        `Post set at \`${post.describe()}\` by **${username}**. `
        + `Watching a ${radii.scanRadius} block radius (${radii.closeRadius} close).`
        + (check.ok ? '' : `\n:warning: ${check.detail}`),
      );
      return { ok: true, anchor: post.anchor };
    } finally {
      setupInFlight = false;
    }
  }

  // ── ?test ─────────────────────────────────────────────────────────────────
  function handleTest(username, arg) {
    const requested = Number(arg);
    const windowMs = Number.isFinite(requested) && requested > 0
      ? Math.min(10 * 60 * 1000, requested * 1000)
      : Math.max(5000, Number(settings.watch.testWindowMs) || 60000);
    // A test is only meaningful if the bot could report at all right now, so
    // check first rather than letting the admin stand there waiting.
    const check = watcher.validity();
    if (!check.ok) {
      reply(username, `test not started, bot is muted: ${check.detail}`);
      log.warn(`?test refused for ${username}: ${check.detail}`);
      return { ok: false, reason: check.reason };
    }

    watcher.openTestWindow(username, windowMs);
    const seconds = Math.round(windowMs / 1000);
    const radii = watcher.radii;
    reply(
      username,
      `test on: you are scannable for ${seconds}s, one alert when you are within ${radii.scanRadius} blocks`,
    );
    return { ok: true, windowMs };
  }

  // ── ?status ───────────────────────────────────────────────────────────────
  function handleStatus(username) {
    const here = bot && bot.entity && bot.entity.position;
    const away = post.isSet && here ? Math.round(post.distanceFrom(here)) : null;
    const check = watcher.validity();
    reply(username, `state=${conn.state} post=${post.describe()}${away == null ? '' : ` (${away} away)`}`);
    reply(
      username,
      here
        ? `spawn=${Math.round(watcher.spawnDistance(here))} blocks away, reporting=${check.ok ? 'yes' : `MUTED (${check.reason})`}`
        : `reporting=${check.ok ? 'yes' : `MUTED (${check.reason})`}`,
    );
    reply(username, `tracked=${stats.count} players, webhook=${discord.enabled ? 'on' : 'OFF'}, tests=${watcher.testWindowCount}`);
    return { ok: true };
  }

  async function handle(username, message) {
    if (!isAdmin(username)) return { ok: false, reason: 'not-admin' };
    const parsed = parseCommand(message, prefix);
    if (!parsed) return { ok: false, reason: 'not-command' };
    if (!bot) return { ok: false, reason: 'no-bot' };
    log.info(`<- ${username}: ${message}`);

    switch (parsed.command) {
      case 'setup': return handleSetup(username);
      case 'test': return handleTest(username, parsed.arg);
      case 'status': return handleStatus(username);
      case 'help':
        reply(username, `commands: ${prefix}setup, ${prefix}test [seconds], ${prefix}status`);
        return { ok: true };
      default:
        reply(username, `unknown command - try ${prefix}help`);
        return { ok: false, reason: 'unknown-command' };
    }
  }

  function dispatch(username, message) {
    if (!isAdmin(username)) return;
    if (seenAlready(username, message)) return;
    Promise.resolve()
      .then(() => handle(username, message))
      .catch((e) => log.warn(`admin command failed: ${(e && e.message) || e}`));
  }

  function attach(nextBot) {
    detach();
    bot = nextBot;
    if (!bot || typeof bot.on !== 'function') return false;

    onWhisper = (username, message) => dispatch(username, message);
    bot.on('whisper', onWhisper);

    // Fallback for servers whose whisper format mineflayer does not recognise.
    onMessage = (text) => {
      const parsed = parseWhisperLine(text);
      if (parsed) dispatch(parsed.username, parsed.message);
    };
    conn.on('message', onMessage);

    log.info(`admin commands enabled for: ${[...admins].join(', ')} (prefix "${prefix}")`);
    return true;
  }

  function detach() {
    if (bot && onWhisper) { try { bot.removeListener('whisper', onWhisper); } catch (_) {} }
    if (onMessage) { try { conn.removeListener('message', onMessage); } catch (_) {} }
    bot = null;
    onWhisper = null;
    onMessage = null;
  }

  return { attach, detach, handle, dispatch, isAdmin };
};

module.exports.parseWhisperLine = parseWhisperLine;
module.exports.parseCommand = parseCommand;
