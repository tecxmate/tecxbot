// Scheduled jobs — one function, dispatched by `?job=`.
//
//   GET /api/cron?job=line-reminders&secret=<CRON_SECRET>
//   GET /api/cron?job=ops-daily-report&secret=<CRON_SECRET>
//
// The historical `/api/line-reminders` and `/api/ops-daily-report` URLs are
// rewritten here by vercel.json, so an existing Vercel Cron entry, GitHub
// Action, or external scheduler keeps working unchanged.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildWatchlistBrief } from '../src/botSystems/mcpBrief.js';
import { buildDailyOpsReport } from '../src/ops/companyOps.js';
import { getOpsConfig } from '../src/ops/config.js';
import { listConversations, pruneOlderThan, storeBackend } from '../src/core/conversationStore.js';
import { listNotes, saveNote } from '../src/core/noteStore.js';
import { pushInternalNotice } from '../src/connector/reply.js';
import { archivePendingMedia } from '../src/connector/media.js';
import { isR2Configured } from '../src/core/r2.js';
import { getDueBriefReminders, markBriefReminderSent } from '../src/core/personalProfileStore.js';
import { resolveTenantChannel } from '../src/core/tenantStore.js';
import { sendFacebookUpdate } from '../src/platforms/facebook/client.js';
import { pushLineMessage } from '../src/platforms/line/client.js';

// The reminder sweep is the slow one; it sets the ceiling for all jobs.
export const config = { maxDuration: 300 };

// Exported so the docs-currency test can compare it against the job table in
// docs/tutorial.md — adding a job without documenting it fails the suite.
export const JOBS = ['line-reminders', 'ops-daily-report', 'connector-prune', 'archive-media', 'weekly-digest', 'daily-brief'] as const;
type Job = (typeof JOBS)[number];

const DEFAULT_RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;
// Media is only archived while LINE still holds it; look back a couple of days
// so a lagging schedule still catches recent media.
const ARCHIVE_WINDOW_MS = 2 * MS_PER_DAY;
const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const job = firstQueryValue(req.query.job) as Job | undefined;
  if (!job || !JOBS.includes(job)) {
    return res.status(400).json({ error: `Unknown job: ${job ?? '(missing)'}. Expected one of: ${JOBS.join(', ')}.` });
  }

  if (job === 'line-reminders') return runLineReminders(req, res);
  if (job === 'connector-prune') return runConnectorPrune(req, res);
  if (job === 'archive-media') return runArchiveMedia(req, res);
  if (job === 'weekly-digest') return runWeeklyDigest(req, res);
  if (job === 'daily-brief') return runDailyBrief(req, res);
  return runOpsDailyReport(req, res);
}

