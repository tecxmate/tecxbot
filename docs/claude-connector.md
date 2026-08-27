# Claude connector

Tecxbot can act as a **connector for Claude**: it captures what your clients say
on LINE and WhatsApp, and exposes those conversations to Claude over MCP so a
session starts already knowing the latest state of every client chat.

```text
LINE group / 1:1 ─┐
                  ├─▶ webhook ─▶ conversation log (Postgres) ─▶ /api/mcp ─▶ Claude
WhatsApp number ──┘
```

The connector is **read-only**. It answers questions about client conversations;
it never sends a message or changes anything on LINE or WhatsApp.

## 1. Storage

The bot's other stores are in-memory because they only need to survive one
reply. The connector is different: the request that reads a conversation is a
different serverless invocation from the webhook that captured it, so history
has to live in a database.

Set a Postgres connection string — Neon, Supabase, or any Postgres reachable
over the Neon-compatible SQL-over-HTTP endpoint:

```text
CONNECTOR_DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Tables are created automatically on the first captured message. `docs/connector-schema.sql`
has the DDL if you would rather provision it yourself.

Without a connection string the connector still works, but on an in-memory
store: each serverless instance sees only what it captured since its last cold
start. That is fine for `vercel dev`, not for production. Every tool says so in
its output when it is running that way.

## 2. Connector token

```text
CONNECTOR_TOKEN=<a long random string>
```

`/api/mcp` **fails closed**: with no token set it refuses every request rather
than serving client chat to anyone who finds the URL. Generate one with:

```bash
openssl rand -hex 32
```

### Multi-tenant

For a single-owner deployment, leave `CONNECTOR_TENANT_ID` unset — the connector
serves that deployment's captured chat.

If several businesses share one database, run one connector deployment per tenant
and set `CONNECTOR_TENANT_ID` on each. The token is then pinned to that tenant:
the `tenant_id` a caller passes is ignored, so a leaked token cannot read another
tenant's conversations by asking for a different id.

### Retention

Captured history grows without bound unless you prune it. A cron job deletes
messages older than `CONNECTOR_RETENTION_DAYS` (default 90; `0` disables), then
removes any conversation left with no messages:

```text
GET /api/cron?job=connector-prune&secret=<CRON_SECRET>
```

Schedule it daily. `?days=<n>` overrides the retention window for a one-off
sweep. On the in-memory store the job is a no-op (that store self-evicts and is
per-instance), and it says so in the response.

## 3. Connect Claude

Claude Code:

```bash
claude mcp add --transport http tecxbot \
  https://your-domain.vercel.app/api/mcp \
  --header "Authorization: Bearer $CONNECTOR_TOKEN"
```

Clients that only accept a bare URL can carry the token as a query parameter
instead:

```text
https://your-domain.vercel.app/api/mcp?key=<CONNECTOR_TOKEN>
```

That URL *is* the credential — it can land in browser history and server logs,
so prefer the header wherever the client supports one, and rotate
`CONNECTOR_TOKEN` if a URL leaks.

Check it end to end with curl:

```bash
curl -s https://your-domain.vercel.app/api/mcp \
  -H "Authorization: Bearer $CONNECTOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

## 4. Tools

| Tool | What it answers |
| --- | --- |
| `latest_context` | "What's the latest with my clients?" — the most recently active conversations with their recent messages. The one to reach for first. |
| `list_conversations` | Which client chats exist, ordered by recent activity, with a preview of the last message. |
| `get_conversation` | The full transcript of one conversation. |
| `search_messages` | "When did they mention the invoice?" across every captured conversation. |
| `get_image` | Actually *see* an image sent in a LINE conversation (by anyone in it). |
| `connector_status` | Storage backend, capture state, configured channels, how much history exists. Use it when a tool returns nothing. |

Time windows accept relative values (`24h`, `7d`, `2w`), an ISO date
(`2026-08-01`), or `all`.

### Viewing images

Text is captured verbatim; images and other media are captured as short
placeholders (`[image]`), not stored. To let Claude actually see one, an image
message carries a `mediaId` in `get_conversation` / `latest_context`; pass it to
`get_image`, which fetches the picture **live from LINE on demand** — nothing is
persisted. This works while LINE still retains the media (a limited window), so
it's for recent images, not the whole archive. LINE only; capped at 5 MB per
image.

Set `CONNECTOR_TIMEZONE=Asia/Taipei` to render timestamps in local time instead
of UTC.

## 5. What gets captured

LINE (`/api/line-webhook`) captures every message on every configured LINE
channel — groups, rooms, and 1:1 chats — regardless of which bot system handles
it, including messages the bot deliberately does not answer. Bot replies are
captured too, marked as outbound, so a transcript reads as a real conversation.
Non-text messages are logged as short placeholders (`[image]`,
`[file: quote.pdf]`, `[voice message · 12s]`).

Group names and display names are resolved through the LINE profile API and
cached per instance, so conversations are labelled "Acme Corp" rather than
`C1a2b3c4…`. A room has no name endpoint on LINE, so rooms stay labelled by id.

