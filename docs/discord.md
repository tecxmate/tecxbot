# Capturing a Discord server

Discord is the one platform here where you can read the past. LINE delivers each
message once and keeps no history; Discord has a messages endpoint, so an
existing project channel can be backfilled on day one rather than starting
empty.

The trade is that it needs a process that stays running.

## Why a listener, not a webhook

Discord sends message events **only over a Gateway WebSocket**. Its HTTP
webhooks carry interactions — slash commands, buttons — and a handful of Social
SDK events. There is no HTTP route to a channel transcript, so nothing
serverless can capture one.

So capture is split:

- `scripts/discord-gateway.mjs` holds the WebSocket. Runs wherever you have a
  machine that stays on — the same one running the archive-media ticker will do.
- `POST /api/discord-ingest` receives what it forwards and decides what to keep.

The listener holds the bot token and the ingest secret, and nothing else. No
database credentials: what gets stored, and how, is decided server-side.

## Setting it up

**1. Create the app.** <https://discord.com/developers/applications> → New
Application → Bot. Copy the token.

**2. Turn on MESSAGE CONTENT.** Same page, *Privileged Gateway Intents* →
**Message Content Intent**.

> This is the trap. Without it the bot connects, events arrive, and every
> `content` field is an empty string — capture looks like it is working and
> stores nothing. It is a toggle for apps under 10,000 users; larger ones need
> Discord's review.

**3. Invite it.** OAuth2 → URL Generator → scope `bot`, permissions *View
Channels* and *Read Message History*. It needs nothing else: the bot never
posts.

**4. Configure the deployment:**

```
DISCORD_INGEST_SECRET=        # openssl rand -hex 32 — gates the endpoint
DISCORD_TENANT_ID=tecxmate    # otherwise it lands in the 'demo' tenant
DISCORD_CHANNEL_ID=default-discord
DISCORD_OPERATOR_USER_IDS=    # your own Discord user ids, comma separated
```

`DISCORD_OPERATOR_USER_IDS` matters more than it looks. Discord has no
inbound/outbound distinction — a listener sees one flat stream — so without it
every message is recorded as the client talking, and the weekly update draft
gets the attribution backwards. Right-click your name → Copy User ID (Developer
Mode must be on).

**5. Run the listener:**

```bash
DISCORD_BOT_TOKEN=... DISCORD_INGEST_SECRET=... \
TECXBOT_BASE_URL=https://bot.tecxmate.com \
DISCORD_CHANNEL_IDS=123456789 \
node scripts/discord-gateway.mjs --backfill 500
```

`--backfill 500` pulls the last 500 messages per channel, oldest first, then
starts listening. Re-running it is safe: messages are keyed by Discord's
snowflake id, so a repeated backfill overwrites rather than duplicating.

Leave `DISCORD_CHANNEL_IDS` unset to watch every channel the bot can see —
though `--backfill` requires it, because there is no "every channel" history
endpoint.

**6. Keep it running.** Same pattern as `scripts/archive-media-tick.sh`: a
launchd agent on macOS, a systemd unit on Linux. It reconnects on its own with
exponential backoff, but nothing restarts it if the machine reboots.

## What gets captured

Human messages and replies, with attachments described as `[image]`,
`[video]`, `[audio]` or `[file: name]`.

Skipped: other people's bots (CI, polls, music — they would bury the
conversation), system notices like joins and pins, and messages with no text
and no attachment.

## Before you move a client here

Worth saying plainly: your clients in Taiwan and Vietnam use LINE and WhatsApp.
Discord is where engineering teams live, not where 陳小姐 will message you about
an invoice.

Where it does fit:

- **Internal project channels** — your own team, where the PM workflow has the
  most to work with and no client has to change anything.
- **Technical clients** who already run a Discord server.
- **Demos**, because you can stand up a server, backfill it, and show real
  capture in minutes without touching a client account.
