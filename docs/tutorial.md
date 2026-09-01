# Tutorial — how to actually use this

The other docs are organized by subsystem: `claude-connector.md` explains the
connector, `transcribe.md` explains speech-to-text, `deployment-status.md`
explains what is switched on. This one is organized by **what you want to do**.

If you read one thing, read §2 (the daily loop) and §4 (the five conventions).
Everything else is detail you can come back for.

---

## 1. The mental model

Four parts, in order. Each one only does its own job:

```
  capture  ──▶   memory   ──▶   brain   ──▶   tasks
  (LINE,        (Neon:         (your        (Jira)
  recordings,    notes +        Claude)
  uploads)       messages)
```

- **Capture** is automatic and unconditional. Every message in a LINE group the
  bot is in gets stored. You never have to remember to save anything.
- **Memory** is a Postgres database of two things: *messages* (what was said in
  chat) and *notes* (durable, curated — decisions, transcripts, reminders,
  project briefs). Notes are platform-agnostic; they outlive LINE.
- **The brain is your own Claude**, not a model running on the server. Tecxbot
  hosts no LLM for this. The connector hands Claude the record; Claude reasons.
  This is why it costs nothing per query beyond your Claude subscription.
- **Tasks live in Jira.** Tecxbot is deliberately not a task tracker. It
  cross-references Jira rather than competing with it.

What makes this worth having is the boring part: the record accumulates whether
or not anyone is paying attention, so six months from now "what did we promise
Richard in March?" has an answer.

## 2. The daily loop

**Setup, once.** In Claude Desktop or Claude Code, add the connector:

```
claude mcp add --transport http tecxbot \
  https://tecxbot.vercel.app/api/mcp \
  --header "Authorization: Bearer $CONNECTOR_TOKEN"
```

Connect the **Jira (Atlassian)** connector alongside it — several of the things
below check both, and they are much weaker with only one.

> **After any deploy that adds a tool, disconnect and reconnect.** MCP clients
> cache the tool list at connect time, so a new tool stays invisible until you
> do. This has cost more debugging time than any actual bug.

**Then, in normal use, you just ask.** There is no app to open and no forms to
fill. Some things worth asking:

| You say | What Claude does |
| --- | --- |
| "Catch me up" | `latest_context` — recent conversations and what was said |
| "Where does ogsmbooster stand?" | `project_status` — brief, open reminders, decisions, Jira keys, in one call |
| "What did Richard say about the invoice?" | `search_messages` across the captured transcript |
| "What have we promised that isn't tracked?" | the commitment sweep (§5) |
| "Draft this week's update for the client" | the client update (§5) |
| "Remind me to send the quote Thursday" | `save_note` tagged `reminder`, due Thursday |
| "We decided to go with the monthly plan" | `save_note` tagged `decision` |

The two habits that make the rest work: **say decisions out loud to Claude** so
they get filed, and **give reminders a date**. An undated reminder is a wish.

## 3. Getting things in

Three doors into the same memory.

**Chat — automatic.** LINE messages in any group the TECXMATE bot is in are
captured with no action from you. The bot is capture-only: it reads and never
posts. Two groups matter:

| Group | Id | Use |
| --- | --- | --- |
| Client ("Richard & Brian") | `line:tecxmate:group:C4d841fdb4f2ab45254fa8c77a5dfcc60` | the client conversation |
| Exec ("tecx-boss", internal) | `line:tecxmate:group:C985633fca4271ba1af8a880cee989ba0` | internal; where the daily brief pushes |

**Recordings — `/transcribe.html`.** Open it on your phone, pick an audio file,
and it transcribes and files a note automatically. It uploads straight to
Deepgram from the browser, so there is **no length limit** — a 90-minute meeting
is fine. Pre-seed the keyterms field with names the transcriber otherwise
mangles. See `docs/transcribe.md`.

**Text — `POST /api/transcribe`.** Send `{"text": "...", "project": "..."}` to
file a note from a script or a shortcut, no audio involved.

**Anything else — just tell Claude,** and it calls `save_note`.

## 4. The five conventions

This is the filing system. It is only five rules, and they are what let a
teammate's Claude see the same picture yours does. They are baked into the
connector's instructions, so Claude follows them without being reminded — but
knowing them tells you what to ask for.

