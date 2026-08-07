'use strict';

// ═════════════════════════════════════════════════════════════════════════════
//
//   ██  FILL THESE THREE IN  ██
//
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. ADMINS ────────────────────────────────────────────────────────────────
// Minecraft name(s) allowed to whisper the bot commands (?setup, ?test, ?status).
// Admins are NEVER reported to Discord, except during a ?test window.
// Add more names to the list if you have more than one admin.
const ADMINS = [
  'PutYourMinecraftNameHere',
];

// ── 2. DISCORD WEBHOOK ───────────────────────────────────────────────────────
// Paste the full webhook URL here, e.g.
//   'https://discord.com/api/webhooks/123456789/AbCdEf...'
const DISCORD_WEBHOOK_URL = '';

// Optional: ping this Discord user/role on every sighting. Leave '' for no ping.
//   user -> '<@123456789012345678>'      role -> '<@&123456789012345678>'
const DISCORD_PING = '';

// ── 3. THE BOT'S MINECRAFT ACCOUNT (cracked / offline-mode) ──────────────────
const MC_USERNAME = 'PutTheBotsMinecraftNameHere';
const MC_PASSWORD = 'PutTheBotsAuthMePasswordHere'; // used for /register and /login

// ═════════════════════════════════════════════════════════════════════════════
//   Everything below has working defaults for 6b6t. Change only if you need to.
// ═════════════════════════════════════════════════════════════════════════════

const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Any of the values above can also be supplied by an environment variable, so
// nothing secret has to be committed. The environment always wins when set.
const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};
const envNum = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const admins = String(env('BW_ADMINS', ADMINS.join(',')))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

