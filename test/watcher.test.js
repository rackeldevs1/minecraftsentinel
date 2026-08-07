'use strict';

// Offline tests: no server, no network. They pin the behaviours that are easy
// to break silently — admin filtering, the one-alert ?test window, the notify
// cooldowns, the 6b6t TPA strings, and the absence of bed fields on the embed.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const createWatcher = require('../src/watcher');
const createVisitorStats = require('../src/visitorStats');
const createDiscord = require('../src/discord');
const adminCommands = require('../src/adminCommands');
const tpa = require('../src/tpa');

const quietLog = { info() {}, warn() {}, error() {}, event() {} };

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'base-watcher-')), name);
}

// The post sits well outside the 5000 block spawn mute, like a real base.
const BASE = { x: 20000, y: 64, z: 20000 };

function makeHarness(overrides = {}) {
  const settings = {
    admins: ['AdminGuy'],
    commandPrefix: '?',
    discord: { webhookUrl: '', avatarMode: 'none' },
    post: { walkBackMaxBlocks: 96 },
    watch: {
      file: tmpFile('visitors.json'),
      scanIntervalMs: 1000,
      spawnRadius: 5000,
      spawnX: 0,
      spawnZ: 0,
      scanRadius: 128,
      closeRadius: 32,
      closeRepeatMs: 5 * 60 * 1000,
      farCooldownMs: 60 * 60 * 1000,
      awayResetMs: 15 * 60 * 1000,
      ignore: ['BlockedGuy'],
      testWindowMs: 60000,
      onlineTickMs: 10000,
      flushMinMs: 60000,
      ...(overrides.watch || {}),
    },
    debug: { watcher: false },
  };
  const sent = [];
  const discord = {
    enabled: true,
    async sendSighting(sighting) { sent.push(sighting); return true; },
    async sendText() { return true; },
  };
  const conn = Object.assign(new EventEmitter(), { state: 'main' });
  const anchor = { ...BASE };
  const post = {
    isSet: true,
    anchor,
    describe: () => `${anchor.x}, ${anchor.y}, ${anchor.z}`,
    distanceFrom: (position) => (position
      ? Math.hypot(position.x - anchor.x, position.y - anchor.y, position.z - anchor.z)
      : Infinity),
    stopHolding() {},
    startHolding() {},
    freeze() {},
  };
  const stats = createVisitorStats({ file: settings.watch.file, log: quietLog });
  const bot = {
    username: 'WatchBot',
    entity: { position: { ...BASE } },
    entities: {},
    players: {},
    on() {},
    removeListener() {},
  };
  const watcher = createWatcher({ settings, conn, post, discord, stats, log: quietLog });
  return { settings, discord, sent, conn, post, stats, bot, watcher, anchor };
}

// distance is measured out along +X from the post.
function addPlayer(harness, name, distance) {
  harness.bot.entities[name] = {
    type: 'player',
    username: name,
    position: { x: BASE.x + distance, y: BASE.y, z: BASE.z },
  };
}

function moveBotTo(harness, x, z) {
  harness.bot.entity.position = { x, y: BASE.y, z };
}

async function scanOnce(harness) {
  harness.watcher.attach(harness.bot);
  // attach() only starts timers; drive one tick directly through the same path
  // by borrowing the interval body: simplest is to await a real interval.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  harness.watcher.detach();
}

test('a normal player inside the scan radius is reported', async () => {
  const h = makeHarness();
  addPlayer(h, 'Griefer', 20);
  await scanOnce(h);
  assert.equal(h.sent.length >= 1, true, 'expected a sighting');
  assert.equal(h.sent[0].name, 'Griefer');
  assert.equal(h.sent[0].isClose, true, '20 blocks is inside the 32 block close radius');
});

test('a player past the scan radius is not reported', async () => {
  const h = makeHarness();
  addPlayer(h, 'FarAway', 400);
  await scanOnce(h);
  assert.equal(h.sent.length, 0);
});

test('admins are never reported without a test window', async () => {
  const h = makeHarness();
  addPlayer(h, 'AdminGuy', 10);
  assert.equal(h.watcher.skipReason('adminguy'), 'admin');
  await scanOnce(h);
  assert.equal(h.sent.length, 0, 'admin must not generate an alert');
});

