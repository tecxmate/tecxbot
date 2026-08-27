// Meta webhook — Messenger and WhatsApp Business share this one endpoint.
//
// They are the same webhook protocol: `hub.challenge` verification on GET, an
// `X-Hub-Signature-256` HMAC on POST, and an `entry[]` envelope whose top-level
// `object` field names the product. Serving both from one function keeps the
// deployment under Vercel's Hobby function cap.
//
// The historical `/api/whatsapp-webhook` URL is rewritten here by vercel.json,
// so a callback URL already configured in the Meta dashboard keeps working.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleFacebookWebhook, type FacebookWebhookPayload } from '../src/platforms/facebook/webhook.js';
import { handleWhatsappWebhook, type WhatsappWebhookPayload } from '../src/platforms/whatsapp/webhook.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

type MetaProduct = 'messenger' | 'whatsapp';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return verifyWebhook(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await readRawBody(req);

  let payload: FacebookWebhookPayload | WhatsappWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as FacebookWebhookPayload | WhatsappWebhookPayload;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // The body is parsed before the signature is checked, because `object` is what
  // selects the signing secret. Nothing is acted on until verification passes.
  const product = resolveProduct(payload);
  const appSecret = resolveAppSecret(product);
  if (appSecret) {
    const signature = firstHeaderValue(req.headers['x-hub-signature-256']);
    if (!signature || !verifyMetaSignature(rawBody, signature, appSecret)) {
      return res.status(401).json({ error: 'Invalid Meta signature' });
    }
  } else if (!allowUnsigned()) {
    // Fail closed: an unsigned webhook that no secret can verify is rejected
    // rather than dispatched. Set META_ALLOW_UNSIGNED=true only for local
    // testing without a configured app secret.
    console.error(`[meta-webhook] Rejected ${product} webhook: no app secret configured. Set FB_APP_SECRET / WHATSAPP_APP_SECRET, or META_ALLOW_UNSIGNED=true for local testing.`);
    return res.status(401).json({ error: 'Webhook signature verification is not configured' });
  }

  try {
    if (product === 'whatsapp') {
      const captured = await handleWhatsappWebhook(payload as WhatsappWebhookPayload, firstQueryValue(req.query.channel));
      return res.status(200).json({ ok: true, product, captured });
    }
    const processed = await handleFacebookWebhook(payload as FacebookWebhookPayload);
    return res.status(200).json({ ok: true, product, processed });
  } catch (error) {
    console.error(`[meta-webhook] ${product} failed:`, error);
    // Meta retries non-2xx aggressively; acknowledge and keep the error in logs.
    return res.status(200).json({ ok: false, product, error: formatError(error) });
  }
}

function resolveProduct(payload: { object?: string }): MetaProduct {
  return payload.object === 'whatsapp_business_account' ? 'whatsapp' : 'messenger';
}

function allowUnsigned() {
  return process.env.META_ALLOW_UNSIGNED === 'true';
}

// One Meta app serving both products signs with a single secret, so WhatsApp
// falls back to the Messenger secret when no separate one is configured.
function resolveAppSecret(product: MetaProduct) {
  if (product === 'whatsapp') return process.env.WHATSAPP_APP_SECRET || process.env.FB_APP_SECRET || '';
  return process.env.FB_APP_SECRET || '';
}

function verifyWebhook(req: VercelRequest, res: VercelResponse) {
  const mode = firstQueryValue(req.query['hub.mode']);
  const token = firstQueryValue(req.query['hub.verify_token']);
  const challenge = firstQueryValue(req.query['hub.challenge']);
  // Either product's verify token is accepted: the GET carries no `object`, so
  // there is no way to tell which product is being subscribed.
  const accepted = [process.env.FB_VERIFY_TOKEN, process.env.WHATSAPP_VERIFY_TOKEN].filter((value): value is string => Boolean(value));
  if (mode === 'subscribe' && token && accepted.includes(token)) {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(challenge ?? '');
  }
  return res.status(403).json({ error: 'Meta webhook verification failed' });
}

function verifyMetaSignature(rawBody: string, signature: string, appSecret: string) {
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

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
