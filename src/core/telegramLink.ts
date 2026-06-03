import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, expiring token that ties a web upload back to a specific Telegram chat.
// The browser treats it as opaque; only the server signs and verifies it.

const DEFAULT_TTL_MS = 1000 * 60 * 60; // 1 hour to finish the upload

function secret() {
  const value = process.env.TELEGRAM_LINK_SECRET;
  if (!value) throw new Error('TELEGRAM_LINK_SECRET not configured');
  return value;
}

export function signChatToken(chatId: number | string, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const payload = `${chatId}.${now + ttlMs}`;
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyChatToken(token: string, now = Date.now()): string | undefined {
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return undefined;
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  const actual = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (actual.length !== want.length || !timingSafeEqual(new Uint8Array(actual), new Uint8Array(want))) return undefined;
  const [chatId, expStr] = payload.split('.');
  const exp = Number(expStr);
  if (!chatId || !Number.isFinite(exp) || now > exp) return undefined;
  return chatId;
}
