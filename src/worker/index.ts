// Cloudflare Worker entry point.
//
// Two jobs: route HTTP to the api/ handlers through the adapter, and run the
// scheduled jobs that Vercel Cron used to fire. Static files in public/ are
// served by Workers Assets and never reach this code — the assets binding is
// checked first, so only unmatched paths arrive here.

import { runVercelHandler } from './adapter.js';
import { cronHandler, matchRoute } from './router.js';

/**
 * Which job each cron expression runs. Must agree with the `crons` list in
 * wrangler.toml — a mismatch means a trigger fires and does nothing, which is
 * the kind of failure nobody notices for a month, so the suite checks both.
 */
export const CRON_SCHEDULE: Record<string, string> = {
  // Every 15 minutes. LINE keeps media only briefly, and on Vercel Hobby a
  // once-a-day sweep was not enough — that is why a laptop was running launchd.
  '*/15 * * * *': 'archive-media',
  // Sunday 22:00 UTC.
  '0 22 * * 0': 'weekly-digest',
  // 23:00 UTC = 07:00 Taipei.
  '0 23 * * *': 'daily-brief',
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);
    if (!route) {
      return new Response(JSON.stringify({ error: `Not found: ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return runVercelHandler(route.handler, request, route.query ?? {});
  },

  async scheduled(controller: { cron: string }, _env: unknown, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    const job = CRON_SCHEDULE[controller.cron];
    if (!job) {
      console.error('[worker] no job mapped to cron', controller.cron);
      return;
    }
    ctx.waitUntil(runScheduledJob(job));
  },
};

/**
 * Invoke the cron dispatcher the same way an HTTP caller would.
 *
 * The secret is presented even though this call originates inside the Worker:
 * the handler's own auth stays the single gate, so there is no second code path
 * that can run a job without one. An unset CRON_SECRET is refused outright
 * rather than relying on the handler's dev fallback.
 */
export async function runScheduledJob(job: string): Promise<void> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error(`[worker] refusing to run ${job}: CRON_SECRET is not set`);
    return;
  }
  const request = new Request(`https://worker.internal/api/cron?job=${encodeURIComponent(job)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  });
  const response = await runVercelHandler(cronHandler, request);
  const body = await response.text();
  if (!response.ok) console.error(`[worker] ${job} failed: ${response.status} ${body}`);
  else console.log(`[worker] ${job}: ${body}`);
}