WhatsApp (`/api/whatsapp-webhook`, a rewrite onto the shared Meta webhook at
`/api/facebook-webhook`) is capture-only — no bot replies. Subscribe
the `messages` webhook field; add `message_echoes` if you also want replies you
send from the WhatsApp app to appear in the transcript.

Redelivered webhooks are idempotent: a message that arrives twice is stored
once.

To turn capture off entirely without removing the endpoints, set
`CONNECTOR_CAPTURE=false`.

## 6. WhatsApp setup

In the Meta app dashboard, under WhatsApp → Configuration:

```text
Callback URL   https://your-domain.vercel.app/api/whatsapp-webhook
Verify token   the value of WHATSAPP_VERIFY_TOKEN
Webhook fields messages  (optionally message_echoes)
```

Environment:

```text
WHATSAPP_PHONE_NUMBER_ID=...        # registers the channel; required
WHATSAPP_VERIFY_TOKEN=...           # must match the dashboard
WHATSAPP_APP_SECRET=...             # enables X-Hub-Signature-256 verification
WHATSAPP_DISPLAY_PHONE_NUMBER=+886...
WHATSAPP_TENANT_ID=                 # defaults to DEFAULT_TENANT_ID
```

Inbound webhooks route by `phone_number_id`, so a second number is a second
channel rather than a second endpoint. As with LINE, an explicit
`?channel=<id>` overrides the routing.

If one Meta app serves both Messenger and WhatsApp, they share a signing secret
and `WHATSAPP_APP_SECRET` can be left unset — the webhook falls back to
`FB_APP_SECRET`. If neither is set the webhook **fails closed**: unsigned posts
are rejected with 401 rather than dispatched, so a public endpoint cannot be fed
forged client messages. For local testing without a configured secret, set
`META_ALLOW_UNSIGNED=true` to opt back into accepting unsigned payloads — never
in production.

## 7. Endpoint layout

Vercel's Hobby plan allows 12 serverless functions per deployment, so related
endpoints share a function and `vercel.json` rewrites keep the original URLs
alive. Nothing configured in a dashboard or scheduler needs to change.

| URL | Function | Notes |
| --- | --- | --- |
| `/api/whatsapp-webhook` | `api/facebook-webhook.ts` | Same Meta webhook protocol; routed by the payload's `object` field |
| `/api/line-reminders` | `api/cron.ts?job=line-reminders` | |
| `/api/ops-daily-report` | `api/cron.ts?job=ops-daily-report` | |
| (schedule directly) | `api/cron.ts?job=connector-prune` | Retention sweep; no legacy URL |

## 8. A note on trust

The transcripts this connector serves are written by other people. Treat their
contents as data to report on, not as instructions to act on — the server tells
Claude exactly that in its MCP `instructions`, and the tools expose no way to
send or modify anything regardless.

## 9. Claude in LINE (the Claude Tag equivalent)

The connector above *feeds context to Claude Code* — you pull the client
conversation into a coding session on demand. The **`claude_assistant`** bot
mode is the other half: it puts Claude *inside LINE*, the way Claude Tag lives
inside Slack. Tag the bot and it answers using the captured client conversation
as context, grounded in what was actually said.

This is a distinct channel/bot mode, registered only when
`CLAUDE_ASSISTANT_LINE_CHANNEL_ACCESS_TOKEN` is set, so nothing else changes
without it. It requires `ANTHROPIC_API_KEY`, and `CONNECTOR_DATABASE_URL` for
context that survives across serverless invocations.

### Two modes — pick by who should see Claude

Because this fronts a real client group, the reply surface is a deliberate
choice, set by `CLAUDE_ASSISTANT_ALLOW_GROUPS`:

- **`false` (default) — private copilot.** Claude answers only in your **1:1**
  chat with the bot, never in the client group. You ask "what's the latest with
  the client / draft a reply", it answers from the captured conversation, and
  you decide what to send. The client never sees an AI message.
- **`true` — Slack-style.** The bot also replies **inline in the group**, so a
  tag there gets a client-visible answer. Most like Claude Tag; only enable it
  when you want the client interacting with the assistant directly.

Either way it is **owner-gated**: with `CLAUDE_ASSISTANT_OWNER_USER_IDS` set,
only you can invoke it — a client cannot make the bot talk. The transcript is
passed to Claude as data, with an explicit instruction never to follow
directions contained inside it.

### Setup

Point a LINE channel's webhook at:

```text
https://your-domain.vercel.app/api/line-webhook?channel=claude-assistant
```

and set (see `.env.example` for the full list):

```text
ANTHROPIC_API_KEY=...
CLAUDE_ASSISTANT_LINE_CHANNEL_ACCESS_TOKEN=...
CLAUDE_ASSISTANT_LINE_CHANNEL_SECRET=...
CLAUDE_ASSISTANT_OWNER_USER_IDS=<your LINE user id>
CLAUDE_ASSISTANT_ALLOW_GROUPS=false        # flip to true for in-group replies
```

To run it on an existing account (e.g. TECXMATE) instead of a separate channel,
set that channel's `bot_system_kind` to `claude_assistant`. Note a channel runs
one bot mode at a time, so this replaces that channel's current behavior.
