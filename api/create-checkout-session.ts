import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createStripeCheckoutSession, paidPlanFromEnv } from '../src/core/payment.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {};
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId : process.env.DEFAULT_TENANT_ID || 'demo';
  const priceId = typeof body.priceId === 'string' ? body.priceId : paidPlanFromEnv().stripePriceId;
  if (!priceId) return res.status(400).json({ error: 'STRIPE_PRICE_ID is required' });
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers.host}`;
  try {
    const session = await createStripeCheckoutSession({
      tenantId,
      priceId,
      successUrl: `${baseUrl}/?checkout=success`,
      cancelUrl: `${baseUrl}/?checkout=cancelled`,
    });
    return res.status(200).json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('[checkout] Failed:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
