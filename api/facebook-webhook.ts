import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleFacebookWebhook, type FacebookWebhookPayload } from '../src/platforms/facebook/webhook.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return verifyWebhook(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await readRawBody(req);
  const appSecret = process.env.FB_APP_SECRET;
  const signature = req.headers['x-hub-signature-256'];
  if (appSecret) {
    if (!signature || Array.isArray(signature) || !verifyFacebookSignature(rawBody, signature, appSecret)) {
      return res.status(401).json({ error: 'Invalid Facebook signature' });
    }
  }

  let payload: FacebookWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as FacebookWebhookPayload;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  try {
    const processed = await handleFacebookWebhook(payload);
    return res.status(200).json({ ok: true, processed });
  } catch (error) {
    console.error('[facebook-webhook] Failed:', error);
    return res.status(200).json({ ok: false, error: formatError(error) });
  }
}

function verifyWebhook(req: VercelRequest, res: VercelResponse) {
  const mode = firstQueryValue(req.query['hub.mode']);
  const token = firstQueryValue(req.query['hub.verify_token']);
  const challenge = firstQueryValue(req.query['hub.challenge']);
  if (mode === 'subscribe' && token && token === process.env.FB_VERIFY_TOKEN) return res.status(200).send(challenge ?? '');
  return res.status(403).json({ error: 'Facebook webhook verification failed' });
}

function verifyFacebookSignature(rawBody: string, signature: string, appSecret: string) {
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(new Uint8Array(expectedBytes), new Uint8Array(actualBytes));
}

async function readRawBody(req: VercelRequest) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