const settings = {
  admins,
  commandPrefix: env('BW_PREFIX', '?'),

  discord: {
    webhookUrl: String(env('BW_WEBHOOK_URL', DISCORD_WEBHOOK_URL)).trim(),
    ping: String(env('BW_DISCORD_PING', DISCORD_PING)).trim(),
    // Avatar thumbnails on the embed. 'auto' looks the UUID up at Mojang and
    // falls back to a name-based skin service; 'none' disables thumbnails.
    avatarMode: env('BW_AVATAR_MODE', 'auto'),
    avatarSize: envNum('BW_AVATAR_SIZE', 64),
    timeoutMs: envNum('BW_WEBHOOK_TIMEOUT_MS', 8000),
  },

  server: {
    host: env('BW_HOST', 'play.6b6t.org'),
    // Rotated on every failed join so one dead front-end cannot wedge the bot.
    hosts: String(env('BW_HOSTS', 'play.6b6t.org,alt.6b6t.org,alt2.6b6t.org,alt3.6b6t.org'))
      .split(',').map((h) => h.trim()).filter(Boolean),
    hostStartIndex: envNum('BW_HOST_START_INDEX', 0),
    port: envNum('BW_PORT', 25565),
    version: env('BW_VERSION', false),
    // The watcher wants to see players far away, so keep the view distance up.
    viewDistance: envNum('BW_VIEW_DISTANCE', 8),
  },

  account: {
    username: env('BW_MC_USERNAME', MC_USERNAME),
    auth: 'offline',
    loginPassword: env('BW_MC_PASSWORD', MC_PASSWORD),
    registerEmailDomain: env('BW_REGISTER_EMAIL_DOMAIN', '6b6t.services'),
  },

  // Chat strings and coordinates of the cracked-login flow. These drive the
  // /register + /login handling and the walk through the auth + game lobbies.
  login: {
    authPortal: { x: -1000, y: 102, z: -988 },
    lobbyPortal: { x: -1, y: 21, z: -16 },
    promptText: 'please login with the command',
    registerText: 'please register to 6b6t with the command',
    successText: 'you are now logged in',
    mainServerText: 'welcome to 6b6t.org',
    connectTimeoutMs: 45000,
    skipLobbyCommand: '/skiplobby on',
    skipLobbyAfterLoginMs: 3000,
    // How long to sit in the game lobby before disconnecting and rejoining.
    lobbyRejoinMs: 30000,
    // How long to wait on the backup server before rotating the join host.
    backupReconnectMs: 90000,
    backupLogIntervalMs: 45000,
    // A server reporting this many players or fewer is the backup server.
    backupMaxPlayers: 1,
    presenceCheckMs: 5000,
    portalMoveTimeoutMs: 60000,
  },

  reconnect: {
    afterKickMinMs: 5000,
    duplicateSessionMs: 30000,
    afterMainMs: 15000,
    afterLobbyMs: 5000,
    ddosMs: 8000,
  },

  proxy: {
    enabled: String(env('BW_PROXY_ENABLED', 'false')) === 'true',
    host: env('BW_PROXY_HOST', ''),
    port: envNum('BW_PROXY_PORT', 1080),
    username: env('BW_PROXY_USERNAME', null),
    password: env('BW_PROXY_PASSWORD', null),
  },

  // ── Standing at the base ───────────────────────────────────────────────────
  post: {
    file: path.join(DATA_DIR, 'anchor.json'),
    // Drift further than this from the anchor and the bot walks back.
    holdToleranceBlocks: envNum('BW_HOLD_TOLERANCE', 3),
    holdCheckMs: envNum('BW_HOLD_CHECK_MS', 4000),
    // After a reconnect, walk back to the anchor if it is within this range.
    // Further than that and the bot watches from where it woke up and warns.
    walkBackMaxBlocks: envNum('BW_WALKBACK_MAX', 96),
    // Turn the head every so often so the server does not see an AFK client.
    // The bot never leaves the block; only the look direction changes.
    antiAfk: String(env('BW_ANTI_AFK', 'true')) === 'true',
    antiAfkMs: envNum('BW_ANTI_AFK_MS', 45000),
    // How long ?setup waits for the admin to accept the /tpa.
    setupTpaTimeoutMs: envNum('BW_SETUP_TPA_TIMEOUT_MS', 105000),
  },

  // ── Who gets logged, how often ─────────────────────────────────────────────
  watch: {
    file: path.join(DATA_DIR, 'visitors.json'),
    scanIntervalMs: envNum('BW_SCAN_INTERVAL_MS', 1000),
    // Spawn mute. While the bot is within this many blocks of spawn it reports
    // nothing: it is either dead and respawned, or transiting the lobby/proxy
    // hops, or travelling back -- either way it is not at the base, and every
    // player it can see there is spawn traffic. Nothing latches; it starts
    // reporting again by itself once it is back out past the ring and standing
    // on its post. Set to 0 to disable the mute.
    spawnRadius: envNum('BW_SPAWN_RADIUS', 5000),
    // Where spawn actually is, if the server's is not 0,0.
    spawnX: envNum('BW_SPAWN_X', 0),
    spawnZ: envNum('BW_SPAWN_Z', 0),

    // Report any player seen within this many blocks of the anchor.
    scanRadius: envNum('BW_SCAN_RADIUS', 128),
    // Inside this radius the sighting is flagged "close range" and repeats
    // more often, because someone is standing on top of the base.
    closeRadius: envNum('BW_CLOSE_RADIUS', 32),
    // Re-alert on a player who stays close, at most this often.
    closeRepeatMs: envNum('BW_CLOSE_REPEAT_MS', 5 * 60 * 1000),
    // Re-alert on a player who is only in the outer ring, at most this often.
    farCooldownMs: envNum('BW_FAR_COOLDOWN_MS', 60 * 60 * 1000),
    // Gone for longer than this and the next sighting counts as a fresh visit.
    awayResetMs: envNum('BW_AWAY_RESET_MS', 15 * 60 * 1000),
    // Extra names that should never be reported (comma separated).
    ignore: String(env('BW_IGNORE', '')).split(',').map((n) => n.trim()).filter(Boolean),
    // How long ?test opens the scanner up to the admin who ran it.
    testWindowMs: envNum('BW_TEST_WINDOW_MS', 60 * 1000),
    onlineTickMs: envNum('BW_ONLINE_TICK_MS', 10000),
    flushMinMs: envNum('BW_FLUSH_MIN_MS', 60000),
  },

  debug: {
    chatMessages: String(env('BW_CHAT_DEBUG', 'false')) === 'true',
    watcher: String(env('BW_WATCH_DEBUG', 'false')) === 'true',
  },

  dataDir: DATA_DIR,
};

// Fail loudly at boot rather than silently watching nothing.
function validate() {
  const problems = [];
  if (!settings.admins.length || settings.admins.some((n) => /PutYour/i.test(n))) {
    problems.push('ADMINS is not set (src/settings.js, section 1)');
  }
  if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(settings.discord.webhookUrl)) {
    problems.push('DISCORD_WEBHOOK_URL is not set to a Discord webhook URL (src/settings.js, section 2)');
  }
  if (!settings.account.username || /PutThe/i.test(settings.account.username)) {
    problems.push('MC_USERNAME is not set (src/settings.js, section 3)');
  }
  if (!settings.account.loginPassword || /PutThe/i.test(settings.account.loginPassword)) {
    problems.push('MC_PASSWORD is not set (src/settings.js, section 3)');
  }
  return problems;
}

module.exports = settings;
module.exports.validate = validate;
