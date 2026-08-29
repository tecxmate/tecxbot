# Deployment status & remaining setup

Handoff note for a local agent (or human) working in this repo. It records what
is **live**, what is **built but dormant**, and the **remaining setup** — with
exact steps. No secrets are in this file; production secrets live in Vercel and
local secrets in an untracked `.env`.

_As of the Cloudflare R2 media work (`#6`). Update this note as things change._

## Live and verified

- **Claude connector** at `https://tecxbot.vercel.app/api/mcp` (MCP over HTTP),
  connected to the operator's Claude app. `src/connector/`, `api/mcp.ts`.
- **Capture → durable storage.** LINE messages are captured to Postgres (Neon).
  `connector_status` confirmed `storage: postgres (durable)`, capture on.
- **Exec / review group** ("tecx-boss", the operator's internal group):
  `line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0`. Used as the PM's
  review target (see §4). **No client group is set up yet** — when one is added,
  find its id with `list_conversations` and point CLAUDE.md + the client
  references at it.
- **LINE `tecxmate` channel** webhook is set to
  `…/api/line-webhook?channel=tecxmate`, and the account's **Chat toggle is OFF**
  (required — with Chat on, a LINE OA auto-leaves groups).
- **Read-only tools:** `latest_context`, `list_conversations`, `get_conversation`,
  `search_messages`, `get_image`, `get_file`, `connector_status`.

### Production env already set (in Vercel, not in the repo)
- `CONNECTOR_TOKEN` — gates `/api/mcp` (fails closed without it).
- `CONNECTOR_DATABASE_URL` — Neon Postgres.
- `TECXMATE_LINE_CHANNEL_ACCESS_TOKEN` / `_SECRET` — the client bot channel.

## Built but dormant (no action taken until configured)

- **Durable media on Cloudflare R2** (`#6`). Code is merged; inactive until the
  R2 env vars are set. Until then, `get_image` / `get_file` fetch **live from
  LINE** (recent media only). Video is intentionally not archived.
- **TECXMATE PM reply** (`send_line_reply`). Lets a connected Claude (Claude
  Desktop / Claude Code, on your own plan — no `ANTHROPIC_API_KEY`) reply into the
  client LINE group as the PM, checking Jira for status. Fail-closed: off and not
  even advertised until `CONNECTOR_ALLOW_REPLY=true`. See `docs/tecxmate-pm.md`.
- **Claude-in-LINE assistant** (`claude_assistant` bot mode). Code is merged but
  not enabled on any channel. This one *does* use the Claude API key. See
  `docs/claude-connector.md` §9.

## Remaining setup (do these)

### 1. Turn on durable media (Cloudflare R2) — **done**
Bucket `tecxbot-media` exists, the four `R2_*` vars are set in Production, and
`connector_status` reports `mediaArchival: true`.

What remains is **scheduling the archive job**. Two drivers, both wanted:

- **Vercel Cron** (`vercel.json`) — `0 3 * * *`. The Hobby plan allows at most one
  run per day, so this is a backstop, not the main driver. It keeps working when
  the always-on machine is down.
- **The always-on machine** — every 15 minutes via launchd, which is what
  actually keeps media fresh. See `scripts/archive-media-tick.sh` and
  `scripts/com.tecxmate.archive-media.plist` for setup.

Why both: LINE only holds media for a short window, so a once-daily sweep can
miss things; but a local scheduler is a single machine that can go down. Neither
alone is sufficient. The job is idempotent, so overlapping runs are harmless.

Verify: `vercel crons ls` lists the job, `launchctl list | grep archive-media`
shows the agent, and `~/Library/Logs/tecxbot-archive-media.log` shows `ok` lines.

### 2. Reconnect the Claude connector
After a deploy that adds tools (e.g. `get_image`/`get_file`), **disconnect and
reconnect** the connector in the Claude app so it picks up the new tools.

### 3. LINE account cleanup
- **Auto-response messages → OFF** (LINE OA Manager → Response settings). It fires
  canned replies ("感謝您的訊息…") that are not from this bot.
- There are multiple similarly named accounts (`Tecxbot`, `TECXMATE`, a stray
  `Tecxmate`). Only **TECXMATE (@234wrzwi)** should be in client groups; drop the
  duplicates to avoid confusion.

### 4. (Optional) Turn on the TECXMATE PM reply
Let Claude on your own plan answer as the PM — no API key. **Default is
draft-in-chat** (Claude proposes the reply in the Claude chat, you send it — zero
LINE quota); the steps below add the optional push tiers. In **review mode**,
pushes go to the exec group ("tecx-boss") for approval; the client is never
written to automatically. Note the PM flow only does real work once a **client
group** exists — none is set up yet.
1. The exec group is already captured:
   `line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0` (tecx-boss).
2. In Vercel: `CONNECTOR_ALLOW_REPLY=true`,
   `CONNECTOR_REVIEW_CONVERSATION_ID=line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0`,
   and `CONNECTOR_REPLY_MONTHLY_CAP` a bit under the LINE free tier (quota is
   200/month, so e.g. 180). Redeploy. (For direct-to-client instead, leave the
   review var unset and set `CONNECTOR_REPLY_CONVERSATION_IDS` to the client
   group once it exists.)
3. In Claude Desktop / Claude Code, connect **both** the tecxbot connector and the
   **Jira (Atlassian)** connector, then reconnect tecxbot so `send_line_reply`
   appears.
4. Give Claude the PM prompt and run it. Full walkthrough: `docs/tecxmate-pm.md`.
   Note: project tracking is **Jira** now, not Linear.

### 5. (Optional) Enable Claude-in-LINE
Set `ANTHROPIC_API_KEY` and the `CLAUDE_ASSISTANT_*` vars, point a channel at
`?channel=claude-assistant`. Defaults to 1:1-only (`CLAUDE_ASSISTANT_ALLOW_GROUPS=false`)
so it never posts in the client group unless you opt in. See `docs/claude-connector.md` §9.

## Working in the repo

- `npm run build` — typecheck. `npm test` — the connector smoke suite (in-memory,
  no DB/network/creds needed). Both run in CI on every push/PR.
- For local dev, copy `.env.example` → `.env` and fill what you need. Postgres and
  R2 fall back gracefully when unset (memory store; live-LINE media).
- Full reference: `docs/claude-connector.md`. Schema: `docs/connector-schema.sql`.
