// Durable, platform-agnostic project memory for the connector.
//
// The conversation log captures what was said on LINE/WhatsApp. This is the
// other half: notes and transcripts Claude curates — a meeting transcript, a
// decision, a spec summary — saved in the same Neon Postgres and tagged with
// date, participants, project, and milestone so the whole project stays
// organized and readable from any Claude client, not locked to any one chat
// platform.
//
// Like the conversation store it falls back to an in-memory map when no
// database is configured (fine for dev/tests; not durable).

import { isSqlConfigured, sql, sqlBatch } from './sql.js';

export type Note = {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  source: string; // 'transcript' | 'note' | 'line' | ...
  project?: string;
  milestone?: string;
  participants: string[];
  tags: string[];
  conversationId?: string; // optional link to a captured conversation
  occurredAt?: number; // when the meeting/recording happened (vs. when saved)
  createdAt: number;
  updatedAt: number;
};

export type SaveNoteInput = {
  tenantId: string;
  title: string;
  body: string;
  source?: string;
  project?: string;
  milestone?: string;
  participants?: string[];
  tags?: string[];
  conversationId?: string;
  occurredAt?: number;
};

export type UpdateNoteInput = {
  tenantId?: string;
  title?: string;
  body?: string;
  source?: string;
  project?: string;
  milestone?: string;
  participants?: string[];
  tags?: string[];
  conversationId?: string;
  occurredAt?: number;
  addTags?: string[];
  addParticipants?: string[];
};

export type ListNotesQuery = {
  tenantId?: string;
  project?: string;
  milestone?: string;
  tag?: string;
  participant?: string;
  since?: number;
  /**
   * Only notes at or before this time (by occurred_at, falling back to
   * created_at). Setting it also flips the ordering to OLDEST first — a
   * due-date query wants the most overdue items, and the row cap must trim the
   * least-overdue tail rather than the head.
   */
  until?: number;
  limit?: number;
};

export type SearchNotesQuery = { query: string; tenantId?: string; project?: string; limit?: number };

export function noteStoreBackend(): 'postgres' | 'memory' {
  return isSqlConfigured() ? 'postgres' : 'memory';
}

export function isNoteStoreDurable(): boolean {
  return isSqlConfigured();
}

// ---- public API ----

