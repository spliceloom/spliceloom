/**
 * Permissions a package requests. Everything is denied unless declared here.
 *
 * - fs.read / fs.write: paths relative to the Splice project root (the directory with splice.json).
 *   The package's own install directory is always readable and never needs to be declared.
 * - network: hostnames the package may contact (`api.github.com`, `*.example.com`), or `*` for any
 *   public host. The runtime refuses private, loopback, link-local and other non-public addresses
 *   unless that exact IP literal (or `localhost`) is declared.
 * - env: environment variable names passed through to the tool process.
 * - capabilities: host capabilities the tool may call through the Splice capability broker
 *   (`ctx.capability("web.search", {...})`), e.g. web search, market prices or on-chain data. The
 *   host runs them with its own provider keys — the tool never receives a key or opens a socket for
 *   them. Omitted (not `[]`) when none are requested, so earlier manifests and grants are unchanged.
 */
export interface Permissions {
  fs: { read: string[]; write: string[] };
  network: string[];
  env: string[];
  capabilities?: string[];
}

/**
 * Capabilities a package may request (the broker's public surface). Each maps to one host data-layer
 * call; results are the data layer's own (LIVE / CACHED / UNAVAILABLE / ERROR with provenance).
 */
export const BROKER_CAPABILITIES = [
  "onchain.balance",
  "onchain.transaction",
  "onchain.block",
  "onchain.token",
  "onchain.contract",
  "onchain.transfers",
  "onchain.logs",
  "market.price",
  "market.token",
  "market.pairs",
  "market.pair",
  "market.ohlcv",
  "market.trades",
  "market.search",
  "security.token",
  "security.address",
  "wallet.portfolio",
  "web.search",
  "web.extract",
  "web.map",
  "web.similar",
  "web.answer",
  "github.repository",
  "github.search",
  "github.contents",
  "github.commits",
  "github.releases",
  "github.raw",
  "ai.generate",
  "ai.models",
  // Every Robinhood Chain token (Codex), research, stock tokens, perps, DeFi, global and US data
  "tokens.rank",
  "tokens.search",
  "tokens.details",
  "tokens.whales",
  "tokens.report",
  "stock.quote",
  "stock.list",
  "perps.markets",
  "perps.funding",
  "defi.overview",
  "defi.protocols",
  "defi.yields",
  "global.overview",
  "macro.overview",
  "equity.profile",
  "equity.news",
] as const;
export type BrokerCapability = (typeof BROKER_CAPABILITIES)[number];

/** Capabilities that spend money or provider credits on every call (shown when consent is asked). */
export const BILLED_CAPABILITIES: ReadonlySet<string> = new Set(["ai.generate", "web.search", "web.extract", "web.map", "web.similar", "web.answer"]);

const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** Network permission value meaning "any public host" (non-public addresses stay blocked). */
export const ANY_PUBLIC_HOST = "*";
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function emptyPermissions(): Permissions {
  return { fs: { read: [], write: [] }, network: [], env: [] };
}

/** A project-relative path: forward slashes, no `..`, not absolute. `.` means the whole project. */
export function isSafeRelativePath(value: string): boolean {
  if (value === ".") return true;
  if (value.length === 0 || value.length > 256) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((seg) => seg !== ".." && seg !== "" && seg !== ".");
}