test('the bot never reports itself, or names on the ignore list', () => {
  const h = makeHarness();
  h.watcher.attach(h.bot);
  assert.equal(h.watcher.skipReason('watchbot'), 'self');
  assert.equal(h.watcher.skipReason('blockedguy'), 'ignored');
  assert.equal(h.watcher.skipReason('griefer'), '');
  h.watcher.detach();
});

test('?test scans the admin and sends exactly one alert in the window', async () => {
  const h = makeHarness();
  addPlayer(h, 'AdminGuy', 15);
  h.watcher.openTestWindow('AdminGuy', 60000);
  assert.equal(h.watcher.skipReason('adminguy'), '', 'admin is scannable during the window');

  h.watcher.attach(h.bot);
  await new Promise((resolve) => setTimeout(resolve, 3300)); // three scan ticks
  h.watcher.detach();

  assert.equal(h.sent.length, 1, `expected exactly one test alert, got ${h.sent.length}`);
  assert.equal(h.sent[0].isTest, true);
  assert.equal(h.watcher.skipReason('adminguy'), 'admin-test-already-fired');
});

test('an expired test window puts the admin back on the ignore list', () => {
  const h = makeHarness();
  h.watcher.openTestWindow('AdminGuy', 5000);
  assert.equal(h.watcher.skipReason('adminguy'), '');
  h.watcher.openTestWindow('AdminGuy', -1); // clamped to the 5s floor, then aged out
  const window = h.watcher.testWindowFor('AdminGuy');
  window.until = Date.now() - 1;
  assert.equal(h.watcher.skipReason('adminguy'), 'admin');
});

test('notify cooldowns: close repeats on a timer, long range waits an hour', () => {
  const h = makeHarness();
  const now = Date.now();

  // First sighting of someone close always fires.
  let decision = h.watcher.decide({}, now, 10, 0, false);
  assert.equal(decision.notify, true);
  assert.equal(decision.isClose, true);

  // Still close a second later: suppressed.
  decision = h.watcher.decide(
    { lastIsClose: true, lastCloseWebhookAt: now - 1000, lastWebhookAt: now - 1000 },
    now, 10, now - 1000, false,
  );
  assert.equal(decision.notify, false);

  // Still close six minutes later: fires again.
  decision = h.watcher.decide(
    { lastIsClose: true, lastCloseWebhookAt: now - 6 * 60 * 1000, lastWebhookAt: now - 6 * 60 * 1000 },
    now, 10, now - 1000, false,
  );
  assert.equal(decision.notify, true);

  // Long range, alerted ten minutes ago: suppressed.
  decision = h.watcher.decide(
    { lastWebhookAt: now - 10 * 60 * 1000 }, now, 100, now - 1000, false,
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.isClose, false);

  // Long range, alerted two hours ago: fires.
  decision = h.watcher.decide(
    { lastWebhookAt: now - 2 * 60 * 60 * 1000 }, now, 100, now - 1000, false,
  );
  assert.equal(decision.notify, true);

  // Back after a long absence always counts as a fresh visit.
  decision = h.watcher.decide(
    { lastIsClose: true, lastCloseWebhookAt: now - 1000, lastWebhookAt: now - 1000 },
    now, 10, now - 60 * 60 * 1000, false,
  );
  assert.equal(decision.notify, true);
});

// ── spawn mute ──────────────────────────────────────────────────────────────

test('nothing is reported while the bot is inside the spawn ring', async () => {
  const h = makeHarness();
  addPlayer(h, 'Griefer', 20);
  // It died, or it is transiting the proxy hops: either way it is at spawn.
  moveBotTo(h, 120, -80);
  const check = h.watcher.validity(h.bot.entity.position);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'at-spawn');
  await scanOnce(h);
  assert.equal(h.sent.length, 0, 'spawn traffic must not be reported as base visitors');
});

test('a player standing right next to the bot at spawn is still not reported', async () => {
  const h = makeHarness();
  moveBotTo(h, 0, 0);
  h.bot.entities.Griefer = { type: 'player', username: 'Griefer', position: { x: 2, y: 64, z: 0 } };
  await scanOnce(h);
  assert.equal(h.sent.length, 0);
});

