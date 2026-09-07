# Deployment status & remaining setup

Handoff note for a local agent (or human) working in this repo. It records what
is **live**, what is **built but dormant**, and the **remaining setup** — with
exact steps. No secrets are in this file; production secrets live in Vercel and
local secrets in an untracked `.env`.

_Verified against `connector_status` on 2026-09-07._

> **Check `connector_status` before trusting this file.** It reports the
> readiness of every subsystem as booleans, from the deployment that is actually
> serving traffic; this note is a human summary that has drifted before. Where
> the two disagree, the tool is right.

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
- **13 connector tools** — read: `latest_context`, `list_conversations`,
  `get_conversation`, `search_messages`, `get_image`, `get_file`,
  `connector_status`, `list_notes`, `search_notes`, `get_note`,
  `project_status`; write: `save_note`, `update_note`. (`send_line_reply`
  appears only when enabled — "Remaining setup" §2.)
- **10 serverless functions** — comfortably under the Hobby cap of 12. Stripe,
  stock-chart, and the marketing landing page were removed; `/` serves a minimal
  holding page.
- **`GET /api/export`** — dumps project memory and captured conversations as
  markdown or JSON, gated by the same `CONNECTOR_TOKEN`. Nothing extra to
  configure; it works wherever the connector already does. The escape hatch that
  keeps the memory from being locked to this deployment — see
  `docs/claude-connector.md` §13.
- **Speech-to-text.** `DEEPGRAM_API_KEY` (Member role) and `TRANSCRIBE_SECRET`
  are both set; `POST /api/deepgram-token` returns a grant, so `/transcribe.html`
  can upload recordings of any length. See "Operating notes" below.
- **Durable media on Cloudflare R2.** All four `R2_*` vars are set;
  `connector_status` reports `media archival: on (Cloudflare R2)`. Media is
  archived out of LINE rather than served live.

### Production env already set (in Vercel, not in the repo)
- `CONNECTOR_TOKEN` — gates `/api/mcp` (fails closed without it).
- `CONNECTOR_DATABASE_URL` — Neon Postgres. **Everything durable depends on
  this**: conversations, notes, transcripts, digests. Without it the stores fall
  back to per-instance memory that vanishes.
- `TECXMATE_LINE_CHANNEL_ACCESS_TOKEN` / `_SECRET` — the client bot channel.
- `DEEPGRAM_API_KEY` — must be **Member** role; see "Operating notes".
- `TRANSCRIBE_SECRET` — gates `/api/transcribe` and `/api/deepgram-token`.
- `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- `CRON_SECRET` — without it every scheduled job refuses to run.

## Built but dormant (no action taken until configured)

Everything here is merged, tested, and inert until its env var exists.

| Feature | Gate | Effect while unset |
| --- | --- | --- |
| Daily reminder brief (§1) | `CONNECTOR_BRIEF_CONVERSATION_ID` | the cron job does nothing |
| TECXMATE PM reply (§2) | `CONNECTOR_ALLOW_REPLY=true` | `send_line_reply` is neither advertised nor callable |
| Claude-in-LINE (§3) | `ANTHROPIC_API_KEY` + `CLAUDE_ASSISTANT_*` | bot mode not enabled on any channel |

## Operating notes for what is live

Things that are configured and working, but whose failure modes are not obvious
from the code.

### Speech-to-text — the Deepgram key needs the Member role
Two endpoints, both gated by `TRANSCRIBE_SECRET`: `POST /api/transcribe` (short
audio, or JSON `{text}` to file a note) and `/transcribe.html` (the browser
upload page for **long** recordings, which streams straight to Deepgram and so
has no size limit). See `docs/transcribe.md`.

> **When rotating `DEEPGRAM_API_KEY`, keep the Member role.** A
> *scope-restricted* key (`usage:write` only) transcribes but cannot mint the
> temporary token the browser upload needs — `/v1/auth/grant` returns
> `403 FORBIDDEN "Insufficient permissions"`, and the failure shows up only in
> the browser upload path, not in `POST /api/transcribe`.

Check the whole chain in one call — a JWT back means the key, its role, and the
secret are all correct:

```
curl -X POST "https://tecxbot.vercel.app/api/deepgram-token" \
  -H "Authorization: Bearer $TRANSCRIBE_SECRET"
```

`401` means the secret does not match (both sides are trimmed, so a trailing
newline in Vercel is not the cause); `500` names the Deepgram-side problem.

### Durable media on Cloudflare R2
Archive (`archivePendingMedia` → `putObject` → `setMediaKey`) and read
(`fetchMediaBytes` prefers R2, falls back to live LINE). Credentials come from
Cloudflare → R2 → *Manage API Tokens* (Object Read & Write on one bucket), which
issues an S3-style key pair — not a general Cloudflare API token. Set
`R2_ACCOUNT_ID` (or `R2_ENDPOINT` instead), `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`.

A one-off sweep: `GET /api/cron?job=archive-media&secret=<CRON_SECRET>` →
`{archived, skipped, errors}`.

Two schedulers drive it, both wanted:
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

## Remaining setup

### 1. (Optional) Daily reminder brief
Pushes reminders that are due or overdue to an internal LINE group each morning
(23:00 UTC = 07:00 Taipei). Set
`CONNECTOR_BRIEF_CONVERSATION_ID=line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0`.

It is fail-closed, pushes **only when something is due** (a quiet week costs zero
quota), and shares `CONNECTOR_REPLY_MONTHLY_CAP` with the PM reply so it cannot
overrun the LINE budget. Independent of `CONNECTOR_ALLOW_REPLY`. A reminder needs
an explicit `occurred_at` (due date) to be pushed. See `docs/claude-connector.md`.

### 2. (Optional) Turn on the TECXMATE PM reply
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

### 3. (Optional) Enable Claude-in-LINE
Set `ANTHROPIC_API_KEY` and the `CLAUDE_ASSISTANT_*` vars, point a channel at
`?channel=claude-assistant`. Defaults to 1:1-only
(`CLAUDE_ASSISTANT_ALLOW_GROUPS=false`) so it never posts in the client group
unless you opt in. See `docs/claude-connector.md` §9.

### 4. Housekeeping
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
- How to *use* the system: `docs/tutorial.md` (start there). Full reference:
  `docs/claude-connector.md`. Schema: `docs/connector-schema.sql`.
  Speech-to-text: `docs/transcribe.md`. PM role: `docs/tecxmate-pm.md`.
- The tutorial's reference tables are pinned to the code by the smoke suite, so
  a new tool, endpoint, or cron job must be documented in the same change.