| Convention | How | Why it matters |
| --- | --- | --- |
| **Decision** | note tagged `decision` | "what did we decide about X" becomes a query, not an archaeology dig |
| **Reminder** | note tagged `reminder`, `occurred_at` = the **due** time; add tag `done` to close it | dated reminders get pushed each morning; undated ones never do |
| **Living brief** | one note per project titled `<project> — brief`, updated **in place** | one current statement instead of forty stale ones |
| **Jira key** | tag the note `TECX-42` | `project_status` reads these, so memory and Jira cross-reference |
| **Digest** | the weekly job files an index tagged `digest` | "what happened this week" starts here |

The reminder rule is the one with teeth: **`occurred_at` is the due date, not
the date you wrote it.** A reminder with no date shows up in lists but is never
pushed, on purpose — otherwise it would read as overdue forever.

## 5. The three recipes

Set up as instructions rather than tools, because each is a *way of using* the
tools that already exist. Ask in plain words; the phrasing here is just what
reliably triggers each.

### "What have we promised that isn't tracked?"

The failure this catches: a promise made in chat — "we'll have the revised quote
to you Thursday" — that never became a Jira issue or a reminder, and so lives
only in a transcript nobody re-reads.

Claude reads the client conversation, pulls out every commitment your side made,
checks each against **both** Jira and memory, and reports the ones tracked in
neither. Each comes with the message it came from, so you verify rather than
trust. It offers to file each gap as a dated reminder and as a Jira issue.

It will not invent a commitment that isn't in the transcript. Finding none is a
valid answer.

### "Draft this week's update for <client>"

Assembled from the record: `project_status` for the brief and open items, the
latest `digest` note for the week's activity, the conversation for what the
client actually asked, Jira for what moved. Structured *shipped / in progress /
waiting on you / next week*.

It comes back as a **draft in the Claude chat** for you to send — not pushed to
LINE. That costs zero LINE quota and nothing reaches a client unread. Anything
Claude couldn't verify is marked unconfirmed rather than asserted.

### "Turn this meeting into Jira issues"

Hand Claude a transcript (or point at one in memory). It extracts the concrete
actions, creates Jira issues, and links them **both ways**: the issue keys get
tagged onto the transcript note, and the note id goes into the issue
description. It also says which actions it turned into issues and which it left
out, so the omissions are visible rather than silent.

Both directions matter. Without the tag, `project_status` can't tell you which
meeting a ticket came from.

## 6. Answering as the PM

Claude can answer as the TECXMATE project manager for the client group, using
your own Claude plan — no API key, no per-message cost.

**The default is draft-in-chat**: Claude reads the conversation, checks Jira,
and proposes a reply *in your Claude chat*. You send it. This uses only read
tools, so it works right now with nothing switched on.

The optional push tiers (`CONNECTOR_ALLOW_REPLY`) add `send_line_reply`. Even
then it is the exception, not the default — LINE's free tier is about 200 pushes
a month, and review mode posts to the exec group for approval rather than to the
client. Full walkthrough: `docs/tecxmate-pm.md`.

## 7. Getting things out

`GET /api/export` turns everything into portable files. This is the escape
hatch: the memory is **not** locked to this deployment.

```
curl -H "Authorization: Bearer $CONNECTOR_TOKEN" \
  "https://tecxbot.vercel.app/api/export?include=all&format=md" -o memory.md
```

| Query | Default | Meaning |
| --- | --- | --- |
| `include` | `notes` | `notes`, `conversations`, `all` |
| `format` | `md` | readable document, or `json` |
| `project` | — | one project's notes |
| `since` | — | `7d` / ISO date — looks **backward** |
| `limit` | `200` | capped at 1000 |
| `messages` | `500` | per conversation, capped at 5000 |

A monthly export committed to a private repo is a real backup, and `git diff`
then shows exactly what changed in a project's memory.

## 8. When something doesn't work

**Ask `connector_status` first.** Nearly every feature here is *fail-closed* by
design: with its setting missing it does nothing at all, silently — which is
safe, but means a misconfiguration looks identical to "nothing to report".
`connector_status` reports the readiness of every subsystem in one call
(booleans only, never secret values), and it names the half-configured case
specifically, because "set up wrong" and "not set up" need different fixes.

