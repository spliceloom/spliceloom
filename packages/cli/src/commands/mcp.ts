import { resolve } from "node:path";
import { SpliceProject } from "@spliceloom/core";
import { SpliceData } from "@spliceloom/data";
import { MIN_MCP_TOKEN_LENGTH, SpliceMcpServer, serveMcpHttp, serveStdio } from "@spliceloom/mcp";
import { UsageError, type Context } from "../io.js";
import { VERSION } from "../version.js";

export interface McpFlags {
  project?: string;
  http?: boolean;
  port?: string;
  host?: string;
  /** Also expose the live data tools (real providers; keys from the provider env variables). */
  data?: boolean;
}

/**
 * `splice mcp`: serve the project's installed skills over MCP.
 * - default: stdio, runs until stdin closes;
 * - `--http`: Streamable HTTP on --host/--port (default 127.0.0.1:8788, path /mcp); requires the
 *   bearer token in SPLICE_MCP_TOKEN. Runs until SIGINT/SIGTERM.
 */
export async function mcpCommand(ctx: Context, positionals: string[], flags: McpFlags = {}): Promise<number> {
  if (positionals.length > 0) throw new UsageError("mcp takes no arguments", "Usage: splice mcp [--project <dir>] [--http [--port <n>] [--host <addr>]]");
  if (!flags.http && (flags.port !== undefined || flags.host !== undefined)) throw new UsageError("--port and --host require --http");

  let port = 8788;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be an integer between 0 and 65535");
  }
  const token = ctx.io.env.SPLICE_MCP_TOKEN ?? "";
  if (flags.http && token.length < MIN_MCP_TOKEN_LENGTH) {
    throw new UsageError(
      `splice mcp --http requires SPLICE_MCP_TOKEN (at least ${MIN_MCP_TOKEN_LENGTH} characters)`,
      "Generate one: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  if (!flags.http && !ctx.io.stdin) throw new UsageError("splice mcp needs a stdin stream (it is meant to be launched by an MCP client)");

  const project = await SpliceProject.require(resolve(ctx.io.cwd, flags.project ?? "."));
  const log = (message: string) => ctx.io.stderr(`[splice mcp] ${message}\n`);
  const serverOptions: ConstructorParameters<typeof SpliceMcpServer>[0] = { projectRoot: project.root, env: ctx.io.env, serverVersion: VERSION, log };
  if (flags.data) {
    serverOptions.data = new SpliceData({ env: ctx.io.env, cwd: project.root });
    log("live data tools enabled (tokens_*, token_*, stock_*, perps_*, defi_*, global_*, macro_*, oracle_*, market_*, onchain_*, wallet_*, security_*, web_*, github_*, ai_*, providers_status)");
  }
  const server = new SpliceMcpServer(serverOptions);

  if (!flags.http) {
    log(`serving skills installed in ${project.root} over stdio`);
    await serveStdio(server, ctx.io.stdin!, (line) => ctx.io.stdout(line));
    return 0;
  }

  const running = await serveMcpHttp({ backend: server.backend, token, port, host: flags.host ?? "127.0.0.1", log });
  log(`serving skills installed in ${project.root} at ${running.url} (Streamable HTTP, bearer token required)`);
  ctx.io.stdout(`${running.url}\n`);
  await new Promise<void>((done) => {
    const stop = () => void running.close().then(done);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
