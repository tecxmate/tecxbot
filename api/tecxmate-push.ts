import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resolveTenantChannel } from '../src/core/tenantStore.js';
import { pushLineMessage } from '../src/platforms/line/client.js';

// The local coding agent in tecxcorp calls this after finishing a task: it
// pushes a message (typically a Drive share link) into the client LINE group.
// Secret-gated so only the owner's agent can send. This is the outbound half of
// the bridge; the inbound half is the Linear task created by the bot handler.

export const config = { maxDuration: 30 };

type PushBody = {
  to?: string; // LINE group/room/user id (reply_target from the Linear task)
  text?: string;
  link?: string;
  channel?: string; // which LINE channel's credentials to use; defaults to tecxmate
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { to, text, link, channel } = (req.body || {}) as PushBody;
  if (!to || typeof to !== 'string') return res.status(400).json({ error: 'Missing "to" (LINE target id)' });
  if ((!text || !text.trim()) && (!link || !link.trim())) return res.status(400).json({ error: 'Provide "text" and/or "link"' });

  const message = [text?.trim(), link?.trim()].filter(Boolean).join('\n\n');

  try {
    const channelId = channel || process.env.TECXMATE_LINE_CHANNEL_ID || 'tecxmate';
    const runtime = resolveTenantChannel({ channelId });
    const accessToken = runtime.channel.line?.channelAccessToken;
    if (!accessToken) return res.status(500).json({ error: `LINE channel "${channelId}" has no access token configured` });
    await pushLineMessage(to, { text: message }, accessToken);
    return res.status(200).json({ ok: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Push failed';
    console.error('[tecxmate-push]', detail);
    return res.status(500).json({ ok: false, error: detail });
  }
}

function isAuthorized(req: VercelRequest) {
  const secret = process.env.TECXMATE_PUSH_SECRET;
  if (!secret) return false; // fail closed: no secret set means the endpoint is disabled
  const provided = firstQueryValue(req.query.secret)
    ?? (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined);
  return typeof provided === 'string' && constantTimeEquals(provided, secret);
}

function constantTimeEquals(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(new Uint8Array(aBuf), new Uint8Array(bBuf));
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
