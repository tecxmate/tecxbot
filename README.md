# Tecxbot

Tecxbot is a multi-tenant chat automation engine for LINE first, designed to expand to Telegram, WhatsApp, Zalo, and other chat platforms.

The goal is to combine deterministic workflows with LLM interpretation:

- Platform adapters normalize inbound events and outbound replies.
- Deterministic workflows collect structured inputs and handle state transitions.
- LLM routers interpret ambiguous free text and call approved tools.
- Tenant configuration controls prompts, vocabulary, workflows, and enabled tools.
- Audio workflows support transcript generation and optional polishing.

Current scope:

- LINE webhook verification
- LINE text/postback/audio handling
- Group mention gating
- Short-lived session context
- Audio confirmation and language selection
- LINE media download
- Deepgram raw transcript
- OpenAI transcript polish
- Rich menu setup script

This intentionally does not port dental demo patients, clinic-specific CRM UI, Telegram command handlers, or one-clinic assumptions.

See docs/architecture.md.
