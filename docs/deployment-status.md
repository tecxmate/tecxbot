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
- **Primary client group** (the one CLAUDE.md targets):
  `line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0`.
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
- **Claude-in-LINE assistant** (`claude_assistant` bot mode). Code is merged but
  not enabled on any channel. See `docs/claude-connector.md` §9.

## Remaining setup (do these)

### 1. Turn on durable media (Cloudflare R2)
1. Cloudflare → **R2** → create a bucket. Under **Manage R2 API Tokens**, create a
   token with Object Read & Write → note the Access Key ID + Secret.
2. In **Vercel → tecxbot → Environment Variables**, add (see `.env.example`):
   `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
3. **Redeploy.**
4. **Schedule the archive job** every few minutes (Vercel Cron / GitHub Actions):
   `GET https://tecxbot.vercel.app/api/cron?job=archive-media&secret=$CRON_SECRET`
5. Verify: `connector_status` should show `media archival: on (Cloudflare R2)`.

### 2. Reconnect the Claude connector
After a deploy that adds tools (e.g. `get_image`/`get_file`), **disconnect and
reconnect** the connector in the Claude app so it picks up the new tools.

### 3. LINE account cleanup
- **Auto-response messages → OFF** (LINE OA Manager → Response settings). It fires
  canned replies ("感謝您的訊息…") that are not from this bot.
- There are multiple similarly named accounts (`Tecxbot`, `TECXMATE`, a stray
  `Tecxmate`). Only **TECXMATE (@234wrzwi)** should be in client groups; drop the
  duplicates to avoid confusion.

### 4. (Optional) Enable Claude-in-LINE
Set `ANTHROPIC_API_KEY` and the `CLAUDE_ASSISTANT_*` vars, point a channel at
`?channel=claude-assistant`. Defaults to 1:1-only (`CLAUDE_ASSISTANT_ALLOW_GROUPS=false`)
so it never posts in the client group unless you opt in. See `docs/claude-connector.md` §9.

## Working in the repo

- `npm run build` — typecheck. `npm test` — the connector smoke suite (in-memory,
  no DB/network/creds needed). Both run in CI on every push/PR.
- For local dev, copy `.env.example` → `.env` and fill what you need. Postgres and
  R2 fall back gracefully when unset (memory store; live-LINE media).
- Full reference: `docs/claude-connector.md`. Schema: `docs/connector-schema.sql`.
