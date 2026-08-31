# Tecxbot Architecture Notes

## Product Template

Tecxbot is now shaped as a LINE group translation product template:

- A website introduces the product and pricing.
- A LINE bot joins group chats.
- Group admins configure translation languages with `/set`.
- Group members can opt their own messages in or out with `/on` / `/off`.
- Translation usage is counted against a tenant character cap.

This should not copy another translator's brand, visual assets, or wording. The implementation can share familiar interaction patterns because those are product-category conventions.

## Core Layers

1. Platform adapters

Normalize LINE, Telegram, WhatsApp, Zalo, and web chat events into common internal messages.

2. Conversation/session layer

Tracks tenant id, platform, conversation id, user id, current workflow, current step, recent messages, and transient artifacts such as audio or transcripts.

Current implementation uses memory. Production should move this to Postgres plus a short-lived cache.

2a. Group translation settings

Tracks per-platform group id, enabled language codes, and user opt-out state.

Current implementation uses memory. Production should store this durably because LINE webhook requests can land on different serverless instances.

2b. Conversation log (connector storage)

Durable, cross-platform record of what clients actually said. Unlike the session
and group stores above, this one has to outlive the request that wrote it: the
Claude connector reads it from a different serverless invocation than the
webhook that captured it. Postgres when `CONNECTOR_DATABASE_URL` is set, memory
otherwise. See `src/core/conversationStore.ts` and `docs/connector-schema.sql`.

2c. Claude connector

`/api/mcp` serves that log to Claude as a read-only MCP server over Streamable
HTTP, so a session starts with the latest client context already loaded. Note
the direction: `src/core/mcpClient.ts` makes Tecxbot an MCP *client* of some
other server, while `src/connector/` makes Tecxbot an MCP *server* that Claude
connects to. See `docs/claude-connector.md`.

3. Workflow engine

Runs deterministic workflows. It should own required fields, validation rules, state transitions, confirmations, and audit history. LLMs should not validate critical structured data.

4. Tool registry

Tenant-specific typed tools exposed to the LLM, such as search customer, create ticket, create pending memory, draft reply, transcribe audio, notify staff.

5. LLM router

Interprets ambiguous free text and selects allowed actions. The server executes tools, not the model.

6. Tenant configuration

Each business user should configure business profile, language policy, enabled channels, rich menus, prompts, workflow definitions, tools, and escalation rules.

7. Usage and billing

Counts billable translation characters per tenant. A billing provider is no longer wired in (the former Stripe Checkout/webhook endpoints were removed and are recoverable from git history); real production billing should persist subscription state, payment provider ids, billing period boundaries, and usage events.

## Initial Production Data Model

Likely tables:

- tenants
- channels
- channel_accounts
- users
- conversations
- conversation_messages
- workflow_definitions
- workflow_runs
- workflow_steps
- prompt_templates
- tool_definitions
- tool_invocations
- media_assets
- transcripts
- group_translation_settings
- usage_accounts
- usage_events
- billing_customers
- billing_subscriptions
- tenant_events
