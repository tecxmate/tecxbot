// Media fetch + archival, shared by the connector tools and the archive cron.
//
// Durability model: captured media (image/file/audio) is archived to Cloudflare
// R2 by the archive job while LINE still holds it. Reads prefer R2 (permanent)
// and fall back to a live LINE fetch for anything not yet archived (recent).
// With no R2 configured, everything is live-LINE only — exactly the prior
// behavior.

import { listUnarchivedMedia, setMediaKey, type StoredMessage } from '../core/conversationStore.js';
import { getObject, isR2Configured, putObject } from '../core/r2.js';
import { getTenantChannelConfig } from '../core/tenantStore.js';
import { downloadLineMessageContent } from '../platforms/line/client.js';

export type FetchedMedia = { content: ArrayBuffer; contentType: string; source: 'r2' | 'line' };

/** Deterministic R2 key so a redelivered message maps to the same object. */
export function mediaObjectKey(message: StoredMessage) {
  return `${message.platform}/${message.channelId}/${message.externalMessageId}`;
}

/** Prefer the durable R2 copy; fall back to a live LINE fetch. */
export async function fetchMediaBytes(message: StoredMessage): Promise<FetchedMedia> {
  if (message.mediaKey && isR2Configured()) {
    const object = await getObject(message.mediaKey);
    if (object) return { content: object.body, contentType: object.contentType, source: 'r2' };
  }
  if (!message.externalMessageId) throw new Error('This message has no fetchable media id.');
  const token = channelToken(message.channelId);
  if (!token) throw new Error(`LINE channel "${message.channelId}" has no access token configured, so its media can't be fetched.`);
  const media = await downloadLineMessageContent(message.externalMessageId, token);
  return { content: media.content, contentType: media.contentType, source: 'line' };
}

export type ArchiveResult = { archived: number; skipped: number; errors: number; details: string[] };

/**
 * Archive not-yet-stored media to R2. Best-effort per message: a channel with no
 * token, an oversized file, or media LINE has already expired is skipped, and
 * the sweep moves on.
 */
export async function archivePendingMedia(opts: { sinceMs: number; limit: number; maxBytes: number }): Promise<ArchiveResult> {
  const pending = await listUnarchivedMedia({ sinceMs: opts.sinceMs, limit: opts.limit });
  let archived = 0;
  let skipped = 0;
  let errors = 0;
  const details: string[] = [];
  for (const message of pending) {
    const token = channelToken(message.channelId);
    if (!token || !message.externalMessageId) { skipped += 1; continue; }
    try {
      const media = await downloadLineMessageContent(message.externalMessageId, token);
      if (media.content.byteLength > opts.maxBytes) {
        skipped += 1;
        details.push(`${message.externalMessageId}: ${(media.content.byteLength / 1024 / 1024).toFixed(1)}MB over cap`);
        continue;
      }
      const key = mediaObjectKey(message);
      await putObject(key, new Uint8Array(media.content), media.contentType);
      await setMediaKey(message.id, key);
      archived += 1;
    } catch (error) {
      errors += 1;
      details.push(`${message.externalMessageId}: ${formatError(error)}`);
    }
  }
  return { archived, skipped, errors, details: details.slice(0, 20) };
}

function channelToken(channelId: string): string | undefined {
  try {
    return getTenantChannelConfig(channelId).line?.channelAccessToken || undefined;
  } catch {
    return undefined;
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
