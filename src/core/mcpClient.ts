import type { BotSystemConfig } from './types.js';

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type McpToolCallResult = {
  toolName: string;
  result: unknown;
};

export async function callMcpTool(config: Extract<BotSystemConfig, { kind: 'mcp_agent' }>, toolName: string, arguments_: Record<string, unknown> = {}): Promise<McpToolCallResult> {
  if (config.allowedTools?.length && !config.allowedTools.includes(toolName)) {
    throw new Error(`MCP tool is not enabled for this channel: ${toolName}`);
  }

  try {
    return {
      toolName,
      result: unwrapToolResult(await postJsonRpc(config.mcpEndpoint, {
        jsonrpc: '2.0',
        id: nextRpcId(),
        method: 'tools/call',
        params: { name: toolName, arguments: arguments_ },
      })),
    };
  } catch (error) {
    if (!isInitializationError(error)) throw error;
  }

  await initializeMcpEndpoint(config.mcpEndpoint);
  return {
    toolName,
    result: unwrapToolResult(await postJsonRpc(config.mcpEndpoint, {
      jsonrpc: '2.0',
      id: nextRpcId(),
      method: 'tools/call',
      params: { name: toolName, arguments: arguments_ },
    })),
  };
}

async function initializeMcpEndpoint(endpoint: string) {
  await postJsonRpc(endpoint, {
    jsonrpc: '2.0',
    id: nextRpcId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'tecxbot-line-runtime', version: '0.1.0' },
    },
  });

  await postJsonRpc(endpoint, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });
}

async function postJsonRpc(endpoint: string, payload: Record<string, unknown>) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!text.trim()) return undefined;

  const json = parseMcpResponseBody(text, response.headers.get('content-type') ?? '');
  if (!json) return undefined;
  if (json.error) {
    const detail = typeof json.error.data === 'string' ? ` ${json.error.data}` : '';
    throw new Error(`MCP ${json.error.code ?? 'error'}: ${json.error.message ?? 'Unknown error'}${detail}`);
  }
  return json.result;
}

function parseMcpResponseBody(text: string, contentType: string): JsonRpcResponse | undefined {
  if (contentType.includes('text/event-stream') || text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:')) {
    const events = parseSseData(text)
      .map((chunk) => safeJsonParse<JsonRpcResponse>(chunk))
      .filter((item): item is JsonRpcResponse => Boolean(item));
    return events.find((item) => item.error || Object.prototype.hasOwnProperty.call(item, 'result')) ?? events.at(-1);
  }
  return safeJsonParse<JsonRpcResponse>(text);
}

function parseSseData(text: string) {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.length) chunks.push(current.join('\n'));
      current = [];
      continue;
    }
    if (line.startsWith('data:')) current.push(line.slice(5).trimStart());
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks.filter((chunk) => chunk !== '[DONE]');
}

function unwrapToolResult(result: unknown) {
  if (!isRecord(result)) return result;
  if ('structuredContent' in result) return result.structuredContent;
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const textItems = content
    .filter((item): item is { type?: unknown; text?: unknown } => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string);
  if (!textItems.length) return result;
  const joined = textItems.join('\n');
  return safeJsonParse(joined) ?? joined;
}

function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInitializationError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('initializ') || message.includes('session');
}

let rpcCounter = 0;

function nextRpcId() {
  rpcCounter += 1;
  return `tecxbot-${Date.now()}-${rpcCounter}`;
}
