'use strict';

// Discord webhook poster + sighting embed.
//
// Structure follows kitbot's VisitorManagerNotify/_postVisitorWebhooks (embed
// shape, avatar lookup, timeout) and base-hunter's discordAlerts.js (serialized
// send queue, 429 backoff, never throw).
//
// The bot has no bed, so none of kitbot's bed-derived fields are here: no
// "near bed", no bed distance, no bed status. Distance is measured from the
// anchor the admin set with ?setup.

const COLORS = Object.freeze({
  CLOSE: 0xe74c3c, // red    - inside the close radius, someone is on the base
  FAR: 0xe67e22,   // orange - spotted in the outer ring
  TEST: 0x3498db,  // blue   - ?test sighting of an admin
});

const MAX_RETRY_AFTER_S = 30;

function formatHms(ms) {
  let value = Number(ms) || 0;
  if (value < 0) value = 0;
  const sec = Math.floor(value / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

function round(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : '?';
}

module.exports = function createDiscord({ settings, log = console, fetchImpl, sleepImpl } = {}) {
  const cfg = (settings && settings.discord) || {};
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const doSleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const enabled = !!(cfg.webhookUrl && doFetch);
  const uuidCache = new Map();

  // ── avatar ────────────────────────────────────────────────────────────────
  async function mojangUuid(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return '';
    if (uuidCache.has(key)) return uuidCache.get(key);
    let id = '';
    try {
      const response = await doFetch(
        `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
        { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2500) },
      );
      if (response && response.ok) {
        const json = await response.json();
        if (json && typeof json.id === 'string') id = json.id.trim();
      }
    } catch (_) {
      id = '';
    }
    uuidCache.set(key, id);
    return id;
  }

  async function avatarUrl(name, stats) {
    const mode = String(cfg.avatarMode || 'auto').toLowerCase();
    if (mode === 'none') return '';
    const size = Math.max(16, Math.min(256, Number(cfg.avatarSize) || 64));
    const uuid = stats && typeof stats.uuid === 'string' ? stats.uuid.trim() : '';
    if (uuid) return `https://crafatar.com/avatars/${uuid}?size=${size}&overlay=true`;
    const looked = await mojangUuid(name);
    if (looked) {
      // Cache it on the record so the next sighting skips the lookup entirely.
      if (stats && typeof stats === 'object') stats.uuid = looked;
      return `https://crafatar.com/avatars/${looked}?size=${size}&overlay=true`;
    }
    // Cracked players have no Mojang profile; fall back to a name-based skin.
    return `https://minotar.net/avatar/${encodeURIComponent(String(name || ''))}/${size}.png`;
  }

  // ── embed ─────────────────────────────────────────────────────────────────
  function buildEmbed({ name, stats, prevLastSeen, isClose, isTest, distance, position, botName }) {
    const prev = Number(prevLastSeen || 0) || 0;
    const unixPrev = prev > 0 ? Math.floor(prev / 1000) : 0;
    const firstMs = Number(stats && stats.firstSeen) || 0;
    const unixFirst = firstMs > 0 ? Math.floor(firstMs / 1000) : 0;

    const fields = [
      {
        name: 'Distance',
        value: Number.isFinite(Number(distance)) ? `${round(distance)} blocks from post` : 'Unknown',
        inline: true,
      },
      {
        name: 'Their coords',
        value: position ? `\`${round(position.x)}, ${round(position.y)}, ${round(position.z)}\`` : 'Unknown',
        inline: true,
      },
      {
        name: 'Range',
        value: isClose ? 'Close' : 'Long',
        inline: true,
      },
      {
        name: 'Last seen',
        value: unixPrev > 0 ? `<t:${unixPrev}:F>\n<t:${unixPrev}:R>` : 'First time',
        inline: true,
      },
      {
        name: 'First seen',
        value: unixFirst > 0 ? `<t:${unixFirst}:F>\n<t:${unixFirst}:R>` : 'Unknown',
        inline: true,
      },
      { name: 'Times seen', value: String(Number((stats && stats.totalSeen) || 0)), inline: true },
      { name: 'Seen today', value: formatHms(stats && stats.todayPresenceMs), inline: true },
      { name: 'Total time seen', value: formatHms(stats && stats.totalPresenceMs), inline: true },
      { name: 'Days seen', value: `${Number((stats && stats.uniqueDays) || 0)}d`, inline: true },
      { name: 'Total time online', value: formatHms(stats && stats.totalOnlineMs), inline: true },
    ];

    const title = isTest
      ? 'Test sighting'
      : isClose
        ? 'Player at the base — close range'
        : 'Player spotted';
    const description = isTest
      ? `**${name}** is in range. This is a \`?test\` alert; admins are not normally reported.`
      : `**${name}** was seen near the base.`;

    return {
      title,
      description,
      color: isTest ? COLORS.TEST : isClose ? COLORS.CLOSE : COLORS.FAR,
      fields,
      footer: { text: `base watcher${botName ? ` · ${botName}` : ''}` },
      timestamp: new Date().toISOString(),
    };
  }

  // ── send ──────────────────────────────────────────────────────────────────
  // Sends are serialized: a group walking past should not fire six parallel
  // requests and trip the webhook rate limiter.
  let queue = Promise.resolve();

  async function post(payload) {
    if (!enabled) return false;
    const body = JSON.stringify(payload);
    const timeoutMs = Math.max(1000, Math.min(30000, Number(cfg.timeoutMs) || 8000));

    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await doFetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        log.warn(`discord webhook network error: ${(e && e.message) || e}`);
        return false;
      }
      if (response && response.status === 429) {
        let retryAfter = 1;
        try {
          const json = await response.json();
          if (json && Number.isFinite(Number(json.retry_after))) retryAfter = Number(json.retry_after);
        } catch (_) {}
        if (retryAfter > MAX_RETRY_AFTER_S) {
          log.warn(`discord rate-limited ${retryAfter}s (over the ${MAX_RETRY_AFTER_S}s cap) - dropping this alert`);
          return false;
        }
        log.warn(`discord rate-limited, retrying in ${retryAfter}s`);
        await doSleep(Math.max(0, retryAfter) * 1000);
        continue;
      }
      if (response && response.ok) return true;
      log.warn(`discord webhook failed: HTTP ${response ? response.status : '?'}`);
      return false;
    }
    log.warn('discord webhook gave up after retries');
    return false;
  }

  function send(payload) {
    const run = queue.then(() => post(payload)).catch(() => false);
    queue = run.catch(() => {});
    return run;
  }

  async function sendSighting(sighting) {
    if (!enabled) return false;
    const embed = buildEmbed(sighting);
    try {
      const url = await avatarUrl(sighting.name, sighting.stats);
      if (url) embed.thumbnail = { url };
    } catch (_) {}
    const payload = { embeds: [embed] };
    if (cfg.ping) payload.content = cfg.ping;
    return send(payload);
  }

  function sendText(content) {
    if (!enabled) return Promise.resolve(false);
    return send({ content: String(content || '').slice(0, 1900) });
  }

  return { enabled, buildEmbed, sendSighting, sendText, formatHms };
};

module.exports.COLORS = COLORS;
module.exports.formatHms = formatHms;
