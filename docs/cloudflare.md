# Running on Cloudflare Workers

The code runs on both Vercel and Cloudflare Workers. This note covers why, what
changed, and how to cut over without losing a single LINE message.

> **The one irreversible risk.** LINE delivers each message to your webhook
> exactly once. There is no history endpoint and no replay. Any gap while the
> webhook points nowhere means those client messages are gone permanently — so
> the LINE webhook URL is the **last** thing you change, and the first thing you
> change back if anything looks wrong.

## Why move

| | Vercel Hobby | Cloudflare Workers |
| --- | --- | --- |
| Deploy from a private org repo | no | yes |
| Serverless function limit | 12 (we were at 10) | none |
| Cron frequency | once a day | 1-minute minimum |

The cron limit is the one that costs real money today: LINE expires media
quickly, so a daily sweep misses things, and the gap is currently covered by
launchd on a machine that has to stay on. On Workers that becomes a `*/15`
trigger and the machine can be retired.

## What changed in the code

Nothing in the handlers. That was the point.

- **`src/worker/adapter.ts`** translates a Fetch `Request` into the `(req, res)`
  shape `api/*.ts` expects. The ten handlers, and the tests that drive them
  through the same shape, are untouched — so they still run on Vercel too.
- **`src/worker/router.ts`** restates `vercel.json`: one path per `api/` module,
  plus the five cron rewrites. Those rewrites now **pin** their `job`, so
  `/api/daily-brief?job=archive-media` still runs the daily brief.
- **`src/worker/index.ts`** is the entry point — `fetch` plus `scheduled`.
- **`src/core/tenantStore.ts`** builds its registry lazily. It used to read
  `process.env` while the module was evaluated, which works on Vercel and fails
  on Workers, where bindings only reach `process.env` inside a request. Built
  eagerly there, it would have registered **no channels at all**, silently.
- **`api/cron.ts`** decides "is this production?" from `DEPLOY_ENV` as well as
  `VERCEL_ENV`. Without that, a Worker with no `CRON_SECRET` would have read as
  non-production and left every scheduled job callable by anyone.

`process.env` keeps working because `compatibility_date` in `wrangler.toml` is
past 2025-04-01, which populates vars and secrets into it.

## Setting it up

**1. Install the Cloudflare GitHub App on the tecxmate org.** Needs owner or
GitHub Apps Manager rights. Without it Cloudflare cannot see org repos.

**2. Create the Worker** and connect the repo, with:

- Build command: `npm run build:worker`
- Deploy command: `npx wrangler deploy`

**3. Set the secrets.** `wrangler.toml` holds only non-sensitive vars; secrets go
in with `wrangler secret put <NAME>`. The ones production actually uses today:

```
CONNECTOR_TOKEN  CONNECTOR_DATABASE_URL  CRON_SECRET
DEEPGRAM_API_KEY  TRANSCRIBE_SECRET
TECXMATE_LINE_CHANNEL_ACCESS_TOKEN  TECXMATE_LINE_CHANNEL_SECRET
R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY
```

Plus the non-secret config from `.env.example` — `CONNECTOR_BRIEF_CONVERSATION_ID`,
the `R2_*` account and bucket names, and anything else you have set on Vercel.
The full list, split into secrets and configuration, is in `.env.example`.

**Copy values from Vercel rather than regenerating them.** A new
`TRANSCRIBE_SECRET` means re-pasting it into the upload page; a new
`CONNECTOR_TOKEN` means reconnecting Claude.

## Verifying before you cut over

Both deployments talk to the same Neon database, so the Worker can be checked
properly while Vercel is still serving live traffic.

```bash
# 1. The connector reads real data through the new deployment.
curl "https://<worker>/api/export?format=json&include=notes&key=$CONNECTOR_TOKEN"

# 2. Speech-to-text end to end (a JWT back means key, role and secret all work).
curl -X POST "https://<worker>/api/deepgram-token" \
  -H "Authorization: Bearer $TRANSCRIBE_SECRET"

# 3. A cron job runs. Nothing due is a pass — "reason":"not_found" is not.
curl -H "Authorization: Bearer $CRON_SECRET" "https://<worker>/api/daily-brief"

# 4. Static assets are served.
curl -I "https://<worker>/transcribe.html"
```

Then point Claude at `https://<worker>/api/mcp` and call `connector_status`. It
should report the same storage, channels and readiness as the Vercel
deployment. If it does, the Worker is fully working and nothing has moved yet.

## Cutting over

In this order:

1. **Custom domain.** Attach `bot.tecxmate.com` to the Worker. You already hold
   DNS at Cloudflare, so this is where that long-standing 404 gets fixed.
2. **Disable the Vercel crons** so two deployments do not run the same jobs. The
   jobs are idempotent, but double-pushing the daily brief is not.
3. **Stop the launchd ticker** on the always-on machine — `*/15` on Workers has
   replaced it. `scripts/com.tecxmate.archive-media.plist`.
4. **Switch the LINE webhook** to `https://bot.tecxmate.com/api/line-webhook?channel=tecxmate`.
   This is the irreversible step. Verify with LINE's own webhook verification,
   then send a test message into tecx-boss and confirm it appears via
   `list_conversations`.
5. **Reconnect the Claude connector** to the new `/api/mcp` URL. MCP clients
   cache the tool list at connect time.
6. **Update the Meta and Telegram webhooks**, if those are in use.

**Rollback** is step 4 in reverse: point the LINE webhook back at Vercel. Keep
the Vercel deployment alive and configured for at least a week.

## Not done yet

- **R2 still goes through SigV4.** `src/core/r2.ts` signs S3 requests by hand
  because that is what worked on Vercel. On Workers an R2 binding replaces the
  whole file, drops two credentials from the catalog, and removes egress cost.
  Worth doing, but after the cutover — it changes how media is written, and that
  is not a thing to change on the same day as the platform.
- **`connector-prune`, `line-reminders` and `ops-daily-report` have no trigger.**
  They had none on Vercel either. Add them to `wrangler.toml` and
  `CRON_SCHEDULE` if you want them scheduled; the suite checks the two agree.
