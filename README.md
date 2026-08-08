# base watcher

Minecraft Node.js bot made exclusively for BlackCat Clan by `rackeldevs`
## BlackCat is love, blackcat is life

You place it in game — walk to the spot, whisper it `?setup`, accept the
teleport it sends you, and it stands there from then on. It survives kicks,
restarts, backup-server limbo and the whole cracked-login dance on its own.

Built for 6b6t; the login flow and chat strings are configurable for similar
servers.

```
                    ┌─ ?setup ──────────► bot TPAs to you, anchors where it lands
   you (admin) ─────┼─ ?test ───────────► one-off alert to prove it works
                    └─ ?status ─────────► is it alive, is it muted, is it reporting

   someone walks past your base ────────► Discord embed: who, how far, history
```

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Run it](#run-it)
- [Place the bot](#place-the-bot)
- [Commands](#commands)
- [What gets reported](#what-gets-reported)
- [The spawn mute](#the-spawn-mute)
- [Keeping it running](#keeping-it-running)
- [All settings](#all-settings)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Credits](#credits)

---

## What it does

- **Joins a cracked server by itself.** Handles `/register` and `/login`
  (AuthMe), walks the auth portal and the game-lobby portal, sits out the
  mandatory lobby wait, detects the backup server and waits for main, and
  rotates between join hosts when one is dead.
- **Stands exactly where you put it.** No bed, no home, no coordinates in a
  config file — you teleport it into place once.
- **Reports players to Discord.** Rich embed with distance, coordinates, and
  running history: first seen, last seen, times seen, time seen today, total
  time seen, days seen, total time online.
- **Stays quiet when it should.** It knows when it isn't at its post (it died,
  or it's in transit) and mutes itself until it's back.
- **Never reports you.** Admins are invisible to it, except during a `?test`.
- **Reconnects forever.** Kicks, duplicate sessions, account limits, DDoS
  blocks and network drops all have their own backoff.

---

## Requirements

| | |
| --- | --- |
| **Node.js 20 or newer** | `node --version` to check. [Download](https://nodejs.org/) |
| **A cracked Minecraft account** | Just a username and a password you'll register on the server |
| **A Discord webhook URL** | Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL |
| **A server that allows bots** | 6b6t and similar anarchy servers. Check the rules of yours |

No Minecraft client, no Java, no Mojang account needed.

---

## Install

```bash
git clone https://github.com/NOSLEEPSMOKE/base-watcher.git
```

```bash
cd base-watcher && npm install
```

---

## Configure

Open **`src/settings.js`**. The first thirty lines are the only part you have
to touch — they are marked and there are exactly three things to fill in.

**1. Your Minecraft name**, so the bot knows who is allowed to command it. Add
more names to the list if more than one person should have control.

```js
const ADMINS = [
  'YourMinecraftName',
];
```

**2. Your Discord webhook URL**, pasted whole.

```js
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123456789/AbCdEf...';
```

**3. The bot's own account.** This is *not* your account — pick a username for
the bot and a password. It registers itself on first join.

```js
const MC_USERNAME = 'MyWatcherBot';
const MC_PASSWORD = 'something-long-and-random';
```

That's it. Everything else has working defaults.

> **Prefer not to put the password in a file?** Every setting can come from an
> environment variable instead, and those always win. Copy `.env.example` to
> `.env`, fill it in, and start with `node --env-file=.env src/index.js`.
> `.env` is gitignored.

If you get any of the three wrong the bot refuses to start and tells you which
one:

```
ERROR [bot] cannot start - fill these in first:
ERROR [bot]   * DISCORD_WEBHOOK_URL is not set to a Discord webhook URL (src/settings.js, section 2)
```

---

## Run it

```bash
npm start
```

You'll see it work through the join:

```
INFO  [bot]  admins: YourMinecraftName
INFO  [bot]  webhook: configured
INFO  [bot]  post: not set
INFO  [conn] Connecting directly to play.6b6t.org:25565 as MyWatcherBot
INFO  [conn] Register prompt detected, sending /register
INFO  [conn] Authenticated - walking to auth portal
INFO  [conn] At lobby portal, waiting for transfer to main
EVENT [conn] === MAIN SERVER REACHED ===
WARN  [bot]  no post set - whisper "?setup" to the bot as YourMinecraftName
```

Stop it with `Ctrl+C` — it saves its history before exiting.

---

## Place the bot

1. Log in and **stand exactly where you want the bot to watch from**.
2. Whisper it: `/msg MyWatcherBot ?setup`
3. It sends you a teleport request. **Accept it** (`/tpy YourName` on 6b6t).
4. It lands on you, freezes on that block, and starts watching.

It confirms in chat and in Discord:

```
post set at 21044, 64, -8912 - watching 128 blocks (32 close)
```

The spot is saved to `data/anchor.json`, so after a kick or a restart the bot
walks back to it by itself. If it wakes up more than 96 blocks away it says so
and stays quiet rather than pretending — whisper `?setup` again to re-place it.

---

## Commands

Whisper these to the bot in game. Only names in `ADMINS` are listened to;
everyone else is ignored completely.

| Command | What it does |
| --- | --- |
| `?setup` | Sends you a TPA and makes the landing spot its post |
| `?test` | Makes **you** visible to it for 60 seconds and sends one alert when you're in range |
| `?test 120` | Same, for a custom number of seconds |
| `?status` | Connection state, post location, distance from spawn, muted or reporting, players tracked, webhook on/off |
| `?help` | Lists the commands |

**Why `?test` exists:** admins are invisible to the watcher, so there's no way
to check it's working without logging in on a second account. `?test` lifts
that for you briefly. It sends **one** alert and then goes quiet, even if you
stand there the whole minute.

Change the `?` prefix with `BW_PREFIX`.

---

## What gets reported

Any player within **128 blocks** of the post (`BW_SCAN_RADIUS`), except:

- the bot itself
- anyone in `ADMINS` — unless their `?test` window is open
- anyone in `BW_IGNORE` (friends, alts, other bots)

Alerts come in two tiers, tracked per player:

| Tier | Range | Fires |
| --- | --- | --- |
| **Close** | within 32 blocks (`BW_CLOSE_RADIUS`) | the moment they arrive, then every 5 minutes while they stay |
| **Long** | anywhere else within 128 blocks | at most once an hour |

Someone who's been gone longer than 15 minutes always counts as a fresh visit
and reports straight away.

The embed shows distance from the post, their coordinates, the range tier, and
the full history for that player. **There are no bed fields** — this bot
doesn't have one.

---

## The spawn mute

**The bot reports nothing while it's within 5000 blocks of spawn, or more than
96 blocks from its post.**

Both mean the same thing: it isn't standing at your base. It died and
respawned at spawn, or it's moving through the lobby and proxy hops, or it's
travelling back. Anything it can see from there is spawn traffic, not someone
at your base — so those sightings are thrown away instead of being written into
the history as visitors.

**Nothing about this latches.** It's re-checked every second, so the moment the
bot is back out past the ring and standing on its post, it starts reporting
again on its own. No `?setup`, no restart, no reset.

```
WARN  [watch] muted: bot is 812 blocks from spawn, inside the 5000 block ring
              (died, or still travelling back); staying quiet until it is out past it again
INFO  [watch] unmuted: back on the post, 23104 blocks from spawn; reporting again
```

A death also posts a one-line notice to Discord, so the silence is never a
mystery. `?test` is muted by the same rule and tells you why instead of
starting.

Two things to know:

- **Don't put your post inside the ring.** If your base is within 5000 blocks
  of spawn the bot can never report. It warns you loudly at `?setup` — move
  further out, or lower `BW_SPAWN_RADIUS`.
- **Different spawn?** Set `BW_SPAWN_X` / `BW_SPAWN_Z`. Set `BW_SPAWN_RADIUS=0`
  to switch the spawn half of the check off entirely.

---

## Keeping it running

**Linux (systemd)** — `/etc/systemd/system/base-watcher.service`:

```ini
[Unit]
Description=base watcher
After=network-online.target

[Service]
WorkingDirectory=/opt/base-watcher
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
User=basewatcher
EnvironmentFile=/opt/base-watcher/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now base-watcher && journalctl -fu base-watcher
```

**Anywhere** — with [pm2](https://pm2.keymetrics.io/):

```bash
npx pm2 start src/index.js --name base-watcher && npx pm2 logs base-watcher
```

The bot handles its own reconnects, so a process supervisor is only there for
crashes and reboots.

---

## All settings

Everything below is an environment variable. Each one has a matching entry in
`src/settings.js` if you'd rather edit the file.

### Required

| Variable | Meaning |
| --- | --- |
| `BW_ADMINS` | Comma-separated Minecraft names allowed to command the bot |
| `BW_WEBHOOK_URL` | Discord webhook URL |
| `BW_MC_USERNAME` | The bot's Minecraft username |
| `BW_MC_PASSWORD` | The bot's AuthMe password |

### Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `BW_HOST` | `play.6b6t.org` | Primary host |
| `BW_HOSTS` | the 6b6t `alt*` list | Hosts to rotate through after a failed join |
| `BW_PORT` | `25565` | Port |
| `BW_VERSION` | auto | Protocol version, e.g. `1.20.4` |
| `BW_VIEW_DISTANCE` | `8` | Chunks. Higher sees further, costs more bandwidth |

### Watching

| Variable | Default | Meaning |
| --- | --- | --- |
| `BW_SCAN_RADIUS` | `128` | Report players within this many blocks of the post |
| `BW_CLOSE_RADIUS` | `32` | Inside this counts as "close range" |
| `BW_CLOSE_REPEAT_MS` | `300000` | Re-alert on someone who stays close, at most this often |
| `BW_FAR_COOLDOWN_MS` | `3600000` | Re-alert on someone at long range, at most this often |
| `BW_AWAY_RESET_MS` | `900000` | Gone this long and the next sighting is a fresh visit |
| `BW_IGNORE` | — | Comma-separated names never to report |
| `BW_TEST_WINDOW_MS` | `60000` | How long `?test` lasts |
| `BW_SCAN_INTERVAL_MS` | `1000` | How often it looks around |

### Spawn mute

| Variable | Default | Meaning |
| --- | --- | --- |
| `BW_SPAWN_RADIUS` | `5000` | Mute while this close to spawn. `0` disables |
| `BW_SPAWN_X` / `BW_SPAWN_Z` | `0` / `0` | Where spawn is, if not the origin |

### Standing still

| Variable | Default | Meaning |
| --- | --- | --- |
| `BW_HOLD_TOLERANCE` | `3` | Drift further than this and it walks back |
| `BW_WALKBACK_MAX` | `96` | Won't try to walk back from further than this |
| `BW_ANTI_AFK` | `true` | Turn the head occasionally. Never moves off the block |
| `BW_SETUP_TPA_TIMEOUT_MS` | `105000` | How long `?setup` waits for you to accept |

### Discord

| Variable | Default | Meaning |
| --- | --- | --- |
| `BW_DISCORD_PING` | — | Prepend a ping, e.g. `<@123…>` or `<@&123…>` |
| `BW_AVATAR_MODE` | `auto` | `auto` shows player heads, `none` disables thumbnails |

### Other

| Variable | Default | Meaning |
| --- | --- | --- |
| `BW_PREFIX` | `?` | Command prefix |
| `BW_CHAT_DEBUG` | `false` | Log every chat line the server sends |
| `BW_WATCH_DEBUG` | `false` | Log why each player was skipped |
| `BW_PROXY_ENABLED` | `false` | Route through a SOCKS5 proxy |
| `BW_PROXY_HOST` / `BW_PROXY_PORT` / `BW_PROXY_USERNAME` / `BW_PROXY_PASSWORD` | — | Proxy details |

---

## Troubleshooting

**It won't start and lists things to fill in.** Exactly what it says — open
`src/settings.js` and fill in the three marked sections.

**"WRONG PASSWORD - stopping".** The account is already registered on the
server with a different password. Use that password, or pick a new username.

**It never gets past the lobby.** Normal for a few minutes — 6b6t makes you
wait. Watch for `=== MAIN SERVER REACHED ===`. If it loops forever, try
`BW_VERSION=1.20.4` to pin the protocol version.

**"limbo: connected to backup server".** The main server is full or restarting.
It waits, then rotates to another host after 90 seconds. Nothing to do.

**"Duplicate session (username already online)".** An old session is still
connected. It retries every 30 seconds until the server drops the ghost.

**Nothing is posted to Discord.** In order: check `?status` says
`reporting=yes` — if it says `MUTED` read [the spawn mute](#the-spawn-mute).
Then check `webhook=on`. Then remember admins are never reported: use `?test`,
not your own account walking past.

**`?setup` says "not accepting teleport requests".** Run `/tpon` (or your
server's equivalent) and try again.

**The bot whispers back but ignores commands.** Your name isn't in `ADMINS`, or
you typed the wrong prefix. `?help` from an admin account lists what it knows.

**Too many alerts.** Raise `BW_CLOSE_REPEAT_MS` and `BW_FAR_COOLDOWN_MS`, drop
`BW_SCAN_RADIUS`, or add names to `BW_IGNORE`.

---

## How it works

```
src/settings.js        ← the only file you need to edit
src/index.js           entrypoint, wires everything together
src/connection.js      joining, cracked login, lobby/backup/limbo, reconnect
src/anarchyModSignal.js  AnarchyMod join payload
src/tpa.js             sending /tpa and waiting for a real teleport
src/adminCommands.js   whisper commands
src/watcher.js         the scan loop and the mute rules
src/discord.js         webhook posting and the embed
src/visitorStats.js    per-player history
src/post.js            the anchor, holding position, walking back
src/logger.js          console logging
data/anchor.json       written by ?setup
data/visitors.json     written by the watcher
```

`data/` is gitignored — your base coordinates and visitor history never leave
your machine.

### Tests

```bash
npm test
```

24 tests, fully offline — no server, no network. They cover the spawn mute
(including that it lifts by itself), admin filtering, the one-alert `?test`
window, the alert cooldowns, the server's TPA replies (including players trying
to fake them in chat), whisper parsing, and that no bed field ever reaches the
embed.

---

## Credits

Assembled from two existing Mineflayer projects:

| Part | From |
| --- | --- |
| Joining, cracked `/register` + `/login`, lobby → main transfer, backup detection, host rotation, reconnect classification | **base hunter** |
| Sending `/tpa` and waiting for a real teleport | **base hunter** + **mc-kitbot2** |
| Sighting scan, presence history, Discord embed | **mc-kitbot2** |

Built on [mineflayer](https://github.com/PrismarineJS/mineflayer) and
[mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder).

## License

MIT — see [LICENSE](LICENSE).

Use it on servers where bots are allowed, and follow the rules of the server
you're on.
