import type { VercelRequest, VercelResponse } from '@vercel/node';

// Mint a short-lived Deepgram API key so the browser can POST audio
// directly to Deepgram, bypassing the 4.5MB Vercel Function body limit.
// The minted key has scope `usage:write` only and expires after 10 minutes.

export const config = { maxDuration: 15 };

const TTL_SECONDS = 600;

// Cache project ID for the lifetime of the function instance to skip a roundtrip.
let cachedProjectId: string | null = null;

async function getProjectId(masterKey: string): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const res = await fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${masterKey}` },
  });
  if (!res.ok) throw new Error(`Failed to list Deepgram projects: ${res.status} ${await res.text()}`);
  const data = await res.json() as { projects?: Array<{ project_id: string }> };
  const id = data.projects?.[0]?.project_id;
  if (!id) throw new Error('No Deepgram projects available for this account');
  cachedProjectId = id;
  return id;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const masterKey = process.env.DEEPGRAM_API_KEY;
  if (!masterKey) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not configured' });

  try {
    const projectId = await getProjectId(masterKey);
    const keyRes = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
      method: 'POST',
      headers: { Authorization: `Token ${masterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'telegram-browser-transcription', scopes: ['usage:write'], time_to_live_in_seconds: TTL_SECONDS }),
    });
    if (!keyRes.ok) throw new Error(`Failed to mint key: ${keyRes.status} ${await keyRes.text()}`);
    const data = await keyRes.json() as { key: string };
    return res.status(200).json({ key: data.key, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token mint failed';
    console.error('[deepgram-token]', message);
    return res.status(500).json({ error: message });
  }
}
