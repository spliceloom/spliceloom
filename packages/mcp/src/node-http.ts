/**
 * `splice mcp --http`: MCP over Streamable HTTP on Node.js, executing the project's installed
 * skills in the Splice sandbox. A bearer token is mandatory; only its SHA-256 is kept in memory.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_MCP_BODY_BYTES, handleMcpHttp } from "./http.js";
import type { McpBackend } from "./protocol.js";

export const MIN_MCP_TOKEN_LENGTH = 24;

export interface McpHttpServerOptions {
  backend: McpBackend;
  /** Required bearer token clients must send (`Authorization: Bearer <token>`). */
  token: string;
  port?: number;
  /** Default 127.0.0.1 (loopback only). */
  host?: string;
  /** Endpoint path. Default `/mcp`. */
  path?: string;
  allowedOrigins?: readonly string[];
  log?: (message: string) => void;
}

export interface RunningMcpHttpServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const init: RequestInit = { method: req.method ?? "GET", headers };
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_MCP_BODY_BYTES) throw new Error("body too large");
      chunks.push(chunk as Buffer);
    }
    init.body = new Uint8Array(Buffer.concat(chunks)) as Uint8Array<ArrayBuffer>;
  }
  return new Request(new URL(req.url ?? "/", origin), init);
}

export function serveMcpHttp(options: McpHttpServerOptions): Promise<RunningMcpHttpServer> {
  if (!options.token || options.token.length < MIN_MCP_TOKEN_LENGTH) {
    return Promise.reject(new Error(`An MCP bearer token of at least ${MIN_MCP_TOKEN_LENGTH} characters is required`));
  }
  const expected = sha256(options.token);
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/mcp";

  const server = createServer(async (req, res) => {
    const send = (response: Response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return response.arrayBuffer().then((b) => res.end(Buffer.from(b)));
    };
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname !== path) return void (await send(new Response("Not Found", { status: 404 })));
      const header = req.headers.authorization ?? "";
      const presented = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? "";
      if (!presented || !timingSafeEqual(sha256(presented), expected)) {
        return void (await send(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="splice-mcp"' },
          }),
        ));
      }
      const httpOptions: Parameters<typeof handleMcpHttp>[1] = { backend: options.backend };
      if (options.allowedOrigins) httpOptions.allowedOrigins = options.allowedOrigins;
      if (options.log) httpOptions.log = options.log;
      await send(await handleMcpHttp(await toRequest(req, `http://${host}`), httpOptions));
    } catch (error) {
      options.log?.(`request failed: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Bad request" } }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8788, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${port}${path}`,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
