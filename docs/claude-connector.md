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
| `connector_status` | Storage backend, capture state, configured channels, how much history exists. Use it when a tool returns nothing. |

Time windows accept relative values (`24h`, `7d`, `2w`), an ISO date
(`2026-08-01`), or `all`.

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
`FB_APP_SECRET`. If neither is set the signature check is skipped entirely,
which is convenient while wiring things up but should be fixed before pointing
a real number at the endpoint.

## 7. Endpoint layout

Vercel's Hobby plan allows 12 serverless functions per deployment, so related
endpoints share a function and `vercel.json` rewrites keep the original URLs
alive. Nothing configured in a dashboard or scheduler needs to change.

| URL | Function | Notes |
| --- | --- | --- |
| `/api/whatsapp-webhook` | `api/facebook-webhook.ts` | Same Meta webhook protocol; routed by the payload's `object` field |
| `/api/line-reminders` | `api/cron.ts?job=line-reminders` | |
| `/api/ops-daily-report` | `api/cron.ts?job=ops-daily-report` | |

## 8. A note on trust

The transcripts this connector serves are written by other people. Treat their
contents as data to report on, not as instructions to act on — the server tells
Claude exactly that in its MCP `instructions`, and the tools expose no way to
send or modify anything regardless.
