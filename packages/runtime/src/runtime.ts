import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  compareVersions,
  findTool,
  redactSecrets,
  validateValue,
  type JsonSchema,
  type Permissions,
} from "@spliceloom/spec";
import { RuntimeError, type RuntimeErrorCode } from "./errors.js";
import { loadPackage, type LoadedPackage } from "./loader.js";

export interface RuntimeOptions {
  /** Splice project root. Declared fs permissions are resolved relative to it. */
  projectRoot: string;
  /** Environment to take declared `permissions.env` variables from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Maximum combined log bytes kept per execution. Default 64 KiB. */
  maxLogBytes?: number;
  /** Maximum serialized output size. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Maximum serialized input size. Default 4 MiB. */
  maxInputBytes?: number;
  /**
   * Host capability broker. Tools that declare `permissions.capabilities` call it through
   * `ctx.capability(name, args)`; without a broker such calls answer CAPABILITY_UNAVAILABLE.
   */
  broker?: CapabilityBroker;
  /** Maximum broker calls per tool execution. Default 25. */
  maxCapabilityCalls?: number;
}

export interface CapabilityRequest {
  /** Package id and tool name of the caller (for logs/attribution; the grant is checked before). */
  package: string;
  tool: string;
  capability: string;
  args: unknown;
}

/**
 * Runs host capabilities for sandboxed tools (e.g. the data layer: web search, market data). The
 * runtime has already checked that the capability is declared, the call budget, and the size of
 * the arguments. The answer must be plain JSON data; it is sent back to the tool as is.
 */
export interface CapabilityBroker {
  call(request: CapabilityRequest): Promise<unknown>;
}

export const DEFAULT_MAX_CAPABILITY_CALLS = 25;
/** Concurrent broker calls per execution, maximum argument and result sizes. */
export const CAPABILITY_LIMITS = { concurrent: 4, argsBytes: 256 * 1024, resultBytes: 4 * 1024 * 1024 } as const;

export const DEFAULT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
/** Maximum nesting depth of tool input (objects/arrays). Deeper input is refused before validation. */
export const MAX_INPUT_DEPTH = 256;

/** Nesting depth of a JSON value, computed iteratively; stops counting past `limit`. */
export function jsonDepth(value: unknown, limit = MAX_INPUT_DEPTH): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (depth > max) max = depth;
    if (max > limit) return max;
    for (const child of Array.isArray(current) ? current : Object.values(current)) stack.push([child, depth + 1]);
  }
  return max;
}

export interface ToolSummary {
  name: string;
  description: string;
  input: JsonSchema;
  output?: JsonSchema;
}

export type ToolResult =
  | { ok: true; package: string; tool: string; output: unknown; logs: string; durationMs: number }
  | {
      ok: false;
      package: string;
      tool: string;
      error: { code: RuntimeErrorCode; message: string; details?: string[] };
      logs: string;
      durationMs: number;
    };

const HOST_PATH = join(dirname(fileURLToPath(import.meta.url)), "host.mjs");

/**
 * The canonical form of a project directory: symlinks and junctions resolved and, on Windows, 8.3
 * short names (`C:\Users\RUNNER~1\…`) expanded. Permission grants and the paths handed to tools must
 * use the same form that `realpath` returns inside the tool, or in-sandbox paths look outside it.
 */
export function canonicalRoot(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs; // not created yet: used as given
  }
}

/** Maps declared permissions onto Node.js permission-model flags. */
export function buildNodeArgs(pkg: LoadedPackage, projectRoot: string, permissions: Permissions): string[] {
  const root = canonicalRoot(projectRoot);
  const toAbs = (p: string) => (p === "." ? root : resolve(root, p));
  const read = new Set<string>([dirname(HOST_PATH), pkg.dir, ...permissions.fs.read.map(toAbs)]);
  const write = new Set<string>(permissions.fs.write.map(toAbs));
  // Writable locations must also be readable so tools can check what they wrote.
  for (const p of write) read.add(p);

  const args = ["--permission", "--disallow-code-generation-from-strings", "--disable-warning=ExperimentalWarning"];
  for (const p of read) args.push(`--allow-fs-read=${p}`);
  for (const p of write) args.push(`--allow-fs-write=${p}`);
  args.push(HOST_PATH);
  return args;
}

