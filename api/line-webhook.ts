import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleLineWebhook, type LineWebhookPayload } from '../src/platforms/line/webhook.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rawBody = await readRawBody(req);
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const signature = req.headers['x-line-signature'];
  if (channelSecret) {
    if (!signature || Array.isArray(signature) || !verifyLineSignature(rawBody, signature, channelSecret)) return res.status(401).json({ error: 'Invalid LINE signature' });
  }
  let payload: LineWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LineWebhookPayload;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  try {
    const processed = await handleLineWebhook(payload);
    return res.status(200).json({ ok: true, processed });
  } catch (error) {
    console.error('[line-webhook] Failed:', error);
    return res.status(200).json({ ok: false, error: formatError(error) });
  }
}

function verifyLineSignature(rawBody: string, signature: string, secret: string) {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'base64');
  return expected.length === actual.length && timingSafeEqual(new Uint8Array(expected), new Uint8Array(actual));
}

async function readRawBody(req: VercelRequest) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
