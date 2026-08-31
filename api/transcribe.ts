import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { transcribeWithDeepgram } from '../src/core/transcription.js';
import { saveNote } from '../src/core/noteStore.js';
import type { TranscriptLanguage } from '../src/core/types.js';

// Speech-to-text ingest, platform-agnostic. Record audio on a phone, hit Share,
// and an iOS/Android shortcut POSTs the file here; it transcribes with Deepgram,
// files the text into project memory (so Claude can tag and organize it later),
// and returns the transcript. No LINE required.
//
//   POST /api/transcribe            body: the audio bytes
//   auth: Authorization: Bearer <TRANSCRIBE_SECRET>   or   ?key=<TRANSCRIBE_SECRET>
//   query: language=auto|en|zh-TW (default auto), save=1 (default; 0 to skip),
//          title=, project=, milestone=, tags=a,b, participants=a,b
//   returns: { text, language, noteId }
//
// Raw audio must not be body-parsed, and it caps at Vercel's ~4.5 MB request
// limit — fine for typical voice memos; longer recordings would use the
// browser-direct upload flow (api/deepgram-token.ts).

export const config = { api: { bodyParser: false }, maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not configured' });

  const audio = await readRawBody(req);
  if (!audio.byteLength) return res.status(400).json({ error: 'Empty body — POST the audio bytes.' });

  const language = pickLanguage(firstQuery(req.query.language));
  const contentType = (typeof req.headers['content-type'] === 'string' && req.headers['content-type']) || 'audio/*';

  let transcript: string;
  try {
    const result = await transcribeWithDeepgram({ apiKey, audio: toArrayBuffer(audio), contentType, language });
    transcript = result.transcript;
  } catch (error) {
    console.error('[transcribe]', error);
    return res.status(502).json({ error: `Transcription failed: ${formatError(error)}` });
  }

  // Save into durable project memory unless explicitly skipped.
  let noteId: string | null = null;
  if (firstQuery(req.query.save) !== '0' && transcript.trim()) {
    try {
      const note = await saveNote({
        tenantId: process.env.CONNECTOR_TENANT_ID?.trim() || process.env.DEFAULT_TENANT_ID?.trim() || 'demo',
        title: firstQuery(req.query.title) || `Voice memo ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`,
        body: transcript,
        source: 'transcript',
        project: firstQuery(req.query.project),
        milestone: firstQuery(req.query.milestone),
        tags: splitList(firstQuery(req.query.tags)),
        participants: splitList(firstQuery(req.query.participants)),
        occurredAt: Date.now(),
      });
      noteId = note.id;
    } catch (error) {
      console.error('[transcribe] saved transcript but failed to file the note:', error);
    }
  }

  return res.status(200).json({ text: transcript, language, noteId });
}

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.TRANSCRIBE_SECRET;
  if (!secret) return false; // fail closed: no secret set means the endpoint is disabled
  const auth = req.headers.authorization;
  const provided = firstQuery(req.query.key)
    ?? (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined);
  return typeof provided === 'string' && constantTimeEquals(provided, secret);
}

function pickLanguage(value: string | undefined): TranscriptLanguage | 'auto' {
  const v = value?.trim().toLowerCase();
  if (v === 'en') return 'en';
  if (v === 'zh-tw' || v === 'zh' || v === 'zh_tw') return 'zh-TW';
  return 'auto';
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const out = value.split(',').map((item) => item.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  return Buffer.concat(chunks);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(new Uint8Array(aBuf), new Uint8Array(bBuf));
}

function firstQuery(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
