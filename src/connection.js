// Connection: owns the mineflayer bot for a cracked anarchy server (6b6t-style).
//
// Handles: offline login, the in-game /register + /login (AuthMe) flow, the 1.21
// lobby->main transfer packets, walking the auth + lobby portals, and robust
// reconnect. It emits high-level events that the rest of the bot subscribes to,
// so no other module needs to know about the login dance.
//
// Taken from the base-hunter project (src/bot/connection.js) with two changes:
// the anarchy-mod require path, and the vendored-mineflayer-only physics
// options, which are now passed only when configured.
//
// Events:
//   'state'  (newState)            offline|connecting|lobby|authed|limbo|main
//   'spawn'  (bot)                 entity spawned (may be lobby or main)
//   'main'   (bot)                 reached the main anarchy server
//   'message'(text, bot)           every chat line (already stringified)
//   'kicked' (reasonStr)
//   'end'    (reasonStr)
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const mcDataLoader = require('minecraft-data');
const { SocksClient } = require('socks');
const EventEmitter = require('events');
const { attachAnarchyModJoinSignal } = require('./anarchyModSignal');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_KICK_RECONNECT_MS = 5000;
const DEFAULT_DUPLICATE_SESSION_RECONNECT_MS = 30000;

class Connection extends EventEmitter {
  constructor(config, log) {
    super();
    this.cfg = config;
    this.log = log;
    this.bot = null;
    this.state = 'offline';
    this.manualStop = false;
    // Runtime-owned persistent admin stops set this hard lock. Unlike the
    // ordinary manualStop flag, a generic start(), lobby retry, or scheduled
    // cooldown expiry cannot clear it. Only an explicit admin Start clears it.
    this.adminStopped = false;
    this._mcData = null;
    this._reconnectTimer = null;
    this._scheduledReconnectTimer = null;
    this.scheduledReconnectAt = 0;
    this.scheduledReconnectReason = null;
    this._timeout = null;
    this._presenceTimer = null;
    this._flowTimers = new Set();
    this._closed = false; // guards _onClose: 'kicked' and 'end' both fire on one drop
    this._serverHosts = normalizeServerHosts(config && config.server);
    this._serverHostIndex = normalizeHostStartIndex(config && config.server, this._serverHosts.length);
    this._accountLimitDelayMs = 0;
    this._chatDebug = !!(config && config.debug && config.debug.chatMessages);
  }

  setChatDebug(enabled) {
    this._chatDebug = enabled === true;
    this.log.info(`chat-debug: ${this._chatDebug ? 'enabled; logging every inbound chat/system message' : 'disabled'}`);
    return this._chatDebug;
  }

  get chatDebugEnabled() {
    return this._chatDebug;
  }

  _logInboundChat(text) {
    if (!this._chatDebug) return false;
    this.log.info(`chat-in: ${formatChatForLog(text)}`);
    return true;
  }

