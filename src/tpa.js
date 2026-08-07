'use strict';

// Outgoing /tpa: send a teleport request and wait until the bot has actually
// been moved. Merged from the two proven implementations:
//
//   * base-hunter  src/tpa.js               — the send/retry/await state machine
//   * mc-kitbot2   src/modules/TpaManager.ts — server-string classification and
//                                              the anti-spoof guards
//
// Both use the same 6b6t vocabulary and the same timings, so the numbers below
// are the ones already running in production on both bots:
//
//   accept deadline    105000ms  (KIT_TPA_ACCEPT_TIMEOUT_MS)
//   send confirmation    3000ms  (KIT_TPA_SEND_CONFIRM_MS)
//   resend gap           1000ms  (KIT_TPA_RESEND_UNTIL_SENT_MS)
//   max send attempts         5  (KIT_TPA_MAX_ATTEMPTS)
//   cooldown retries          5  (KIT_TPA_COOLDOWN_MAX_RETRIES)
//   poll interval         250ms  (KIT_TPA_ACCEPT_POLL_MS)
//   "Player not found"   3000ms  (KIT_TPA_PLAYER_NOT_FOUND_WINDOW_MS)
//   accept reminder     30000ms  (KIT_TPA_REMINDER_MS)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A chat line containing one of these came from a player, not the server. The
// last two are the mojibake forms of » that 6b6t emits through some proxies —
// kitbot carries them because a player can otherwise fake a server reply.
const CHAT_LINE_SEPARATORS = [
  '>>',
  '»',
  'Ã‚Â»',
  'Ãƒâ€šÃ‚Â»',
];

const DEFAULTS = Object.freeze({
  timeoutMs: 105000,
  sendConfirmMs: 3000,
  resendGapMs: 1000,
  maxAttempts: 5,
  cooldownMaxRetries: 5,
  pollMs: 250,
  playerNotFoundWindowMs: 3000,
  reminderMs: 30000,
  acceptedSettleMs: 5000,
  minTeleportBlocks: 10,
});

