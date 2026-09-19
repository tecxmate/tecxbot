// Path → handler, mirroring what vercel.json did.
//
// Vercel routed by filename in api/ and rewrote a handful of friendly paths
// onto the cron dispatcher. Workers have no file routing, so both halves are
// spelled out here: every api/ module gets its own path, and the rewrites
// re-appear as routes that pin a `job` parameter.
//
// The smoke suite checks this table against the files in api/ in both
// directions, so a new endpoint that is not routed here fails the build rather
// than 404ing in production.

import type { VercelLikeHandler } from './adapter.js';

import cron from '../../api/cron.js';
import deepgramToken from '../../api/deepgram-token.js';
import exportMemory from '../../api/export.js';
import facebookWebhook from '../../api/facebook-webhook.js';
import lineWebhook from '../../api/line-webhook.js';
import mcp from '../../api/mcp.js';
import tecxmatePush from '../../api/tecxmate-push.js';
import telegramDeliver from '../../api/telegram-deliver.js';
import telegramWebhook from '../../api/telegram-webhook.js';
import transcribe from '../../api/transcribe.js';

export type Route = {
  /** The api/ module this path runs, by basename — what the docs test compares. */
  endpoint: string;
  handler: VercelLikeHandler;
  /** Query pinned by the route itself, for the cron rewrites. */
  query?: Record<string, string>;
};

/** Cron jobs reachable by their own path, exactly as vercel.json rewrote them. */
const CRON_ROUTES: Record<string, string> = {
  '/api/line-reminders': 'line-reminders',
  '/api/ops-daily-report': 'ops-daily-report',
  '/api/archive-media': 'archive-media',
  '/api/weekly-digest': 'weekly-digest',
  '/api/daily-brief': 'daily-brief',
};

export const ROUTES: Record<string, Route> = {
  '/api/cron': { endpoint: 'cron', handler: cron as VercelLikeHandler },
  '/api/deepgram-token': { endpoint: 'deepgram-token', handler: deepgramToken as VercelLikeHandler },
  '/api/export': { endpoint: 'export', handler: exportMemory as VercelLikeHandler },
  '/api/facebook-webhook': { endpoint: 'facebook-webhook', handler: facebookWebhook as VercelLikeHandler },
  // Meta delivers WhatsApp on the same webhook shape as Messenger; this alias
  // existed on Vercel and stays so the configured callback URL keeps working.
  '/api/whatsapp-webhook': { endpoint: 'facebook-webhook', handler: facebookWebhook as VercelLikeHandler },
  '/api/line-webhook': { endpoint: 'line-webhook', handler: lineWebhook as VercelLikeHandler },
  '/api/mcp': { endpoint: 'mcp', handler: mcp as VercelLikeHandler },
  '/api/tecxmate-push': { endpoint: 'tecxmate-push', handler: tecxmatePush as VercelLikeHandler },
  '/api/telegram-deliver': { endpoint: 'telegram-deliver', handler: telegramDeliver as VercelLikeHandler },
  '/api/telegram-webhook': { endpoint: 'telegram-webhook', handler: telegramWebhook as VercelLikeHandler },
  '/api/transcribe': { endpoint: 'transcribe', handler: transcribe as VercelLikeHandler },
  ...Object.fromEntries(Object.entries(CRON_ROUTES).map(([path, job]) => [
    path,
    { endpoint: 'cron', handler: cron as VercelLikeHandler, query: { job } },
  ])),
};

/** The cron handler, for the scheduled() entry point. */
export const cronHandler = cron as VercelLikeHandler;

/**
 * Match a pathname to a route. Trailing slashes are tolerated because LINE and
 * Meta both let you paste a callback URL by hand, and a stray slash turning
 * capture off silently is not a failure worth having.
 */
export function matchRoute(pathname: string): Route | undefined {
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return ROUTES[normalized];
}
