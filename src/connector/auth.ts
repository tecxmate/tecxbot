import { timingSafeEqual } from 'node:crypto';

export type ConnectorAuthResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * The connector exposes real client conversations, so it fails closed: with no
 * CONNECTOR_TOKEN configured the endpoint refuses every request rather than
 * serving chat history to anyone who finds the URL.
 *
 * Two ways to present the token, because MCP clients differ:
 *   Authorization: Bearer <token>   (Claude Code, `claude mcp add --header`)
 *   ?key=<token>                    (clients that only accept a bare URL)
 */
export function authorizeConnector(input: { authorization?: string; key?: string }): ConnectorAuthResult {
  const expected = process.env.CONNECTOR_TOKEN?.trim();
  if (!expected) {
    return { ok: false, status: 503, message: 'Connector is disabled: set CONNECTOR_TOKEN to enable /api/mcp.' };
  }
  const bearer = input.authorization?.trim().match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const presented = bearer || input.key?.trim();
  if (!presented) {
    return { ok: false, status: 401, message: 'Missing credentials. Send "Authorization: Bearer <token>" or ?key=<token>.' };
  }
  if (!secretsMatch(presented, expected)) {
    return { ok: false, status: 401, message: 'Invalid connector token.' };
  }
  return { ok: true };
}

function secretsMatch(presented: string, expected: string) {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
