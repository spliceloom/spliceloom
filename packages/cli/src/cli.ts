import { parseArgs, type ParseArgsConfig } from "node:util";
import { CoreError, expandRegistry } from "@spliceloom/core";
import { RuntimeError } from "@spliceloom/runtime";
import { SpecError, redactSecrets } from "@spliceloom/spec";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { configCommand } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand, type McpFlags } from "./commands/mcp.js";
import { namespaceCommand } from "./commands/namespace.js";
import { tokenCommand } from "./commands/tokens.js";
import { verifyCommand } from "./commands/verify.js";
import { VERSION } from "./version.js";
import { publishCommand } from "./commands/publish.js";
import { infoCommand } from "./commands/info.js";
import { addCommand, installCommand, listCommand, outdatedCommand, removeCommand, updateCommand } from "./commands/packages.js";
import {
  blockCommand,
  chainCommand,
  contractCommand,
  logsCommand,
  priceCommand,
  providersCommand,
  securityCommand,
  tokenCommand as tokenInspectCommand,
  txCommand,
  walletCommand,
  type DataFlags,
} from "./commands/data.js";

function dataFlags(values: Record<string, unknown>): DataFlags {
  const flags: DataFlags = {};
  if (typeof values.chain === "string") flags.chain = values.chain;
  if (values.fresh === true) flags.fresh = true;
  if (typeof values.limit === "string") flags.limit = values.limit;
  if (typeof values.address === "string") flags.address = values.address;
  if (typeof values["from-block"] === "string") flags.fromBlock = values["from-block"];
  if (typeof values["to-block"] === "string") flags.toBlock = values["to-block"];
  if (Array.isArray(values.topic)) flags.topic = values.topic as string[];
  if (typeof values.vs === "string") flags.vs = values.vs;
  return flags;
}
import { aiCommand, defiCommand, githubCommand, marketCommand, oracleCommand, stockCommand, webCommand, type LiveFlags } from "./commands/providers-live.js";
import { runCommand } from "./commands/run.js";
import { setupCommand } from "./commands/setup.js";

function liveFlags(values: Record<string, unknown>): LiveFlags {
  const flags: LiveFlags = {};
  const s = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  if (values.fresh === true) flags.fresh = true;
  if (values["no-fallback"] === true) flags.noFallback = true;
  if (values.content === true) flags.content = true;
  if (Array.isArray(values["include-domain"])) flags.includeDomain = values["include-domain"] as string[];
  if (Array.isArray(values["exclude-domain"])) flags.excludeDomain = values["exclude-domain"] as string[];
  const map: Array<[keyof LiveFlags, string]> = [
    ["model", "model"], ["provider", "provider"], ["system", "system"], ["maxTokens", "max-tokens"], ["temperature", "temperature"], ["search", "search"], ["schema", "schema"],
    ["ref", "ref"], ["page", "page"], ["perPage", "per-page"], ["state", "state"], ["maxBytes", "max-bytes"], ["vs", "vs"], ["timeframe", "timeframe"], ["aggregate", "aggregate"], ["limit", "limit"], ["maxChars", "max-chars"],
    ["session", "session"], ["sort", "sort"], ["window", "window"], ["minLiquidity", "min-liquidity"], ["venue", "venue"],
    ["above", "above"], ["below", "below"], ["change", "change"], ["interval", "interval"], ["count", "count"], ["min", "min"], ["notify", "notify"],
  ];
  for (const [key, opt] of map) {
    const v = s(opt);
    if (v !== undefined) (flags as Record<string, unknown>)[key] = v;
  }
  return flags;
}
import { searchCommand } from "./commands/search.js";
import { keysCommand, signCommand, type KeyFlags } from "./commands/keys.js";

function signingFlags(values: Record<string, unknown>): { requireSigned: boolean; allowSignerChange: boolean } {
  return { requireSigned: values["require-signed"] === true, allowSignerChange: values["allow-signer-change"] === true };
}

function keyFlags(values: Record<string, unknown>): KeyFlags {
  const flags: KeyFlags = {};
  if (typeof values.key === "string") flags.key = values.key;
  if (typeof values.dir === "string") flags.dir = values.dir;
  return flags;
}
import { askCommand, chatCommand, type AskFlags } from "./commands/ask.js";
import { dashCommand, globalCommand, macroCommand, newsCommand, perpsCommand, tokensCommand } from "./commands/markets.js";
import { compareCommand, radarCommand, reportCommand, watchCommand, watchlistCommand } from "./commands/pro.js";
import { COMMAND_HELP, MAIN_HELP } from "./help.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, createStyle, type CliIo, type Context } from "./io.js";