function normalizeMessage(value) {
  return String(value || '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, ' ')
    .trim();
}

function hasChatLineSeparator(text) {
  return CHAT_LINE_SEPARATORS.some((separator) => text.includes(separator));
}

// Anything a player could have typed is rejected before classification, so a
// visitor cannot spoof "Your request sent to X was accepted!" in public chat.
function looksPlayerAuthored(text) {
  if (hasChatLineSeparator(text)) return true;
  if (/^\w+\s*(?:whispers?|says?)\s*:/i.test(text)) return true;
  if (/^You\s+(?:whisper|message|tell)\s+to\s+\S+\s*:/i.test(text)) return true;
  return false;
}

function classifyTpaServerMessage(value, expectedUser = '') {
  const text = normalizeMessage(value);
  if (!text || looksPlayerAuthored(text)) return '';
  const escaped = escapeRegex(String(expectedUser || '').trim());
  const sent = escaped
    ? new RegExp(`^Request\\s+sen[dt]\\s+to:\\s*${escaped}\\.?$`, 'i')
    : /^Request\s+sen[dt]\s+to:\s*\w+\.?$/i;
  const accepted = escaped
    ? new RegExp(`^Your request sent to\\s+${escaped}\\s+was accepted!?$`, 'i')
    : /^Your request sent to\s+\w+\s+was accepted!?$/i;
  const denied = escaped
    ? new RegExp(`^Your request sent to\\s+${escaped}\\s+was denied!?$`, 'i')
    : /^Your request sent to\s+\w+\s+was denied!?$/i;
  const notAccepting = escaped
    ? new RegExp(`^${escaped}\\s+is currently not accepting (?:\\S+\\s+)?teleport requests\\.?$`, 'i')
    : /^\w+\s+is currently not accepting (?:\S+\s+)?teleport requests\.?$/i;
  if (sent.test(text)) return 'sent';
  if (accepted.test(text)) return 'accepted';
  if (denied.test(text)) return 'denied';
  if (/^Player not found!?$/i.test(text)) return 'not-found';
  if (notAccepting.test(text)) return 'not-accepting';
  if (/^Please wait for your existing request to be accepted or denied\.?$/i.test(text)) return 'existing-request';
  if (/cooldown|you have to wait|teleport again/i.test(text)) return 'cooldown';
  if (/^Teleport failed!?$/i.test(text)) return 'teleport-failed';
  return '';
}

function parseTpaCooldownMs(value) {
  const text = normalizeMessage(value).toLowerCase();
  let match = /(\d+)\s*m\s*(\d+)\s*s/.exec(text);
  if (match) return (Number(match[1]) * 60 + Number(match[2])) * 1000;
  match = /(\d+)\s*m(?:in(?:ute)?s?)?\b/.exec(text);
  if (match) return Number(match[1]) * 60 * 1000;
  match = /(\d+)\s*s(?:ec(?:ond)?s?)?\b/.exec(text);
  return match ? Number(match[1]) * 1000 : 0;
}

// Sends /tpa <username> and resolves once the bot has actually moved (or the
// server said the request was accepted and the hop was too short to detect).
//
// conn must be the Connection instance: its 'message' event carries every chat
// line, which is the only source used to classify replies.
async function requestTpaAndWait(options = {}) {
  const {
    conn,
    bot,
    username,
    log = console,
    timeoutMs = DEFAULTS.timeoutMs,
    sendConfirmMs = DEFAULTS.sendConfirmMs,
    resendGapMs = DEFAULTS.resendGapMs,
    maxAttempts = DEFAULTS.maxAttempts,
    cooldownMaxRetries = DEFAULTS.cooldownMaxRetries,
    pollMs = DEFAULTS.pollMs,
    playerNotFoundWindowMs = DEFAULTS.playerNotFoundWindowMs,
    reminderMs = DEFAULTS.reminderMs,
    acceptedSettleMs = DEFAULTS.acceptedSettleMs,
    minTeleportBlocks = DEFAULTS.minTeleportBlocks,
    onReminder = null,
  } = options;

  if (!conn || !bot || typeof bot.chat !== 'function' || !username) {
    return { ok: false, reason: 'invalid-request' };
  }
  const start = clonePosition(bot.entity && bot.entity.position);
  if (!start) return { ok: false, reason: 'missing-position' };

  const replies = [];
  let replyCursor = 0;
  let acceptedAt = 0;
  let lastSentAt = 0;
  let previousPosition = start;

  const onMessage = (value) => {
    const text = normalizeMessage(value);
    const kind = classifyTpaServerMessage(text, username);
    if (!kind) return;
    const at = Date.now();
    // "Player not found!" is a bare line with no username in it, so it can
    // easily belong to someone else's command. Only trust it in the short
    // window right after our own /tpa left the client (kitbot guard).
    if (kind === 'not-found') {
      if (!lastSentAt || at < lastSentAt || at > lastSentAt + playerNotFoundWindowMs) return;
    }
    // A reply that predates our request is stale.
    if (lastSentAt && at < lastSentAt) return;
    const reply = { kind, text, at };
    replies.push(reply);
    if (log && log.info) log.info(`tpa response: ${text}`);
    if (kind === 'accepted') acceptedAt = at;
  };

  let reminderTimer = null;
  conn.on('message', onMessage);
  try {
    const timeout = Math.max(5000, Number(timeoutMs) || DEFAULTS.timeoutMs);
    const deadline = Date.now() + timeout;
    const attempts = Math.max(1, Number(maxAttempts) || DEFAULTS.maxAttempts);
    let pending = false;
    let cooldownRetries = 0;

    for (let attempt = 1; attempt <= attempts && Date.now() < deadline && !pending; attempt++) {
      lastSentAt = Date.now();
      bot.chat(`/tpa ${username}`);
      if (log && log.event) {
        log.event(`sent /tpa ${username} (${attempt}/${attempts}); ${Math.ceil((deadline - Date.now()) / 1000)}s deadline`);
      }
      const confirmDeadline = Math.min(deadline, lastSentAt + Math.max(1000, Number(sendConfirmMs) || DEFAULTS.sendConfirmMs));
      while (Date.now() < confirmDeadline) {
        const moved = teleportMovement(bot, start, previousPosition, minTeleportBlocks);
        if (moved.ok) return { ...moved, replies };
        if (moved.position) previousPosition = moved.position;
        const reply = replies[replyCursor];
        if (!reply) { await sleep(pollMs); continue; }
        replyCursor++;
        if (['sent', 'existing-request', 'accepted'].includes(reply.kind)) {
          pending = true;
          break;
        }
        if (reply.kind === 'cooldown') {
          cooldownRetries++;
          if (cooldownRetries > Math.max(1, Number(cooldownMaxRetries) || DEFAULTS.cooldownMaxRetries)) {
            return { ok: false, reason: 'cooldown-retries-exhausted', response: reply.text, replies };
          }
          const cooldownMs = Math.max(1000, parseTpaCooldownMs(reply.text));
          if (Date.now() + cooldownMs >= deadline) {
            return { ok: false, reason: 'cooldown-timeout', cooldownMs, response: reply.text, replies };
          }
          if (log && log.info) log.info(`tpa cooldown ${Math.ceil(cooldownMs / 1000)}s; retrying after the server cooldown`);
          await sleep(cooldownMs + 250);
          break;
        }
        if (['denied', 'not-found', 'not-accepting', 'teleport-failed'].includes(reply.kind)) {
          return { ok: false, reason: reply.kind, response: reply.text, replies };
        }
      }
      if (!pending && Date.now() < deadline) {
        if (log && log.warn) log.warn(`no server confirmation for /tpa attempt ${attempt}/${attempts}`);
        await sleep(Math.max(250, Number(resendGapMs) || DEFAULTS.resendGapMs));
      }
    }
    if (!pending) return { ok: false, reason: 'send-unconfirmed', replies };

    // The request is queued on the server. Nudge the admin once if they sit on
    // it, exactly like kitbot's "Accept your tpa" reminder.
    if (typeof onReminder === 'function' && reminderMs > 0) {
      reminderTimer = setTimeout(() => { try { onReminder(username); } catch (_) {} }, reminderMs);
      if (reminderTimer.unref) reminderTimer.unref();
    }

    if (log && log.info) {
      log.info(`tpa pending; waiting for acceptance and an actual position jump (${Math.round(timeout / 1000)}s deadline)`);
    }
    while (Date.now() < deadline) {
      const moved = teleportMovement(bot, start, previousPosition, minTeleportBlocks);
      if (moved.ok) return { ...moved, replies };
      if (moved.position) previousPosition = moved.position;
      // Accepted, but the admin was standing close enough that the hop is
      // under the movement threshold. Settle briefly, then take it: for ?setup
      // a short teleport is a perfectly normal outcome.
      if (acceptedAt && Date.now() - acceptedAt >= Math.max(1000, acceptedSettleMs)) {
        return {
          ok: true,
          reason: 'accepted-no-jump',
          distance: previousPosition ? distance3d(start, previousPosition) : 0,
          position: previousPosition,
          replies,
        };
      }
      const reply = replies[replyCursor];
      if (!reply) { await sleep(pollMs); continue; }
      replyCursor++;
      if (reply.kind === 'accepted') {
        acceptedAt = reply.at;
        if (log && log.info) log.info('tpa accepted; waiting for the server position jump');
        continue;
      }
      if (['sent', 'existing-request', 'cooldown'].includes(reply.kind)) continue;
      if (['denied', 'not-found', 'not-accepting', 'teleport-failed'].includes(reply.kind)) {
        return { ok: false, reason: reply.kind, response: reply.text, replies };
      }
    }
    return { ok: false, reason: acceptedAt ? 'accepted-no-teleport' : 'not-accepted-timeout', replies };
  } catch (error) {
    return { ok: false, reason: 'send-failed', error: (error && error.message) || String(error), replies };
  } finally {
    if (reminderTimer) clearTimeout(reminderTimer);
    try { conn.removeListener('message', onMessage); } catch (_) {}
  }
}

function teleportMovement(bot, start, previousPosition, minTeleportBlocks) {
  const position = clonePosition(bot && bot.entity && bot.entity.position);
  const stepDistance = position && previousPosition ? distance3d(previousPosition, position) : 0;
  const distance = position ? distance3d(start, position) : 0;
  const threshold = Math.max(2, Number(minTeleportBlocks) || DEFAULTS.minTeleportBlocks);
  const ok = stepDistance >= threshold;
  return { ok, reason: ok ? 'position-jump' : '', distance, stepDistance, position };
}

function clonePosition(value) {
  if (!value) return null;
  const x = Number(value.x), y = Number(value.y), z = Number(value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function distance3d(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  DEFAULTS,
  classifyTpaServerMessage,
  parseTpaCooldownMs,
  requestTpaAndWait,
  normalizeMessage,
  looksPlayerAuthored,
  hasChatLineSeparator,
};
