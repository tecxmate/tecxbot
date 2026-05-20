# Multi-Tenant Bot Architecture

## Goal

Tecxbot should be a chatbot-as-a-service runtime:

- A customer owns their LINE Official Account.
- The customer pastes Messaging API credentials into Tecxbot.
- Tecxbot gives them a webhook URL.
- The customer enables that webhook in LINE.
- Tecxbot routes inbound events to the configured bot system for that tenant/channel.

Tecxbot does not need the customer's LINE login, manager role, or full Official Account access.

## Runtime Model

Webhook URL:

```text
https://your-domain.com/api/line-webhook?channel=<tenant_channel_id>
```

Request flow:

1. Resolve `tenant_channel_id`.
2. Load tenant, channel credentials, and bot-system config.
3. Verify LINE signature with that channel's `channel_secret`.
4. Route events to the configured bot system.
5. Send replies with that channel's `channel_access_token`.

Current implementation supports the env-backed default channel:

```text
/api/line-webhook
```

and the architecture path:

```text
/api/line-webhook?channel=default-line
```

## Bot Systems

`group_translator`

Current LINE group translation assistant. Includes:

- `/set`
- `/summary`
- `/actions`
- `/catchup`
- usage caps
- recent group context

`mcp_agent`

Future generic MCP-backed bot. Intended config:

```json
{
  "kind": "mcp_agent",
  "mcpEndpoint": "https://example.com/mcp",
  "systemPrompt": "You answer questions about Taiwanese stocks.",
  "allowedTools": ["twse_quote", "factor_screen", "backtest"]
}
```

The LINE token can stay the same while the channel's `bot_system_config` changes from `group_translator` to `mcp_agent`.

## Credential Storage

LINE channel credentials must be stored encrypted:

- `channel_access_token_encrypted`
- `channel_secret_encrypted`

Use envelope encryption:

- application has a master key in env, such as `CREDENTIAL_ENCRYPTION_KEY`
- database stores ciphertext only
- decrypt only at request time

## Swap Behavior

To swap the bot behind a LINE channel:

1. Keep the same `tenant_channels` row and LINE credentials.
2. Update `bot_system_kind`.
3. Update `bot_system_config`.
4. No LINE Official Account change is needed.

Example:

```sql
update tenant_channels
set
  bot_system_kind = 'mcp_agent',
  bot_system_config = jsonb_build_object(
    'kind', 'mcp_agent',
    'mcpEndpoint', 'https://stocks.example.com/mcp',
    'systemPrompt', 'Answer Taiwanese stock questions using approved tools only.',
    'allowedTools', jsonb_build_array('twse_quote', 'factor_screen', 'backtest')
  )
where id = '<tenant_channel_id>';
```

## Current Gap

The code now has the runtime contracts and env-backed default channel. The next production step is replacing in-memory stores with the Neon schema in `docs/neon-schema.sql`.