test('the mute lifts by itself once the bot is back on the post', async () => {
  const h = makeHarness();
  addPlayer(h, 'Griefer', 20);

  moveBotTo(h, 500, 500);                       // inside the ring: muted
  assert.equal(h.watcher.validity(h.bot.entity.position).ok, false);
  await scanOnce(h);
  assert.equal(h.sent.length, 0);

  moveBotTo(h, BASE.x, BASE.z);                 // travelled back: no reset needed
  assert.equal(h.watcher.validity(h.bot.entity.position).ok, true);
  await scanOnce(h);
  assert.equal(h.sent.length, 1, 'reporting must resume with no ?setup and no restart');
});

test('the bot is muted while it is away from the post but outside the ring', async () => {
  const h = makeHarness();
  addPlayer(h, 'Griefer', 20);
  moveBotTo(h, BASE.x + 400, BASE.z);           // 400 blocks off post, far from spawn
  const check = h.watcher.validity(h.bot.entity.position);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'off-post');
  await scanOnce(h);
  assert.equal(h.sent.length, 0);
});

test('normal drift inside the walk-back limit still reports', async () => {
  const h = makeHarness();
  addPlayer(h, 'Griefer', 20);
  moveBotTo(h, BASE.x + 20, BASE.z);            // 20 blocks: the hold guard handles it
  assert.equal(h.watcher.validity(h.bot.entity.position).ok, true);
  await scanOnce(h);
  assert.equal(h.sent.length, 1);
});

test('?test is muted at spawn too, so a test cannot pass off the post', async () => {
  const h = makeHarness();
  addPlayer(h, 'AdminGuy', 10);
  moveBotTo(h, 300, 300);
  h.watcher.openTestWindow('AdminGuy', 60000);
  await scanOnce(h);
  assert.equal(h.sent.length, 0);
});

test('the spawn mute can be turned off with a zero radius', () => {
  const h = makeHarness({ watch: { spawnRadius: 0 } });
  moveBotTo(h, 0, 0);
  h.post.anchor.x = 0;
  h.post.anchor.z = 0;
  assert.equal(h.watcher.validity(h.bot.entity.position).ok, true);
});

test('a post placed inside the ring is reported as permanently muted', () => {
  const h = makeHarness();
  h.post.anchor.x = 100;
  h.post.anchor.z = 100;
  moveBotTo(h, 100, 100);
  const check = h.watcher.validity(h.bot.entity.position);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'at-spawn');
  assert.match(check.detail, /spawn/);
});

