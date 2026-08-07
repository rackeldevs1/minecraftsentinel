'use strict';

// Per-player sighting history, persisted to data/visitors.json.
//
// Ported from kitbot's VisitorManagerSupport (day keys, debounced flush,
// presence accrual) minus the SQLite/economy ledgers it wrote alongside.
//
// One record per lowercased player name:
//   name, uuid, firstSeen, lastSeen, totalSeen,
//   dayKey, todaySeen, todayPresenceMs, uniqueDays,
//   totalPresenceMs, lastPresenceAt, totalOnlineMs, onlineDayKey, lastOnlineAt,
//   lastIsClose, lastCloseExitAt, lastCloseWebhookAt, lastWebhookAt, lastAfterCloseFarAt

const fs = require('fs');
const path = require('path');

function dayKey(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = function createVisitorStats({ file, flushMinMs = 60000, log = console } = {}) {
  const filePath = String(file || path.join(process.cwd(), 'data', 'visitors.json'));
  let stats = {};
  let dirty = false;
  let lastFlushAt = 0;

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const json = JSON.parse(raw);
      stats = json && typeof json.stats === 'object' && json.stats ? json.stats : {};
      log.info(`visitor stats loaded: ${Object.keys(stats).length} player(s) from ${filePath}`);
    } catch (e) {
      if (e && e.code !== 'ENOENT') log.warn(`visitor stats unreadable (${(e && e.message) || e}); starting empty`);
      stats = {};
    }
    return stats;
  }

  // Atomic write: a crash mid-save must not leave a truncated JSON file that
  // wipes months of history on the next boot.
  function flush(reason = 'flush') {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const out = { version: 1, savedAt: Date.now(), reason: String(reason), stats };
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, filePath);
      dirty = false;
      lastFlushAt = Date.now();
      return true;
    } catch (e) {
      log.warn(`visitor stats save failed: ${(e && e.message) || e}`);
      return false;
    }
  }

  function maybeFlush(reason = 'interval') {
    if (!dirty) return false;
    if (Date.now() - lastFlushAt < Math.max(2000, Number(flushMinMs) || 60000)) return false;
    return flush(reason);
  }

  function get(name) {
    const key = String(name || '').toLowerCase();
    const existing = stats[key];
    return existing && typeof existing === 'object' ? existing : {};
  }

  function put(name, record) {
    const key = String(name || '').toLowerCase();
    stats[key] = record;
    dirty = true;
    return record;
  }

  function markDirty() {
    dirty = true;
  }

  // Roll the per-day counters over when the calendar day changes.
  function rollDay(record, key) {
    if (String(record.dayKey || '') === key) return record;
    record.todaySeen = 0;
    record.todayPresenceMs = 0;
    record.lastPresenceAt = 0;
    record.uniqueDays = (Number(record.uniqueDays || 0) || 0) + 1;
    record.dayKey = key;
    return record;
  }

  return {
    load,
    flush,
    maybeFlush,
    get,
    put,
    markDirty,
    rollDay,
    dayKey,
    get all() { return stats; },
    get count() { return Object.keys(stats).length; },
    get filePath() { return filePath; },
  };
};

module.exports.dayKey = dayKey;
