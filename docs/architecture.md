# Tecxbot Architecture Notes

## Core Layers

1. Platform adapters

Normalize LINE, Telegram, WhatsApp, Zalo, and web chat events into common internal messages.

2. Conversation/session layer

Tracks tenant id, platform, conversation id, user id, current workflow, current step, recent messages, and transient artifacts such as audio or transcripts.

Current implementation uses memory. Production should move this to Postgres plus a short-lived cache.

3. Workflow engine

Runs deterministic workflows. It should own required fields, validation rules, state transitions, confirmations, and audit history. LLMs should not validate critical structured data.

4. Tool registry

Tenant-specific typed tools exposed to the LLM, such as search customer, create ticket, create pending memory, draft reply, transcribe audio, notify staff.

5. LLM router

Interprets ambiguous free text and selects allowed actions. The server executes tools, not the model.

6. Tenant configuration

Each business user should configure business profile, language policy, enabled channels, rich menus, prompts, workflow definitions, tools, and escalation rules.

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
- tenant_events
