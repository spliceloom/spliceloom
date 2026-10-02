/**
 * MCP Streamable HTTP transport (stateless, JSON responses), Web-standard Request → Response.
 * Used by the registry Worker (`/mcp`) and by `splice mcp --http`.
 *
 * - POST: one JSON-RPC message (or a batch, for 2025-03-26 clients) → `application/json` response,
 *   or `202 Accepted` when the body only contained notifications/responses.
 * - GET/DELETE: `405` — this server never opens server-initiated streams and keeps no sessions.
 * - Rejects requests whose `Origin` is not explicitly allowed (DNS-rebinding protection).
 *
 * Authentication is the caller's job and must happen before `handleMcpHttp` is invoked.
 */
import {
  DEFAULT_HTTP_PROTOCOL_VERSION,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  McpSession,
  isSupportedProtocolVersion,
  type JsonRpcResponse,
  type McpBackend,
} from "./protocol.js";

export const MAX_MCP_BODY_BYTES = 1024 * 1024;

export interface McpHttpOptions {
  backend: McpBackend;
  /** Origins allowed to call the endpoint from a browser. Requests without Origin are accepted. */
  allowedOrigins?: readonly string[];
  log?: (message: string) => void;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function rpcError(status: number, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id: null, error: { code, message } }, status);
}

export async function handleMcpHttp(request: Request, options: McpHttpOptions): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !(options.allowedOrigins ?? []).includes(origin)) {
    return rpcError(403, JSONRPC_INVALID_REQUEST, "Origin not allowed");
  }
  const method = request.method.toUpperCase();
  if (method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return rpcError(415, JSONRPC_INVALID_REQUEST, "Content-Type must be application/json");
  }
  const accept = request.headers.get("accept");
  if (accept && !/application\/json|\*\/\*/i.test(accept)) {
    return rpcError(406, JSONRPC_INVALID_REQUEST, "Client must accept application/json");
  }
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion && !isSupportedProtocolVersion(headerVersion)) {
    return rpcError(400, JSONRPC_INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${headerVersion}`);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_MCP_BODY_BYTES) return rpcError(413, JSONRPC_INVALID_REQUEST, "Request body too large");
  const text = await request.text();
  if (text.length > MAX_MCP_BODY_BYTES) return rpcError(413, JSONRPC_INVALID_REQUEST, "Request body too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, JSONRPC_PARSE_ERROR, "Parse error");
  }

  // Stateless: a fresh session per HTTP request, versioned by the header (initialize negotiates itself).
  const sessionOptions: { protocolVersion: string; log?: (m: string) => void } = { protocolVersion: headerVersion ?? DEFAULT_HTTP_PROTOCOL_VERSION };
  if (options.log) sessionOptions.log = options.log;
  const session = new McpSession(options.backend, sessionOptions);

  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(400, JSONRPC_INVALID_REQUEST, "Empty batch");
    const responses = (await Promise.all(body.map((m) => session.handle(m)))).filter((r): r is JsonRpcResponse => r !== null);
    return responses.length === 0 ? new Response(null, { status: 202 }) : jsonResponse(responses);
  }
  const response = await session.handle(body);
  return response ? jsonResponse(response) : new Response(null, { status: 202 });
}
