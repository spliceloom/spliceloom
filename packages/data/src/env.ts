/**
 * Provider configuration from the environment. Only the variables listed in PROVIDER_ENV are
 * read — from process.env first, then from a `.env.local` / `.env` file (nearest to the working
 * directory, else `~/.splice/.env`) — and nothing else in those files is parsed into memory.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PROVIDER_ENV = [
  "ALCHEMY_API_KEY",
  "ALCHEMY_RPC_URL",
  "QUICKNODE_RPC_URL",
  "ROBINHOOD_PUBLIC_RPC_URL",
  "BLOCKSCOUT_API_KEY",
  "COINGECKO_API_KEY",
  "GOPLUS_APP_KEY",
  "GOPLUS_APP_SECRET",
  "ZERION_API_KEY",
  "GOLDSKY_API_KEY",
  "THEGRAPH_API_KEY",
  "STREAMINGFAST_API_TOKEN",
  // Oracle prices (Chainlink Data Streams)
  "CHAINLINK_DATA_STREAMS_API_KEY",
  "CHAINLINK_DATA_STREAMS_HMAC_SECRET",
  "CHAINLINK_CANDLESTICK_USER",
  "CHAINLINK_CANDLESTICK_API_KEY",
  // Token data (Codex)
  "CODEX_API_KEY",
  // US equities and news (Finnhub), macro (FRED)
  "FINNHUB_API_KEY",
  "FRED_API_KEY",
  // AI
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "AI_PROVIDER",
  "AI_DEFAULT_MODEL",
  "AI_ASK_MODEL",
  "AI_FALLBACK_PROVIDER",
  "AI_FALLBACK_MODEL",
  "GEMINI_DEFAULT_MODEL",
  // Web search / extraction
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  // Developer data
  "GITHUB_TOKEN",
  "GITHUB_API_VERSION",
] as const;

export type ProviderEnvName = (typeof PROVIDER_ENV)[number];
export type ProviderEnv = Partial<Record<ProviderEnvName, string>>;

/** Variables whose values are not secrets (public URLs, routing configuration); all others are redacted. */
const PUBLIC_VALUES: ReadonlySet<ProviderEnvName> = new Set(["ROBINHOOD_PUBLIC_RPC_URL", "AI_PROVIDER", "AI_DEFAULT_MODEL", "AI_ASK_MODEL", "AI_FALLBACK_PROVIDER", "AI_FALLBACK_MODEL", "GEMINI_DEFAULT_MODEL", "GITHUB_API_VERSION"]);

/** First `.env.local` or `.env` found walking up from `cwd`. */
export function findEnvFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of [".env.local", ".env"]) {
      const file = join(dir, name);
      if (existsSync(file)) return file;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `<SPLICE_HOME>/.env` (default `~/.splice/.env`): keys for every directory, used when no project file exists. */
export function userEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = join(env.SPLICE_HOME ?? join(homedir(), ".splice"), ".env");
  return existsSync(file) ? file : null;
}

/** Parses only the whitelisted keys of a dotenv file (KEY=value, optional quotes, # comments). */
export function parseProviderEnvFile(text: string): ProviderEnv {
  const wanted = new Set<string>(PROVIDER_ENV);
  const out: ProviderEnv = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !wanted.has(m[1]!)) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) out[m[1] as ProviderEnvName] = value;
  }
  return out;
}

export interface LoadedProviderEnv {
  values: ProviderEnv;
  /** Where the file values came from (null when only process.env was used). */
  file: string | null;
  /** Secret values, for redaction of provider errors (never printed). */
  secrets: string[];
}

export function loadProviderEnv(options: { env?: NodeJS.ProcessEnv; cwd?: string; file?: string | null } = {}): LoadedProviderEnv {
  const env = options.env ?? process.env;
  const fileName = options.file === undefined ? (env.SPLICE_ENV_FILE ?? findEnvFile(options.cwd ?? process.cwd()) ?? userEnvFile(env)) : options.file;
  const fromFile = fileName && existsSync(fileName) ? parseProviderEnvFile(readFileSync(fileName, "utf8")) : {};
  const values: ProviderEnv = {};
  for (const name of PROVIDER_ENV) {
    const value = env[name]?.trim() || fromFile[name];
    if (value) values[name] = value;
  }
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(values) as Array<[ProviderEnvName, string]>) {
    if (PUBLIC_VALUES.has(name)) continue;
    secrets.push(value);
    // Keys embedded in URL paths (Alchemy/QuickNode endpoints) are secrets too.
    if (/^https?:\/\//.test(value)) {
      try {
        const url = new URL(value);
        for (const segment of url.pathname.split("/")) if (segment.length >= 16) secrets.push(segment);
        for (const v of url.searchParams.values()) if (v.length >= 8) secrets.push(v);
        // QuickNode endpoint names (first label of <name>.<network>.quiknode.pro) are account-specific;
        // public network labels such as Alchemy's "robinhood-mainnet" are not.
        if (url.hostname.endsWith(".quiknode.pro") && url.hostname.split(".").length >= 4) secrets.push(url.hostname.split(".")[0]!);
      } catch {
        /* not a URL */
      }
    }
  }
  return { values, file: fileName && existsSync(fileName) ? fileName : null, secrets };
}
