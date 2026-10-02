/**
 * Transport-agnostic MCP (Model Context Protocol) JSON-RPC handling. Pure Web-platform code: used by
 * the local stdio server, the local Streamable HTTP server and the registry Worker's `/mcp` endpoint.
 *
 * A backend supplies tools and resources; the session implements initialize/version negotiation,
 * method dispatch, error mapping and version-dependent fields (outputSchema, structuredContent).
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
/** Streamable HTTP: version assumed when a request carries no MCP-Protocol-Version header. */
export const DEFAULT_HTTP_PROTOCOL_VERSION = "2025-03-26";

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const MCP_RESOURCE_NOT_FOUND = -32002;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Extension metadata (MCP `_meta`); Splice puts the package, version and declared permissions here. */
  _meta?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}

export interface McpBackend {
  info: { name: string; title: string; version: string; instructions?: string };
  listTools(): Promise<McpTool[]>;
  /** Returns undefined for an unknown tool (reported as a protocol error). */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult | undefined>;
  listResources?(): Promise<McpResource[]>;
  listResourceTemplates?(): Promise<McpResourceTemplate[]>;
  /** Returns undefined when the resource does not exist. */
  readResource?(uri: string): Promise<McpResourceContents | undefined>;
}

/** Thrown by backends to produce a specific JSON-RPC error. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export function isSupportedProtocolVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/** Helpers for backends: a JSON result with optional structured content. */
export function jsonToolResult(output: unknown): McpToolCallResult {
  const result: McpToolCallResult = { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], isError: false };
  if (typeof output === "object" && output !== null && !Array.isArray(output)) result.structuredContent = output as Record<string, unknown>;
  return result;
}

export function errorToolResult(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export interface McpSessionOptions {
  /** Initial protocol version (Streamable HTTP passes the MCP-Protocol-Version header). */
  protocolVersion?: string;
  log?: (message: string) => void;
}

export class McpSession {
  private negotiatedVersion: string;
  private readonly log: (message: string) => void;

  constructor(
    private readonly backend: McpBackend,
    options: McpSessionOptions = {},
  ) {
    this.negotiatedVersion = options.protocolVersion && isSupportedProtocolVersion(options.protocolVersion) ? options.protocolVersion : LATEST_PROTOCOL_VERSION;
    this.log = options.log ?? (() => {});
  }

  get protocolVersion(): string {
    return this.negotiatedVersion;
  }

  /** structuredContent / outputSchema exist from 2025-06-18. */
  private get structured(): boolean {
    return this.negotiatedVersion >= "2025-06-18";
  }

  private initialize(params: Record<string, unknown>): unknown {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    this.negotiatedVersion = isSupportedProtocolVersion(requested) ? requested : LATEST_PROTOCOL_VERSION;
    const capabilities: Record<string, unknown> = { tools: { listChanged: false } };
    if (this.backend.listResources || this.backend.listResourceTemplates) capabilities.resources = { listChanged: false };
    const result: Record<string, unknown> = {
      protocolVersion: this.negotiatedVersion,
      capabilities,
      serverInfo: { name: this.backend.info.name, title: this.backend.info.title, version: this.backend.info.version },
    };
    if (this.backend.info.instructions) result.instructions = this.backend.info.instructions;
    return result;
  }

  private async listTools(): Promise<unknown> {
    const tools = (await this.backend.listTools()).map((tool) => {
      const { outputSchema, ...rest } = tool;
      // outputSchema must describe an object and only exists in newer protocol versions.
      return this.structured && outputSchema?.type === "object" ? { ...rest, outputSchema } : rest;
    });
    return { tools };
  }

  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") throw new McpError(JSONRPC_INVALID_PARAMS, "tools/call requires a string 'name'");
    const args = params.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new McpError(JSONRPC_INVALID_PARAMS, "'arguments' must be an object");
    const result = await this.backend.callTool(name, args as Record<string, unknown>);
    if (!result) throw new McpError(JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
    if (!this.structured && result.structuredContent !== undefined) {
      const { structuredContent: _omitted, ...rest } = result;
      return rest;
    }
    return result;
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return this.listTools();
      case "tools/call":
        return this.callTool(params);
      case "resources/list":
        if (!this.backend.listResources && !this.backend.listResourceTemplates) break;
        return { resources: this.backend.listResources ? await this.backend.listResources() : [] };
      case "resources/templates/list":
        if (!this.backend.listResources && !this.backend.listResourceTemplates) break;
        return { resourceTemplates: this.backend.listResourceTemplates ? await this.backend.listResourceTemplates() : [] };
      case "resources/read": {
        if (!this.backend.readResource) break;
        const uri = params.uri;
        if (typeof uri !== "string") throw new McpError(JSONRPC_INVALID_PARAMS, "resources/read requires a string 'uri'");
        const contents = await this.backend.readResource(uri);
        if (!contents) throw new McpError(MCP_RESOURCE_NOT_FOUND, "Resource not found", { uri });
        return contents;
      }
    }
    throw new McpError(JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  /** Handles one JSON-RPC message. Returns null for notifications and client responses. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid request" } };
    }
    const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = "id" in msg && (typeof msg.id === "string" || typeof msg.id === "number");
    if (typeof msg.method !== "string") {
      if (!hasId && !("result" in msg || "error" in msg)) {
        return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid request" } };
      }
      return null;
    }
    if (!hasId) return null; // notification
    const id = msg.id as string | number;
    if (msg.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: JSONRPC_INVALID_REQUEST, message: "jsonrpc must be '2.0'" } };
    const params = typeof msg.params === "object" && msg.params !== null && !Array.isArray(msg.params) ? (msg.params as Record<string, unknown>) : {};
    try {
      return { jsonrpc: "2.0", id, result: await this.dispatch(msg.method, params) };
    } catch (error) {
      if (error instanceof McpError) {
        const err: JsonRpcResponse["error"] = { code: error.code, message: error.message };
        if (error.data !== undefined) err.data = error.data;
        return { jsonrpc: "2.0", id, error: err };
      }
      this.log(`internal error in ${msg.method}: ${(error as Error)?.stack ?? String(error)}`);
      return { jsonrpc: "2.0", id, error: { code: JSONRPC_INTERNAL_ERROR, message: "Internal error" } };
    }
  }
}
