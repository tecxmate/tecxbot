// Discord gateway listener. The persistent half of Discord capture.
//
//   DISCORD_BOT_TOKEN=... DISCORD_INGEST_SECRET=... \
//   TECXBOT_BASE_URL=https://bot.tecxmate.com \
//   node scripts/discord-gateway.mjs
//
//   ... --backfill 500        fetch recent history first, then listen
//   ... --backfill 500 --once fetch history and exit, no listening
//
// Why this exists outside the deployment: Discord sends message events only
// over a Gateway WebSocket. HTTP webhooks carry interactions (slash commands,
// buttons) and a few Social SDK events — not messages — so there is no
// serverless route to a channel transcript. This runs wherever you have a
// machine that stays on, and forwards to /api/discord-ingest.
//
// It holds the bot token and the ingest secret, and nothing else. No database
// credentials: what to keep and how to store it is decided server-side.
//
// No dependencies — Node 22 has WebSocket and fetch built in.

const TOKEN = required('DISCORD_BOT_TOKEN');
const SECRET = required('DISCORD_INGEST_SECRET');
const BASE_URL = (process.env.TECXBOT_BASE_URL || 'https://tecxbot.vercel.app').replace(/\/+$/, '');

const args = process.argv.slice(2);
const backfillCount = readFlag('--backfill');
const onceOnly = args.includes('--once');

// Only the channels named, or everything the bot can see.
const WATCHED = new Set(
  (process.env.DISCORD_CHANNEL_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
);
const watching = (channelId) => WATCHED.size === 0 || WATCHED.has(channelId);

// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES.
// MESSAGE_CONTENT is privileged: without it every `content` arrives empty and
// the capture is silently useless, so the listener checks for that below.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15) | (1 << 12);

const API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const channelMeta = new Map();

if (backfillCount) {
  await backfill(backfillCount);
  if (onceOnly) process.exit(0);
}

let reconnectDelay = 1000;
connect();

function connect() {
  const socket = new WebSocket(GATEWAY_URL);
  let heartbeat;
  let acked = true;

  socket.addEventListener('open', () => log('gateway connected'));

  socket.addEventListener('message', async (event) => {
    const frame = JSON.parse(event.data);
    if (frame.op === 10) {
      const interval = frame.d.heartbeat_interval;
      heartbeat = setInterval(() => {
        if (!acked) { log('no heartbeat ack — reconnecting'); socket.close(); return; }
        acked = false;
        socket.send(JSON.stringify({ op: 1, d: null }));
      }, interval);
      socket.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: INTENTS, properties: { os: 'linux', browser: 'tecxbot', device: 'tecxbot' } } }));
      return;
    }
    if (frame.op === 11) { acked = true; return; }
    if (frame.op === 7 || frame.op === 9) { log('gateway asked us to reconnect'); socket.close(); return; }
    if (frame.t === 'READY') {
      reconnectDelay = 1000;
      log(`ready as ${frame.d?.user?.username} — watching ${WATCHED.size || 'all'} channel(s)`);
      return;
    }
    if (frame.t === 'MESSAGE_CREATE') {
      const message = frame.d;
      if (!watching(message.channel_id)) return;
      await forward([message]);
    }
  });

  socket.addEventListener('close', () => {
    clearInterval(heartbeat);
    log(`gateway closed — reconnecting in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  });

  socket.addEventListener('error', (error) => log(`gateway error: ${error?.message ?? error}`));
}

/** Pull recent history. Discord, unlike LINE, lets you read the past. */
async function backfill(limit) {
  if (!WATCHED.size) {
    fail('--backfill needs DISCORD_CHANNEL_IDS: there is no "every channel" history endpoint.');
  }
  for (const channelId of WATCHED) {
    let before;
    let fetched = 0;
    while (fetched < limit) {
      const page = Math.min(100, limit - fetched);
      const url = new URL(`${API}/channels/${channelId}/messages`);
      url.searchParams.set('limit', String(page));
      if (before) url.searchParams.set('before', before);
      const response = await fetch(url, { headers: { Authorization: `Bot ${TOKEN}` } });
      if (!response.ok) {
        log(`backfill ${channelId}: ${response.status} ${await safeText(response)}`);
        break;
      }
      const messages = await response.json();
      if (!messages.length) break;
      // Oldest first, so the stored transcript reads forwards.
      await forward([...messages].reverse());
      fetched += messages.length;
      before = messages[messages.length - 1].id;
      if (messages.length < page) break;
    }
    log(`backfill ${channelId}: ${fetched} message(s)`);
  }
}

async function forward(messages) {
  const first = messages[0];
  const meta = await describeChannel(first.channel_id);
  const response = await fetch(`${BASE_URL}/api/discord-ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...meta, messages }),
  });
  if (!response.ok) {
    log(`ingest rejected: ${response.status} ${await safeText(response)}`);
    return;
  }
  const body = await response.json().catch(() => ({}));
  if (body.captured) log(`captured ${body.captured}${body.skipped ? `, skipped ${body.skipped}` : ''}`);
}

/** Channel and guild names, so the stored conversation has a readable title. */
async function describeChannel(channelId) {
  if (channelMeta.has(channelId)) return channelMeta.get(channelId);
  const meta = {};
  try {
    const response = await fetch(`${API}/channels/${channelId}`, { headers: { Authorization: `Bot ${TOKEN}` } });
    if (response.ok) {
      const channel = await response.json();
      meta.channelName = channel.name;
      if (channel.guild_id) {
        const guild = await fetch(`${API}/guilds/${channel.guild_id}`, { headers: { Authorization: `Bot ${TOKEN}` } });
        if (guild.ok) meta.guildName = (await guild.json()).name;
      }
    }
  } catch (error) {
    log(`could not describe channel ${channelId}: ${error.message}`);
  }
  channelMeta.set(channelId, meta);
  return meta;
}

function readFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return 0;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is not set.`);
  return value;
}

async function safeText(response) {
  try { return (await response.text()).slice(0, 300); } catch { return ''; }
}

function log(message) {
  console.log(`${new Date().toISOString()} discord-gateway: ${message}`);
}

function fail(message) {
  console.error(`discord-gateway: ${message}`);
  process.exit(1);
}
