# Tecxbot

Tecxbot is a LINE group translation bot template with usage-capped billing hooks.

It is inspired by the public product category of LINE translators, but it is an original scaffold with its own commands, copy, storage boundaries, and payment flow. Use it to launch a bot that can be invited into a LINE group, translate messages across multiple languages, and gate usage behind free and paid character limits.

The goal is to combine deterministic workflows with LLM interpretation:

- Platform adapters normalize inbound events and outbound replies.
- Deterministic workflows collect structured inputs and handle state transitions.
- LLM routers interpret ambiguous free text and call approved tools.
- Tenant configuration controls prompts, vocabulary, workflows, and enabled tools.
- Group translation settings define target languages per LINE group.
- Usage accounting caps translation characters by tenant plan.
- Stripe-compatible checkout/webhook endpoints provide a payment template.
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
- Stripe Checkout session endpoint
- Stripe webhook endpoint for paid plan activation
- Group mention gating
- Short-lived session context
- Audio confirmation and language selection
- LINE media download
- Deepgram raw transcript
- OpenAI transcript polish
- Rich menu setup script
- Swappable MCP-backed bot runtime for command-driven domain bots

This intentionally does not port dental demo patients, clinic-specific CRM UI, Telegram command handlers, or one-clinic assumptions.

See docs/architecture.md.

See also:

- `docs/multi-tenant-architecture.md`
- `docs/neon-schema.sql`

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
OPS_TEAM_DIRECTORY_FILE=/Users/niko/antigravity/tecxcorp/ops/task_owner_contacts.csv
LINEAR_PROJECT_ID=
LINEAR_LABEL_IDS=
LINEAR_DEFAULT_ASSIGNEE_ID=
```

`OPS_TEAM_DIRECTORY_FILE` can point at the live TecxCorp team CSV. The current
`ops/task_owner_contacts.csv` schema works as-is, and Tecxbot also recognizes
extra columns when you add them:

```csv
task_owner,full_name,position,github_login,linear_user_id,aliases,channel,recipient_id,active
brian,Brian Doan,CTO,briandoan,linear-user-uuid,"brian|cto",messenger,PSID,yes
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
GET /api/ops-daily-report?secret=<CRON_SECRET>
```

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

Scheduled reminders are delivered by `GET /api/line-reminders`. Run it every minute from Vercel Pro Cron, GitHub Actions, or another external scheduler. Set `CRON_SECRET` for protected manual invocation.

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

## Payment template

The free plan defaults to 5,000 billable characters. Billable characters are counted as message characters multiplied by configured target language count.

Stripe endpoints:

- `POST /api/create-checkout-session`
- `POST /api/stripe-webhook`

The current store is intentionally in memory. Before real customers, replace `src/core/usageStore.ts` and `src/core/groupTranslationStore.ts` with durable storage such as Postgres plus Redis.