export { VERSION };

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  registry: { type: "string" },
  "no-color": { type: "boolean" },
  limit: { type: "string" },
  input: { type: "string" },
  token: { type: "string" },
  "dry-run": { type: "boolean" },
  project: { type: "string" },
  http: { type: "boolean" },
  "accept-permissions": { type: "boolean" },
  "require-signed": { type: "boolean" },
  "allow-signer-change": { type: "boolean" },
  sign: { type: "boolean" },
  key: { type: "string" },
  dir: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  label: { type: "string" },
  namespace: { type: "string", multiple: true },
  expires: { type: "string" },
  chain: { type: "string" },
  fresh: { type: "boolean" },
  address: { type: "string" },
  "from-block": { type: "string" },
  "to-block": { type: "string" },
  topic: { type: "string", multiple: true },
  vs: { type: "string" },
  data: { type: "boolean" },
  model: { type: "string" },
  provider: { type: "string" },
  system: { type: "string" },
  "max-tokens": { type: "string" },
  temperature: { type: "string" },
  search: { type: "string" },
  "no-fallback": { type: "boolean" },
  schema: { type: "string" },
  ref: { type: "string" },
  page: { type: "string" },
  "per-page": { type: "string" },
  state: { type: "string" },
  "max-bytes": { type: "string" },
  timeframe: { type: "string" },
  aggregate: { type: "string" },
  "max-chars": { type: "string" },
  content: { type: "boolean" },
  "include-domain": { type: "string", multiple: true },
  "exclude-domain": { type: "string", multiple: true },
  template: { type: "boolean" },
  init: { type: "boolean" },
  session: { type: "string" },
  sort: { type: "string" },
  window: { type: "string" },
  "min-liquidity": { type: "string" },
  venue: { type: "string" },
  above: { type: "string" },
  below: { type: "string" },
  change: { type: "string" },
  interval: { type: "string" },
  notify: { type: "string" },
  count: { type: "string" },
  min: { type: "string" },
} satisfies ParseArgsConfig["options"];

/** Options each command accepts in addition to the global ones (also used to validate the docs). */
export const COMMAND_OPTIONS: Record<string, string[]> = {
  init: [],
  search: ["limit"],
  info: [],
  add: ["accept-permissions", "require-signed", "allow-signer-change"],
  install: ["accept-permissions", "require-signed", "allow-signer-change"],
  outdated: [],
  update: ["accept-permissions", "require-signed", "allow-signer-change"],
  verify: [],
  remove: [],
  list: [],
  run: ["input"],
  publish: ["dry-run", "sign", "key"],
  keys: ["key"],
  sign: ["key", "dir"],
  login: ["token"],
  logout: [],
  whoami: [],
  config: [],
  mcp: ["project", "http", "port", "host", "data"],
  // `token` manages registry tokens; `token inspect <address>` is a live data command.
  token: ["label", "namespace", "expires", "chain", "fresh"],
  namespace: [],
  // Live data commands (real providers; see docs/data-providers.md)
  chain: ["chain", "fresh"],
  providers: ["chain"],
  block: ["chain", "fresh"],
  tx: ["chain", "fresh"],
  wallet: ["chain", "fresh", "limit"],
  contract: ["chain", "fresh"],
  logs: ["chain", "fresh", "address", "from-block", "to-block", "topic"],
  price: ["chain", "fresh", "vs"],
  security: ["chain", "fresh"],
  provider: ["chain"],
  ai: ["model", "provider", "system", "max-tokens", "temperature", "search", "no-fallback", "schema", "fresh"],
  github: ["ref", "page", "per-page", "state", "max-bytes", "fresh"],
  market: ["vs", "timeframe", "aggregate", "limit", "fresh", "sort", "window", "min-liquidity", "page"],
  web: ["provider", "limit", "max-chars", "content", "include-domain", "exclude-domain", "fresh"],
  setup: ["template", "init"],
  ask: ["model", "provider", "max-tokens"],
  chat: ["model", "provider", "max-tokens"],
  stock: ["fresh", "limit", "session", "search", "window", "min-liquidity"],
  oracle: ["fresh", "limit", "search", "session", "timeframe"],
  defi: ["fresh", "limit", "search", "sort", "min-liquidity", "timeframe"],
  tokens: ["fresh", "limit", "window", "min-liquidity", "timeframe", "min"],
  report: ["fresh"],
  compare: ["fresh"],
  watchlist: ["fresh"],
  watch: ["fresh", "above", "below", "change", "interval", "count", "min", "notify"],
  radar: ["fresh", "interval", "count", "min-liquidity", "notify"],
  global: ["fresh", "limit"],
  dash: ["fresh"],
  perps: ["fresh", "limit", "venue", "sort", "search"],
  macro: ["fresh", "limit"],
  news: ["fresh", "limit"],
};
export const GLOBAL_OPTIONS = ["help", "version", "json", "registry", "no-color"];

