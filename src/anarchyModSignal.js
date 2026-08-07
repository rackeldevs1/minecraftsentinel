'use strict';

const CHANNEL = 'anarchymod:join';

// These are the built-in domain families in 6b6t/AnarchyMod. The Base Hunter
// only connects to 6b6t, but keeping the official defaults makes the host gate
// behave like the real mod without adding its remote-domain HTTP dependency.
const DEFAULT_DOMAIN_BASES = Object.freeze([
  '6b6t.org',
  '10b10t.org',
  '6b6t.cc',
  '6b6t.me',
  '7b7t.me',
  '8b8t.org',
  '8b8t.xyz',
  'alacity.net',
  'anarchypvp.pw',
  'l2x9.org',
  'simpleanarchy.org',
]);

function normalizeHost(input) {
  let host = String(input || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close > 0 ? host.slice(1, close) : '';
  }
  const firstColon = host.indexOf(':');
  const lastColon = host.lastIndexOf(':');
  if (firstColon >= 0 && firstColon === lastColon) host = host.slice(0, firstColon);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function isAnarchyModHost(input) {
  const host = normalizeHost(input);
  if (!host) return false;
  return DEFAULT_DOMAIN_BASES.some((base) => host === base || host.endsWith(`.${base}`));
}

function sendAnarchyModJoin(bot, host) {
  if (!isAnarchyModHost(host)) return { ok: false, reason: 'host-not-supported' };
  const client = bot && bot._client;
  if (!client || typeof client.write !== 'function') return { ok: false, reason: 'client-unavailable' };
  try {
    // Exact 1.20.4 AnarchyMod wire format:
    // serverbound play custom_payload, channel anarchymod:join, empty data.
    client.write('custom_payload', { channel: CHANNEL, data: Buffer.alloc(0) });
    return { ok: true, channel: CHANNEL, bytes: 0 };
  } catch (error) {
    return { ok: false, reason: 'write-failed', error };
  }
}

function attachAnarchyModJoinSignal({ bot, getHost, log, enabled = true } = {}) {
  if (!enabled || !bot || typeof bot.on !== 'function') return () => {};
  let sent = false;
  const onLogin = () => {
    if (sent) return;
    const host = typeof getHost === 'function' ? getHost() : getHost;
    const result = sendAnarchyModJoin(bot, host);
    if (result.ok) {
      sent = true;
      if (log && typeof log.info === 'function') {
        log.info(`AnarchyMod compatibility: sent empty ${CHANNEL} join payload to ${normalizeHost(host)}`);
      }
    } else if (result.reason === 'write-failed' && log && typeof log.warn === 'function') {
      log.warn(`AnarchyMod compatibility: join payload failed: ${(result.error && result.error.message) || result.error}`);
    }
  };
  bot.on('login', onLogin);
  return () => {
    if (typeof bot.removeListener === 'function') bot.removeListener('login', onLogin);
  };
}

module.exports = {
  CHANNEL,
  DEFAULT_DOMAIN_BASES,
  normalizeHost,
  isAnarchyModHost,
  sendAnarchyModJoin,
  attachAnarchyModJoinSignal,
};
