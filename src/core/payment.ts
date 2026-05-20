import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TenantPlan } from './types.js';

export type CheckoutSession = {
  id: string;
  url?: string;
};

export type StripeWebhookEvent = {
  type: string;
  data?: { object?: Record<string, unknown> };
};

export function paidPlanFromEnv(): TenantPlan {
  return {
    id: 'paid',
    name: process.env.PAID_PLAN_NAME || 'Team',
    characterLimit: Number(process.env.PAID_CHARACTER_LIMIT || 100000),
    stripePriceId: process.env.STRIPE_PRICE_ID,
  };
}

export async function createStripeCheckoutSession(input: { tenantId: string; priceId: string; successUrl: string; cancelUrl: string }): Promise<CheckoutSession> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required');
  const params = new URLSearchParams({
    mode: 'subscription',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': '1',
    'metadata[tenantId]': input.tenantId,
    'subscription_data[metadata][tenantId]': input.tenantId,
    allow_promotion_codes: 'true',
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Stripe checkout failed: ${response.status} ${text}`);
  return JSON.parse(text) as CheckoutSession;
}

export function verifyStripeWebhook(rawBody: string, signatureHeader: string, endpointSecret: string) {
  const fields = Object.fromEntries(signatureHeader.split(',').map((part) => {
    const [key, value] = part.split('=');
    return [key, value];
  }));
  const timestamp = fields.t;
  const signature = fields.v1;
  if (!timestamp || !signature) return false;
  const expected = createHmac('sha256', endpointSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  const actual = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(new Uint8Array(actual), new Uint8Array(expectedBuffer));
}

export function getTenantIdFromStripeObject(object: Record<string, unknown>) {
  const metadata = object.metadata;
  if (metadata && typeof metadata === 'object' && 'tenantId' in metadata && typeof metadata.tenantId === 'string') return metadata.tenantId;
  return undefined;
}
