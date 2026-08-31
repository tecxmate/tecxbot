import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Issue a short-lived Deepgram temporary token so the browser can POST audio
// directly to Deepgram, bypassing the 4.5MB Vercel Function body limit.
//
// Uses POST /v1/auth/grant, which returns a JWT scoped to usage:write and needs
// only a Member-permission key — no keys:write / Administrator key. The token is
// used by the client as `Authorization: Bearer <token>` (not `Token`).
//
// Gated by TRANSCRIBE_SECRET (same secret as /api/transcribe): without it the
// endpoint fails closed. The caller passes the secret as ?key= or an
// Authorization: Bearer header.

export const config = { maxDuration: 15 };

// Deepgram's grant TTL defaults to 30s — far too short to upload a long meeting
// recording. Ask for the max (1 hour) so the upload finishes before it expires.
const TTL_SECONDS = 3600;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const masterKey = process.env.DEEPGRAM_API_KEY;
  if (!masterKey) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not configured' });

  try {
    const grantRes = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${masterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: TTL_SECONDS }),
    });
    if (!grantRes.ok) throw new Error(`Failed to grant token: ${grantRes.status} ${await grantRes.text()}`);
    const data = await grantRes.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Deepgram returned no access_token');
    return res.status(200).json({ token: data.access_token, scheme: 'Bearer', expiresAt: Date.now() + (data.expires_in ?? TTL_SECONDS) * 1000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token grant failed';
    console.error('[deepgram-token]', message);
    return res.status(500).json({ error: message });
  }
}

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.TRANSCRIBE_SECRET;
  if (!secret) return false; // fail closed: no secret set means the endpoint is disabled
  const auth = req.headers.authorization;
  const key = req.query.key;
  const fromQuery = Array.isArray(key) ? key[0] : key;
  const provided = (typeof fromQuery === 'string' && fromQuery.trim())
    ? fromQuery.trim()
    : (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined);
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