test('the embed carries no bed fields', () => {
  const discord = createDiscord({
    settings: { discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x', avatarMode: 'none' } },
    log: quietLog,
  });
  const embed = discord.buildEmbed({
    name: 'Griefer',
    stats: { firstSeen: Date.now() - 86400000, totalSeen: 3, totalPresenceMs: 61000, todayPresenceMs: 1000, uniqueDays: 2, totalOnlineMs: 120000 },
    prevLastSeen: Date.now() - 3600000,
    isClose: true,
    isTest: false,
    distance: 12.4,
    position: { x: 12, y: 64, z: 1 },
    botName: 'WatchBot',
  });
  const blob = JSON.stringify(embed).toLowerCase();
  assert.equal(blob.includes('bed'), false, 'no bed field may appear on the embed');
  const names = embed.fields.map((f) => f.name);
  assert.deepEqual(names.includes('Distance'), true);
  assert.deepEqual(names.includes('Total time seen'), true);
  assert.equal(embed.fields.find((f) => f.name === 'Distance').value, '12 blocks from post');
});

test('6b6t TPA server replies classify correctly', () => {
  const cases = [
    ['Request sent to: Steve', 'sent'],
    ['Request send to: Steve', 'sent'],
    ['Your request sent to Steve was accepted!', 'accepted'],
    ['Your request sent to Steve was denied!', 'denied'],
    ['Player not found!', 'not-found'],
    ['Steve is currently not accepting teleport requests.', 'not-accepting'],
    ['Please wait for your existing request to be accepted or denied.', 'existing-request'],
    ['You have to wait 1m 30s before you can teleport again', 'cooldown'],
    ['Teleport failed!', 'teleport-failed'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(tpa.classifyTpaServerMessage(message, 'Steve'), expected, message);
  }
});

test('players cannot spoof TPA replies in chat', () => {
  const spoofs = [
    'Bob whispers: Your request sent to Steve was accepted!',
    'Bob says: Player not found!',
    '» Your request sent to Steve was accepted!',
    '>> Your request sent to Steve was accepted!',
    'You whisper to Bob: Your request sent to Steve was accepted!',
  ];
  for (const spoof of spoofs) {
    assert.equal(tpa.classifyTpaServerMessage(spoof, 'Steve'), '', spoof);
  }
});

test('TPA cooldown text parses to milliseconds', () => {
  assert.equal(tpa.parseTpaCooldownMs('you have to wait 1m 30s'), 90000);
  assert.equal(tpa.parseTpaCooldownMs('wait 45s before teleporting'), 45000);
  assert.equal(tpa.parseTpaCooldownMs('wait 2 minutes'), 120000);
});

test('the TPA timings match the values both source bots ship', () => {
  assert.equal(tpa.DEFAULTS.timeoutMs, 105000);        // KIT_TPA_ACCEPT_TIMEOUT_MS
  assert.equal(tpa.DEFAULTS.sendConfirmMs, 3000);      // KIT_TPA_SEND_CONFIRM_MS
  assert.equal(tpa.DEFAULTS.resendGapMs, 1000);        // KIT_TPA_RESEND_UNTIL_SENT_MS
  assert.equal(tpa.DEFAULTS.maxAttempts, 5);           // KIT_TPA_MAX_ATTEMPTS
  assert.equal(tpa.DEFAULTS.cooldownMaxRetries, 5);    // KIT_TPA_COOLDOWN_MAX_RETRIES
  assert.equal(tpa.DEFAULTS.pollMs, 250);              // KIT_TPA_ACCEPT_POLL_MS
  assert.equal(tpa.DEFAULTS.playerNotFoundWindowMs, 3000);
  assert.equal(tpa.DEFAULTS.reminderMs, 30000);        // KIT_TPA_REMINDER_MS
});

test('whisper formats are recognised', () => {
  const expected = { username: 'AdminGuy', message: '?setup' };
  for (const line of [
    'AdminGuy whispers: ?setup',
    'AdminGuy whispers to you: ?setup',
    '[AdminGuy -> me] ?setup',
    'AdminGuy -> me: ?setup',
    'From AdminGuy: ?setup',
    '§dAdminGuy whispers: ?setup',
  ]) {
    assert.deepEqual(adminCommands.parseWhisperLine(line), expected, line);
  }
  assert.equal(adminCommands.parseWhisperLine('AdminGuy: hello everyone'), null);
});

test('commands parse with their argument', () => {
  assert.deepEqual(adminCommands.parseCommand('?setup', '?'), { command: 'setup', arg: '' });
  assert.deepEqual(adminCommands.parseCommand('?test 120', '?'), { command: 'test', arg: '120' });
  assert.equal(adminCommands.parseCommand('setup', '?'), null);
});

test('visitor stats survive a save and reload', () => {
  const file = tmpFile('visitors.json');
  const a = createVisitorStats({ file, log: quietLog });
  a.load();
  a.put('Griefer', { name: 'Griefer', totalSeen: 4, firstSeen: 1000 });
  assert.equal(a.flush('test'), true);

  const b = createVisitorStats({ file, log: quietLog });
  b.load();
  assert.equal(b.count, 1);
  assert.equal(b.get('griefer').totalSeen, 4);
  assert.equal(b.get('GRIEFER').name, 'Griefer');
});

test('the day roll resets today counters and bumps unique days', () => {
  const store = createVisitorStats({ file: tmpFile('visitors.json'), log: quietLog });
  const record = { dayKey: '2020-01-01', todaySeen: 9, todayPresenceMs: 5000, uniqueDays: 3 };
  store.rollDay(record, '2020-01-02');
  assert.equal(record.todaySeen, 0);
  assert.equal(record.todayPresenceMs, 0);
  assert.equal(record.uniqueDays, 4);
  assert.equal(record.dayKey, '2020-01-02');
});
