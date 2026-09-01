# Deployment status & remaining setup

Handoff note for a local agent (or human) working in this repo. It records what
is **live**, what is **built but dormant**, and the **remaining setup** — with
exact steps. No secrets are in this file; production secrets live in Vercel and
local secrets in an untracked `.env`.

_Current as of the daily reminder brief. Update this note as things change._

## The shape of the system

Five layers, so it's clear where a new feature belongs:

| Layer | What it is | Where |
| --- | --- | --- |
| **Capture** | LINE/WhatsApp messages, voice memos, shared text | `api/line-webhook.ts`, `api/transcribe.ts` |
| **Memory** | Conversation log + durable project-memory notes | `src/core/conversationStore.ts`, `src/core/noteStore.ts` |
| **Heartbeat** | Weekly digest, daily reminder brief | `api/cron.ts` (`?job=`) |
| **Brain** | Claude, over MCP | `api/mcp.ts`, `src/connector/` |
| **Tasks** | Jira (external, via Claude's own connector) | — |

tecxbot is deliberately **not** a task tracker and **not** an LLM host: Jira owns
tasks, and the reasoning happens in the operator's own Claude.

## Live and verified

- **Claude connector** at `https://tecxbot.vercel.app/api/mcp` (MCP over HTTP),
  connected to the operator's Claude app. `src/connector/`, `api/mcp.ts`.
- **Capture → durable storage.** LINE messages captured to Postgres (Neon).
  `connector_status` confirmed `storage: postgres (durable)`, capture on.
- **Exec / review group** ("tecx-boss", internal):
  `line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0`.
- **Client group** ("Richard & Brian"):
  `line:tecxmate:group:C4d841fdb4f2ab45254fa8c77a5dfcc60`. The one CLAUDE.md's
  client-context section targets. Distinct from the exec group, so review-mode
  drafts stay out of it.
- **LINE `tecxmate` channel** webhook is set to
  `…/api/line-webhook?channel=tecxmate`, the account's **Chat toggle is OFF**
  (required — with Chat on, a LINE OA auto-leaves groups), and the bot is
  **capture-only** (`TECXMATE_CAPTURE_ONLY` defaults true): it never posts.
- **12 connector tools** — read: `latest_context`, `list_conversations`,
  `get_conversation`, `search_messages`, `get_image`, `get_file`,
  `connector_status`, `list_notes`, `search_notes`, `get_note`; write:
  `save_note`, `update_note`. (`send_line_reply` appears only when enabled — §4.)
- **9 serverless functions** — comfortably under the Hobby cap of 12. Stripe,
  stock-chart, and the marketing landing page were removed; `/` serves a minimal
  holding page.

### Production env already set (in Vercel, not in the repo)
- `CONNECTOR_TOKEN` — gates `/api/mcp` (fails closed without it).
- `CONNECTOR_DATABASE_URL` — Neon Postgres. **Everything durable depends on
  this**: conversations, notes, transcripts, digests. Without it the stores fall
  back to per-instance memory that vanishes.
- `TECXMATE_LINE_CHANNEL_ACCESS_TOKEN` / `_SECRET` — the client bot channel.
- `DEEPGRAM_API_KEY` — see the caveat in §1.

## Built but dormant (no action taken until configured)

Everything here is merged, tested, and inert until its env var exists.

| Feature | Gate | Effect while unset |
| --- | --- | --- |
| Speech-to-text (§1) | `TRANSCRIBE_SECRET` | `/api/transcribe` + `/transcribe.html` refuse every request |
| Durable media on R2 (§2) | four `R2_*` vars | `get_image`/`get_file` fetch **live from LINE** (recent only) |
| Daily reminder brief (§3) | `CONNECTOR_BRIEF_CONVERSATION_ID` | the cron job does nothing |
| TECXMATE PM reply (§4) | `CONNECTOR_ALLOW_REPLY=true` | `send_line_reply` is neither advertised nor callable |
| Claude-in-LINE (§5) | `ANTHROPIC_API_KEY` + `CLAUDE_ASSISTANT_*` | bot mode not enabled on any channel |

## Remaining setup

### 1. Speech-to-text — blocked on a Deepgram key with the right role
Two endpoints, both gated by `TRANSCRIBE_SECRET`: `POST /api/transcribe` (short
audio, or JSON `{text}` to file a note) and `/transcribe.html` (the browser
upload page for **long** recordings, which streams straight to Deepgram and so
has no size limit). See `docs/transcribe.md`.

> **Known blocker.** `DEEPGRAM_API_KEY` must be a key with at least the
> **Member** role. A *scope-restricted* key (`usage:write` only) transcribes but
> cannot mint the temporary token the browser upload needs — `/v1/auth/grant`
> returns `403 FORBIDDEN "Insufficient permissions"`. Create a Member-role key in
> the Deepgram console and replace the value, then redeploy.

Also set `TRANSCRIBE_SECRET` (`openssl rand -hex 32`).

### 2. Durable media on Cloudflare R2
Code is complete end to end — archive (`archivePendingMedia` → `putObject` →
`setMediaKey`) and read (`fetchMediaBytes` prefers R2, falls back to live LINE).
Nothing to build; it needs only credentials.

Set in Production, from Cloudflare → R2 → *Manage API Tokens* (Object Read &
Write on one bucket):
`R2_ACCOUNT_ID` (or `R2_ENDPOINT`), `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`.

**Verify rather than assume** — an earlier revision of this note claimed both
"dormant" and "done". The single source of truth is `connector_status`, which
reports `media archival: on (Cloudflare R2)` or `off`. A one-off sweep:
`GET /api/cron?job=archive-media&secret=<CRON_SECRET>` → `{archived, skipped, errors}`.

Scheduling, once configured — two drivers, both wanted:
- **Vercel Cron** (`vercel.json`, `0 3 * * *`). Hobby allows one run/day, so it
  is a backstop, not the main driver.
- **The always-on machine**, every 15 minutes via launchd — what actually keeps
  media fresh. See `scripts/archive-media-tick.sh` and
  `scripts/com.tecxmate.archive-media.plist`.

Why both: LINE holds media only briefly, so a daily sweep misses things; but a
local scheduler is one machine that can go down. The job is idempotent, so
overlapping runs are harmless. Only media LINE still holds can be archived —
this protects *future* media, not the back catalogue. Files over 25 MB are
skipped; video is intentionally not archived.

### 3. (Optional) Daily reminder brief
Pushes reminders that are due or overdue to an internal LINE group each morning
(23:00 UTC = 07:00 Taipei). Set
`CONNECTOR_BRIEF_CONVERSATION_ID=line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0`.

It is fail-closed, pushes **only when something is due** (a quiet week costs zero
quota), and shares `CONNECTOR_REPLY_MONTHLY_CAP` with the PM reply so it cannot
overrun the LINE budget. Independent of `CONNECTOR_ALLOW_REPLY`. A reminder needs
an explicit `occurred_at` (due date) to be pushed. See `docs/claude-connector.md`.

### 4. (Optional) Turn on the TECXMATE PM reply
Let Claude on your own plan answer as the PM — no API key. **Default is
draft-in-chat** (Claude proposes the reply in the Claude chat, you send it — zero
LINE quota); the steps below add the optional push tiers. In **review mode**,
pushes go to the exec group for approval; the client is never written to
automatically.
1. Both groups are already captured (ids above).
2. In Vercel: `CONNECTOR_ALLOW_REPLY=true`,
   `CONNECTOR_REVIEW_CONVERSATION_ID=line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0`,
   and `CONNECTOR_REPLY_MONTHLY_CAP` a bit under the LINE free tier (200/month,
   so e.g. 180). Redeploy. (For direct-to-client instead, leave the review var
   unset and set
   `CONNECTOR_REPLY_CONVERSATION_IDS=line:tecxmate:group:C4d841fdb4f2ab45254fa8c77a5dfcc60`.)
3. In Claude Desktop / Claude Code, connect **both** the tecxbot connector and the
   **Jira (Atlassian)** connector, then reconnect tecxbot so `send_line_reply`
   appears.
4. Give Claude the PM prompt and run it. Full walkthrough: `docs/tecxmate-pm.md`.
   Note: project tracking is **Jira** now, not Linear.

### 5. (Optional) Enable Claude-in-LINE
Set `ANTHROPIC_API_KEY` and the `CLAUDE_ASSISTANT_*` vars, point a channel at
`?channel=claude-assistant`. Defaults to 1:1-only
(`CLAUDE_ASSISTANT_ALLOW_GROUPS=false`) so it never posts in the client group
unless you opt in. See `docs/claude-connector.md` §9.

### 6. Housekeeping
- **`CRON_SECRET`** must be set, or the cron jobs refuse to run in production
  (they fail closed). All three jobs need it.
- **Reconnect the Claude connector** after any deploy that adds tools — MCP
  clients cache the tool list at connect time, so new tools stay invisible until
  you disconnect and reconnect.
- **LINE account cleanup:** *Auto-response messages → OFF* (LINE OA Manager →
  Response settings); it fires canned replies that are not from this bot. Several
  similarly named accounts exist (`Tecxbot`, `TECXMATE`, a stray `Tecxmate`) —
  only **TECXMATE (@234wrzwi)** should be in client groups.
- **`bot.tecxmate.com` returns a Vercel 404** — a custom-domain mapping issue,
  not code. The deployment is reachable at `tecxbot.vercel.app`. Diagnose with
  `vercel domains inspect bot.tecxmate.com`.

## Conventions that make the memory usable

Baked into the connector's own instructions, so every teammate's Claude follows
them (see `docs/claude-connector.md`):

- **Decisions** → note tagged `decision`.
- **Reminders** → note tagged `reminder` with `occurred_at` = the **due** time;
  complete by adding tag `done`.
- **Living brief** → one note per project titled `<project> — brief`, updated in
  place.
- **Jira** → tag notes with the issue key (e.g. `TECX-42`).
- **Digests** → the weekly job files an index tagged `digest`.

## Working in the repo

- `npm run build` — typecheck. `npm test` — the connector smoke suite (in-memory,
  no DB/network/creds needed). Both run in CI on every push/PR.
- For local dev, copy `.env.example` → `.env` and fill what you need. Postgres,
  R2, Deepgram and the reply path all fall back gracefully when unset.
- Full reference: `docs/claude-connector.md`. Schema: `docs/connector-schema.sql`.
  Speech-to-text: `docs/transcribe.md`. PM role: `docs/tecxmate-pm.md`.
