// WhatsApp Business (Meta Cloud API) webhook.
//
// Configure in the Meta app dashboard:
//   Callback URL   https://your-domain.vercel.app/api/whatsapp-webhook
//   Verify token   WHATSAPP_VERIFY_TOKEN
//   Webhook fields messages  (optionally message_echoes, to also capture
//                            replies the operator sends from the WhatsApp app)

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listWhatsappChannels } from '../src/core/tenantStore.js';
import { handleWhatsappWebhook, type WhatsappWebhookPayload } from '../src/platforms/whatsapp/webhook.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const channelId = firstQueryValue(req.query.channel);

  if (req.method === 'GET') return verifySubscription(req, res, channelId);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await readRawBody(req);
  const appSecret = resolveAppSecret(channelId);
  if (appSecret) {
    const signature = firstHeaderValue(req.headers['x-hub-signature-256']);
    if (!signature || !verifySignature(rawBody, signature, appSecret)) {
      return res.status(401).json({ error: 'Invalid WhatsApp signature' });
    }
  }

  let payload: WhatsappWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsappWebhookPayload;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  try {
    const captured = await handleWhatsappWebhook(payload, channelId);
    return res.status(200).json({ ok: true, captured });
  } catch (error) {
    console.error('[whatsapp-webhook] Failed:', error);
    // Meta retries non-2xx aggressively; acknowledge and keep the error in logs.
    return res.status(200).json({ ok: false, error: formatError(error) });
  }
}

function verifySubscription(req: VercelRequest, res: VercelResponse, channelId?: string) {
  const mode = firstQueryValue(req.query['hub.mode']);
  const token = firstQueryValue(req.query['hub.verify_token']);
  const challenge = firstQueryValue(req.query['hub.challenge']);
  const expected = resolveVerifyToken(channelId);
  if (!expected) return res.status(503).json({ error: 'WhatsApp is not configured: set WHATSAPP_VERIFY_TOKEN.' });
  if (mode !== 'subscribe' || token !== expected) return res.status(403).json({ error: 'Verification failed' });
  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send(challenge ?? '');
}

function verifySignature(rawBody: string, signature: string, appSecret: string) {
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const actual = Buffer.from(signature.replace(/^sha256=/i, ''), 'hex');
  return expected.length === actual.length && timingSafeEqual(new Uint8Array(expected), new Uint8Array(actual));
}

function resolveAppSecret(channelId?: string) {
  return resolveChannel(channelId)?.whatsapp?.appSecret || process.env.WHATSAPP_APP_SECRET || '';
}

function resolveVerifyToken(channelId?: string) {
  return resolveChannel(channelId)?.whatsapp?.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || '';
}

// The verification GET and the signature check happen before the payload is
// parsed, so there is no phone_number_id to route on yet — fall back to the
// single configured channel.
function resolveChannel(channelId?: string) {
  const channels = listWhatsappChannels();
  if (channelId) return channels.find((channel) => channel.id === channelId);
  return channels[0];
}

async function readRawBody(req: VercelRequest) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
