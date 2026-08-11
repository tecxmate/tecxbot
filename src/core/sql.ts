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
  const result = await post<SqlHttpResult>({ query, params: params.map(prepareParam) });
  return (result.rows ?? []) as T[];
}

// One request, one implicit transaction. Used for schema bootstrap so a cold
// start costs a single round trip instead of one per DDL statement.
export async function sqlBatch(queries: SqlQuery[]): Promise<void> {
  if (!queries.length) return;
  await post<SqlHttpBatchResult>({ queries: queries.map((item) => ({ query: item.query, params: (item.params ?? []).map(prepareParam) })) });
}

// The Neon SQL-over-HTTP endpoint binds every parameter as text, exactly as the
// Postgres wire protocol does — so a param must reach it in the string form
// node-postgres would produce, not as raw JSON. This matters most for arrays:
// `= any($1::text[])` needs a Postgres array literal (`{"a","b"}`), and a bare
// JSON array (`["a","b"]`) does not bind. This mirrors node-postgres's
// `prepareValue`, which the official driver runs on every parameter.
export function prepareParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return arrayLiteral(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// Postgres array literal, e.g. ['a', 'b'] -> {"a","b"}. Elements are quoted and
// escaped so commas, braces, and quotes inside a value survive; null elements
// become the unquoted NULL keyword.
function arrayLiteral(values: unknown[]): string {
  const elements = values.map((element) => {
    if (element === null || element === undefined) return 'NULL';
    if (Array.isArray(element)) return arrayLiteral(element);
    const text = prepareParam(element);
    if (text === null) return 'NULL';
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${elements.join(',')}}`;
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
