// Smoke tests for the Claude connector.
//
//   npm test
//
// The repo has no test framework and no dependencies, so this is a plain script
// with a tiny assert harness. It runs against the compiled output in `dist/`
// (see the `test` script in package.json) and exercises the connector the way a
// real client does: ingest messages, then drive the MCP server over JSON-RPC.
//
// Everything runs on the in-memory store — no database, no network, no
// credentials — so it is safe to run anywhere, including CI.

// Must be set before the first import: tenantStore reads env at module load.
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
process.env.DEFAULT_TENANT_ID = 'demo';
delete process.env.CONNECTOR_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.CONNECTOR_TIMEZONE;

// Resolved against the working directory, not this file, so `npm test` from the
// repo root finds the build output regardless of where the script lives.
const { resolve } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const DIST = pathToFileURL(resolve(process.env.SMOKE_DIST || 'dist')).href;
const { recordMessage, buildConversationId } = await import(`${DIST}/src/core/conversationStore.js`);
const { handleMcpMessage } = await import(`${DIST}/src/connector/mcpServer.js`);
const { handleWhatsappWebhook } = await import(`${DIST}/src/platforms/whatsapp/webhook.js`);
const { authorizeConnector } = await import(`${DIST}/src/connector/auth.js`);
const { resolveSqlEndpoint } = await import(`${DIST}/src/core/sql.js`);
const { parseSince } = await import(`${DIST}/src/connector/tools.js`);
const mcpEndpoint = (await import(`${DIST}/api/mcp.js`)).default;

// ---- harness ----

