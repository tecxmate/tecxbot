// Run a Vercel-style handler inside a Cloudflare Worker.
//
// The ten endpoints in api/ are written against Vercel's Node signature —
// (req, res) with res.status().json(). Workers speak Fetch: a Request in, a
// Response out. Rather than rewrite ten handlers and the 140 tests that drive
// them through that same signature, this adapts the call.
//
// That is a deliberate trade. A shim is a layer that can be wrong on its own,
// so it is small, has no branches that depend on which handler is running, and
// is tested directly. In exchange, every line of routing, auth, signature
// verification and storage logic moves platforms unchanged — and stays runnable
// on Vercel, which matters while both deployments exist during cutover.

type Query = Record<string, string | string[]>;

/** The shape api/*.ts actually uses — see the survey in docs/cloudflare.md. */
export type VercelLikeHandler = (req: VercelLikeRequest, res: VercelLikeResponse) => unknown;

export type VercelLikeRequest = {
  method: string;
  headers: Record<string, string>;
  query: Query;
  body: unknown;
  [Symbol.asyncIterator](): AsyncGenerator<Uint8Array>;
};

export type VercelLikeResponse = {
  setHeader(key: string, value: string): void;
  status(code: number): VercelLikeResponse;
  json(payload: unknown): VercelLikeResponse;
  send(payload: unknown): VercelLikeResponse;
  end(): VercelLikeResponse;
};

/**
 * Parse a URL's search params into Vercel's query shape: a repeated key becomes
 * an array, everything else a string. `injected` comes from a route rewrite
 * (e.g. /api/daily-brief carrying job=daily-brief) and is merged underneath the
 * real query, so a caller can never shadow the job a route pins.
 */
export function buildQuery(url: URL, injected: Record<string, string> = {}): Query {
  const query: Query = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  // Injected last: a route's own parameters win over anything in the URL.
  for (const [key, value] of Object.entries(injected)) query[key] = value;
  return query;
}

/**
 * Body, both ways at once.
 *
 * Three handlers set `bodyParser: false` and read raw bytes by iterating the
 * request (they verify signatures over the exact payload, so a re-serialized
 * copy would not do). The rest read `req.body` already parsed. Providing both
 * from one buffered read means the adapter needs no per-handler knowledge.
 */
function parseBody(raw: Uint8Array, contentType: string): unknown {
  if (raw.byteLength === 0) return undefined;
  const text = new TextDecoder().decode(raw);
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text; // handlers that care re-parse and report their own error
    }
  }
  return text;
}

export async function runVercelHandler(
  handler: VercelLikeHandler,
  request: Request,
  injectedQuery: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;

  const raw = new Uint8Array(await request.arrayBuffer());

  const req: VercelLikeRequest = {
    method: request.method,
    headers,
    query: buildQuery(url, injectedQuery),
    body: parseBody(raw, headers['content-type'] ?? ''),
    async *[Symbol.asyncIterator]() {
      // One chunk. Workers already buffered the body, so there is nothing to
      // stream, and handlers concatenate regardless of chunk count.
      if (raw.byteLength) yield raw;
    },
  };

  let status = 200;
  const outHeaders = new Headers();
  let body: BodyInit | null = null;

  const res: VercelLikeResponse = {
    setHeader(key, value) {
      outHeaders.set(key, value);
    },
    status(code) {
      status = code;
      return res;
    },
    json(payload) {
      if (!outHeaders.has('content-type')) outHeaders.set('content-type', 'application/json; charset=utf-8');
      body = JSON.stringify(payload);
      return res;
    },
    send(payload) {
      if (payload instanceof Uint8Array) {
        // Copied so the type is a plain ArrayBuffer-backed view, which is what
        // BodyInit accepts. No handler sends bytes today; this is here so one
        // that does works rather than failing at the type boundary.
        const bytes = new Uint8Array(payload.byteLength);
        bytes.set(payload);
        body = bytes;
      } else if (typeof payload === 'string') {
        body = payload;
      } else if (payload === undefined || payload === null) {
        body = null;
      } else {
        if (!outHeaders.has('content-type')) outHeaders.set('content-type', 'application/json; charset=utf-8');
        body = JSON.stringify(payload);
      }
      return res;
    },
    end() {
      return res;
    },
  };

  try {
    await handler(req, res);
  } catch (error) {
    // A handler that throws past its own try/catch must not take the isolate
    // with it, and must not leak internals to the caller.
    console.error('[worker] unhandled error', error);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  // 204 and 304 must not carry a body, per fetch semantics; Workers throws if
  // one is attached.
  if (status === 204 || status === 304) return new Response(null, { status, headers: outHeaders });
  return new Response(body, { status, headers: outHeaders });
}
