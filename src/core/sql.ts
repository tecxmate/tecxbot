// Minimal Postgres-over-HTTP client.
//
// The repo is intentionally dependency-free — every integration is a plain
// `fetch` call — so this speaks the same SQL-over-HTTP protocol that the Neon
// serverless driver uses instead of pulling in a driver package.
//
//   POST https://api.<region>.<provider>.neon.tech/sql
//   Neon-Connection-String: postgresql://user:pass@host/db
//   { "query": "select $1::text", "params": ["hi"] }
//   -> { "command": "SELECT", "fields": [...], "rowCount": 1, "rows": [{...}] }
//
// Set CONNECTOR_SQL_ENDPOINT to point at any other HTTP proxy that speaks the
// same shape.

export type SqlQuery = { query: string; params?: unknown[] };

type SqlHttpResult = { command?: string; rowCount?: number; fields?: Array<{ name: string }>; rows?: Array<Record<string, unknown>> };
type SqlHttpBatchResult = { results?: SqlHttpResult[] };

export function getConnectionString() {
  return process.env.CONNECTOR_DATABASE_URL || process.env.DATABASE_URL || '';
}

export function isSqlConfigured() {
  return /^postgres(ql)?:\/\//i.test(getConnectionString());
}

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const result = await post<SqlHttpResult>({ query, params });
  return (result.rows ?? []) as T[];
}

// One request, one implicit transaction. Used for schema bootstrap so a cold
// start costs a single round trip instead of one per DDL statement.
export async function sqlBatch(queries: SqlQuery[]): Promise<void> {
  if (!queries.length) return;
  await post<SqlHttpBatchResult>({ queries: queries.map((item) => ({ query: item.query, params: item.params ?? [] })) });
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const connectionString = getConnectionString();
  if (!isSqlConfigured()) throw new Error('No Postgres connection string configured (set CONNECTOR_DATABASE_URL or DATABASE_URL)');
  const response = await fetch(resolveSqlEndpoint(connectionString), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': connectionString,
      // Ask for JSON-typed values and object-shaped rows so callers do not have
      // to re-implement the driver's type parsing.
      'Neon-Raw-Text-Output': 'false',
      'Neon-Array-Mode': 'false',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SQL HTTP ${response.status}: ${extractSqlError(text)}`);
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

// The HTTP endpoint lives on the same domain as the database host with the
// first label swapped for `api` — e.g.
// ep-x-123456.us-east-2.aws.neon.tech -> api.us-east-2.aws.neon.tech
export function resolveSqlEndpoint(connectionString: string) {
  const override = process.env.CONNECTOR_SQL_ENDPOINT;
  if (override) return override;
  const host = new URL(connectionString).hostname;
  const apiHost = host.includes('.') ? host.replace(/^[^.]+\./, 'api.') : host;
  return `https://${apiHost}/sql`;
}

function extractSqlError(text: string) {
  try {
    const parsed = JSON.parse(text) as { message?: string; detail?: string; code?: string };
    return [parsed.message, parsed.detail, parsed.code].filter(Boolean).join(' — ') || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
