import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ingestDiscordMessages } from '../src/platforms/discord/ingest.js';
import type { DiscordIngestPayload } from '../src/platforms/discord/types.js';

// Capture Discord messages forwarded by the gateway listener.
//
//   POST /api/discord-ingest
//   auth: Authorization: Bearer <DISCORD_INGEST_SECRET>
//   body: { channelName?, guildName?, messages: [...] }
//   returns: { captured, skipped }
//
// Why an endpoint rather than a webhook: Discord sends message events only over
// a Gateway WebSocket, and nothing serverless can hold one open. The persistent
// half is scripts/discord-gateway.mjs, which runs wherever you have a machine
// that stays on and POSTs here. That keeps the deployment serverless and means
// the listener holds no database credentials — only this one secret.
//
// Fail-closed: with no DISCORD_INGEST_SECRET set, every request is refused. An
// open ingest endpoint would let anyone write anything into the client log.

// bodyParser off so the body is read the same way on every runtime: Vercel
// parses req.body, the Workers adapter exposes both, and the test harness only
// streams. Reading the bytes ourselves is the one path that works on all three.
export const config = { api: { bodyParser: false }, maxDuration: 60 };

/** One forwarded batch. Enough for a busy channel, small enough to bound work. */
const MAX_MESSAGES = 200;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const raw = await readRawBody(req);
  const payload = parseBody(raw);
  if (!payload) return res.status(400).json({ error: 'Body must be JSON with a "messages" array.' });
  if (payload.messages.length > MAX_MESSAGES) {
    return res.status(413).json({ error: `Too many messages in one batch (max ${MAX_MESSAGES}).` });
  }

  try {
    const result = await ingestDiscordMessages(payload);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('[discord-ingest]', error);
    return res.status(500).json({ error: 'Failed to capture messages.' });
  }
}

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(raw: string): DiscordIngestPayload | undefined {
  if (!raw.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<DiscordIngestPayload>;
  if (!Array.isArray(candidate.messages)) return undefined;
  return {
    channelName: typeof candidate.channelName === 'string' ? candidate.channelName : undefined,
    guildName: typeof candidate.guildName === 'string' ? candidate.guildName : undefined,
    messages: candidate.messages,
  };
}

// Trimmed on both sides, like the other secret endpoints: a value pasted into a
// hosting dashboard easily carries a trailing newline, and an untrimmed compare
// turns that into a 401 indistinguishable from a wrong secret.
function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.DISCORD_INGEST_SECRET?.trim();
  if (!secret) return false; // fail closed: unset means the endpoint is disabled
  const auth = req.headers.authorization;
  const presented = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length).trim()
    : undefined;
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
