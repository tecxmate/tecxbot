# Showing the system without showing a client

Notes for the blog post and any live walkthrough.

## Production is not the demo

`/api/mcp` and `/api/export` expose **every** captured conversation under a
single `CONNECTOR_TOKEN`. There is no read-only mode, no per-conversation scope,
and no redaction. Hand that token to anyone for "a quick look" and they have
Richard's messages and every client group with them.

So a demo needs its own database with invented people in it. That is what
`scripts/seed-demo.mjs` builds.

## Standing one up

1. **A separate Neon database.** Not a schema in the production one — a
   different database, so a mistake in a connection string cannot cross over.
2. **Seed it:**
   ```bash
   DEMO_DATABASE_URL='postgres://…' npm run seed:demo -- --yes
   ```
   Without `--yes` it prints what it would do. It refuses outright if
   `DEMO_DATABASE_URL` is unset, if it matches `CONNECTOR_DATABASE_URL` or
   `DATABASE_URL`, or if the target database already holds conversations
   belonging to another tenant.
3. **Point a deployment at it** with `CONNECTOR_DATABASE_URL` = the demo
   database and `CONNECTOR_TENANT_ID=showcase`. No LINE channel is attached, so
   nothing can be captured into it by accident.
4. Connect Claude to that deployment's `/api/mcp` with its own token.

## What the seed contains

A small Taiwanese café chain, Lotus 茶飲, rebuilding its site and adding online
ordering. Three stores, three menus, an iCHEF integration, and a six-week
timeline — the shape of work you actually do.

Fifteen messages over three weeks, in the mix of Chinese and English a real
group uses. Seven notes: a living brief, three decisions, two reminders, and a
kickoff transcript. Two Jira keys tagged through.

Three things are planted on purpose:

- **A dated promise** — a staging link for the 14th, said once in chat.
- **A commitment agreed in passing** — loyalty points, never scoped, never
  dated, written down nowhere else.
- **An unresolved complaint** — mobile load time, the reason they hired you.

## The walkthrough

Each question maps to one of the capabilities, in order.

**LINE capture.** Open the group in LINE, then ask Claude:

> What has Lotus been asking about?

It answers from the captured log. Worth saying out loud that nothing was copied
or pasted — the bot sits in the group and the messages are simply there.

**Memory.**

> Where does lotus-rebuild stand?

One `project_status` call returns the brief, the open reminders, the decisions
and the linked Jira keys. The overdue staging-link reminder shows up here.

**PM workflow.** This is the one that lands:

> What did we promise Lotus that isn't tracked anywhere?

It finds the loyalty-points commitment — agreed in chat, absent from Jira and
from the reminders. That is the failure mode every agency recognises, and it is
the argument for the whole system.

Then:

> Draft this week's update for them.

A client-ready summary built from the log and the notes, which you edit and send
yourself. Say that out loud too: the bot is capture-only by default and does not
message clients on its own.

## For the blog

A recording beats a live link. A reader cannot try a live demo without
connecting Claude to an MCP endpoint first, so a URL converts badly — whereas a
forty-second clip of the untracked-commitment question makes the point on its
own.

If you do publish a live demo, it is a separate deployment with a separate
token, and the token is rotated on a schedule because it will end up in a
screenshot eventually.