// Daily reminder brief — the push half of the reminder convention. Notes tagged
// "reminder" whose occurred_at is the due time, not yet tagged "done", get pushed
// once a morning to an internal LINE group.
//
// Fail-closed and quota-frugal by design:
//  - No CONNECTOR_BRIEF_CONVERSATION_ID → the job does nothing at all.
//  - Nothing due → no push, so a quiet week spends zero LINE quota.
//  - The push goes through pushInternalNotice, sharing the PM reply monthly cap
//    and its counter, so briefs can never overrun the budget unseen.
async function runDailyBrief(req: VercelRequest, res: VercelResponse) {
  const briefConversationId = process.env.CONNECTOR_BRIEF_CONVERSATION_ID?.trim();
  if (!briefConversationId) {
    return res.status(200).json({ ok: true, job: 'daily-brief', skipped: 'no CONNECTOR_BRIEF_CONVERSATION_ID configured (fail-closed: set it to an internal LINE group id to enable)' });
  }
  // Two different tenants, deliberately. Notes are saved under the note tenant
  // (same fallback chain save_note uses), but captured LINE conversations are
  // stored under the *channel's* tenant — so the push target must be looked up
  // the way the connector's own tools do (pinned tenant, or unfiltered), not
  // with the notes' 'demo' fallback, or it would never resolve.
  const noteTenantId = process.env.CONNECTOR_TENANT_ID?.trim() || process.env.DEFAULT_TENANT_ID?.trim() || 'demo';
  const conversationTenantId = process.env.CONNECTOR_TENANT_ID?.trim() || undefined;
  const now = Date.now();
  // Due = at or before the end of today (UTC). `?days=` looks further ahead.
  const lookaheadDays = Math.min(30, Math.max(0, Number(firstQueryValue(req.query.days)) || 0));
  const endOfToday = Math.floor(now / MS_PER_DAY) * MS_PER_DAY + MS_PER_DAY - 1 + lookaheadDays * MS_PER_DAY;
  const LIMIT = 200;

  try {
    const reminders = await listNotes({ tenantId: noteTenantId, tag: 'reminder', until: endOfToday, limit: LIMIT });
    // A reminder needs a real due date. occurred_at is optional on save_note, and
    // falling back to created_at would make every undated note due the moment it
    // is created — and "overdue" forever after, pushing every single day. That
    // would quietly spend ~30 LINE pushes a month and break the promise that a
    // quiet week costs zero quota.
    const due = reminders
      .filter((note) => !note.tags.includes('done') && note.occurredAt !== undefined && note.occurredAt <= endOfToday)
      .sort((a, b) => (a.occurredAt ?? a.createdAt) - (b.occurredAt ?? b.createdAt));

    if (!due.length) {
      // Silence is the feature: nothing due means nothing pushed and no quota spent.
      return res.status(200).json({ ok: true, job: 'daily-brief', due: 0, pushed: false, skipped: 'nothing due' });
    }

    const startOfToday = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const lines = due.map((note) => {
      const at = note.occurredAt ?? note.createdAt;
      const marker = at < startOfToday ? `⚠️ overdue ${day(at)}` : `due ${day(at)}`;
      return `• ${note.title}${note.project ? ` (${note.project})` : ''} — ${marker}`;
    });
    const text = [
      `🗓 Reminders — ${day(now)}`,
      '',
      ...lines,
      '',
      'Ask Claude to mark one done, or open it with get_note.',
    ].join('\n');

    // No silent caps: say so when the row limit may have hidden older reminders.
    const truncated = reminders.length >= LIMIT;
    const outcome = await pushInternalNotice({ conversationId: briefConversationId, text, tenantId: conversationTenantId });
    if (!outcome.ok) {
      // over_cap is an expected, benign outcome — report it rather than 500.
      return res.status(200).json({ ok: true, job: 'daily-brief', due: due.length, truncated, pushed: false, reason: outcome.reason, used: outcome.used, cap: outcome.cap });
    }
    return res.status(200).json({ ok: true, job: 'daily-brief', due: due.length, truncated, pushed: true, to: outcome.conversationId, at: outcome.at });
  } catch (error) {
    console.error('[cron:daily-brief] Failed:', error);
    return res.status(500).json({ ok: false, job: 'daily-brief', error: formatError(error) });
  }
}