  isOnMainServer(bot = this.bot) {
    return classifyServerPresence(bot, this.cfg && this.cfg.login).state === 'main';
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  start() {
    // Re-entrancy guard: a second start() while already connecting/online would
    // build a second bot, orphan the first (its listeners + monkeypatched
    // _client.write/emit + connect-timeout timer leak, and the server kicks one
    // session for "already online"). Auto-reconnect goes through _reconnect()->
    // _connect() directly, so guarding start() here is safe.
    if (this.adminStopped) {
      this.log.info('start ignored: bot is persistently stopped by an admin; explicit admin Start is required');
      return false;
    }
    if (this.state !== 'offline') { this.log.warn(`start ignored: already ${this.state} (logout first to force a reconnect)`); return false; }
    this._clearScheduledReconnect();
    this.manualStop = false;
    this._connect();
    return true;
  }

  setAdminStopped(stopped) {
    this.adminStopped = stopped === true;
    if (!this.adminStopped) return false;
    this.manualStop = true;
    this._clearScheduledReconnect();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    this._clearFlowTimers();
    return true;
  }

  stopForReconnect(delayMs, reason = 'scheduled reconnect') {
    const waitMs = Math.max(1, Math.floor(Number(delayMs) || 0));
    return this.stop({
      reconnectAt: Date.now() + waitMs,
      reconnectReason: String(reason || 'scheduled reconnect'),
    });
  }

  // Manual logout: stop reconnecting and drop the connection.
  stop(options = {}) {
    const reconnectAt = Number(options && options.reconnectAt) || 0;
    const scheduled = !this.adminStopped && reconnectAt > Date.now();
    if (scheduled) {
      if (this._scheduledReconnectTimer) clearTimeout(this._scheduledReconnectTimer);
      this._scheduledReconnectTimer = null;
      this.scheduledReconnectAt = reconnectAt;
      this.scheduledReconnectReason = String(options.reconnectReason || 'scheduled reconnect');
    } else {
      this._clearScheduledReconnect();
    }
    this.manualStop = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; }
    this._clearFlowTimers();
    const bot = this.bot;
    if (!bot) {
      this._closed = true;
      this.setState('offline');
      if (scheduled) this._armScheduledReconnect();
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let done = false;
      let endFallbackTimer = null;
      let destroyFallbackTimer = null;
      const client = bot._client;
      const socket = client && client.socket;
      const finish = (clean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(endFallbackTimer);
        clearTimeout(destroyFallbackTimer);
        bot.removeListener('end', onEnd);
        if (client && typeof client.removeListener === 'function') client.removeListener('end', onEnd);
        if (socket && typeof socket.removeListener === 'function') {
          socket.removeListener('close', onEnd);
          socket.removeListener('end', onEnd);
        }
        if (this.bot === bot) this.bot = null;
        this._closed = true;
        this.setState('offline');
        this.log.info(`manual disconnect ${clean ? 'completed cleanly' : 'timed out'}`);
        if (scheduled) this._armScheduledReconnect();
        resolve(clean);
      };
      const onEnd = () => finish(true);
      const timer = setTimeout(() => finish(false), 8000);
      bot.once('end', onEnd);
      if (client && typeof client.once === 'function') client.once('end', onEnd);
      if (socket && typeof socket.once === 'function') {
        socket.once('close', onEnd);
        socket.once('end', onEnd);
      }
      try { bot.quit('manual-disconnect'); } catch (_) {}
      endFallbackTimer = setTimeout(() => {
        try {
          if (typeof bot.end === 'function') bot.end('manual-disconnect');
          else if (bot._client && typeof bot._client.end === 'function') bot._client.end('manual-disconnect');
        } catch (_) {}
      }, 750);
      destroyFallbackTimer = setTimeout(() => {
        try {
          const s = bot._client && bot._client.socket;
          if (s && typeof s.destroy === 'function') s.destroy();
        } catch (_) {}
      }, 6500);
    });
  }

  _armScheduledReconnect() {
    if (this.adminStopped) {
      this._clearScheduledReconnect();
      return false;
    }
    const reconnectAt = Number(this.scheduledReconnectAt) || 0;
    if (reconnectAt <= 0) return false;
    if (this._scheduledReconnectTimer) clearTimeout(this._scheduledReconnectTimer);
    const reason = this.scheduledReconnectReason || 'scheduled reconnect';
    const waitMs = Math.max(0, reconnectAt - Date.now());
    this._scheduledReconnectTimer = setTimeout(() => {
      this._scheduledReconnectTimer = null;
      if (Number(this.scheduledReconnectAt) !== reconnectAt) return;
      this.scheduledReconnectAt = 0;
      this.scheduledReconnectReason = null;
      this.log.info(`${reason} expired; reconnecting now`);
      this.start();
    }, waitMs);
    if (this._scheduledReconnectTimer.unref) this._scheduledReconnectTimer.unref();
    return true;
  }

  _clearScheduledReconnect() {
    if (this._scheduledReconnectTimer) clearTimeout(this._scheduledReconnectTimer);
    this._scheduledReconnectTimer = null;
    this.scheduledReconnectAt = 0;
    this.scheduledReconnectReason = null;
  }

  _proxySocket(client) {
    const p = this.cfg.proxy;
    const server = this._currentServer();
    const opts = {
      proxy: {
        host: p.host,
        port: p.port,
        type: 5,
        ...(p.username && p.password ? { userId: p.username, password: p.password } : {}),
      },
      command: 'connect',
      destination: { host: server.host, port: server.port },
      timeout: 30000,
    };
    SocksClient.createConnection(opts)
      .then(({ socket }) => { client.setSocket(socket); client.emit('connect'); })
      .catch((err) => client.emit('error', err));
  }

  _connect() {
    if (this.manualStop) return;
    this._closed = false;
    const { account } = this.cfg;
    const server = this._currentServer();
    this.setState('connecting');
    if (this.manualStop) {
      this.setState('offline');
      return;
    }

    const opts = {
      host: server.host,
      port: server.port,
      username: account.username,
      auth: account.auth || 'offline',
      version: server.version === undefined ? false : server.version,
      viewDistance: normalizeViewDistance(server.viewDistance),
      hideErrors: true,
      checkTimeoutInterval: 120000,
    };
    // These two are only understood by the anti-cheat-friendly mineflayer fork
    // the base hunter vendors. Stock mineflayer ignores them, so they are only
    // passed when explicitly configured.
    if (server.physicsBackend) opts.physicsBackend = String(server.physicsBackend).toLowerCase();
    if (server.maxCatchupTicks != null) opts.maxCatchupTicks = normalizePhysicsCatchupTicks(server.maxCatchupTicks);
    if (this.cfg.proxy && this.cfg.proxy.enabled && this.cfg.proxy.host) {
      this.log.info(`Connecting to ${server.host}:${server.port} via SOCKS5 ${this.cfg.proxy.host}:${this.cfg.proxy.port}`);
      opts.connect = (client) => this._proxySocket(client);
    } else {
      this.log.info(`Connecting directly to ${server.host}:${server.port} as ${account.username}`);
    }
    this.log.info(`Client view distance: ${opts.viewDistance} chunk${opts.viewDistance === 1 ? '' : 's'}${opts.physicsBackend ? `; physics=${opts.physicsBackend}` : ''}${opts.maxCatchupTicks ? `; physics catch-up=${opts.maxCatchupTicks} tick` : ''}`);

    const setupTimeoutMs = (this.cfg.login && this.cfg.login.connectTimeoutMs) || 45000;
    if (this._timeout) clearTimeout(this._timeout);
    this._timeout = setTimeout(() => {
      if (this.manualStop || this.state !== 'connecting') return;
      this.log.warn(`Connect setup timeout (state=${this.state}) - retrying`);
      this._closed = true;
      try { if (this.bot) this.bot.quit('connect-setup-timeout'); } catch (_) {}
      this._advanceServerHost('connect setup timeout');
      this._reconnect(3000);
    }, setupTimeoutMs);

    let bot;
    try {
      bot = mineflayer.createBot(opts);
    } catch (e) {
      if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
      this.log.error(`createBot failed: ${e.message}`);
      this._advanceServerHost('createBot failed');
      return this._reconnect(10000);
    }
    this.bot = bot;
    try {
      bot.loadPlugin(pathfinder);
      this._wire(bot);
    } catch (e) {
      if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
      this.log.warn(`connect setup failed: ${(e && e.message) || e}`);
      this._closed = true;
      try { bot.quit('connect-setup-failed'); } catch (_) {}
      try {
        if (typeof bot.end === 'function') bot.end('connect-setup-failed');
        else if (bot._client && typeof bot._client.end === 'function') bot._client.end('connect-setup-failed');
      } catch (_) {}
      if (this.bot === bot) this.bot = null;
      this._advanceServerHost('connect setup failed');
      this._reconnect(3000);
    }
  }

  _wire(bot) {
    const log = this.log;
    const L = this.cfg.login;
    const flags = { authed: false, main: false, lobbyNavTriggered: false, fired: false };

    // Match the official Fabric AnarchyMod join notification. On 1.20.4 the
    // mod sends one empty anarchymod:join custom payload when play login is
    // ready. It does not alter the client brand or send a registration packet.
    attachAnarchyModJoinSignal({
      bot,
      getHost: () => this._currentServer().host,
      log,
      enabled: !(this.cfg.server && this.cfg.server.anarchyModJoinSignal === false),
    });

    // --- 1.21 transfer plumbing (lobby -> main re-runs the configuration phase) ---
    let configurationCount = 0;
    let inConfiguration = false;
    let pendingPacks = null;

    const origWrite = bot._client.write.bind(bot._client);
    bot._client.write = (name, data) => {
      const command = outgoingCommand(name, data);
      if (command && /^(?:\/)?(?:home|kill|tpa)\b/i.test(command)) {
        bot._baseHunterLastTeleportCommand = { command, at: Date.now() };
      }
      if (inConfiguration && (name === 'position' || name === 'configuration.position')) return;
      if (name === 'select_known_packs' && configurationCount > 1 && Array.isArray(pendingPacks)) {
        return origWrite('select_known_packs', { packs: pendingPacks });
      }
      return origWrite(name, data);
    };
    bot._client.on('start_configuration', () => { configurationCount++; inConfiguration = true; });
    bot._client.on('finish_configuration', () => { inConfiguration = false; });
    bot._client.on('select_known_packs', (pkt) => { if (pkt && pkt.packs && pkt.packs.length) pendingPacks = pkt.packs; });
    const origEmit = bot._client.emit.bind(bot._client);
    bot._client.emit = (event, ...args) => {
      if (event === 'registry_data' && configurationCount > 1) {
        const pkt = args[0];
        if (pkt && pkt.entries && pkt.entries.length) {
          const first = pkt.entries[0];
          if (first && first.key && !first.data) return true; // swallow empty re-send
        }
      }
      return origEmit(event, ...args);
    };

    let serverBrand = '';
    let lastServerPositionPacket = null;
    let lastMainPosition = null;
    let lastQuarantineLogAt = 0;
    let backupSinceAt = 0;
    let lastBackupLogAt = 0;
    bot._client.on('custom_payload', (packet = {}) => {
      const channel = String(packet.channel || packet.tag || '');
      if (!/(?:^|:)brand$/i.test(channel)) return;
      const decoded = decodeBrandPayload(packet.data);
      if (decoded) serverBrand = decoded;
    });
    bot._client.on('position', (packet = {}) => {
      lastServerPositionPacket = {
        at: Date.now(),
        x: packet.x,
        y: packet.y,
        z: packet.z,
        flags: packet.flags == null ? 'none' : String(packet.flags),
        teleportId: packet.teleportId == null ? 'none' : Number(packet.teleportId),
      };
    });

    const logUnexpectedTeleport = (from, to, distance) => {
      const now = Date.now();
      if (now - lastQuarantineLogAt < 5000) return;
      lastQuarantineLogAt = now;
      const lastCommand = bot._baseHunterLastTeleportCommand;
      const commandAge = lastCommand && Number.isFinite(lastCommand.at) ? now - lastCommand.at : Infinity;
      const game = bot.game || {};
      const snapshot = {
        host: this._currentServer().host,
        version: bot.version || 'unknown',
        brand: String(serverBrand || game.serverBrand || 'unknown'),
        mode: String(game.gameMode == null ? 'unknown' : game.gameMode),
        difficulty: String(game.difficulty == null ? 'unknown' : game.difficulty),
        maxPlayers: String(game.maxPlayers == null ? 'unknown' : game.maxPlayers),
        listedPlayers: playerCount(bot),
        dimension: String(game.dimension || (bot.entity && bot.entity.dimension) || 'unknown'),
        from: describePos(from),
        to: describePos(to),
        distance: Math.round(distance),
        lastCommand: lastCommand ? lastCommand.command : 'none',
        lastCommandAgeMs: Number.isFinite(commandAge) ? commandAge : 'none',
        positionPacket: lastServerPositionPacket,
      };
      log.warn(`server identity probe: unexpected uncommanded teleport while classified main; ${JSON.stringify(snapshot)}`);
    };

    bot.on('move', () => {
      if (this.bot !== bot || this.state !== 'main' || !flags.main || !bot.entity || !bot.entity.position) return;
      const current = clonePosition(bot.entity.position);
      if (!current) return;
      if (lastMainPosition) {
        const distance = positionDistance(lastMainPosition, current);
        const command = bot._baseHunterLastTeleportCommand;
        const expected = command && Date.now() - Number(command.at || 0) <= 45000;
        const threshold = Math.max(1000, Number((L && L.unexpectedMainTeleportDistance) || 10000));
        if (!expected && distance >= threshold) {
          logUnexpectedTeleport(lastMainPosition, current, distance);
        }
      }
      lastMainPosition = current;
    });

    const confirmMain = (reason) => {
      if (flags.main) return;
      flags.main = true;
      backupSinceAt = 0;
      lastBackupLogAt = 0;
      this._resetAccountLimitBackoff();
      lastMainPosition = clonePosition(bot.entity && bot.entity.position);
      if (this._timeout) clearTimeout(this._timeout);
      this._clearFlowTimers();
      if (typeof bot.resumePhysicsFromServerPosition === 'function') {
        const resumed = bot.resumePhysicsFromServerPosition();
        log.info(`main physics resume=${resumed} backend=${bot.physicsBackend || 'unknown'}`);
      }
      this.setState('main');
      log.event('=== MAIN SERVER REACHED ===');
      if (reason) log.info(`main confirmed: ${reason}`);
      this.emit('main', bot);
      setTimeout(() => {
        if (this.bot && bot.entity) {
          const p = bot.entity.position;
          log.info(`Main position: ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
        }
      }, 3000);
    };

    const reconnectFromPreMain = (reason, disposeReason) => {
      this._closed = true;
      if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
      if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; }
      this._clearFlowTimers();
      this._advanceServerHost(reason);
      this.setState('offline');
      this._disposeCurrentBot(disposeReason || reason);
      this._reconnect(1000);
    };
    const handleBackupPresence = (presence, detail) => {
      const now = Date.now();
      if (!backupSinceAt) backupSinceAt = now;
      const waitedMs = now - backupSinceAt;
      const maxWaitMs = normalizeBackupReconnectMs(this.cfg.login);
      if (waitedMs >= maxWaitMs) {
        log.warn(
          `limbo: backup server persisted for ${Math.round(waitedMs / 1000)}s; `
          + `rotating join host instead of waiting forever (${presence.reason})`,
        );
        reconnectFromPreMain('backup limbo timeout', 'backup-limbo-timeout');
        return true;
      }
      const wasLimbo = this.state === 'limbo';
      this.setState('limbo');
      const logIntervalMs = Math.max(30000, Number(this.cfg.login && this.cfg.login.backupLogIntervalMs) || 45000);
      const shouldLog = !wasLimbo
        || now - lastBackupLogAt >= logIntervalMs
        || String(detail || '').includes('without rejoining');
      if (shouldLog) {
        lastBackupLogAt = now;
        log.info(`limbo: connected to backup server; ${detail || 'waiting for main'} (${presence.reason})`);
      }
      return false;
    };

    bot._client.on('login', () => {
      inConfiguration = false;
      // a transfer to the game lobby re-fires login but no spawn npc is in view
      if (configurationCount >= 1 && flags.authed && !flags.main && !flags.lobbyNavTriggered) {
        flags.lobbyNavTriggered = true;
        this._flowTimeout(() => { if (this.bot && !flags.main) this._toLobbyPortal(flags); }, 4000);
      }
    });

    bot.on('resourcePack', () => { try { bot.acceptResourcePack(); } catch (_) {} });
    bot.on('error', () => {});
    bot._client.on('error', () => {});

    // re-queue if we never reach a usable state in time (clear-before-assign so a
    // prior timer can never be orphaned)
    if (this._timeout) clearTimeout(this._timeout);
    const onConnectTimeout = () => {
      if (!flags.main && !this.manualStop) {
        const presence = classifyServerPresence(bot, this.cfg.login);
        if (presence.state === 'main') {
          confirmMain(presence.reason);
          return;
        }
        if (flags.authed && presence.state === 'backup') {
          if (handleBackupPresence(presence, 'waiting for main')) return;
          this._timeout = setTimeout(onConnectTimeout, L.connectTimeoutMs || 45000);
          return;
        }
        log.warn(`Connect timeout (state=${this.state}) - retrying`);
        this._closed = true;
        try { bot.quit('connect-timeout'); } catch (_) {}
        this._advanceServerHost('connect timeout');
        this._reconnect(3000);
      }
    };
    this._timeout = setTimeout(onConnectTimeout, L.connectTimeoutMs || 45000);

    bot.once('spawn', () => {
      const p = bot.entity && bot.entity.position;
      this._resetAccountLimitBackoff();
      log.info(`Spawned${p ? ` at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : ''}`);
      this.setState('lobby');
      this.emit('spawn', bot);
    });

    bot.on('message', (json) => {
      const text = json.toString().trim();
      if (!text) return;
      const low = text.toLowerCase();
      this._logInboundChat(text);
      this.emit('message', text, bot);

      if (!flags.authed && (low.includes(L.registerText))) {
        const email = `${bot.username}@${this.cfg.account.registerEmailDomain}`;
        log.info('Register prompt detected, sending /register');
        this._flowTimeout(() => { if (this.bot === bot) bot.chat(`/register ${email} ${email}`); }, 1500);
        return;
      }
      if (!flags.authed && (low.includes(L.promptText) || low.includes('/login <password>'))) {
        log.info('Login prompt detected, sending /login');
        this._flowTimeout(() => {
          if (this.bot !== bot || flags.main) return;
          try {
            bot.chat(`/login ${this.cfg.account.loginPassword}`);
            this._scheduleSkipLobby(bot, flags);
          } catch (_) {}
        }, 1500);
        return;
      }
      if (low.includes('wrong password') || low.includes('incorrect password')) {
        log.error('WRONG PASSWORD - stopping (fix MC_PASSWORD in src/settings.js)');
        this.manualStop = true;
        try { bot.quit('wrong-password'); } catch (_) {}
        return;
      }
      if (!flags.authed && (low.includes(L.successText) || low.includes('successfully logged in'))) {
        flags.authed = true;
        this.setState('authed');
        log.info('Authenticated - walking to auth portal');
        this._flowTimeout(() => { if (this.bot && !flags.main) this._toAuthPortal(flags); }, 3000);
        this._scheduleLobbyRejoin(bot, flags);
        return;
      }
      if (!flags.main && low.includes(L.mainServerText)) {
        const presence = classifyServerPresence(bot, L);
        if (presence.state === 'main') {
          confirmMain(presence.reason);
        } else {
          log.info(`main text seen; waiting for strict main server game state (${presence.reason})`);
        }
      }
    });

    if (this._presenceTimer) clearInterval(this._presenceTimer);
    this._presenceTimer = setInterval(() => {
      if (this.bot !== bot || !flags.authed || this.manualStop) return;
      const presence = classifyServerPresence(bot, this.cfg.login);
      if (presence.state === 'main') {
        backupSinceAt = 0;
        lastBackupLogAt = 0;
        if (!flags.main) confirmMain(presence.reason);
      } else if (presence.state === 'backup') {
        const alreadyLimbo = this.state === 'limbo' && !flags.main;
        flags.main = false;
        if (handleBackupPresence(presence, alreadyLimbo ? 'waiting for main' : 'backup server detected; staying connected and waiting for main')) return;
      } else if (flags.main) {
        backupSinceAt = 0;
        lastBackupLogAt = 0;
        flags.main = false;
        this.setState('lobby');
        log.warn(`main server was replaced by lobby; rejoining in ${Math.round(normalizeLobbyRejoinMs(this.cfg.login) / 1000)}s (${presence.reason})`);
        this._scheduleLobbyRejoin(bot, flags);
      } else if (this.state === 'limbo') {
        backupSinceAt = 0;
        lastBackupLogAt = 0;
        this.setState('lobby');
        log.info(`limbo: left backup for lobby; rejoin timer started (${presence.reason})`);
        this._scheduleLobbyRejoin(bot, flags);
      } else {
        backupSinceAt = 0;
        lastBackupLogAt = 0;
      }
    }, Math.max(1000, Number((this.cfg.login && this.cfg.login.presenceCheckMs) || 5000)));
    if (this._presenceTimer.unref) this._presenceTimer.unref();

    // MeterMaid npc spawns in the game lobby -> that is our cue to find the portal
    bot.on('entitySpawn', (ent) => {
      if (ent.type === 'player' && ent.username === 'MeterMaid' && !flags.main && !flags.lobbyNavTriggered) {
        flags.lobbyNavTriggered = true;
        this._flowTimeout(() => { if (this.bot) this._toLobbyPortal(flags); }, 2000);
      }
    });

    bot.on('kicked', (reason) => this._onClose('kicked', reason, flags));
    bot.on('end', (reason) => this._onClose('end', reason, flags));
  }

  _flowTimeout(fn, delay) {
    const t = setTimeout(() => {
      this._flowTimers.delete(t);
      fn();
    }, delay);
    this._flowTimers.add(t);
    if (t.unref) t.unref();
    return t;
  }

  _clearFlowTimers() {
    for (const t of this._flowTimers) clearTimeout(t);
    this._flowTimers.clear();
  }

  _scheduleSkipLobby(bot, flags) {
    const L = this.cfg.login || {};
    if (flags.skipLobbyScheduled || flags.skipLobbySent) return;
    flags.skipLobbyScheduled = true;
    const command = L.skipLobbyCommand || '/skiplobby on';
    const delay = Number.isFinite(Number(L.skipLobbyAfterLoginMs)) ? Number(L.skipLobbyAfterLoginMs) : 3000;
    this._flowTimeout(() => {
      flags.skipLobbyScheduled = false;
      if (this.bot !== bot || flags.main) return;
      try {
        bot.chat(command);
        flags.skipLobbySent = true;
        this.log.info(`Sent ${command}`);
      } catch (e) {
        this.log.warn(`skip-lobby command failed: ${(e && e.message) || e}`);
      }
    }, delay);
  }

  _scheduleLobbyRejoin(bot, flags, options = {}) {
    const L = this.cfg.login || {};
    const reset = options && options.reset === true;
    if (flags.lobbyRejoinScheduled) {
      if (!reset) return;
      if (flags.lobbyRejoinTimer) {
        clearTimeout(flags.lobbyRejoinTimer);
        this._flowTimers.delete(flags.lobbyRejoinTimer);
      }
      flags.lobbyRejoinTimer = null;
      flags.lobbyRejoinScheduled = false;
    }
    flags.lobbyRejoinScheduled = true;
    const delay = normalizeLobbyRejoinMs(L);
    let timer = null;
    timer = this._flowTimeout(() => {
      if (flags.lobbyRejoinTimer === timer) flags.lobbyRejoinTimer = null;
      flags.lobbyRejoinScheduled = false;
      if (this.bot !== bot || flags.main || !flags.authed) return;
      const presence = classifyServerPresence(bot, this.cfg.login);
      if (presence.state === 'backup') {
        this.setState('limbo');
        this.log.info(`limbo: connected to backup server; waiting for main without rejoining (${presence.reason})`);
        return;
      }
      this.log.warn(`Still in lobby after ${Math.round(delay / 1000)}s - disconnecting and rejoining`);
      this._closed = true;
      if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
      if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; }
      this._clearFlowTimers();
      this._advanceServerHost('30s lobby rejoin');
      this.setState('offline');
      this._disposeCurrentBot('lobby-rejoin');
      this._reconnect(1000);
    }, delay);
    flags.lobbyRejoinTimer = timer;
  }

  _onClose(kind, reason, flags) {
    // 'kicked' and 'end' both fire on a single disconnect; classify once so a
    // kick reason (e.g. duplicate session -> slow retry) isn't overwritten by the
    // trailing 'socketClosed' end event (which would reset to the default delay).
    if (this._closed) return;
    this._closed = true;
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; }
    this._clearFlowTimers();
    const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
    const closeClass = classifyDisconnect(kind, reasonStr);
    this.log.warn(`${kind}: ${reasonStr}${closeClass ? ` (${closeClass})` : ''}`);
    this.emit(kind, reasonStr);
    this.setState('offline');
    if (this.manualStop) return;

    if (/Bad login|Invalid session|not logged into your Minecraft account/i.test(reasonStr)) {
      this.log.error('Bad token / session - not retrying'); return;
    }
    if (isVerificationKick(reasonStr)) {
      this.log.error('VPN/proxy verification required - stopping this bot until the account/IP is verified');
      this.manualStop = true;
      return;
    }
    if (/reached your connected account limit/i.test(reasonStr)) {
      this._accountLimitDelayMs = this._accountLimitDelayMs > 0
        ? this._accountLimitDelayMs + 15000
        : 30000;
      this.log.warn(`Connected account limit reached - fully closing this bot session and waiting ${Math.round(this._accountLimitDelayMs / 1000)}s`);
      this._disposeCurrentBot('account-limit-backoff');
      return this._reconnect(this._accountLimitDelayMs);
    }
    if (/already connected|already logged in|already online/i.test(reasonStr)) {
      const delay = this._duplicateSessionReconnectDelay();
      this.log.warn(`Duplicate session (username already online) - retrying in ${Math.round(delay / 1000)}s`);
      return this._reconnect(delay);
    }
    if (!flags || !flags.main) this._advanceServerHost(`${kind} before main`);
    if (/DDoS|Connection Blocked/i.test(reasonStr)) return this._reconnect(this._afterKickReconnectDelay(kind, this.cfg.reconnect.ddosMs));
    if (flags && flags.main) return this._reconnect(this._afterKickReconnectDelay(kind, this.cfg.reconnect.afterMainMs));
    return this._reconnect(this._afterKickReconnectDelay(kind, this.cfg.reconnect.afterLobbyMs));
  }

  _afterKickReconnectDelay(kind, delay = 0) {
    const base = Math.max(0, Number(delay) || 0);
    const R = this.cfg.reconnect || {};
    const raw = R.afterKickMs != null ? R.afterKickMs : R.afterKickMinMs;
    const n = Number(raw);
    const kickDelay = Number.isFinite(n) && n >= 0 ? n : DEFAULT_KICK_RECONNECT_MS;
    return kind === 'kicked' ? kickDelay : base;
  }

  _duplicateSessionReconnectDelay() {
    const R = this.cfg.reconnect || {};
    const configured = Number(R.duplicateSessionMs);
    return Number.isFinite(configured) && configured >= 5000
      ? configured
      : DEFAULT_DUPLICATE_SESSION_RECONNECT_MS;
  }

  _reconnect(delay) {
    if (this.manualStop) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this.log.info(`Reconnecting in ${Math.round(delay / 1000)}s`);
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _disposeCurrentBot(reason = 'connection-disposed') {
    const bot = this.bot;
    if (!bot) return;
    this.bot = null;
    const client = bot._client;
    const socket = client && client.socket;
    try { bot.quit(reason); } catch (_) {}
    try {
      if (client && typeof client.end === 'function') client.end(reason);
      else if (typeof bot.end === 'function') bot.end(reason);
    } catch (_) {}
    try { if (socket && typeof socket.end === 'function') socket.end(); } catch (_) {}
    const destroyTimer = setTimeout(() => {
      try { if (socket && typeof socket.destroy === 'function') socket.destroy(); } catch (_) {}
    }, 250);
    if (destroyTimer.unref) destroyTimer.unref();
  }

  _resetAccountLimitBackoff() {
    if (this._accountLimitDelayMs <= 0) return false;
    this._accountLimitDelayMs = 0;
    this.log.info('Connected-account-limit backoff reset to 30s after successful server join');
    return true;
  }

  _currentServer() {
    const base = this.cfg.server || {};
    const host = this._serverHosts[this._serverHostIndex] || base.host;
    return { ...base, host };
  }

  _advanceServerHost(reason) {
    if (this._serverHosts.length <= 1) return;
    const oldHost = this._serverHosts[this._serverHostIndex];
    this._serverHostIndex = (this._serverHostIndex + 1) % this._serverHosts.length;
    const nextHost = this._serverHosts[this._serverHostIndex];
    this.log.info(`Switching join host ${oldHost} -> ${nextHost}${reason ? ` (${reason})` : ''}`);
  }

  // mcData must track bot.version — across a reconnect the negotiated version can
  // change (auto-version + ViaVersion), so a process-lifetime cache goes stale.
  _md(bot) {
    if (!this._mcData || this._mcDataVersion !== bot.version) {
      this._mcData = mcDataLoader(bot.version);
      this._mcDataVersion = bot.version;
    }
    return this._mcData;
  }

  // ----- movement to the auth / lobby portals (pathfinder, no digging) -----
  _movements(bot, opts = {}) {
    const m = new Movements(bot, this._md(bot));
    m.canDig = false;
    m.scaffoldingBlocks = [];
    if (opts.authPortal) {
      // Keep lobby navigation deliberate and let the normal collision model
      // route around the campfire strip instead of sprinting onto it.
      for (const block of bot.registry.blocksArray || []) {
        if (block && /(?:^|_)campfire$/.test(block.name)) {
          m.blocksToAvoid.add(block.id);
          // getMoveJumpUp does not consult blocksToAvoid for its support block.
          // Marking it non-supporting prevents that invalid jump node while
          // safe=false still prevents walking through the collision volume.
          m.fences.add(block.id);
        }
      }
      m.allowSprinting = false;
    }
    return m;
  }

  _walkTo(bot, pos, timeoutMs, tolerance = 2.5, opts = {}) {
    return new Promise((resolve) => {
      bot.pathfinder.setMovements(this._movements(bot, opts));
      const goal = opts.exact
        ? new goals.GoalBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
        : new goals.GoalNear(pos.x, pos.y, pos.z, Math.max(1, Math.ceil(tolerance)));
      bot.pathfinder.setGoal(goal);
      let settled = false;
      let poll = null;
      let lastPathRoute = '';
      const distance = () => bot.entity && bot.entity.position && typeof bot.entity.position.distanceTo === 'function'
        ? bot.entity.position.distanceTo(pos)
        : Infinity;
      const done = (ok, reason = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        bot.removeListener('goal_reached', onGoal);
        bot.removeListener('path_stop', onStop);
        bot.removeListener('path_update', onPathUpdate);
        bot.removeListener('path_reset', onPathReset);
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        resolve({ ok, dist: distance(), reason });
      };
      const onGoal = () => done(true, 'goal_reached');
      const onPathUpdate = (update = {}) => {
        if (!opts.authPortal) return;
        const path = Array.isArray(update.path) ? update.path : [];
        const end = path.length ? path[path.length - 1] : null;
        const route = path.map(describePos).join('>');
        this.log.info(
          `Auth path update status=${update.status || 'unknown'} nodes=${path.length}`
          + `${end ? ` end=${describePos(end)}` : ''}`,
        );
        if (route && route !== lastPathRoute) {
          lastPathRoute = route;
          this.log.info(`Auth planned route ${route}`);
        }
      };
      const onPathReset = (reason) => {
        if (opts.authPortal) this.log.warn(`Auth path reset: ${reason || 'unknown'}`);
      };
      const onStop = () => {
        const dist = distance();
        done(dist <= tolerance, `path_stop dist=${Number.isFinite(dist) ? dist.toFixed(2) : 'unknown'}`);
      };
      const timer = setTimeout(() => {
        const dist = distance();
        try { bot.pathfinder.stop(); } catch (_) {}
        done(dist <= tolerance, `timeout dist=${Number.isFinite(dist) ? dist.toFixed(2) : 'unknown'}`);
      }, Math.max(1000, timeoutMs || 15000));
      if (timer.unref) timer.unref();
      if (distance() <= tolerance) return done(true, 'already-close');
      if (typeof opts.isCancelled === 'function') {
        poll = setInterval(() => {
          if (opts.isCancelled()) done(false, 'cancelled');
        }, 250);
        if (poll.unref) poll.unref();
      }
      bot.once('goal_reached', onGoal);
      bot.once('path_stop', onStop);
      bot.on('path_update', onPathUpdate);
      bot.on('path_reset', onPathReset);
    });
  }

  async _walkStraightToAuthPortal(bot, target, timeoutMs) {
    if (!bot || !bot.entity || !target) return { ok: false, reason: 'no-entity' };
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (_) {}
    try { bot.clearControlStates(); } catch (_) {}
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 15000);
    const start = clonePosition(bot.entity.position);
    let lastLogAt = 0;
    try {
      // The auth spawn already faces the transfer portal. Leave the server's
      // yaw untouched and reproduce a player simply holding W.
      bot.setControlState('forward', true);
      while (Date.now() < deadline && this.bot === bot && bot.entity) {
        if (classifyServerPresence(bot, this.cfg.login).state === 'main') {
          return { ok: true, reason: 'portal-transfer' };
        }
        const p = bot.entity.position;
        // The auth portal transfers to a second lobby, not directly to main.
        // That transfer can reuse the same Mineflayer bot without immediately
        // changing the game-state fields. Detect the authoritative position
        // jump so the old auth-lobby W input is released at once.
        if (hasAuthPortalTransfer(start, p, target)) {
          return { ok: true, reason: 'portal-transfer-to-lobby' };
        }
        const horizontal = Math.hypot(Number(target.x) - p.x, Number(target.z) - p.z);
        if (Date.now() - lastLogAt >= 2000) {
          lastLogAt = Date.now();
          this.log.info(
            `Auth walk-forward dist=${horizontal.toFixed(2)}`
            + ` pos=${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`
            + ` ground=${!!bot.entity.onGround} collided=${!!bot.entity.isCollidedHorizontally}`,
          );
        }
        await sleep(50);
      }
      const dist = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(target) : Infinity;
      return { ok: false, dist, reason: `walk-forward-timeout dist=${Number.isFinite(dist) ? dist.toFixed(2) : 'unknown'}` };
    } finally {
      try { bot.clearControlStates(); } catch (_) {}
    }
  }

  async _toAuthPortal(flags = null) {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    const a = this.cfg.login.authPortal;
    const timeoutMs = Number(this.cfg.login.portalMoveTimeoutMs) || 15000;
    try {
      this.log.info('Walking to auth portal...');
      const md = this._md(bot);
      const portalIds = ['nether_portal', 'end_portal', 'end_gateway']
        .map((name) => md.blocksByName[name] && md.blocksByName[name].id)
        .filter((id) => id != null);
      const detectedPortal = portalIds.length
        ? bot.findBlock({ matching: portalIds, maxDistance: 32 })
        : null;
      const target = detectedPortal
        ? detectedPortal.position.offset(0.5, 0, 0.5)
        : new Vec3(a.x, a.y, a.z);
      const tabPlayers = Object.keys(bot.players || {})
        .filter((name) => String(name).toLowerCase() !== String(bot.username || '').toLowerCase());
      const nearbyPlayers = Object.values(bot.entities || {})
        .filter((entity) => entity && entity.type === 'player' && entity !== bot.entity)
        .map((entity) => `${entity.username || entity.name || entity.id}@${describePos(entity.position)}`);
      this.log.info(
        `Auth lobby occupants tabOthers=${tabPlayers.length}`
        + ` nearbyPlayers=${nearbyPlayers.length}`
        + `${tabPlayers.length ? ` tab=[${tabPlayers.slice(0, 12).join(',')}]` : ''}`
        + `${nearbyPlayers.length ? ` nearby=[${nearbyPlayers.slice(0, 12).join(',')}]` : ''}`,
      );
      this.log.info(
        `Auth portal target=${describePos(target)} source=${detectedPortal ? detectedPortal.name : 'configured'}`
        + ` current=${describePos(bot.entity.position)}`,
      );
      const current = bot.entity.position;
      const routeX = Math.floor(current.x);
      const routeY = Math.floor(current.y);
      const fromZ = Math.floor(current.z);
      const toZ = Math.floor(target.z);
      const stepZ = toZ >= fromZ ? 1 : -1;
      const routeBlocks = [];
      for (let z = fromZ; routeBlocks.length < 20; z += stepZ) {
        const feet = bot.blockAt(new Vec3(routeX, routeY, z));
        const head = bot.blockAt(new Vec3(routeX, routeY + 1, z));
        const below = bot.blockAt(new Vec3(routeX, routeY - 1, z));
        routeBlocks.push(`${z}:${feet ? feet.name : '?'}|${head ? head.name : '?'}|${below ? below.name : '?'}`);
        if (z === toZ) break;
      }
      this.log.info(`Auth route snapshot x=${routeX} y=${routeY} feet|head|below ${routeBlocks.join(' ')}`);
      const result = await this._walkStraightToAuthPortal(bot, target, Math.min(timeoutMs, 30000));
      this.log.info(result.ok ? `At auth portal, waiting for transfer (${result.reason})` : `Auth portal walk failed (${result.reason}); waiting/retry will continue`);
      if (result.reason === 'portal-transfer-to-lobby' && flags && !flags.main && !flags.lobbyNavTriggered) {
        flags.lobbyNavTriggered = true;
        this._flowTimeout(() => { if (this.bot === bot && !flags.main) this._toLobbyPortal(flags); }, 250);
      }
    } catch (e) { this.log.warn(`auth move: ${e.message}`); }
  }

  async _directWalkTo(bot, target, timeoutMs, tolerance = 3) {
    if (!bot || !bot.entity || !target) return { ok: false, dist: Infinity, reason: 'no-entity' };
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (_) {}
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 10000);
    const distance = () => bot.entity && bot.entity.position
      ? bot.entity.position.distanceTo(target)
      : Infinity;
    let lastLogAt = 0;
    let best = distance();
    const enforce = () => {
      if (!bot.entity) return;
      try { bot.setControlState('forward', true); } catch (_) {}
      try { bot.setControlState('sprint', false); } catch (_) {}
      // The 1.21.4 ViaVersion lobby does not reliably expose the collision
      // flag at the portal lip, so do not wait for isCollidedHorizontally.
      try { bot.setControlState('jump', true); } catch (_) {}
    };
    try { bot.on('physicsTick', enforce); } catch (_) {}
    try {
      while (Date.now() < deadline && this.bot === bot && bot.entity) {
        const dist = distance();
        best = Math.min(best, dist);
        if (dist <= tolerance) return { ok: true, dist, reason: 'direct-steer' };
        const presence = classifyServerPresence(bot, this.cfg.login);
        if (presence.state === 'main' || (best <= tolerance + 2 && dist > 100)) {
          return { ok: true, dist, reason: 'portal-transfer' };
        }
        enforce();
        if (typeof bot.lookAt === 'function') {
          const p = bot.entity.position;
          try {
            await bot.lookAt(new Vec3(Number(target.x), Number(p.y) + 1.6, Number(target.z)), true);
          } catch (_) {}
        }
        if (Date.now() - lastLogAt >= 2000) {
          lastLogAt = Date.now();
          this.log.info(`Auth direct-steer progress dist=${Number.isFinite(dist) ? dist.toFixed(2) : 'unknown'} pos=${describePos(bot.entity.position)}`);
        }
        await sleep(100);
      }
      const dist = distance();
      return { ok: dist <= tolerance, dist, reason: `direct-timeout dist=${Number.isFinite(dist) ? dist.toFixed(2) : 'unknown'}` };
    } finally {
      try { bot.removeListener('physicsTick', enforce); } catch (_) {}
      try { bot.setControlState('forward', false); } catch (_) {}
      try { bot.setControlState('sprint', false); } catch (_) {}
      try { bot.setControlState('jump', false); } catch (_) {}
    }
  }

  async _walkForwardThroughLobby(bot, flags, timeoutMs) {
    if (!bot || !bot.entity) return { ok: false, reason: 'no-entity' };
    const start = clonePosition(bot.entity.position);
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 6000);
    let lastLogAt = 0;
    try {
      // Lobby two is designed to be crossed like a normal client: the server
      // spawns the player facing the route, so preserve that yaw and hold W.
      bot.setControlState('forward', true);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
      while (Date.now() < deadline && this.bot === bot && bot.entity && !(flags && flags.main)) {
        const presence = classifyServerPresence(bot, this.cfg.login);
        if (presence.state === 'main') return { ok: true, reason: 'walk-forward-transfer' };
        const p = bot.entity.position;
        if (start && Number(p.y) < Number(start.y) - 4) {
          return { ok: false, reason: `walk-forward-left-platform y=${Number(p.y).toFixed(1)}` };
        }
        if (Date.now() - lastLogAt >= 2000) {
          lastLogAt = Date.now();
          this.log.info(
            `Lobby walk-forward pos=${describePos(p)}`
            + ` yaw=${Number.isFinite(Number(bot.entity.yaw)) ? Number(bot.entity.yaw).toFixed(3) : 'unknown'}`
            + ` moved=${start ? horizontalDistance(start, p).toFixed(2) : 'unknown'}`,
          );
        }
        await sleep(50);
      }
      if (flags && flags.main) return { ok: true, reason: 'walk-forward-transfer' };
      const moved = start && bot.entity ? horizontalDistance(start, bot.entity.position) : 0;
      return { ok: false, reason: `walk-forward-timeout moved=${Number(moved).toFixed(2)}` };
    } finally {
      try { bot.setControlState('forward', false); } catch (_) {}
      try { bot.setControlState('sprint', false); } catch (_) {}
      try { bot.setControlState('jump', false); } catch (_) {}
    }
  }

  _logLobbyScene(bot, origin) {
    if (!bot || !origin || typeof bot.blockAt !== 'function') return;
    const now = Date.now();
    if (this._lastLobbySceneAt && now - this._lastLobbySceneAt < 60000) return;
    this._lastLobbySceneAt = now;
    const nearbyEntities = Object.values(bot.entities || {})
      .filter((entity) => entity && entity.position && positionDistance(origin, entity.position) <= 64)
      .map((entity) => `${entity.username || entity.name || entity.displayName || entity.type || entity.id}@${describePos(entity.position)}`)
      .slice(0, 40);
    this.log.info(`Lobby scene entities near ${describePos(origin)}: ${nearbyEntities.length ? nearbyEntities.join(', ') : 'none'}`);

    const blocks = new Map();
    const baseX = Math.floor(origin.x), baseY = Math.floor(origin.y), baseZ = Math.floor(origin.z);
    for (let x = baseX - 40; x <= baseX + 10; x++) {
      for (let y = baseY - 2; y <= baseY + 10; y++) {
        for (let z = baseZ - 24; z <= baseZ + 24; z++) {
          let block = null;
          try { block = bot.blockAt(new Vec3(x, y, z)); } catch (_) {}
          const name = block && block.name ? String(block.name) : '';
          if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
          let row = blocks.get(name);
          if (!row) { row = { count: 0, nearest: [] }; blocks.set(name, row); }
          row.count++;
          const distance = positionDistance(origin, { x, y, z });
          row.nearest.push({ distance, pos: `${x},${y},${z}` });
          row.nearest.sort((a, b) => a.distance - b.distance);
          if (row.nearest.length > 3) row.nearest.length = 3;
        }
      }
    }
    const priority = /portal|gateway|button|pressure|plate|sign|command|beacon|lodestone|chest|glass|lantern|light|wool|concrete|stairs|slab/;
    const rows = Array.from(blocks.entries())
      .sort((a, b) => Number(priority.test(b[0])) - Number(priority.test(a[0])) || b[1].count - a[1].count)
      .slice(0, 36)
      .map(([name, row]) => `${name}=${row.count}@${row.nearest.map((entry) => entry.pos).join('|')}`);
    this.log.info(`Lobby scene blocks x=${baseX - 40}..${baseX + 10} y=${baseY - 2}..${baseY + 10} z=${baseZ - 24}..${baseZ + 24}: ${rows.length ? rows.join(', ') : 'none loaded'}`);
  }

  async _toLobbyPortal(flags) {
    const bot = this.bot;
    if (!bot || !bot.entity || flags.main) return;
    try {
      await sleep(2000);
      if (!bot.entity || flags.main) return;
      const here = bot.entity && bot.entity.position ? bot.entity.position : null;
      // The ice-over-water room is a waiting lobby, regardless of who else is
      // standing in it. Never chase players or the historic portal fallback
      // here: stop every movement source and let the mandatory rejoin timer run.
      if (isIceOverWaterLobby(bot, here)) {
        stopLobbyMovement(bot);
        this.setState('lobby');
        this.log.info('Ice-over-water lobby detected; movement paused until the required 30s lobby rejoin (player count ignored)');
        if (flags) this._scheduleLobbyRejoin(bot, flags, { reset: true });
        return;
      }
      const presence = classifyServerPresence(bot, this.cfg.login);
      if (presence.state === 'backup') {
        this.setState('backup');
        this.log.info(`backup: waiting for main server; skipping lobby portal (${presence.reason})`);
        return;
      }
      const timeoutMs = Number(this.cfg.login.portalMoveTimeoutMs) || 15000;
      const md = this._md(bot);
      const ids = ['nether_portal', 'end_portal', 'end_gateway']
        .map((n) => md.blocksByName[n] && md.blocksByName[n].id)
        .filter((x) => x != null);
      const portal = ids.length ? bot.findBlock({ matching: ids, maxDistance: 64 }) : null;
      if (!portal && here && Math.abs(here.x) < 100 && Math.abs(here.z) < 100) this._logLobbyScene(bot, here);
      const fallbackTargets = portal ? [] : resolveLobbyPortalTargets(this.cfg.login, here);
      if (!portal && !fallbackTargets.length) { this.log.warn('No lobby portal found nearby and no login.lobbyPortal fallback is configured'); return; }
      if (flags.main) return;
      let result = { ok: false, reason: 'not-started' };
      let pp = portal ? portal.position : fallbackTargets[0];
      const targets = portal ? [pp] : fallbackTargets;
      for (let i = 0; i < targets.length && !flags.main; i++) {
        pp = targets[i];
        if (portal) this.log.info(`Walking into lobby portal at ${pp.x},${pp.y},${pp.z}`);
        else this.log.warn(`No lobby portal block found nearby at ${describePos(here)}; walking to lobbyPortal fallback ${i + 1}/${targets.length} ${pp.x},${pp.y},${pp.z}`);
        // The second lobby is a short, simple approach and its chunks often do
        // not expose the portal block. Go straight to the configured fallback
        // instead of spending most of the mandatory 30-second lobby window on
        // a pathfinder plan. Keep pathfinder for a portal we can actually see.
        if (portal) {
          try { result = await this._walkTo(bot, pp, timeoutMs, 4, { isCancelled: () => !!flags.main }); } catch (_) {}
        } else {
          try { result = await this._directWalkTo(bot, pp, Math.min(9000, timeoutMs), 4); } catch (_) {}
        }
        if (portal && !result.ok && !flags.main && this.bot === bot && bot.entity) {
          this.log.info(`Lobby pathfinder stopped (${result.reason}); finishing the simple portal approach with direct walking`);
          try { result = await this._directWalkTo(bot, pp, Math.min(10000, timeoutMs), 4); } catch (_) {}
        }
        if (result.ok) break;
      }
      if (bot.entity && !flags.main && result.ok) {
        try { await bot.lookAt(pp.offset(0.5, 0.5, 0.5), true); } catch (_) {}
        bot.setControlState('forward', true);
        await sleep(1500);
        if (this.bot) bot.setControlState('forward', false);
      }
      this.log.info(result.ok ? `At lobby portal, waiting for transfer to main (${result.reason})` : `Lobby portal walk failed (${result.reason}) at ${describePos(bot.entity && bot.entity.position)}`);
    } catch (e) { this.log.warn(`lobby move: ${e.message}`); }
  }
}

