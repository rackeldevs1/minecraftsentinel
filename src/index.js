'use strict';

// base watcher — stands at a base on a cracked anarchy server and reports every
// player it sees to a Discord webhook.
//
//   join + cracked login handling ....... base-hunter  (src/bot/connection.js)
//   /tpa send + await ................... base-hunter + mc-kitbot2
//   sighting scan + Discord embed ....... mc-kitbot2   (VisitorManager*)
//
// Set the admin name and the webhook URL at the top of src/settings.js.

const settings = require('./settings');
const createLogger = require('./logger');
const { Connection } = require('./connection');
const createDiscord = require('./discord');
const createVisitorStats = require('./visitorStats');
const createPost = require('./post');
const createWatcher = require('./watcher');
const createAdminCommands = require('./adminCommands');

const log = createLogger('bot');

function main() {
  const problems = settings.validate();
  if (problems.length) {
    log.error('cannot start - fill these in first:');
    for (const problem of problems) log.error(`  * ${problem}`);
    process.exitCode = 1;
    return;
  }

  const discord = createDiscord({ settings, log: createLogger('discord') });
  const stats = createVisitorStats({
    file: settings.watch.file,
    flushMinMs: settings.watch.flushMinMs,
    log: createLogger('stats'),
  });
  stats.load();

  const post = createPost({ settings, log: createLogger('post') });
  post.load();

  const conn = new Connection(settings, createLogger('conn'));
  const watcher = createWatcher({
    settings, conn, post, discord, stats, log: createLogger('watch'),
  });
  const admin = createAdminCommands({
    settings, conn, post, watcher, stats, discord, log: createLogger('admin'),
  });

  conn.on('state', (state) => {
    if (state === 'main') return; // the 'main' handler below does the work
    // Any state other than main means the bot is not at its post: stop the
    // scanner so a lobby full of players cannot be reported as visitors, and
    // drop the command listeners so they never fire against a dead session.
    // A kick emits 'kicked' but not 'end', so this is the reliable hook.
    watcher.detach();
    post.stopHolding();
    admin.detach();
  });

  conn.on('main', async (bot) => {
    log.event(`on main as ${bot.username}`);
    admin.attach(bot);
    watcher.attach(bot);

    if (post.isSet) {
      const resumed = await post.resume(bot);
      if (resumed.ok) {
        post.startHolding(bot, () => conn.state === 'main');
        log.info(`back at the post ${post.describe()}; watching`);
      }
    } else {
      log.warn(`no post set - whisper "?setup" to the bot as ${settings.admins[0]} to place it`);
    }
  });

  conn.on('kicked', (reason) => log.warn(`kicked: ${reason}`));
  conn.on('end', () => stats.maybeFlush('disconnect'));

  const shutdown = (signal) => {
    log.event(`${signal} - saving and disconnecting`);
    watcher.detach();
    post.stopHolding();
    admin.detach();
    stats.flush('shutdown');
    Promise.resolve(conn.stop()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 9000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A watcher that dies silently is worse than one that restarts, so log loudly
  // and keep going rather than tearing the process down on a stray rejection.
  process.on('unhandledRejection', (e) => log.warn(`unhandled rejection: ${(e && e.message) || e}`));
  process.on('uncaughtException', (e) => log.error(`uncaught exception: ${(e && e.stack) || e}`));

  log.info(`admins: ${settings.admins.join(', ')}`);
  log.info(`webhook: ${discord.enabled ? 'configured' : 'MISSING - nothing will be posted'}`);
  log.info(`post: ${post.describe()}`);
  conn.start();
}

main();