function reportError(ctx: Context, error: unknown): number {
  const s = ctx.style;
  // Error text can contain registry/server messages; never print anything token-shaped.
  const r = (text: string) => redactSecrets(text);
  if (error instanceof UsageError) {
    ctx.err(`${s.red("error:")} ${r(error.message)}`);
    if (error.hint) ctx.err(s.dim(error.hint));
    return EXIT_USAGE;
  }
  if (error instanceof CoreError || error instanceof RuntimeError || error instanceof SpecError) {
    ctx.err(`${s.red("error:")} ${r(error.message)}`);
    for (const detail of error.details) ctx.err(`  - ${r(detail)}`);
    if (error instanceof CoreError && error.hint) ctx.err(s.dim(`hint: ${r(error.hint)}`));
    // Invalid names/ranges typed by the user are usage errors.
    if (error instanceof SpecError && ["INVALID_NAME", "INVALID_REF", "INVALID_RANGE", "INVALID_VERSION"].includes(error.code)) {
      return EXIT_USAGE;
    }
    if (error instanceof CoreError && error.code === "INVALID_CONFIG") return EXIT_USAGE;
    return EXIT_FAILURE;
  }
  ctx.err(`${s.red("error:")} unexpected failure: ${r((error as Error)?.stack ?? String(error))}`);
  return EXIT_FAILURE;
}

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const colorEnabled = io.color && !argv.includes("--no-color") && io.env.NO_COLOR === undefined;
  const ctx: Context = {
    io,
    style: createStyle(colorEnabled),
    json: false,
    out: (line = "") => io.stdout(line + "\n"),
    err: (line = "") => io.stderr(line + "\n"),
  };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return reportError(ctx, new UsageError((error as Error).message, "Run `splice --help` for usage."));
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) {
    ctx.out(VERSION);
    return EXIT_OK;
  }
  if (!command) {
    (values.help ? ctx.out : ctx.err)(MAIN_HELP);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }
  if (command === "help") {
    const topic = rest[0];
    ctx.out(topic && COMMAND_HELP[topic] ? COMMAND_HELP[topic] : MAIN_HELP);
    return EXIT_OK;
  }
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) {
    return reportError(ctx, new UsageError(`Unknown command "${command}"`, "Run `splice --help` to see available commands."));
  }
  if (values.help) {
    ctx.out(COMMAND_HELP[command]!);
    return EXIT_OK;
  }
  for (const key of Object.keys(values)) {
    if (!GLOBAL_OPTIONS.includes(key) && !allowed.includes(key)) {
      return reportError(ctx, new UsageError(`Option --${key} is not valid for "${command}"`, `Run \`splice ${command} --help\`.`));
    }
  }

  ctx.json = values.json === true;
  if (values.registry !== undefined) {
    try {
      ctx.registry = expandRegistry(values.registry);
    } catch (error) {
      return reportError(ctx, new UsageError((error as Error).message));
    }
  }

  try {
    switch (command) {
      case "init":
        return await initCommand(ctx, rest);
      case "search":
        return await searchCommand(ctx, rest, values.limit);
      case "info":
        return await infoCommand(ctx, rest);
      case "add":
        return await addCommand(ctx, rest, values["accept-permissions"] === true, signingFlags(values));
      case "install":
        return await installCommand(ctx, rest, values["accept-permissions"] === true, signingFlags(values));
      case "outdated":
        return await outdatedCommand(ctx, rest);
      case "update":
        return await updateCommand(ctx, rest, values["accept-permissions"] === true, signingFlags(values));
      case "verify":
        return await verifyCommand(ctx, rest);
      case "remove":
        return await removeCommand(ctx, rest);
      case "list":
        return await listCommand(ctx, rest);
      case "run":
        return await runCommand(ctx, rest, values.input);
      case "publish":
        return await publishCommand(ctx, rest, values["dry-run"] === true, values.sign === true ? { key: typeof values.key === "string" ? values.key : "default" } : undefined);
      case "login":
        return await loginCommand(ctx, rest, values.token);
      case "logout":
        return await logoutCommand(ctx, rest);
      case "whoami":
        return await whoamiCommand(ctx, rest);
      case "config":
        return await configCommand(ctx, rest);
      case "mcp": {
        const flags: McpFlags = {};
        if (values.project !== undefined) flags.project = values.project;
        if (values.http) flags.http = true;
        if (values.port !== undefined) flags.port = values.port;
        if (values.host !== undefined) flags.host = values.host;
        if (values.data) flags.data = true;
        return await mcpCommand(ctx, rest, flags);
      }
      case "token": {
        // `splice token inspect <address>` is live token data; everything else manages registry tokens.
        if (rest[0] === "inspect") return await tokenInspectCommand(ctx, rest, dataFlags(values));
        const flags: { label?: string; namespace?: string[]; expires?: string } = {};
        if (values.label !== undefined) flags.label = values.label;
        if (values.namespace !== undefined) flags.namespace = values.namespace;
        if (values.expires !== undefined) flags.expires = values.expires;
        return await tokenCommand(ctx, rest, flags);
      }
      case "chain":
        return await chainCommand(ctx, rest, dataFlags(values));
      case "providers":
        return await providersCommand(ctx, rest, dataFlags(values));
      case "block":
        return await blockCommand(ctx, rest, dataFlags(values));
      case "tx":
        return await txCommand(ctx, rest, dataFlags(values));
      case "wallet":
        return await walletCommand(ctx, rest, dataFlags(values));
      case "contract":
        return await contractCommand(ctx, rest, dataFlags(values));
      case "logs":
        return await logsCommand(ctx, rest, dataFlags(values));
      case "price":
        return await priceCommand(ctx, rest, dataFlags(values));
      case "security":
        return await securityCommand(ctx, rest, dataFlags(values));
      case "provider": {
        const sub = rest[0];
        if (sub !== "list" && sub !== "health") throw new UsageError(`unknown subcommand "provider ${sub ?? ""}"`, "Usage: splice provider list | splice provider health");
        return await providersCommand(ctx, rest.slice(1), dataFlags(values), sub);
      }
      case "ai":
        return await aiCommand(ctx, rest, liveFlags(values));
      case "github":
        return await githubCommand(ctx, rest, liveFlags(values));
      case "market":
        return await marketCommand(ctx, rest, liveFlags(values));
      case "web":
        return await webCommand(ctx, rest, liveFlags(values));
      case "ask":
      case "chat": {
        const flags: AskFlags = {};
        if (values.model !== undefined) flags.model = values.model;
        if (values.provider !== undefined) flags.provider = values.provider;
        if (values["max-tokens"] !== undefined) flags.maxTokens = values["max-tokens"];
        return command === "ask" ? await askCommand(ctx, rest, flags) : await chatCommand(ctx, rest, flags);
      }
      case "stock":
        return await stockCommand(ctx, rest, liveFlags(values));
      case "oracle":
        return await oracleCommand(ctx, rest, liveFlags(values));
      case "defi":
        return await defiCommand(ctx, rest, liveFlags(values));
      case "tokens":
        return await tokensCommand(ctx, rest, liveFlags(values));
      case "global":
        return await globalCommand(ctx, rest, liveFlags(values));
      case "dash":
        return await dashCommand(ctx, rest, liveFlags(values));
      case "perps":
        return await perpsCommand(ctx, rest, liveFlags(values));
      case "report":
        return await reportCommand(ctx, rest, liveFlags(values));
      case "compare":
        return await compareCommand(ctx, rest, liveFlags(values));
      case "watchlist":
        return await watchlistCommand(ctx, rest, liveFlags(values));
      case "watch":
        return await watchCommand(ctx, rest, liveFlags(values));
      case "radar":
        return await radarCommand(ctx, rest, liveFlags(values));
      case "macro":
        return await macroCommand(ctx, rest, liveFlags(values));
      case "news":
        return await newsCommand(ctx, rest, liveFlags(values));
      case "setup":
        return await setupCommand(ctx, rest, { ...(values.template === true ? { template: true } : {}), ...(values.init === true ? { init: true } : {}) });
      case "keys":
        return await keysCommand(ctx, rest, keyFlags(values));
      case "sign":
        return await signCommand(ctx, rest, keyFlags(values));
      case "namespace":
        return await namespaceCommand(ctx, rest);
    }
    return EXIT_USAGE;
  } catch (error) {
    return reportError(ctx, error);
  }
}