let failures = 0;
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message}: ${JSON.stringify(needle)} not found in ${JSON.stringify(String(haystack).slice(0, 200))}`);
}

// ---- fixtures ----

const now = Date.now();
const ACME = buildConversationId({ platform: 'line', channelId: 'tecxmate', conversationType: 'group', externalConversationId: 'C_acme' });

const lineMessage = (text, sender, minutesAgo, direction = 'inbound') => recordMessage({
  tenantId: 'demo',
  channelId: 'tecxmate',
  platform: 'line',
  conversationType: 'group',
  externalConversationId: 'C_acme',
  title: 'Acme Corp',
  direction,
  senderId: direction === 'outbound' ? undefined : `U_${sender}`,
  senderName: sender,
  text,
  messageType: 'text',
  externalMessageId: `line-${minutesAgo}-${direction}`,
  at: now - minutesAgo * 60_000,
});

await lineMessage('Can we get the revised quote today?', 'Ken', 40);
await lineMessage('Sure — sending it this afternoon.', 'Tecxbot', 39, 'outbound');
await lineMessage('也請幫我們把發票地址改成台北市信義區。', 'Mei', 20);

// ---- MCP helpers ----

let rpcId = 0;
async function rpc(method, params) {
  const response = await handleMcpMessage({ jsonrpc: '2.0', id: ++rpcId, method, params });
  if (response?.error) throw new Error(`${method} -> ${response.error.code} ${response.error.message}`);
  return response?.result;
}

const callTool = (name, args = {}) => rpc('tools/call', { name, arguments: args });

// A minimal Vercel-shaped req/res pair, so api/mcp.ts is exercised as deployed.
async function httpCall({ method = 'POST', headers = {}, query = {}, body } = {}) {
  const state = { code: 0, headers: {}, body: undefined };
  const res = {
    setHeader: (key, value) => { state.headers[key.toLowerCase()] = value; },
    status(code) { state.code = code; return res; },
    json(payload) { state.body = payload; return res; },
    send(payload) { state.body = payload; return res; },
    end() { return res; },
  };
  await mcpEndpoint({ method, headers, query, body }, res);
  return state;
}

const jsonRpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

// ---- storage ----

console.log('\nconversation store');

await test('records messages and derives participants', async () => {
  const result = await callTool('get_conversation', { conversation_id: ACME });
  assertEqual(result.structuredContent.found, true, 'conversation found');
  assertEqual(result.structuredContent.messages.length, 3, 'message count');
  const names = result.structuredContent.participants.map((person) => person.name).sort();
  assertEqual(names.join(','), 'Ken,Mei', 'inbound participants only (the bot is not a participant)');
});

await test('a redelivered webhook does not duplicate a message', async () => {
  await lineMessage('Can we get the revised quote today?', 'Ken', 40);
  const result = await callTool('get_conversation', { conversation_id: ACME });
  assertEqual(result.structuredContent.messages.length, 3, 'message count after redelivery');
});

await test('empty text is dropped rather than stored', async () => {
  await recordMessage({
    tenantId: 'demo', channelId: 'tecxmate', platform: 'line', conversationType: 'group',
    externalConversationId: 'C_acme', direction: 'inbound', text: '   ', externalMessageId: 'blank',
  });
  const result = await callTool('get_conversation', { conversation_id: ACME });
  assertEqual(result.structuredContent.messages.length, 3, 'message count after blank message');
});

// ---- WhatsApp ingest ----

console.log('\nwhatsapp ingest');

await test('captures inbound messages and labels the contact', async () => {
  const captured = await handleWhatsappWebhook({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '123456', display_phone_number: '+886900000000' },
      contacts: [{ wa_id: '886912345678', profile: { name: 'Rosa Chen' } }],
      messages: [
        { id: 'wamid.1', from: '886912345678', timestamp: String(Math.floor((now - 600_000) / 1000)), type: 'text', text: { body: 'Can you resend the invoice PDF?' } },
        { id: 'wamid.2', from: '886912345678', timestamp: String(Math.floor((now - 300_000) / 1000)), type: 'document', document: { filename: 'po-2026.pdf', caption: 'our PO' } },
      ],
    } }] }],
  });
  assertEqual(captured, 2, 'captured count');
  const result = await callTool('list_conversations', { platform: 'whatsapp' });
  assertEqual(result.structuredContent.conversations.length, 1, 'whatsapp conversation count');
  assertEqual(result.structuredContent.conversations[0].title, 'Rosa Chen', 'contact name');
  assertIncludes(result.content[0].text, '[document: po-2026.pdf] our PO', 'document placeholder with caption');
});

await test('ignores a payload for an unconfigured phone number', async () => {
  const captured = await handleWhatsappWebhook({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'not-configured' },
      messages: [{ id: 'wamid.x', from: '999', type: 'text', text: { body: 'hello' } }],
    } }] }],
  });
  assertEqual(captured, 0, 'captured count');
});

// ---- MCP protocol ----

console.log('\nmcp protocol');

await test('initialize echoes a supported protocol version', async () => {
  const result = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assertEqual(result.protocolVersion, '2024-11-05', 'echoed version');
  assertEqual(result.serverInfo.name, 'tecxbot-client-context', 'server name');
  assert(result.capabilities.tools, 'declares the tools capability');
  assert(result.instructions.length > 0, 'ships instructions');
});

await test('an unsupported protocol version falls back to the default', async () => {
  const result = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assertEqual(result.protocolVersion, '2025-06-18', 'fallback version');
});

await test('notifications get no response', async () => {
  assertEqual(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined, 'response');
});

await test('tools/list advertises five read-only tools', async () => {
  const { tools } = await rpc('tools/list');
  assertEqual(tools.length, 5, 'tool count');
  assert(tools.every((tool) => tool.annotations.readOnlyHint), 'every tool is annotated read-only');
  assert(tools.every((tool) => tool.inputSchema.type === 'object'), 'every tool has an object schema');
});

await test('an unknown method is a JSON-RPC method-not-found', async () => {
  const response = await handleMcpMessage({ jsonrpc: '2.0', id: 99, method: 'bogus/method' });
  assertEqual(response.error.code, -32601, 'error code');
});

// ---- tools ----

console.log('\ntools');

await test('latest_context returns conversations newest first, messages chronological', async () => {
  const result = await callTool('latest_context', { conversations: 5, messages_per_conversation: 10 });
  const conversations = result.structuredContent.conversations;
  assertEqual(conversations.length, 2, 'conversation count');
  assert(new Date(conversations[0].lastMessageAt) >= new Date(conversations[1].lastMessageAt), 'conversations newest first');
  const acme = conversations.find((item) => item.title === 'Acme Corp');
  assertEqual(acme.messages[0].text, 'Can we get the revised quote today?', 'oldest message first');
  assertEqual(acme.messages.at(-1).text, '也請幫我們把發票地址改成台北市信義區。', 'newest message last');
  assertIncludes(result.content[0].text, '→ Tecxbot', 'bot replies marked as outbound');
});

await test('latest_context honours the platform filter', async () => {
  const result = await callTool('latest_context', { platform: 'line' });
  assert(result.structuredContent.conversations.every((item) => item.platform === 'line'), 'line only');
});

await test('search_messages finds a phrase and reports its conversation', async () => {
  const result = await callTool('search_messages', { query: 'invoice' });
  assertEqual(result.structuredContent.matches.length, 1, 'match count');
  assertIncludes(result.structuredContent.matches[0].text, 'invoice PDF', 'matched text');
});

await test('search_messages is case-insensitive', async () => {
  const result = await callTool('search_messages', { query: 'INVOICE PDF' });
  assertEqual(result.structuredContent.matches.length, 1, 'match count');
});

await test('search_messages reports no match without erroring', async () => {
  const result = await callTool('search_messages', { query: 'zzz-nothing-matches' });
  assert(!result.isError, 'not an error');
  assertEqual(result.structuredContent.matches.length, 0, 'match count');
});

await test('get_conversation on an unknown id explains itself', async () => {
  const result = await callTool('get_conversation', { conversation_id: 'nope' });
  assertEqual(result.structuredContent.found, false, 'found');
  assertIncludes(result.content[0].text, 'list_conversations', 'points at the tool that lists ids');
});

await test('connector_status reports the memory backend and its caveat', async () => {
  const result = await callTool('connector_status');
  assertEqual(result.structuredContent.backend, 'memory', 'backend');
  assertEqual(result.structuredContent.durable, false, 'durable');
  assertIncludes(result.content[0].text, 'CONNECTOR_DATABASE_URL', 'names the fix for non-durable storage');
});

await test('an unknown tool is a tool error, not a protocol error', async () => {
  const result = await callTool('does_not_exist');
  assertEqual(result.isError, true, 'isError');
  assertIncludes(result.content[0].text, 'latest_context', 'lists the real tools');
});

await test('a missing required argument is a tool error', async () => {
  assertEqual((await callTool('search_messages', {})).isError, true, 'search_messages without query');
  assertEqual((await callTool('get_conversation', {})).isError, true, 'get_conversation without id');
});

await test('parseSince handles relative windows, ISO dates and "all"', async () => {
  assert(Math.abs(parseSince('24h') - (Date.now() - 86_400_000)) < 5_000, 'relative hours');
  assert(Math.abs(parseSince('7d') - (Date.now() - 604_800_000)) < 5_000, 'relative days');
  assertEqual(parseSince('all'), undefined, '"all" means no lower bound');
  assertEqual(parseSince(undefined), undefined, 'undefined with no fallback');
  assertEqual(parseSince('2026-01-01'), Date.parse('2026-01-01'), 'ISO date');
  assertEqual(parseSince('not-a-date'), undefined, 'garbage is ignored');
});

// ---- HTTP transport ----

console.log('\nhttp transport');

await test('CORS preflight is answered', async () => {
  const response = await httpCall({ method: 'OPTIONS' });
  assertEqual(response.code, 204, 'status');
  assert(response.headers['access-control-allow-origin'], 'allow-origin header');
});

await test('the endpoint fails closed when no token is configured', async () => {
  const previous = process.env.CONNECTOR_TOKEN;
  delete process.env.CONNECTOR_TOKEN;
  const response = await httpCall({ headers: { authorization: 'Bearer anything' }, body: jsonRpc('tools/list') });
  assertEqual(response.code, 503, 'status');
  if (previous !== undefined) process.env.CONNECTOR_TOKEN = previous;
});

process.env.CONNECTOR_TOKEN = 'smoke-token';
const AUTH = { authorization: 'Bearer smoke-token' };

await test('an unauthenticated request is challenged', async () => {
  const response = await httpCall({ body: jsonRpc('tools/list') });
  assertEqual(response.code, 401, 'status');
  assertIncludes(response.headers['www-authenticate'], 'Bearer', 'challenge header');
});

await test('a wrong token is rejected', async () => {
  assertEqual((await httpCall({ headers: { authorization: 'Bearer wrong' }, body: jsonRpc('ping') })).code, 401, 'status');
});

await test('a bearer header authenticates', async () => {
  const response = await httpCall({ headers: AUTH, body: jsonRpc('tools/list') });
  assertEqual(response.code, 200, 'status');
  assertEqual(response.body.result.tools.length, 5, 'tool count');
});

await test('a query-param key authenticates, for clients that only take a URL', async () => {
  assertEqual((await httpCall({ query: { key: 'smoke-token' }, body: jsonRpc('ping') })).code, 200, 'status');
});

await test('a string body is parsed', async () => {
  const response = await httpCall({ headers: AUTH, body: JSON.stringify(jsonRpc('ping')) });
  assertEqual(response.code, 200, 'status');
});

await test('a JSON-RPC batch returns an array of responses', async () => {
  const response = await httpCall({ headers: AUTH, body: [jsonRpc('ping', {}, 1), jsonRpc('tools/list', {}, 2)] });
  assertEqual(response.code, 200, 'status');
  assert(Array.isArray(response.body), 'array response');
  assertEqual(response.body.map((item) => item.id).join(','), '1,2', 'ids preserved');
});

await test('a notification-only post is acknowledged with no body', async () => {
  const response = await httpCall({ headers: AUTH, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assertEqual(response.code, 202, 'status');
  assertEqual(response.body, undefined, 'body');
});

await test('malformed JSON is a parse error', async () => {
  const response = await httpCall({ headers: AUTH, body: '{oops' });
  assertEqual(response.code, 400, 'status');
  assertEqual(response.body.error.code, -32700, 'error code');
});

await test('GET and DELETE behave', async () => {
  assertEqual((await httpCall({ method: 'GET', headers: AUTH })).code, 405, 'GET is not an SSE stream');
  assertEqual((await httpCall({ method: 'DELETE', headers: AUTH })).code, 204, 'DELETE is a no-op teardown');
});

// ---- units ----

console.log('\nunits');

await test('authorizeConnector accepts both credential styles and rejects the rest', async () => {
  assertEqual(authorizeConnector({ authorization: 'Bearer smoke-token' }).ok, true, 'bearer');
  assertEqual(authorizeConnector({ key: 'smoke-token' }).ok, true, 'query key');
  assertEqual(authorizeConnector({ key: 'wrong' }).status, 401, 'wrong token');
  assertEqual(authorizeConnector({ key: 'smoke-token-longer' }).status, 401, 'length mismatch is not a crash');
  assertEqual(authorizeConnector({}).status, 401, 'no credentials');
});

await test('resolveSqlEndpoint derives the HTTP endpoint from the connection string', async () => {
  assertEqual(
    resolveSqlEndpoint('postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require'),
    'https://api.us-east-2.aws.neon.tech/sql',
    'direct host',
  );
  assertEqual(
    resolveSqlEndpoint('postgresql://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb'),
    'https://api.eu-central-1.aws.neon.tech/sql',
    'pooler host',
  );
});

// ---- result ----

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