export async function saveNote(input: SaveNoteInput): Promise<Note> {
  const now = Date.now();
  const note: Note = {
    id: `note_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: input.tenantId,
    title: input.title.trim() || 'Untitled',
    body: input.body,
    source: input.source?.trim() || 'note',
    project: clean(input.project),
    milestone: clean(input.milestone),
    participants: dedupe(input.participants),
    tags: dedupe(input.tags),
    conversationId: clean(input.conversationId),
    occurredAt: input.occurredAt,
    createdAt: now,
    updatedAt: now,
  };
  if (isSqlConfigured()) await pgInsert(note);
  else memoryNotes.set(note.id, note);
  return note;
}

export async function getNote(id: string, tenantId?: string): Promise<Note | undefined> {
  if (isSqlConfigured()) {
    await ensureSchema();
    const rows = await sql<Record<string, unknown>>(`select * from connector_notes where id = $1`, [id]);
    const note = rows[0] ? toNote(rows[0]) : undefined;
    return note && (!tenantId || note.tenantId === tenantId) ? note : undefined;
  }
  const note = memoryNotes.get(id);
  return note && (!tenantId || note.tenantId === tenantId) ? note : undefined;
}

export async function updateNote(id: string, patch: UpdateNoteInput): Promise<Note | undefined> {
  const existing = await getNote(id, patch.tenantId);
  if (!existing) return undefined;
  const next: Note = {
    ...existing,
    title: patch.title !== undefined ? patch.title.trim() || existing.title : existing.title,
    body: patch.body !== undefined ? patch.body : existing.body,
    source: patch.source?.trim() || existing.source,
    project: patch.project !== undefined ? clean(patch.project) : existing.project,
    milestone: patch.milestone !== undefined ? clean(patch.milestone) : existing.milestone,
    conversationId: patch.conversationId !== undefined ? clean(patch.conversationId) : existing.conversationId,
    occurredAt: patch.occurredAt !== undefined ? patch.occurredAt : existing.occurredAt,
    participants: patch.participants !== undefined ? dedupe(patch.participants) : dedupe([...existing.participants, ...(patch.addParticipants ?? [])]),
    tags: patch.tags !== undefined ? dedupe(patch.tags) : dedupe([...existing.tags, ...(patch.addTags ?? [])]),
    updatedAt: Date.now(),
  };
  if (isSqlConfigured()) await pgUpdate(next);
  else memoryNotes.set(next.id, next);
  return next;
}

export async function listNotes(query: ListNotesQuery = {}): Promise<Note[]> {
  const limit = clamp(query.limit ?? 25, 1, 200);
  const candidates = await candidateNotes(query.tenantId, query.project, query.since, 500, query.until);
  return refine(candidates, query).slice(0, limit);
}

export async function searchNotes(query: SearchNotesQuery): Promise<Note[]> {
  const needle = query.query.trim().toLowerCase();
  if (!needle) return [];
  const limit = clamp(query.limit ?? 25, 1, 200);
  const candidates = await candidateNotes(query.tenantId, query.project, undefined, 1000);
  return candidates
    .filter((note) => `${note.title}\n${note.body}`.toLowerCase().includes(needle))
    .slice(0, limit);
}

// ---- shared filtering ----

async function candidateNotes(tenantId: string | undefined, project: string | undefined, since: number | undefined, cap: number, until?: number): Promise<Note[]> {
  // A bounded `until` query is a due-date lookup: order oldest-first so the row
  // cap drops the least-overdue notes instead of the most overdue ones.
  const oldestFirst = until !== undefined;
  if (isSqlConfigured()) {
    await ensureSchema();
    const where: string[] = [];
    const params: unknown[] = [];
    if (tenantId) { params.push(tenantId); where.push(`tenant_id = $${params.length}`); }
    if (project) { params.push(project); where.push(`project = $${params.length}`); }
    if (since !== undefined) { params.push(since); where.push(`coalesce(occurred_at, created_at) >= $${params.length}`); }
    if (until !== undefined) { params.push(until); where.push(`coalesce(occurred_at, created_at) <= $${params.length}`); }
    params.push(cap);
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const rows = await sql<Record<string, unknown>>(
      `select * from connector_notes ${clause} order by coalesce(occurred_at, created_at) ${oldestFirst ? 'asc' : 'desc'} limit $${params.length}`,
      params,
    );
    return rows.map(toNote);
  }
  return [...memoryNotes.values()]
    .filter((note) => (!tenantId || note.tenantId === tenantId)
      && (!project || note.project === project)
      && (since === undefined || (note.occurredAt ?? note.createdAt) >= since)
      && (until === undefined || (note.occurredAt ?? note.createdAt) <= until))
    .sort((a, b) => oldestFirst
      ? (a.occurredAt ?? a.createdAt) - (b.occurredAt ?? b.createdAt)
      : (b.occurredAt ?? b.createdAt) - (a.occurredAt ?? a.createdAt))
    .slice(0, cap);
}

function refine(notes: Note[], query: ListNotesQuery): Note[] {
  const tag = query.tag?.trim().toLowerCase();
  const participant = query.participant?.trim().toLowerCase();
  const milestone = query.milestone?.trim().toLowerCase();
  return notes.filter((note) =>
    (!milestone || (note.milestone ?? '').toLowerCase() === milestone) &&
    (!tag || note.tags.some((t) => t.toLowerCase() === tag)) &&
    (!participant || note.participants.some((p) => p.toLowerCase().includes(participant))));
}

// ---- postgres ----

let schemaPromise: Promise<void> | undefined;

function ensureSchema() {
  schemaPromise ??= sqlBatch([
    {
      query: `create table if not exists connector_notes (
        id text primary key,
        tenant_id text not null,
        title text not null,
        body text not null,
        source text not null default 'note',
        project text,
        milestone text,
        participants_json text not null default '[]',
        tags_json text not null default '[]',
        conversation_id text,
        occurred_at bigint,
        created_at bigint not null,
        updated_at bigint not null
      )`,
    },
    { query: `create index if not exists connector_notes_recent_idx on connector_notes (tenant_id, coalesce(occurred_at, created_at) desc)` },
    { query: `create index if not exists connector_notes_project_idx on connector_notes (tenant_id, project)` },
  ]).catch((error) => {
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

async function pgInsert(note: Note): Promise<void> {
  await ensureSchema();
  await sql(
    `insert into connector_notes
      (id, tenant_id, title, body, source, project, milestone, participants_json, tags_json, conversation_id, occurred_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [note.id, note.tenantId, note.title, note.body, note.source, note.project ?? null, note.milestone ?? null,
      JSON.stringify(note.participants), JSON.stringify(note.tags), note.conversationId ?? null, note.occurredAt ?? null, note.createdAt, note.updatedAt],
  );
}

async function pgUpdate(note: Note): Promise<void> {
  await ensureSchema();
  await sql(
    `update connector_notes set title=$2, body=$3, source=$4, project=$5, milestone=$6, participants_json=$7, tags_json=$8, conversation_id=$9, occurred_at=$10, updated_at=$11 where id=$1`,
    [note.id, note.title, note.body, note.source, note.project ?? null, note.milestone ?? null,
      JSON.stringify(note.participants), JSON.stringify(note.tags), note.conversationId ?? null, note.occurredAt ?? null, note.updatedAt],
  );
}

function toNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    source: String(row.source ?? 'note'),
    project: row.project ? String(row.project) : undefined,
    milestone: row.milestone ? String(row.milestone) : undefined,
    participants: parseJsonArray(row.participants_json),
    tags: parseJsonArray(row.tags_json),
    conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
    occurredAt: row.occurred_at != null ? Number(row.occurred_at) : undefined,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ---- memory ----

const memoryNotes = new Map<string, Note>();

// ---- helpers ----

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function dedupe(values?: string[]): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const v = value.trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
