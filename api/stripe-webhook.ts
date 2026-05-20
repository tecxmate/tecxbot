import type { VercelRequest, VercelResponse } from '@vercel/node';
import { activatePaidPlan } from '../src/core/usageStore.js';
import { getTenantIdFromStripeObject, paidPlanFromEnv, verifyStripeWebhook, type StripeWebhookEvent } from '../src/core/payment.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rawBody = await readRawBody(req);
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers['stripe-signature'];
  if (endpointSecret) {
    if (!signature || Array.isArray(signature) || !verifyStripeWebhook(rawBody, signature, endpointSecret)) return res.status(400).json({ error: 'Invalid Stripe signature' });
  }
  const event = JSON.parse(rawBody) as StripeWebhookEvent;
  const object = event.data?.object;
  if (object && (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated')) {
    const tenantId = getTenantIdFromStripeObject(object);
    if (tenantId) {
      activatePaidPlan({
        tenantId,
        plan: paidPlanFromEnv(),
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : undefined,
        stripeSubscriptionId: typeof object.subscription === 'string' ? object.subscription : typeof object.id === 'string' ? object.id : undefined,
      });
    }
  }
  return res.status(200).json({ received: true });
}

async function readRawBody(req: VercelRequest) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
