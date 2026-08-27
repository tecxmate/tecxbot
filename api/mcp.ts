// Claude connector endpoint — MCP over Streamable HTTP.
//
//   claude mcp add --transport http tecxbot \
//     https://your-domain.vercel.app/api/mcp \
//     --header "Authorization: Bearer $CONNECTOR_TOKEN"
//
// The server is stateless: every POST carries a complete JSON-RPC message (or a
// batch of them) and gets a complete response, so no session id is issued and
// nothing has to be kept warm between calls. Server-initiated SSE is not
// supported — there is nothing to push.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizeConnector } from '../src/connector/auth.js';
import { DEFAULT_PROTOCOL_VERSION, fail, handleMcpMessage, type JsonRpcMessage } from '../src/connector/mcpServer.js';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  const auth = authorizeConnector({
    authorization: firstHeaderValue(req.headers.authorization),
    key: firstQueryValue(req.query.key) ?? firstQueryValue(req.query.token),
  });
  if (!auth.ok) {
    if (auth.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="tecxbot-connector"');
    return res.status(auth.status).json({ error: auth.message });
  }

  // Session teardown from clients that send one; there is no session to tear.
  if (req.method === 'DELETE') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(405).json({
      error: 'This MCP endpoint is POST-only. Configure it as a Streamable HTTP MCP server.',
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload: unknown;
  try {
    payload = parseBody(req);
  } catch (error) {
    return res.status(400).json(fail(null, -32700, `Parse error: ${formatError(error)}`));
  }

  const messages: JsonRpcMessage[] = Array.isArray(payload) ? payload as JsonRpcMessage[] : [payload as JsonRpcMessage];
  if (!messages.length || messages.some((message) => typeof message !== 'object' || message === null)) {
    return res.status(400).json(fail(null, -32600, 'Invalid request: expected a JSON-RPC message or an array of them.'));
  }

  const responses = (await Promise.all(messages.map((message) => handleMcpMessage(message)))).filter(Boolean);

  res.setHeader('MCP-Protocol-Version', DEFAULT_PROTOCOL_VERSION);
  // An all-notification batch has nothing to answer with.
  if (!responses.length) return res.status(202).end();
  return res.status(200).json(Array.isArray(payload) ? responses : responses[0]);
}

function applyCorsHeaders(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function parseBody(req: VercelRequest): unknown {
  if (typeof req.body === 'string') return req.body.trim() ? JSON.parse(req.body) : {};
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
  return req.body ?? {};
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