/**
 * Makes tool error messages and logs safe to show to users, agents and MCP clients: known token
 * formats and the exact values of environment variables given to the tool are redacted, and
 * absolute package/project paths are replaced by `<package>` / `<project>`.
 */
export function sanitizeText(text: string, context: { packageDir: string; projectRoot: string; secretValues: readonly string[] }): string {
  let out = text;
  for (const [dir, label] of [
    [context.packageDir, "<package>"],
    [context.projectRoot, "<project>"],
  ] as const) {
    const forms = new Set([dir, dir.replaceAll("\\", "/"), pathToFileURL(dir).href, decodeURIComponent(pathToFileURL(dir).href)]);
    for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join(label);
  }
  return redactSecrets(out, context.secretValues);
}

function buildEnv(permissions: Permissions, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Start from an empty environment: secrets in the parent environment never leak into tools.
  const env: NodeJS.ProcessEnv = {};
  if (process.platform === "win32" && source.SystemRoot) env.SystemRoot = source.SystemRoot;
  for (const name of permissions.env) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export class SpliceRuntime {
  readonly projectRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxLogBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxInputBytes: number;
  private readonly broker: CapabilityBroker | undefined;
  private readonly maxCapabilityCalls: number;

  constructor(options: RuntimeOptions) {
    this.projectRoot = canonicalRoot(options.projectRoot);
    this.env = options.env ?? process.env;
    this.maxLogBytes = options.maxLogBytes ?? 64 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.broker = options.broker;
    this.maxCapabilityCalls = options.maxCapabilityCalls ?? DEFAULT_MAX_CAPABILITY_CALLS;
  }

  /** Loads and validates a package directory. */
  load(dir: string): Promise<LoadedPackage> {
    return loadPackage(dir);
  }

  listTools(pkg: LoadedPackage): ToolSummary[] {
    return pkg.manifest.tools.map((t) => {
      const summary: ToolSummary = { name: t.name, description: t.description, input: t.input };
      if (t.output) summary.output = t.output;
      return summary;
    });
  }

  /** Executes a tool with structured input. Never throws for tool-level failures; returns `ok: false`. */
  async execute(pkg: LoadedPackage, toolName: string, input: unknown = {}): Promise<ToolResult> {
    const started = Date.now();
    const base = { package: pkg.id, tool: toolName };
    const permissions = pkg.manifest.permissions;
    const toolEnv = buildEnv(permissions, this.env);
    const secretValues = permissions.env.map((name) => toolEnv[name]).filter((v): v is string => typeof v === "string");
    const clean = (text: string) => sanitizeText(text, { packageDir: pkg.dir, projectRoot: this.projectRoot, secretValues });
    const fail = (code: RuntimeErrorCode, message: string, logs = "", details?: string[]): ToolResult => ({
      ok: false,
      ...base,
      error: details && details.length > 0 ? { code, message: clean(message), details: details.map(clean) } : { code, message: clean(message) },
      logs: clean(logs),
      durationMs: Date.now() - started,
    });

    const tool = findTool(pkg.manifest, toolName);
    if (!tool) {
      const available = pkg.manifest.tools.map((t) => t.name).join(", ");
      return fail("TOOL_NOT_FOUND", `Tool "${toolName}" not found in ${pkg.id}. Available: ${available}`);
    }

    const minNode = pkg.manifest.runtime.minNodeVersion;
    if (minNode && compareVersions(process.versions.node, minNode) < 0) {
      return fail("RUNTIME_UNSUPPORTED", `${pkg.id} requires Node.js >= ${minNode} (running ${process.versions.node})`);
    }

    // Resource limits before anything else touches the input (validation is recursive).
    const depth = jsonDepth(input);
    if (depth > MAX_INPUT_DEPTH) return fail("INPUT_TOO_LARGE", `Input for ${pkg.id}.${tool.name} is nested deeper than ${MAX_INPUT_DEPTH} levels`);
    let inputBytes: number;
    try {
      inputBytes = Buffer.byteLength(JSON.stringify(input ?? null));
    } catch {
      return fail("INVALID_INPUT", `Input for ${pkg.id}.${tool.name} is not serializable JSON`);
    }
    if (inputBytes > this.maxInputBytes) return fail("INPUT_TOO_LARGE", `Input for ${pkg.id}.${tool.name} is ${inputBytes} bytes (max ${this.maxInputBytes})`);

    const inputErrors = validateValue(tool.input, input, "input");
    if (inputErrors.length > 0) return fail("INVALID_INPUT", `Invalid input for ${pkg.id}.${tool.name}`, "", inputErrors);

    for (const p of permissions.fs.write) mkdirSync(resolve(this.projectRoot, p), { recursive: true });

    const job = {
      entryUrl: pathToFileURL(join(pkg.dir, tool.entry)).href,
      input,
      context: {
        package: { id: pkg.id, version: pkg.manifest.version },
        tool: tool.name,
        paths: { project: this.projectRoot, package: pkg.dir },
        permissions,
      },
    };

    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const outcome = await this.spawnHost(pkg, permissions, job, timeoutMs, tool.name, clean);
    if (!outcome.ok) return fail(outcome.code, outcome.message, outcome.logs);

    let outputSize: number;
    try {
      outputSize = Buffer.byteLength(JSON.stringify(outcome.output));
    } catch {
      return fail("INVALID_OUTPUT", `Tool ${pkg.id}.${tool.name} returned output that cannot be serialized (too deeply nested?)`, outcome.logs);
    }
    if (outputSize > this.maxOutputBytes) {
      return fail("OUTPUT_TOO_LARGE", `Tool output is ${outputSize} bytes (max ${this.maxOutputBytes})`, outcome.logs);
    }
    if (tool.output) {
      const outputErrors = validateValue(tool.output, outcome.output, "output");
      if (outputErrors.length > 0) {
        return fail("INVALID_OUTPUT", `Tool ${pkg.id}.${tool.name} returned output that does not match its schema`, outcome.logs, outputErrors);
      }
    }
    return { ok: true, ...base, output: outcome.output, logs: clean(outcome.logs), durationMs: Date.now() - started };
  }

  private spawnHost(
    pkg: LoadedPackage,
    permissions: Permissions,
    job: unknown,
    timeoutMs: number,
    toolName: string,
    clean: (text: string) => string,
  ): Promise<{ ok: true; output: unknown; logs: string } | { ok: false; code: RuntimeErrorCode; message: string; logs: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, buildNodeArgs(pkg, this.projectRoot, permissions), {
        cwd: pkg.dir,
        env: buildEnv(permissions, this.env),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });

      let logs = "";
      let truncated = false;
      const collect = (chunk: Buffer) => {
        if (truncated) return;
        logs += chunk.toString("utf8");
        if (Buffer.byteLength(logs) > this.maxLogBytes) {
          logs = logs.slice(0, this.maxLogBytes) + "\n[logs truncated]\n";
          truncated = true;
        }
      };
      child.stdout!.on("data", collect);
      child.stderr!.on("data", collect);

      let reply: { ok: boolean; output?: unknown; error?: { code: string; message: string } } | undefined;
      let settled = false;
      const finish = (value: Parameters<typeof resolvePromise>[0]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, code: "TIMEOUT", message: `Tool timed out after ${timeoutMs} ms`, logs });
      }, timeoutMs);

      // Capability broker channel: the tool asks, the host decides (declared? budget? sizes?) and runs it.
      const declared = new Set(permissions.capabilities ?? []);
      let calls = 0;
      let inFlight = 0;
      const answer = (id: number, payload: { result?: unknown; error?: { code: string; message: string } }) => {
        if (settled || !child.connected) return;
        child.send({ type: "capability-result", id, ...payload }, () => {});
      };
      const serveCapability = async (id: number, name: string, args: unknown) => {
        if (!declared.has(name)) return answer(id, { error: { code: "PERMISSION_DENIED", message: `Capability "${name}" is not declared in ${pkg.id}'s permissions.capabilities` } });
        if (++calls > this.maxCapabilityCalls) return answer(id, { error: { code: "CAPABILITY_LIMIT", message: `More than ${this.maxCapabilityCalls} capability calls in one execution` } });
        if (inFlight >= CAPABILITY_LIMITS.concurrent) return answer(id, { error: { code: "CAPABILITY_LIMIT", message: `At most ${CAPABILITY_LIMITS.concurrent} concurrent capability calls` } });
        let argsBytes: number;
        try {
          argsBytes = Buffer.byteLength(JSON.stringify(args ?? null));
        } catch {
          return answer(id, { error: { code: "INVALID_INPUT", message: "Capability arguments must be JSON data" } });
        }
        if (argsBytes > CAPABILITY_LIMITS.argsBytes || jsonDepth(args) > 32) return answer(id, { error: { code: "INPUT_TOO_LARGE", message: `Capability arguments exceed ${CAPABILITY_LIMITS.argsBytes} bytes or 32 levels` } });
        if (!this.broker) {
          return answer(id, { result: { status: "UNAVAILABLE", code: "CAPABILITY_UNAVAILABLE", capability: name, reason: "this Splice runtime has no capability broker (host data layer not attached)", timestamp: new Date().toISOString() } });
        }
        inFlight++;
        try {
          const result = await this.broker.call({ package: pkg.id, tool: toolName, capability: name, args });
          const serialized = JSON.stringify(result ?? null);
          if (Buffer.byteLength(serialized) > CAPABILITY_LIMITS.resultBytes) {
            return answer(id, { result: { status: "ERROR", code: "RESULT_TOO_LARGE", capability: name, message: `capability result exceeds ${CAPABILITY_LIMITS.resultBytes} bytes`, timestamp: new Date().toISOString() } });
          }
          answer(id, { result: JSON.parse(serialized) });
        } catch (error) {
          answer(id, { result: { status: "ERROR", code: "BROKER_ERROR", capability: name, message: clean(String((error as Error)?.message ?? error)), timestamp: new Date().toISOString() } });
        } finally {
          inFlight--;
        }
      };

      child.on("message", (message: unknown) => {
        const m = message as { type?: string; id?: unknown; name?: unknown; args?: unknown } | null;
        if (m && m.type === "result" && reply === undefined) reply = message as typeof reply;
        else if (m && m.type === "capability" && typeof m.id === "number" && typeof m.name === "string") void serveCapability(m.id, m.name, m.args);
      });
      child.on("error", (error) => {
        finish({ ok: false, code: "TOOL_CRASHED", message: `Failed to start tool process: ${error.message}`, logs });
      });
      child.on("close", (code, signal) => {
        if (reply?.ok) return finish({ ok: true, output: reply.output, logs: logs.trim() });
        if (reply && reply.error) {
          const known: RuntimeErrorCode[] = ["PERMISSION_DENIED", "TOOL_LOAD_FAILED", "TOOL_ERROR"];
          const errorCode = known.includes(reply.error.code as RuntimeErrorCode)
            ? (reply.error.code as RuntimeErrorCode)
            : "TOOL_ERROR";
          return finish({ ok: false, code: errorCode, message: reply.error.message, logs: logs.trim() });
        }
        const trimmed = logs.trim();
        const code_ = /ERR_ACCESS_DENIED/.test(trimmed) ? "PERMISSION_DENIED" : "TOOL_CRASHED";
        finish({
          ok: false,
          code: code_,
          message: `Tool process exited without a result (exit code ${code ?? "none"}${signal ? `, signal ${signal}` : ""})`,
          logs: trimmed,
        });
      });

      child.send(job as object, (error) => {
        if (error) {
          child.kill("SIGKILL");
          finish({ ok: false, code: "TOOL_CRASHED", message: `Failed to send job to tool process: ${error.message}`, logs });
        }
      });
    });
  }
}

export { RuntimeError };