Common ones, in the order they actually bite:

| Symptom | Usually |
| --- | --- |
| A new tool isn't there | the client cached the old tool list — reconnect |
| Notes vanish between sessions | `CONNECTOR_DATABASE_URL` unset; the store fell back to per-instance memory |
| A reminder never gets pushed | it has no `occurred_at`, or `CONNECTOR_BRIEF_CONVERSATION_ID` is unset |
| `/transcribe.html` refuses everything | `TRANSCRIBE_SECRET` unset — and check it matches the one in the page |
| Browser upload 403s on the token mint | the Deepgram key is scope-restricted; it needs at least **Member** role |
| A scheduled job never runs | `CRON_SECRET` unset — all jobs fail closed in production |
| Old images won't load | R2 isn't configured, so media is fetched live from LINE and only recent items exist |

## 9. Reference

### Tools

<!-- tool-table:start -->
| Tool | What you use it for |
| --- | --- |
| `latest_context` | recent conversations with their latest messages — the catch-up call |
| `list_conversations` | browse every captured conversation |
| `get_conversation` | one conversation's full transcript |
| `search_messages` | find a phrase someone said |
| `get_image` | read an image sent in chat |
| `get_file` | read a file sent in chat (including inside a zip) |
| `connector_status` | what is configured and what isn't — start here when debugging |
| `save_note` | file a decision, transcript, reminder, or brief |
| `update_note` | edit one in place; `add_tags` appends without replacing |
| `list_notes` | filter by project, milestone, tag, participant, `since`, `until` |
| `search_notes` | full-text across notes |
| `get_note` | one note in full |
| `project_status` | a project's whole state in one call; no argument lists the projects |
| `send_line_reply` | push to LINE — **only** when `CONNECTOR_ALLOW_REPLY=true`, otherwise not advertised |
<!-- tool-table:end -->

### Endpoints

<!-- endpoint-table:start -->
| Endpoint | Purpose |
| --- | --- |
| `/api/mcp` | the Claude connector (MCP over Streamable HTTP) |
| `/api/export` | portable markdown/JSON dump of memory (§7) |
| `/api/transcribe` | speech-to-text ingest, or `{text}` to file a note |
| `/api/deepgram-token` | mints the short-lived key the browser upload page uses |
| `/api/line-webhook` | LINE capture (and the bot runtimes) |
| `/api/facebook-webhook` | Messenger **and** WhatsApp; routed by the payload |
| `/api/telegram-webhook` | Telegram bot intake |
| `/api/telegram-deliver` | posts a finished transcript back to a Telegram chat |
| `/api/tecxmate-push` | secret-gated push into the client group, for the local coding agent |
| `/api/cron` | dispatcher for every scheduled job (below) |
<!-- endpoint-table:end -->

### Scheduled jobs

All run through `/api/cron?job=<name>&secret=$CRON_SECRET`, which is also how
you run one on demand.

<!-- job-table:start -->
| Job | Schedule | Does |
| --- | --- | --- |
| `daily-brief` | 23:00 UTC (07:00 Taipei) | pushes due/overdue reminders to the exec group; silent when nothing is due |
| `weekly-digest` | Mondays | files a mechanical activity index tagged `digest` |
| `archive-media` | 03:00 UTC + every 15 min locally | copies LINE media to R2 before LINE drops it |
| `connector-prune` | on demand | retention sweep |
| `line-reminders` | on demand | the older LINE reminder sweep |
| `ops-daily-report` | on demand | the older Messenger ops report |
<!-- job-table:end -->

---

## 10. How this document stays current

Docs rot. This one is pinned by a test rather than by good intentions.

`npm test` parses the three tables in §9 and compares them against the code:
the tool table against `connectorTools`, the endpoint table against the files in
`api/`, the job table against the cron dispatcher's `JOBS`. Adding a tool,
endpoint, or job without documenting it **fails CI**, and so does documenting
one that doesn't exist. The check runs in the same suite as everything else, on
every push and PR.

That covers drift in the *surface*. Prose still needs a human: if you change
what a tool means rather than whether it exists, update the section that
describes it. But the failure mode that actually happens — new thing shipped,
docs never touched — is the one that now can't happen quietly.