// Weekly project digest — a mechanical index of the week, filed into project
// memory as a note (tagged "digest") so any connected Claude can pick it up and
// expand it. Deliberately LLM-free: it lists activity, it does not summarize.
// Also surfaces due reminders: notes tagged "reminder" whose occurred_at is the
// due time and that are not yet tagged "done".
async function runWeeklyDigest(req: VercelRequest, res: VercelResponse) {
  const tenantId = process.env.CONNECTOR_TENANT_ID?.trim() || process.env.DEFAULT_TENANT_ID?.trim() || 'demo';
  const days = Math.min(31, Math.max(1, Number(firstQueryValue(req.query.days)) || 7));
  const now = Date.now();
  const since = now - days * MS_PER_DAY;
  try {
    const [conversations, recentNotes, reminderNotes] = await Promise.all([
      listConversations({ tenantId, since, limit: 50 }),
      listNotes({ tenantId, since, limit: 100 }),
      // Bounded by due date so the row cap trims the least-overdue tail rather
      // than the most overdue head — same reasoning as the daily brief.
      listNotes({ tenantId, tag: 'reminder', until: now + 7 * MS_PER_DAY, limit: 200 }),
    ]);
    // New notes, minus earlier digests; reminders due within the coming week and not done.
    const notes = recentNotes.filter((note) => !note.tags.includes('digest'));
    // A reminder needs a real due date to count as due; an undated one is a
    // to-do without a deadline, and created_at would make it look due at birth.
    const remindersDue = reminderNotes
      .filter((note) => !note.tags.includes('done') && note.occurredAt !== undefined && note.occurredAt <= now + 7 * MS_PER_DAY)
      .sort((a, b) => (a.occurredAt ?? a.createdAt) - (b.occurredAt ?? b.createdAt));

    if (!conversations.length && !notes.length && !remindersDue.length) {
      return res.status(200).json({ ok: true, job: 'weekly-digest', skipped: 'nothing to report', windowDays: days });
    }

    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const sections = [`# Weekly digest — ${day(since)} → ${day(now)} (UTC)`, ''];
    sections.push(`## Active conversations (${conversations.length})`);
    sections.push(conversations.length
      ? conversations.map((c) => `- ${c.title ?? c.conversationId} — last ${day(c.lastMessageAt)}${c.messageCount ? ` · ${c.messageCount} msgs total` : ''}\n  id: ${c.conversationId}`).join('\n')
      : '- none');
    sections.push('', `## New notes (${notes.length})`);
    sections.push(notes.length
      ? notes.map((n) => `- ${n.title}${n.project ? ` · ${n.project}` : ''}${n.milestone ? ` / ${n.milestone}` : ''} — ${day(n.occurredAt ?? n.createdAt)}\n  id: ${n.id}`).join('\n')
      : '- none');
    sections.push('', `## Reminders due (${remindersDue.length})`);
    sections.push(remindersDue.length
      ? remindersDue.map((n) => `- due ${day(n.occurredAt ?? n.createdAt)} — ${n.title}\n  id: ${n.id} (add tag "done" to complete)`).join('\n')
      : '- none');
    sections.push('', 'Open any item with get_conversation / get_note. Ask Claude to expand this digest into a summary.');

    const note = await saveNote({
      tenantId,
      title: `Weekly digest — ${day(now)}`,
      body: sections.join('\n'),
      source: 'note',
      tags: ['digest'],
      occurredAt: now,
    });
    return res.status(200).json({ ok: true, job: 'weekly-digest', windowDays: days, conversations: conversations.length, notes: notes.length, remindersDue: remindersDue.length, noteId: note.id });
  } catch (error) {
    console.error('[cron:weekly-digest] Failed:', error);
    return res.status(500).json({ ok: false, job: 'weekly-digest', error: formatError(error) });
  }
}

async function runArchiveMedia(req: VercelRequest, res: VercelResponse) {
  if (!isR2Configured()) {
    return res.status(200).json({ ok: true, job: 'archive-media', skipped: 'R2 not configured (set R2_ACCOUNT_ID/R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)' });
  }
  if (storeBackend() !== 'postgres') {
    return res.status(200).json({ ok: true, job: 'archive-media', skipped: 'in-memory store: nothing durable to archive against' });
  }
  const limit = Math.min(100, Math.max(1, Number(firstQueryValue(req.query.limit)) || 25));
  try {
    const result = await archivePendingMedia({ sinceMs: Date.now() - ARCHIVE_WINDOW_MS, limit, maxBytes: ARCHIVE_MAX_BYTES });
    return res.status(200).json({ ok: true, job: 'archive-media', ...result });
  } catch (error) {
    console.error('[cron:archive-media] Failed:', error);
    return res.status(500).json({ ok: false, job: 'archive-media', error: formatError(error) });
  }
}