function stringList(raw: unknown, path: string, check: (v: string) => boolean, hint: string, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path}: must be an array`);
    return [];
  }
  const out: string[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== "string" || !check(item)) errors.push(`${path}[${i}]: ${hint}`);
    else if (!out.includes(item)) out.push(item);
  });
  return out;
}

/** Validates raw permissions and returns a normalized copy. Errors are appended to `errors`. */
export function normalizePermissions(raw: unknown, errors: string[], path = "permissions"): Permissions {
  if (raw === undefined) return emptyPermissions();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${path}: must be an object`);
    return emptyPermissions();
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["fs", "network", "env", "capabilities"].includes(key)) errors.push(`${path}: unknown permission "${key}"`);
  }
  let read: string[] = [];
  let write: string[] = [];
  if (obj.fs !== undefined) {
    if (typeof obj.fs !== "object" || obj.fs === null || Array.isArray(obj.fs)) {
      errors.push(`${path}.fs: must be an object`);
    } else {
      const fs = obj.fs as Record<string, unknown>;
      for (const key of Object.keys(fs)) {
        if (key !== "read" && key !== "write") errors.push(`${path}.fs: unknown key "${key}"`);
      }
      const hint = "must be a project-relative path without '..' (e.g. data/notes)";
      read = stringList(fs.read, `${path}.fs.read`, isSafeRelativePath, hint, errors);
      write = stringList(fs.write, `${path}.fs.write`, isSafeRelativePath, hint, errors);
    }
  }
  const network = stringList(
    obj.network,
    `${path}.network`,
    (v) => v === ANY_PUBLIC_HOST || (v.length <= 253 && HOST_PATTERN.test(v)),
    'must be a lowercase hostname, optionally prefixed with *., or "*" for any public host',
    errors,
  );
  const env = stringList(obj.env, `${path}.env`, (v) => ENV_PATTERN.test(v), "must be an UPPER_SNAKE_CASE name", errors);
  const known = new Set<string>(BROKER_CAPABILITIES);
  const capabilities = stringList(obj.capabilities, `${path}.capabilities`, (v) => known.has(v), `must be one of: ${BROKER_CAPABILITIES.join(", ")}`, errors);
  const out: Permissions = { fs: { read, write }, network, env };
  if (capabilities.length > 0) out.capabilities = capabilities;
  return out;
}

export function isEmptyPermissions(p: Permissions): boolean {
  return p.fs.read.length === 0 && p.fs.write.length === 0 && p.network.length === 0 && p.env.length === 0 && (p.capabilities?.length ?? 0) === 0;
}

/** Human readable lines, used by `splice info` and `splice add`. */
export function describePermissions(p: Permissions): string[] {
  if (isEmptyPermissions(p)) return ["none (sandboxed: no file, network, environment or host capability access)"];
  const lines: string[] = [];
  for (const path of p.fs.read) lines.push(`read files: ${path}`);
  for (const path of p.fs.write) lines.push(`write files: ${path}`);
  for (const host of p.network) {
    lines.push(host === ANY_PUBLIC_HOST ? "network: any public host (private, loopback and link-local addresses are blocked)" : `network: ${host}`);
  }
  for (const name of p.env) lines.push(`environment variable: ${name}`);
  for (const cap of p.capabilities ?? []) {
    lines.push(`host capability: ${cap} (run by Splice with the host's provider keys; the tool gets results, never keys)${BILLED_CAPABILITIES.has(cap) ? " — may spend provider credits/money" : ""}`);
  }
  return lines;
}

/** Permissions in `requested` that `granted` does not cover (empty when fully granted). */
export function ungrantedPermissions(requested: Permissions, granted: Permissions): Permissions {
  const missing = (want: string[], have: string[]) => want.filter((p) => !have.includes(p));
  const out: Permissions = {
    fs: { read: missing(requested.fs.read, [...granted.fs.read, ...granted.fs.write]), write: missing(requested.fs.write, granted.fs.write) },
    network: missing(requested.network, granted.network),
    env: missing(requested.env, granted.env),
  };
  const capabilities = missing(requested.capabilities ?? [], granted.capabilities ?? []);
  if (capabilities.length > 0) out.capabilities = capabilities;
  return out;
}

/**
 * True when `host` matches one of the declared patterns (`*` matches every host; whether the
 * address is public is checked by the runtime at connection time).
 */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) =>
    pattern === ANY_PUBLIC_HOST ? true : pattern.startsWith("*.") ? h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1 : h === pattern,
  );
}
