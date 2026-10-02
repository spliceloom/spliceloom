/**
 * Tool host: the entry point of every sandboxed tool process.
 *
 * Runs under `node --permission` with read access limited to this file's directory, the
 * package directory and declared paths. It receives one job over IPC, executes the tool's
 * default export and replies with a structured result. Imports only Node built-ins and its
 * sibling net-policy module (same, already readable directory).
 */
import { lookup } from "node:dns/promises";
import { registerHooks } from "node:module";
import { format } from "node:util";
import { createGuardedFetch } from "./net-policy.js";

interface Job {
  entryUrl: string;
  input: unknown;
  context: {
    package: { id: string; version: string };
    tool: string;
    paths: { project: string; package: string };
    permissions: { fs: { read: string[]; write: string[] }; network: string[]; env: string[]; capabilities?: string[] };
  };
}

/**
 * Host capabilities over IPC: `ctx.capability(name, args)` sends a request to the Splice process,
 * which checks the declaration and limits, runs it with the host's provider keys and answers with
 * plain data (LIVE / CACHED / UNAVAILABLE / ERROR). Undeclared names are refused here and there.
 */
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCapabilityId = 1;
process.on("message", (message: { type?: string; id?: number; result?: unknown; error?: { code: string; message: string } }) => {
  if (message?.type !== "capability-result" || typeof message.id !== "number") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) {
    const error = new Error(message.error.message) as Error & { code: string };
    error.code = message.error.code === "PERMISSION_DENIED" ? "ERR_ACCESS_DENIED" : message.error.code;
    waiter.reject(error);
  } else waiter.resolve(message.result);
});

function capabilityCaller(declared: readonly string[]) {
  return (name: string, args: unknown = {}): Promise<unknown> => {
    if (typeof name !== "string" || !declared.includes(name)) {
      return Promise.reject(denied(`Capability "${String(name)}" is not declared in this package's permissions.capabilities`));
    }
    // Only plain JSON data crosses the process boundary.
    let plain: unknown;
    try {
      plain = JSON.parse(JSON.stringify(args ?? {}));
    } catch {
      return Promise.reject(new Error("Capability arguments must be JSON data"));
    }
    const id = nextCapabilityId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      process.send!({ type: "capability", id, name, args: plain });
    });
  };
}

type Reply =
  | { type: "result"; ok: true; output: unknown }
  | { type: "result"; ok: false; error: { code: string; message: string } };

/**
 * Built-in modules tools may not load: raw networking, the inspector, and `module` (whose
 * registerHooks/createRequire could re-open the others). Blocked for import, require and
 * process.getBuiltinModule alike.
 */
const DENIED_MODULES = new Set(["net", "http", "https", "http2", "tls", "dgram", "dns", "dns/promises", "inspector", "inspector/promises", "module"]);
const UNDICI_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

function denied(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = "ERR_ACCESS_DENIED";
  return error;
}

function deniedModule(specifier: string): boolean {
  return DENIED_MODULES.has(specifier.startsWith("node:") ? specifier.slice(5) : specifier);
}

function lockGlobal(target: object, name: PropertyKey, value: unknown): void {
  const desc = Object.getOwnPropertyDescriptor(target, name);
  if (!desc || desc.configurable) Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: false });
  else if (desc.writable) (target as Record<PropertyKey, unknown>)[name] = value;
  else if (desc.value !== value) throw new Error(`cannot lock ${String(name)}`);
}

/**
 * Network guard. Node 24 has no network permission flag, so this is enforced in-process: tools get
 * only the checked fetch from net-policy.ts (address validated inside the socket's DNS lookup,
 * every redirect hop re-checked); every other way Node offers to open a socket is removed.
 */
function installNetworkGuard(allowedHosts: readonly string[]): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (deniedModule(specifier)) {
        throw denied(`Access to "${specifier}" is denied. Splice tools may only use fetch() with declared network hosts.`);
      }
      return nextResolve(specifier, context);
    },
  });
  // process.getBuiltinModule() does not go through resolve hooks.
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  lockGlobal(process, "getBuiltinModule", (id: string) => {
    if (deniedModule(id)) throw denied(`Access to "${id}" is denied. Splice tools may only use fetch() with declared network hosts.`);
    return getBuiltinModule(id);
  });

  const lookupAll = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  lockGlobal(globalThis, "fetch", createGuardedFetch(allowedHosts, lookupAll, denied));
  for (const name of ["WebSocket", "EventSource"]) lockGlobal(globalThis, name, undefined);
  // The built-in fetch's dispatcher (undici) can issue raw requests; tools must not reach it.
  void globalThis.Response;
  lockGlobal(globalThis, UNDICI_DISPATCHER, undefined);
}

/** Keep stdout free of noise: all console output from tools is treated as logs on stderr. */
function redirectConsole(): void {
  const write = (...args: unknown[]) => {
    process.stderr.write(format(...args) + "\n");
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
  console.error = write;
}

function send(reply: Reply): Promise<void> {
  return new Promise((resolve) => {
    process.send!(reply, undefined, {}, () => resolve());
  });
}

function toErrorReply(error: unknown): Reply {
  const err = error as { code?: unknown; message?: unknown } | null;
  const nodeCode = typeof err?.code === "string" ? err.code : "";
  const message = typeof err?.message === "string" ? err.message : String(error);
  if (nodeCode === "ERR_ACCESS_DENIED") {
    return { type: "result", ok: false, error: { code: "PERMISSION_DENIED", message } };
  }
  return { type: "result", ok: false, error: { code: "TOOL_ERROR", message } };
}

/** The OS may inject default variables (e.g. on Windows); keep only declared ones. */
function scrubEnvironment(allowed: readonly string[]): void {
  for (const key of Object.keys(process.env)) {
    if (!allowed.includes(key)) delete process.env[key];
  }
}

async function run(job: Job): Promise<Reply> {
  scrubEnvironment(job.context.permissions.env);
  installNetworkGuard(job.context.permissions.network);
  redirectConsole();
  let mod: { default?: unknown };
  try {
    mod = (await import(job.entryUrl)) as { default?: unknown };
  } catch (error) {
    const reply = toErrorReply(error);
    if (!reply.ok && reply.error.code === "TOOL_ERROR") {
      return { type: "result", ok: false, error: { code: "TOOL_LOAD_FAILED", message: reply.error.message } };
    }
    return reply;
  }
  if (typeof mod.default !== "function") {
    return {
      type: "result",
      ok: false,
      error: { code: "TOOL_LOAD_FAILED", message: "Tool entry must have a default export function" },
    };
  }
  try {
    const context = Object.freeze({
      ...job.context,
      log: (...args: unknown[]) => process.stderr.write(format(...args) + "\n"),
      capability: capabilityCaller(job.context.permissions.capabilities ?? []),
    });
    const output = await (mod.default as (input: unknown, ctx: unknown) => unknown)(job.input, context);
    // Round-trip through JSON so only plain data crosses the process boundary.
    const serialized = JSON.stringify(output === undefined ? null : output);
    return { type: "result", ok: true, output: JSON.parse(serialized) };
  } catch (error) {
    return toErrorReply(error);
  }
}

process.once("message", (job: Job) => {
  run(job)
    .catch(toErrorReply)
    .then(send)
    .finally(() => process.exit(0));
});