function normalizeViewDistance(value) {
  if (value === undefined || value === null || value === '') return 32;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return trimmed;
  }
  return 32;
}

function normalizePhysicsCatchupTicks(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, Math.floor(n)));
}

function normalizeServerHosts(server = {}) {
  const values = [];
  const add = (value) => {
    const s = String(value || '').trim();
    if (s && !values.includes(s)) values.push(s);
  };
  add(server.host);
  if (Array.isArray(server.hosts)) {
    for (const host of server.hosts) add(host);
  }
  return values.length ? values : ['play.6b6t.org'];
}

function normalizeHostStartIndex(server = {}, count = 1) {
  if (count <= 1) return 0;
  const raw = Number(server.hostStartIndex);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.floor(raw) % count) + count) % count;
}

function formatChatForLog(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ↵ ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function resolveLobbyPortalPosition(login = {}) {
  const p = login.lobbyPortal;
  if (!p) return null;
  const x = Number(p.x), y = Number(p.y), z = Number(p.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
}

function resolveLobbyPortalTargets(login = {}, here = null) {
  const configured = resolveLobbyPortalPosition(login);
  if (!configured) return [];
  const out = [];
  const add = (pos) => {
    if (!pos) return;
    if (out.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z)) return;
    out.push(pos);
  };
  const hereY = Number(here && here.y);
  // ViaVersion reports the live transfer-lobby floor at Y=15/16 while the
  // historic configured target is Y=21. Use the current server floor first;
  // otherwise a 3D GoalNear/direct-steer stops below the trigger even when its
  // X/Z is exact. The configured Y remains a second fallback.
  if (Number.isFinite(hereY)) {
    add(new Vec3(configured.x, Math.floor(hereY), configured.z));
  }
  add(configured);
  return out;
}

function classifyServerPresence(bot, login = {}) {
  const pos = bot && bot.entity && bot.entity.position;
  if (pos) {
    if (nearPos(pos, { x: 1001, y: 100, z: 1001 }, 40)) return { state: 'auth_lobby', reason: `auth lobby coords ${describePos(pos)}` };
    const auth = login.authPortal;
    if (auth && nearPos(pos, auth, 40)) return { state: 'auth_lobby', reason: `auth portal coords ${describePos(pos)}` };
  }
  const g = (bot && bot.game) || {};
  const difficulty = String(g.difficulty != null ? g.difficulty : '').toLowerCase();
  const gameMode = String(g.gameMode != null ? g.gameMode : '').toLowerCase();
  const maxPlayers = String(g.maxPlayers != null ? g.maxPlayers : '');
  if ((gameMode === 'survival' || gameMode === '0') && maxPlayers === '1000') {
    return { state: 'main', reason: `game state mode=${gameMode} max=${maxPlayers}` };
  }
  // Player count alone cannot distinguish the empty ice lobby from the backup
  // server. Its ice-over-water floor is authoritative and must retain the 30s
  // lobby rejoin behaviour even when this bot is the only listed player.
  if (isIceOverWaterLobby(bot, pos)) {
    return { state: 'lobby', reason: `ice-over-water lobby at ${describePos(pos)}` };
  }
  const n = playerCount(bot);
  const backupMax = Number.isFinite(Number(login.backupMaxPlayers)) ? Number(login.backupMaxPlayers) : 1;
  if (n <= backupMax) return { state: 'backup', reason: `player count is ${n}` };
  if (difficulty === 'peaceful' || gameMode === 'adventure' || maxPlayers === '10000') {
    return { state: 'lobby', reason: `game state diff=${difficulty || '?'} mode=${gameMode || '?'} max=${maxPlayers || '?'}` };
  }
  return { state: 'lobby', reason: `waiting for main text; players=${n}` };
}

function normalizeLobbyRejoinMs(login = {}) {
  const value = Number(login && login.lobbyRejoinMs);
  return Number.isFinite(value) ? Math.max(5000, Math.floor(value)) : 30000;
}

function normalizeBackupReconnectMs(login = {}) {
  const value = Number(login && login.backupReconnectMs);
  return Number.isFinite(value) ? Math.max(30000, Math.floor(value)) : 90000;
}

function playerCount(bot) {
  try { return bot && bot.players ? Object.keys(bot.players).length : 0; } catch (_) { return 0; }
}

function outgoingCommand(name, data = {}) {
  if (name === 'chat_command' || name === 'signed_chat_command') {
    const command = data.command || data.message;
    return command ? `/${String(command).replace(/^\//, '')}` : '';
  }
  if (name === 'chat' || name === 'chat_message') return String(data.message || '');
  return '';
}

function decodeBrandPayload(data) {
  if (!Buffer.isBuffer(data) || !data.length) return '';
  let length = 0;
  let shift = 0;
  let offset = 0;
  while (offset < data.length && shift < 35) {
    const byte = data[offset++];
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (length < 0 || offset + length > data.length) return '';
  try { return data.subarray(offset, offset + length).toString('utf8').trim(); } catch (_) { return ''; }
}

function clonePosition(pos) {
  if (!pos) return null;
  const x = Number(pos.x), y = Number(pos.y), z = Number(pos.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function positionDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function nearPos(a, b, range) {
  if (!a || !b) return false;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  if (![dx, dy, dz].every(Number.isFinite)) return false;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= range;
}

function horizontalDistance(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dz = Number(a.z) - Number(b.z);
  if (![dx, dz].every(Number.isFinite)) return Infinity;
  return Math.sqrt(dx * dx + dz * dz);
}

function hasAuthPortalTransfer(start, current, target, threshold = 128) {
  if (!start || !current || !target) return false;
  const moved = positionDistance(start, current);
  const nowFromTarget = positionDistance(current, target);
  const limit = Math.max(32, Number(threshold) || 128);
  return Number.isFinite(moved) && Number.isFinite(nowFromTarget)
    && moved >= limit && nowFromTarget >= limit;
}

function isIceOverWaterLobby(bot, pos) {
  if (!bot || !pos) return false;
  // During the transfer this lobby is briefly reported at the correct X/Z but
  // an impossible negative Y, before any chunks are available. Recognize its
  // stable spawn coordinates so portal fallback movement cannot start in that
  // unloaded window. Strict main-server classification runs before this check.
  const px = Number(pos.x), pz = Number(pos.z);
  if (Number.isFinite(px) && Number.isFinite(pz) && Math.hypot(px - 33, pz + 4) <= 16) return true;
  if (typeof bot.blockAt !== 'function') return false;
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  const samples = [
    [x, y - 1, z], [x + 1, y - 1, z], [x - 1, y - 1, z],
    [x, y - 1, z + 1], [x, y - 1, z - 1],
  ];
  let ice = 0, water = 0;
  for (const [sx, sy, sz] of samples) {
    let floor = null, below = null;
    try { floor = bot.blockAt(new Vec3(sx, sy, sz)); } catch (_) {}
    try { below = bot.blockAt(new Vec3(sx, sy - 1, sz)); } catch (_) {}
    if (floor && /^(ice|packed_ice|blue_ice|frosted_ice)$/.test(String(floor.name))) ice++;
    if (below && String(below.name) === 'water') water++;
  }
  return ice >= 4 && water >= 4;
}

function stopLobbyMovement(bot) {
  if (!bot) return;
  try { if (bot.pathfinder) bot.pathfinder.stop(); } catch (_) {}
  try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (_) {}
  try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch (_) {}
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
    try { if (typeof bot.setControlState === 'function') bot.setControlState(control, false); } catch (_) {}
  }
  // Releasing movement on ice can leave horizontal momentum for several ticks.
  // Zero only X/Z so normal gravity remains active while the bot waits.
  const velocity = bot.entity && bot.entity.velocity;
  if (velocity) {
    if (Number.isFinite(Number(velocity.x))) velocity.x = 0;
    if (Number.isFinite(Number(velocity.z))) velocity.z = 0;
  }
}

// Backward-compatible export name for callers outside this repository.
const isPlayerlessIceLobby = isIceOverWaterLobby;

function selectAuthPortalLane(bot, from, target, radius = 6) {
  if (!bot || typeof bot.blockAt !== 'function' || !from || !target) return null;
  const baseX = Math.floor(Number(from.x));
  const y = Math.floor(Number(from.y));
  const fromZ = Math.floor(Number(from.z));
  const toZ = Math.floor(Number(target.z));
  if (![baseX, y, fromZ, toZ].every(Number.isFinite)) return null;
  const stepZ = toZ >= fromZ ? 1 : -1;
  let best = null;
  const candidates = [];
  for (let x = baseX - Math.max(1, radius); x <= baseX + Math.max(1, radius); x++) {
    let score = Math.abs(x + 0.5 - Number(from.x));
    let hazards = 0;
    for (let z = fromZ; ; z += stepZ) {
      const feet = bot.blockAt(new Vec3(x, y, z));
      const head = bot.blockAt(new Vec3(x, y + 1, z));
      const below = bot.blockAt(new Vec3(x, y - 1, z));
      const feetName = String((feet && feet.name) || '');
      const hazardous = /campfire|(^|_)fire$|lava|cactus|sweet_berry_bush/.test(feetName);
      if (hazardous) {
        score += 100;
        hazards++;
      }
      if (head && Array.isArray(head.shapes) && head.shapes.length) score += 50;
      if (feet && Array.isArray(feet.shapes) && feet.shapes.length && !/carpet|_slab$|nether_portal/.test(feetName)) score += 12;
      if (!below || !Array.isArray(below.shapes) || !below.shapes.length) score += 80;
      if (z === toZ) break;
    }
    const candidate = { x: x + 0.5, score: Number(score.toFixed(2)), hazards };
    candidates.push(candidate);
    if (!best || candidate.score < best.score) best = candidate;
  }
  return best ? { ...best, candidates } : null;
}

function describePos(pos) {
  return pos ? `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}` : 'unknown';
}

function isVerificationKick(reason = '') {
  return /VPN\/Proxy\/Unregistered|verify\.enderdash\.com/i.test(String(reason));
}

function classifyDisconnect(kind = '', reason = '') {
  const text = String(reason || '');
  if (String(kind) === 'kicked') {
    if (/An internal error occurred in your connection/i.test(text)) return 'server-side kick: proxy/server internal error';
    return 'server-side kick';
  }
  if (/socket|ECONNRESET|timed out|closed/i.test(text)) return 'network/client socket close';
  return '';
}

module.exports = {
  Connection,
  formatChatForLog,
  normalizeViewDistance,
  normalizePhysicsCatchupTicks,
  normalizeServerHosts,
  normalizeHostStartIndex,
  resolveLobbyPortalPosition,
  resolveLobbyPortalTargets,
  hasAuthPortalTransfer,
  isIceOverWaterLobby,
  isPlayerlessIceLobby,
  stopLobbyMovement,
  selectAuthPortalLane,
  classifyServerPresence,
  normalizeLobbyRejoinMs,
  normalizeBackupReconnectMs,
  isVerificationKick,
  classifyDisconnect,
};
