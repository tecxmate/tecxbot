# Tecxbot

> **Using it, rather than working on it? Start with [`docs/tutorial.md`](docs/tutorial.md).**
> That is the how-to guide, organized by what you want to do. What Tecxbot is
> *for* today is the Claude connector: client conversations and project memory
> captured into a durable log and served to your own Claude over MCP. The
> translation-bot scaffold described below is the template it grew out of — the
> code is still in the tree, but it is not what the deployment is used for.
> `docs/deployment-status.md` records exactly what is live and what is dormant.

Tecxbot is a LINE group translation bot template with usage-capped billing hooks.

It is inspired by the public product category of LINE translators, but it is an original scaffold with its own commands, copy, storage boundaries, and payment flow. Use it to launch a bot that can be invited into a LINE group, translate messages across multiple languages, and gate usage behind free and paid character limits.

The goal is to combine deterministic workflows with LLM interpretation:

- Platform adapters normalize inbound events and outbound replies.
- Deterministic workflows collect structured inputs and handle state transitions.
- LLM routers interpret ambiguous free text and call approved tools.
- Tenant configuration controls prompts, vocabulary, workflows, and enabled tools.
- Group translation settings define target languages per LINE group.
- Usage accounting caps translation characters by tenant plan.
- Audio workflows support transcript generation and optional polishing.

Current scope:

- LINE webhook verification
- Facebook Messenger webhook verification
- Tagged Messenger task intake for engineering ops
- Linear issue creation as the canonical task record
- GitHub issue creation across configured repos
- Google Tasks mirroring for non-technical task tracking
- Daily Claude ops report endpoint for open issues and tasks
- LINE text/postback/audio handling
- LINE group translation commands
- Multi-language translation using OpenAI
- Per-tenant character usage cap
- Group mention gating
- Short-lived session context
- Audio confirmation and language selection
- LINE media download
- Deepgram raw transcript
- OpenAI transcript polish
- Rich menu setup script
- Swappable MCP-backed bot runtime for command-driven domain bots
- Claude connector (MCP server) serving LINE and WhatsApp client conversations
- WhatsApp Business (Cloud API) webhook for conversation capture

This intentionally does not port dental demo patients, clinic-specific CRM UI, Telegram command handlers, or one-clinic assumptions.

See docs/architecture.md.

See also:

- `docs/claude-connector.md`
- `docs/multi-tenant-architecture.md`
- `docs/neon-schema.sql`
- `docs/connector-schema.sql`

## Claude connector

Tecxbot can hand Claude the context of your latest client conversations. LINE
and WhatsApp traffic is captured into a durable conversation log, and `/api/mcp`
exposes it as an MCP server, so a Claude session starts already knowing what
each client last said.

```bash
claude mcp add --transport http tecxbot \
  https://your-domain.vercel.app/api/mcp \
  --header "Authorization: Bearer $CONNECTOR_TOKEN"
```

Required environment:

```text
CONNECTOR_TOKEN=<long random string>
CONNECTOR_DATABASE_URL=postgresql://...
```

The endpoint fails closed — with no `CONNECTOR_TOKEN` it refuses every request.
Without `CONNECTOR_DATABASE_URL` the log falls back to memory, which only holds
what a single serverless instance captured since its last cold start.

Read-only tools: `latest_context`, `list_conversations`, `get_conversation`,
`search_messages`, `connector_status`. Nothing here sends messages or changes
state on LINE or WhatsApp.

WhatsApp is capture-only and routes by `phone_number_id`:

```text
https://your-domain.vercel.app/api/whatsapp-webhook
```

Messenger and WhatsApp are served by the same function — they are the same Meta
webhook protocol, and the payload's `object` field tells them apart — so that
URL is a rewrite onto `/api/facebook-webhook`. Either address works.

Full setup, including the Meta dashboard fields and what gets captured, is in
`docs/claude-connector.md`.

## Checks

```bash
npm run build   # typecheck (tsc --noEmit)
npm test        # connector smoke tests
```

`npm test` compiles to `dist/` and runs `scripts/connector-smoke.mjs`, which
ingests LINE and WhatsApp messages into the in-memory store and then drives the
MCP server over JSON-RPC exactly as a client would. It needs no database, no
network, and no credentials.

Both run on every push and pull request via `.github/workflows/ci.yml`.

## Messenger ops intake

Tecxbot can act as the phone-friendly intake layer for the TecxCorp company OS.
When someone tags the bot in Messenger, it extracts concrete work, creates a
canonical Linear issue, creates GitHub issues in one or more configured repos
when code work is involved, and mirrors the same work into Google Tasks when
that is useful for non-technical tracking.

Configure Meta to call:

```text
https://your-domain.vercel.app/api/facebook-webhook
```

Required environment:

```text
FB_VERIFY_TOKEN=...
FB_APP_SECRET=...
FB_PAGE_ACCESS_TOKEN=...
OPS_GITHUB_TOKEN=...
OPS_GITHUB_REPOS=tecxmate/tecxcorp,tecxmate/another-repo
LINEAR_API_KEY=...
LINEAR_TEAM_ID=...
GOOGLE_TASKS_ACCESS_TOKEN=...
GOOGLE_TASKS_LIST_ID=@default
OPENAI_API_KEY=...
```

Optional routing:

```text
FB_BOT_MENTION_NAMES=tecxbot,tecxmate
OPS_REPO_ALIASES=corp=tecxmate/tecxcorp,bot=tecxmate/tecxbot
OPS_GITHUB_DEFAULT_ASSIGNEES=github-user
OPS_GITHUB_LABELS=ops-task,from-messenger
OPS_TEAM_DIRECTORY_FILE=/absolute/path/to/tecxcorp/ops/task_owner_contacts.csv
LINEAR_PROJECT_ID=
LINEAR_LABEL_IDS=
LINEAR_DEFAULT_ASSIGNEE_ID=
```