async function runConnectorPrune(req: VercelRequest, res: VercelResponse) {
  // `?days=` overrides CONNECTOR_RETENTION_DAYS for a one-off sweep; 0 disables.
  const days = resolveRetentionDays(firstQueryValue(req.query.days));
  if (days <= 0) {
    return res.status(200).json({ ok: true, job: 'connector-prune', skipped: 'retention disabled (set CONNECTOR_RETENTION_DAYS or ?days=)' });
  }
  if (storeBackend() !== 'postgres') {
    // The in-memory store is per-instance and already self-evicts, so there is
    // nothing durable to prune — say so rather than silently no-op.
    return res.status(200).json({ ok: true, job: 'connector-prune', skipped: 'in-memory store: nothing durable to prune', retentionDays: days });
  }
  try {
    const cutoff = Date.now() - days * MS_PER_DAY;
    const result = await pruneOlderThan(cutoff);
    return res.status(200).json({ ok: true, job: 'connector-prune', retentionDays: days, cutoff, ...result });
  } catch (error) {
    console.error('[cron:connector-prune] Failed:', error);
    return res.status(500).json({ ok: false, job: 'connector-prune', error: formatError(error) });
  }
}

function resolveRetentionDays(override: string | undefined): number {
  const raw = override ?? process.env.CONNECTOR_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(parsed);
}

async function runLineReminders(req: VercelRequest, res: VercelResponse) {
  const due = getDueBriefReminders({
    tenantId: firstQueryValue(req.query.tenant),
    channelId: firstQueryValue(req.query.channel),
    now: new Date(),
  });
  const results: Array<{ userId: string; reminderId: string; ok: boolean; error?: string }> = [];

  for (const item of due) {
    try {
      const runtime = resolveTenantChannel({ tenantId: item.profile.tenantId, channelId: item.profile.channelId });
      const botSystem = runtime.channel.botSystem.kind === 'mcp_agent' ? runtime.channel.botSystem : undefined;
      if (!botSystem) throw new Error('Channel is not configured as mcp_agent');
      const text = await buildWatchlistBrief({ config: botSystem, profile: item.profile, template: item.reminder.template });
      await pushLineMessage(item.profile.userId, { text }, runtime.channel.line?.channelAccessToken);
      markBriefReminderSent({
        tenantId: item.profile.tenantId,
        channelId: item.profile.channelId,
        platform: 'line',
        userId: item.profile.userId,
        reminderId: item.reminder.id,
        localDate: item.localDate,
      });
      results.push({ userId: item.profile.userId, reminderId: item.reminder.id, ok: true });
    } catch (error) {
      console.error('[cron:line-reminders] Failed:', error);
      results.push({ userId: item.profile.userId, reminderId: item.reminder.id, ok: false, error: formatError(error) });
    }
  }

  return res.status(200).json({ ok: true, job: 'line-reminders', due: due.length, results });
}

async function runOpsDailyReport(req: VercelRequest, res: VercelResponse) {
  try {
    const report = await buildDailyOpsReport();
    const opsConfig = getOpsConfig();
    const shouldSend = firstQueryValue(req.query.send) === 'true' || process.env.OPS_DAILY_REPORT_SEND === 'true';
    if (shouldSend && opsConfig.messengerSummaryRecipientId) {
      await sendFacebookUpdate(opsConfig.messengerSummaryRecipientId, report.text);
    }
    return res.status(200).json({
      ok: true,
      job: 'ops-daily-report',
      sent: Boolean(shouldSend && opsConfig.messengerSummaryRecipientId),
      linearIssueCount: report.linearIssues.length,
      githubIssueCount: report.githubIssues.length,
      googleTaskCount: report.googleTasks.length,
      report: report.text,
    });
  } catch (error) {
    console.error('[cron:ops-daily-report] Failed:', error);
    return res.status(500).json({ ok: false, job: 'ops-daily-report', error: formatError(error) });
  }
}

// With no CRON_SECRET set this stays open outside production and closes in it,
// so an unconfigured deployment cannot be triggered by anyone who finds the URL.
function isAuthorized(req: VercelRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return req.headers.authorization === `Bearer ${secret}` || firstQueryValue(req.query.secret) === secret;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