`OPS_TEAM_DIRECTORY_FILE` can point at the live TecxCorp team CSV. The current
`ops/task_owner_contacts.csv` schema works as-is, and Tecxbot also recognizes
extra columns when you add them:

```csv
task_owner,full_name,position,github_login,linear_user_id,aliases,channel,recipient_id,active
alex,Alex Rivera,CTO,alex-rivera,linear-user-uuid,"alex|cto",messenger,PSID,yes
```

The intake prompt uses this directory to resolve human names, roles, and
positions into task owners, Linear assignees, and GitHub assignees.

Example Messenger message:

```text
@tecxbot ask @engineer to fix the onboarding error in tecxmate/tecxbot by 2026-06-01. Create proof with PR link.
```

The GitHub issue body keeps the original message, source conversation, owner,
due date, priority, and the completion-proof rule from the TecxCorp task
protocol.

## Daily ops report

Run this endpoint from Vercel Cron, GitHub Actions, or another scheduler:

```text
GET /api/cron?job=ops-daily-report&secret=<CRON_SECRET>
```

The former `/api/ops-daily-report` URL still works — `vercel.json` rewrites it
here — so an existing schedule needs no change.

It reads open Linear issues, open issues in `OPS_GITHUB_REPOS`, open Google
Tasks, and asks Claude to summarize what is being worked on, what is slowing
down, and what needs owner attention. Set `OPS_DAILY_REPORT_SEND=true` and
`FB_OPS_SUMMARY_RECIPIENT_ID` to push the report back to Messenger.

## Multi-tenant webhook shape

For a customer-owned LINE Official Account, store their Messaging API credentials against a tenant channel and give them:

```text
https://your-domain.vercel.app/api/line-webhook?channel=<tenant_channel_id>
```

That channel decides which bot system handles the message. The same LINE token can run the current group translator or a future MCP-backed bot by changing `bot_system_kind` and `bot_system_config`.

For a Tecxstock-style MCP bot, set:

```text
BOT_SYSTEM_KIND=mcp_agent
MCP_ENDPOINT=https://your-mcp-domain/mcp/<url-secret>/
MCP_AGENT_WRITE_USER_IDS=<line-user-id>
```

Write-capable commands are allowlisted by LINE user id. Send `/whoami` in a 1:1 LINE chat to get the id.

Personal demo state is keyed by LINE user id:

- `/watch 2330 reason` adds to that user's personal watchlist.
- `/unwatch 2330` removes from that user's personal watchlist.
- `/watchlist` shows only that user's watchlist.
- `/profile` shows personal reply settings.
- `/pref tone concise|balanced|technical`
- `/pref lang tw|en`
- `/pref risk conservative|balanced|aggressive`
- `/brief premarket` sends a watchlist brief immediately.
- `/reminder add 08:30 premarket` schedules a watchlist brief.
- `/reminder list`, `/reminder off <id>`, and `/reminder delete <id>` manage reminders.

The current implementation stores profiles and reminders in memory for the demo runtime. The paid version should back this with the `user_profiles`, `user_watchlist_items`, and `user_watchlist_brief_reminders` tables in `docs/neon-schema.sql`.

## Tecxstock MCP commands

When `BOT_SYSTEM_KIND=mcp_agent`, the LINE channel responds to slash commands:

```text
/q 2330
/help reports
/help watchlist
/help settings
/help advanced
/flow 2330 5d
/flow semiconductor 5d
/map 2330
/n 2330 7
/recent 1
/screen foreign
/regime
/quality 2330
/valuation 2330
/digest 3
/watchlist
/watch 2330 reason
/unwatch 2330
/profile
/pref tone concise
/pref lang tw
/pref risk conservative
/brief premarket
/reminder add 08:30 premarket
/reminder list
/status
```

Tecxstock is 1:1-only. In LINE groups it does not run stock commands; if someone uses a slash command in a group, it tells them to use the 1:1 chat.

`/help` is intentionally compact. It links to nested menus instead of listing every command at once:

- `/help reports`
- `/help watchlist`
- `/help settings`
- `/help advanced`

Free-form text does not trigger open-ended LLM chat. In groups it is ignored; in 1:1 chat the bot returns deterministic command suggestions with clickable quick-reply chips. For example, `what about TSMC` suggests `/q 2330`, `/flow 2330 5d`, `/n 2330 7`, and `/watch 2330`.

Scheduled reminders are delivered by `GET /api/cron?job=line-reminders` (the former `/api/line-reminders` URL is rewritten here, so an existing schedule needs no change). Run it every minute from Vercel Pro Cron, GitHub Actions, or another external scheduler. Set `CRON_SECRET` for protected manual invocation.

## LINE group translation commands

Invite the bot to a LINE group, then send:

```text
/set en tw ja
```

The group will translate messages across the configured languages. Use 2 to 5 language codes.

Other commands:

```text
/help
/settings
/status
/off
/on
/languages
```

## Usage caps

The free plan defaults to 5,000 billable characters. Billable characters are counted as message characters multiplied by configured target language count.

The current store is intentionally in memory. Before real customers, replace `src/core/usageStore.ts` and `src/core/groupTranslationStore.ts` with durable storage such as Postgres plus Redis, and re-add a billing provider (Stripe Checkout/webhook endpoints previously lived at `api/create-checkout-session.ts` and `api/stripe-webhook.ts` — recoverable from git history) to upgrade a tenant past the free cap.
