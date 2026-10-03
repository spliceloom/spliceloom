/**
 * SpliceData — the public facade of the data layer (used by the SDK, CLI and MCP).
 *
 * Every method calls real providers through the ProviderRouter and returns a DataResult (LIVE /
 * CACHED / UNAVAILABLE / ERROR) with provenance, or a Composite of such results. Responses are
 * normalized to stable shapes; a field the provider did not return is absent — never 0,
 * "unknown" or an estimate.
 */
import { CHAINS, GLOBAL_SCOPE, chainScope, resolveChain, resolveMarketScope, type ChainInfo, type Scope } from "./chains.js";
import { loadProviderEnv, type LoadedProviderEnv } from "./env.js";
import { HttpClient, type FetchLike } from "./http.js";
import { ProviderRegistry, ProviderRouter, type HealthStatus, type Provider, type ProviderCapability, type ProviderData, type RunOptions } from "./provider.js";
import { GeminiProvider, OpenRouterProvider, type AiMessage, type AiModel, type AiProvider, type AiRequest, type AiResponse, type AiTool } from "./providers/ai.js";
import { DEFAULT_GITHUB_API_VERSION, GitHubProvider, GitHubRawProvider, parseRawUrl, rawUrl, type ListOptions, type RawLocation } from "./providers/github.js";
import { DexScreenerProvider, GeckoTerminalProvider, OHLCV_TIMEFRAMES, TRENDING_DURATIONS, type GeckoPoolSort, type MarketPair, type MarketSource } from "./providers/market.js";
import { ExaProvider, FirecrawlProvider, TavilyProvider, checkWebUrl, type WebSearchOptions, type WebSource } from "./providers/web.js";
import { BlockscoutProvider, CoinGeckoProvider, FearGreedProvider, GoPlusProvider, RobinhoodStockProvider, TheGraphProvider, ZerionProvider } from "./providers/rest.js";
import { RpcProvider, rpcProviders } from "./providers/rpc.js";
import { DefiLlamaProvider } from "./providers/defillama.js";
import { CodexProvider, type CodexToken } from "./providers/codex.js";
import { FinnhubProvider, FredProvider, LIGHTER_VENUES, LighterProvider, MACRO_SERIES, type PerpMarket } from "./providers/finance.js";
import { CANDLE_RESOLUTIONS, ChainlinkCandlestickProvider, ChainlinkStreamsProvider, type Candle, type OracleFeed } from "./providers/chainlink.js";
import { ProviderError, failure, isLive, unavailable, type DataResult, type ErrorResult } from "./result.js";
import { ADDRESS, HASH, addressFromWord, formatUnits, hexToBigInt, hexToDecimal, toHexQuantity } from "./units.js";

/** Model used when none is passed or configured (AI_DEFAULT_MODEL / GEMINI_DEFAULT_MODEL). */
export const DEFAULT_AI_MODELS: Record<string, string> = { openrouter: "openai/gpt-4o-mini", gemini: "gemini-2.5-flash" };

export interface SpliceDataOptions {
  /** Environment to read provider variables from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Directory to search for .env.local / .env (default process.cwd()). */
  cwd?: string;
  /** Explicit env file, or null to read process env only. */
  envFile?: string | null;
  /** Test seam (unit tests only): replaces network access for every provider. */
  fetch?: FetchLike;
  /** Runtime-native fetch (Cloudflare Workers); each provider stays limited to its own hosts. */
  platformFetch?: FetchLike;
}

export interface CallOptions {
  chain?: string | number;
  /** Bypass the cache and ask a provider now. */
  fresh?: boolean;
}

/** Options for market and developer data calls (scope comes from the arguments). */
export interface MarketOptions {
  fresh?: boolean;
}
export type GitHubOptions = MarketOptions;

export interface WebCallOptions {
  fresh?: boolean;
  /** Use only this provider (tavily, exa, firecrawl); otherwise the default order with fallback. */
  provider?: string;
  /** Results (search/similar: 1–20, default 5) or links (map: 1–500, default 50). */
  limit?: number;
  /** Include page text in search results. */
  content?: boolean;
  /** Max characters of page text per result/page (100–50000, default 5000). */
  maxCharacters?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface AiGenerateInput {
  /** User prompt (appended as the last user message). */
  prompt?: string;
  system?: string;
  messages?: AiMessage[];
  /** Model id for the provider (default: AI_DEFAULT_MODEL for the configured provider). */
  model?: string;
  /** Provider (default: AI_PROVIDER, else openrouter). */
  provider?: string;
  /** false: never use the configured fallback provider for this request. */
  fallback?: boolean;
  maxTokens?: number;
  temperature?: number;
  tools?: AiTool[];
  toolChoice?: AiRequest["toolChoice"];
  responseSchema?: AiRequest["responseSchema"];
  reasoning?: AiRequest["reasoning"];
  timeoutMs?: number;
}

export interface AiRouting {
  requestedProvider: string;
  requestedModel: string;
  actualProvider: string;
  actualModel: string;
  fallback: boolean;
  fallbackReason?: string;
}

export type AiResult = AiResponse & { routing: AiRouting };

export interface Composite {
  kind: "composite";
  subject: string;
  chain: string;
  chainId: number | null;
  generatedAt: string;
  sections: Record<string, DataResult<unknown>>;
}

export interface ProviderStatus {
  provider: string;
  kind: string;
  status: HealthStatus;
  /** All required configuration present (keys never shown). */
  configured: boolean;
  chains: string[];
  capabilities: string[];
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  detail: string | null;
  verifiedChainIds: Record<string, number>;
  endpoint: string;
  auth: string;
  envVars: Array<{ name: string; set: boolean }>;
  rateLimit: string;
  verification: string;
  unsupportedAtRuntime: string[];
}

const TTL = { block: 30_000, tx: 30_000, balance: 5_000, code: 60_000, verified: 600_000, metadata: 600_000, price: 30_000, security: 600_000, wallet: 30_000, indexed: 15_000, market: 30_000, pools: 60_000, stockList: 21_600_000, github: 60_000, web: 300_000 } as const;

/** Pool lists: CoinGecko onchain API first (Demo key, ~30 calls/min), then GeckoTerminal (10 calls/min). */
const POOL_SOURCES = ["coingecko", "geckoterminal"];
/** Pool bases that are not "tokens moving" (stablecoins and wrapped ETH on Robinhood Chain). */
const BASE_EXCLUDED = new Set(["WETH", "ETH", "USDG", "USDC", "USDT", "USDC.E", "DAI", "USDE", "PYUSD"]);

export type MoverKind = "gainers" | "losers" | "volume" | "volume-drop" | "volume-up" | "liquidity" | "txns";
export const MOVER_KINDS: MoverKind[] = ["gainers", "losers", "volume", "volume-drop", "volume-up", "liquidity", "txns"];
const MOVER_FORMULAS: Record<MoverKind, { metric: string; text: string }> = {
  gainers: { metric: "priceChangePct", text: "largest positive price change over {w}" },
  losers: { metric: "priceChangePct", text: "largest negative price change over {w}" },
  volume: { metric: "volumeUsd", text: "highest volume over {w}" },
  "volume-drop": { metric: "pace6h", text: "volume slowing: pace = volume_h6 × 4 ÷ volume_h24 (below 1 = the last 6h trade less than the 24h average; pools ≥ 24h old with ≥ $50k 24h volume)" },
  "volume-up": { metric: "pace1h", text: "volume accelerating: pace = volume_h1 × 24 ÷ volume_h24 (above 1 = the last hour trades more than the 24h average; ≥ $20k 24h volume)" },
  liquidity: { metric: "liquidityUsd", text: "deepest liquidity" },
  txns: { metric: "transactions", text: "most transactions (buys + sells) over {w}" },
};

export interface MoverOptions {
  kind?: MoverKind;
  window?: "h1" | "h6" | "h24";
  minLiquidity?: number;
  pages?: number;
  limit?: number;
}
/** Default US equities / ETFs for global.equities (all served by the Chainlink Candlestick API). */
export const DEFAULT_EQUITIES = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "COIN", "HOOD", "MSTR"];
export interface ResearchFlag {
  level: "danger" | "warn" | "info" | "ok";
  text: string;
  /** Provider and field the flag comes from. */
  source: string;
}
export interface ResearchReport {
  kind: "report";
  subject: string;
  address: string;
  chain: string;
  chainId: number;
  generatedAt: string;
  stats?: CodexToken;
  flags: ResearchFlag[];
  sections: Record<string, DataResult<unknown>>;
}
export type WhaleTrades = { address: string; symbol?: string; minUsd: number; scanned: number; window?: { from?: string; to?: string }; count: number; buyUsd: number; sellUsd: number; netFlowUsd: number; trades: Array<{ type?: string; valueUsd?: string; maker?: string; time?: string; priceUsd?: string; txHash?: string }>; wallets: Array<{ wallet: string; buyUsd: number; sellUsd: number; trades: number }> };
export type TokenList = { network: string; count: number; tokens: CodexToken[]; kind?: string; window?: string; filters?: string; ranking?: unknown };
export type TokenRankKind = "trending" | "hot" | "new" | "gainers" | "losers" | "volume" | "holders" | "mcap" | "txns" | "buyers";
interface TokenRankSpec {
  attribute: string;
  direction: "ASC" | "DESC";
  windowed: boolean;
  defaultWindow: "h1" | "h4" | "h12" | "h24";
  minLiquidity: number;
  filters?: Record<string, unknown>;
  keep?: (t: CodexToken) => boolean;
  text: string;
}
/** Codex rankings behind `splice tokens <kind>` (filters verified live on network 4663). */
export const TOKEN_RANKS: Record<TokenRankKind, TokenRankSpec> = {
  trending: { attribute: "trendingScore{w}", direction: "DESC", windowed: true, defaultWindow: "h24", minLiquidity: 10_000, filters: { trendingIgnored: false }, text: "Codex trending score over {w}" },
  hot: { attribute: "trendingScore{w}", direction: "DESC", windowed: true, defaultWindow: "h1", minLiquidity: 5_000, filters: { trendingIgnored: false }, text: "Codex trending score over {w} (hot right now)" },
  new: { attribute: "createdAt", direction: "DESC", windowed: false, defaultWindow: "h24", minLiquidity: 1_000, text: "newest tokens first" },
  gainers: { attribute: "change{w}", direction: "DESC", windowed: true, defaultWindow: "h24", minLiquidity: 10_000, filters: { volume24: { gt: 5_000 } }, keep: (t) => Object.values(t.changePct).some((v) => v > 0), text: "largest price increase over {w}; 24h volume > $5,000" },
  losers: { attribute: "change{w}", direction: "ASC", windowed: true, defaultWindow: "h24", minLiquidity: 10_000, filters: { volume24: { gt: 5_000 } }, text: "largest price decrease over {w}; 24h volume > $5,000" },
  volume: { attribute: "volume{w}", direction: "DESC", windowed: true, defaultWindow: "h24", minLiquidity: 10_000, text: "highest volume over {w}" },
  holders: { attribute: "holders", direction: "DESC", windowed: false, defaultWindow: "h24", minLiquidity: 10_000, filters: { volume24: { gt: 1_000 } }, text: "most holders; 24h volume > $1,000" },
  mcap: { attribute: "marketCap", direction: "DESC", windowed: false, defaultWindow: "h24", minLiquidity: 10_000, filters: { volume24: { gt: 10_000 } }, text: "largest market cap; 24h volume > $10,000" },
  txns: { attribute: "txnCount24", direction: "DESC", windowed: false, defaultWindow: "h24", minLiquidity: 10_000, text: "most transactions in 24h" },
  buyers: { attribute: "uniqueBuys24", direction: "DESC", windowed: false, defaultWindow: "h24", minLiquidity: 10_000, text: "most unique buyers in 24h" },
};
const CODEX_TIMEFRAMES: Record<string, { resolution: string; seconds: number }> = { "1m": { resolution: "1", seconds: 60 }, "5m": { resolution: "5", seconds: 300 }, "15m": { resolution: "15", seconds: 900 }, "30m": { resolution: "30", seconds: 1800 }, "1h": { resolution: "60", seconds: 3600 }, "4h": { resolution: "240", seconds: 14_400 }, "12h": { resolution: "720", seconds: 43_200 }, "1d": { resolution: "1D", seconds: 86_400 } };
export type StockTokenList = { chain: string; source: string; count: number; tokens: Array<{ symbol: string; name?: string; address: string; coingeckoId?: string; multiplier?: string; status?: string }> };
export type PoolList = { network: string; pools: MarketPair[]; sort?: string; page?: number };
export type MoverList = { network: string; kind: MoverKind; window: string; formula: string; scanned: number; pools: Array<MarketPair & { metric: { name: string; value: number } }> };

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// Input limits for AI requests (validated before any provider is contacted).
const AI_LIMITS = { messages: 100, chars: 200_000, maxTokens: 16_384, tools: 128, imageBytes: 5 * 1024 * 1024 };

function validateAi(input: AiGenerateInput & { model: string; messages: AiMessage[] }): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,199}$/.test(input.model)) return `invalid model id: ${input.model}`;
  if (input.messages.length === 0) return "a prompt or at least one message is required";
  if (input.messages.length > AI_LIMITS.messages) return `at most ${AI_LIMITS.messages} messages`;
  let chars = 0;
  for (const m of input.messages) {
    if (!["system", "user", "assistant", "tool"].includes(m.role)) return `invalid message role: ${String(m.role)}`;
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text" && typeof part.text === "string") chars += part.text.length;
        else if (part.type === "image_url" && typeof part.url === "string") {
          if (!/^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/.test(part.url)) return "image_url must be an https URL or a data:image/(png|jpeg|webp|gif);base64 URL";
          if (part.url.length > AI_LIMITS.imageBytes * 1.4) return "image too large (max 5 MB)";
        } else return "invalid content part";
      }
    } else return "message content must be a string or content parts";
  }
  if (chars === 0) return "the prompt is empty";
  if (chars > AI_LIMITS.chars) return `prompt too long (${chars} characters, max ${AI_LIMITS.chars})`;
  if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > AI_LIMITS.maxTokens)) return `maxTokens must be 1–${AI_LIMITS.maxTokens}`;
  if (input.temperature !== undefined && (typeof input.temperature !== "number" || input.temperature < 0 || input.temperature > 2)) return "temperature must be 0–2";
  if (input.tools) {
    if (input.tools.length > AI_LIMITS.tools) return `at most ${AI_LIMITS.tools} tools`;
    for (const t of input.tools) if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name ?? "") || typeof t.parameters !== "object" || t.parameters === null) return `invalid tool definition: ${String(t.name)}`;
  }
  if (input.responseSchema && (!/^[A-Za-z0-9_-]{1,64}$/.test(input.responseSchema.name ?? "") || typeof input.responseSchema.schema !== "object")) return "responseSchema needs a name (letters, digits, _ or -) and a JSON schema object";
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 120_000)) return "timeoutMs must be 1000–120000";
  return null;
}

const checkQuery = (q: string) => (typeof q === "string" && q.trim().length > 0 && q.length <= 256 ? null : "query must be 1–256 characters");
const checkPage = (o: ListOptions) =>
  (o.page !== undefined && (!Number.isInteger(o.page) || o.page < 1 || o.page > 1000)) || (o.perPage !== undefined && (!Number.isInteger(o.perPage) || o.perPage < 1 || o.perPage > 100)) ? "page must be 1–1000 and perPage 1–100" : null;
const checkPath = (p: string) => (typeof p === "string" && p.length <= 1000 && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === ".") && !/[\\\0]/.test(p) ? null : `invalid repository path: ${p}`);
const checkRef = (r: string | undefined) => (r === undefined || (/^[A-Za-z0-9._\/+-]{1,255}$/.test(r) && !r.includes("..")) ? null : `invalid git ref: ${r}`);
const checkState = (s: string | undefined) => (s === undefined || ["open", "closed", "all"].includes(s) ? null : "state must be open, closed or all");
const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
};
const MAX_LOG_RANGE = 2_000;
const MAX_LOGS = 1_000;

type Raw = Record<string, unknown>;

/** A token balance. Fields the provider did not return are absent (Alchemy returns no metadata). */
export interface TokenBalance {
  token: { address?: string; name?: string; symbol?: string; decimals?: string; type?: string };
  raw?: string;
  formatted?: string;
  tokenId?: string;
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined);
const prune = <T extends Raw>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function normalizeBlock(b: Raw) {
  const ts = hexToDecimal(String(b.timestamp));
  const txs = Array.isArray(b.transactions) ? b.transactions : [];
  return prune({
    number: hexToDecimal(String(b.number)),
    hash: str(b.hash),
    parentHash: str(b.parentHash),
    timestamp: ts,
    time: new Date(Number(ts) * 1000).toISOString(),
    miner: str(b.miner),
    gasUsed: b.gasUsed ? hexToDecimal(String(b.gasUsed)) : undefined,
    gasLimit: b.gasLimit ? hexToDecimal(String(b.gasLimit)) : undefined,
    baseFeePerGas: b.baseFeePerGas ? hexToDecimal(String(b.baseFeePerGas)) : undefined,
    transactionCount: txs.length,
    transactions: txs.map((t) => (typeof t === "string" ? t : String((t as Raw).hash))),
  });
}

function normalizeTx(t: Raw) {
  return prune({
    hash: str(t.hash),
    blockNumber: t.blockNumber ? hexToDecimal(String(t.blockNumber)) : undefined,
    blockHash: str(t.blockHash),
    from: str(t.from),
    to: str(t.to),
    value: t.value ? hexToDecimal(String(t.value)) : undefined,
    valueEth: t.value ? formatUnits(hexToBigInt(String(t.value)), 18) : undefined,
    nonce: t.nonce ? hexToDecimal(String(t.nonce)) : undefined,
    gas: t.gas ? hexToDecimal(String(t.gas)) : undefined,
    gasPrice: t.gasPrice ? hexToDecimal(String(t.gasPrice)) : undefined,
    maxFeePerGas: t.maxFeePerGas ? hexToDecimal(String(t.maxFeePerGas)) : undefined,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas ? hexToDecimal(String(t.maxPriorityFeePerGas)) : undefined,
    type: t.type ? hexToDecimal(String(t.type)) : undefined,
    input: str(t.input),
  });
}

function normalizeReceipt(r: Raw) {
  const logs = Array.isArray(r.logs) ? (r.logs as Raw[]) : [];
  return prune({
    status: r.status === "0x1" ? "success" : r.status === "0x0" ? "reverted" : undefined,
    blockNumber: r.blockNumber ? hexToDecimal(String(r.blockNumber)) : undefined,
    blockHash: str(r.blockHash),
    gasUsed: r.gasUsed ? hexToDecimal(String(r.gasUsed)) : undefined,
    effectiveGasPrice: r.effectiveGasPrice ? hexToDecimal(String(r.effectiveGasPrice)) : undefined,
    contractAddress: str(r.contractAddress),
    logCount: logs.length,
    logs: logs.map((l) => prune({ address: str(l.address), topics: l.topics as string[], data: str(l.data), logIndex: l.logIndex ? hexToDecimal(String(l.logIndex)) : undefined })),
  });
}

function normalizeLog(l: Raw) {
  return prune({
    address: str(l.address),
    topics: l.topics as string[],
    data: str(l.data),
    blockNumber: l.blockNumber ? hexToDecimal(String(l.blockNumber)) : undefined,
    blockHash: str(l.blockHash),
    transactionHash: str(l.transactionHash),
    logIndex: l.logIndex ? hexToDecimal(String(l.logIndex)) : undefined,
    removed: typeof l.removed === "boolean" ? l.removed : undefined,
  });
}

export class SpliceData {
  readonly registry = new ProviderRegistry();
  readonly router: ProviderRouter;
  readonly env: LoadedProviderEnv;
  private readonly lastCheck = new Map<string, string>();

  constructor(options: SpliceDataOptions = {}) {
    const loadOptions: { env?: NodeJS.ProcessEnv; cwd?: string; file?: string | null } = {};
    if (options.env) loadOptions.env = options.env;
    if (options.cwd) loadOptions.cwd = options.cwd;
    if (options.envFile !== undefined) loadOptions.file = options.envFile;
    this.env = loadProviderEnv(loadOptions);
    const v = this.env.values;
    const http = (hosts: string[], timeoutMs?: number, rateLimit?: { requests: number; perMs: number }) => {
      const httpOptions: ConstructorParameters<typeof HttpClient>[0] = { hosts, secrets: this.env.secrets };
      if (timeoutMs) httpOptions.timeoutMs = timeoutMs;
      if (rateLimit) httpOptions.rateLimit = rateLimit;
      if (options.fetch) httpOptions.fetch = options.fetch;
      if (options.platformFetch) httpOptions.platformFetch = options.platformFetch;
      return new HttpClient(httpOptions);
    };
    for (const p of rpcProviders(v, http)) this.registry.register(p);
    // Blockscout's indexed endpoints can take >15 s under load (observed); allow 30 s.
    this.registry.register(new BlockscoutProvider(http(["api.blockscout.com"], 30_000), v.BLOCKSCOUT_API_KEY));
    this.registry.register(new CoinGeckoProvider(http(["api.coingecko.com"]), v.COINGECKO_API_KEY));
    this.registry.register(new FearGreedProvider(http(["api.alternative.me"])));
    this.registry.register(new GoPlusProvider(http(["api.gopluslabs.io"]), v.GOPLUS_APP_KEY, v.GOPLUS_APP_SECRET));
    this.registry.register(new ZerionProvider(http(["api.zerion.io"]), v.ZERION_API_KEY));
    this.registry.register(new TheGraphProvider(http(["gateway.thegraph.com", "token-api.thegraph.com"]), v.THEGRAPH_API_KEY, v.STREAMINGFAST_API_TOKEN));
    this.registry.register(new RobinhoodStockProvider(http(["api.robinhood.com"])));
    // Oracle prices: Chainlink Data Streams (catalog public; reports need a subscribed key).
    this.registry.register(new ChainlinkStreamsProvider(http(["api.dataengine.chain.link"]), v.CHAINLINK_DATA_STREAMS_API_KEY, v.CHAINLINK_DATA_STREAMS_HMAC_SECRET));
    // Every token on Robinhood Chain with live stats (Codex GraphQL; free plan 10k requests/month).
    this.registry.register(new CodexProvider(http(["graph.codex.io"], 20_000), v.CODEX_API_KEY));
    // US equities and news (Finnhub), macro (FRED), perpetuals on Robinhood Chain and Lighter mainnet (Lighter).
    this.registry.register(new FinnhubProvider(http(["finnhub.io"]), v.FINNHUB_API_KEY));
    this.registry.register(new FredProvider(http(["api.stlouisfed.org"]), v.FRED_API_KEY));
    this.registry.register(new LighterProvider(http(["api.rh.lighter.xyz", "mainnet.zklighter.elliot.ai"])));
    // DeFi: DefiLlama public APIs (TVL, protocols, DEX volume, fees, stablecoins, yields, prices).
    this.registry.register(new DefiLlamaProvider(http(["api.llama.fi", "coins.llama.fi", "stablecoins.llama.fi", "yields.llama.fi"], 45_000)));
    this.registry.register(new ChainlinkCandlestickProvider(http(["priceapi.dataengine.chain.link"]), v.CHAINLINK_CANDLESTICK_USER, v.CHAINLINK_CANDLESTICK_API_KEY));
    // Market data across DEX networks (public APIs; client-side limits match the documented ones).
    this.registry.register(new DexScreenerProvider(http(["api.dexscreener.com"], undefined, { requests: 300, perMs: 60_000 })));
    this.registry.register(new GeckoTerminalProvider(http(["api.geckoterminal.com"], undefined, { requests: 10, perMs: 60_000 })));
    // AI: OpenRouter (primary), Gemini (when GEMINI_API_KEY is set).
    this.registry.register(new OpenRouterProvider(http(["openrouter.ai"], 120_000), v.OPENROUTER_API_KEY));
    this.registry.register(new GeminiProvider(http(["generativelanguage.googleapis.com"], 120_000), v.GEMINI_API_KEY));
    // Developer data: GitHub REST API with the token, then anonymously; raw files (public only).
    const githubVersion = v.GITHUB_API_VERSION ?? DEFAULT_GITHUB_API_VERSION;
    this.registry.register(new GitHubProvider(http(["api.github.com"]), v.GITHUB_TOKEN, githubVersion, "token"));
    this.registry.register(new GitHubProvider(http(["api.github.com"]), undefined, githubVersion, "public"));
    this.registry.register(new GitHubRawProvider(http(["raw.githubusercontent.com"])));
    // Web search / extraction: the providers fetch the web; Splice only reaches their APIs.
    this.registry.register(new TavilyProvider(http(["api.tavily.com"], 60_000), v.TAVILY_API_KEY));
    this.registry.register(new ExaProvider(http(["api.exa.ai"], 60_000), v.EXA_API_KEY));
    this.registry.register(new FirecrawlProvider(http(["api.firecrawl.dev"], 90_000), v.FIRECRAWL_API_KEY));
    this.router = new ProviderRouter(this.registry);
  }

  // ------------------------------------------------------------------------------- helpers

  private chain(input: CallOptions["chain"]): ChainInfo | ErrorResult {
    const chain = resolveChain(input);
    return chain ?? failure("INVALID_INPUT", "chain", null, `unknown chain "${String(input)}"; known: ${CHAINS.map((c) => `${c.key} (${c.chainId})`).join(", ")}`);
  }

  private invalid(capability: string, chain: Scope | null, message: string): ErrorResult {
    return failure("INVALID_INPUT", capability, chain, message);
  }

  private run<T>(capability: ProviderCapability, chain: Scope, op: (p: Provider) => Promise<ProviderData<T>>, options: Omit<CallOptions, "chain"> & RunOptions = {}): Promise<DataResult<T>> {
    const run: RunOptions = {};
    if (options.fresh !== undefined) run.fresh = options.fresh;
    if (options.ttlMs !== undefined) run.ttlMs = options.ttlMs;
    if (options.cacheKey !== undefined) run.cacheKey = options.cacheKey;
    if (options.prefer !== undefined) run.prefer = options.prefer;
    if (options.only !== undefined) run.only = options.only;
    return this.router.run(capability, chain, op, run);
  }

  /** JSON-RPC capability with the block number the answer refers to pinned in provenance. */
  private rpcAt<T>(capability: ProviderCapability, chain: ChainInfo, build: (rpc: RpcProvider, blockTag: string, blockNumber: string) => Promise<T>, options: CallOptions & RunOptions = {}): Promise<DataResult<T>> {
    return this.run<T>(
      capability,
      chain,
      async (p) => {
        const rpc = p as RpcProvider;
        const { result: head } = await rpc.call<string>(chain, "eth_blockNumber");
        return { data: await build(rpc, head, hexToDecimal(head)), blockNumber: hexToDecimal(head) };
      },
      options,
    );
  }

  private composite(subject: string, chain: ChainInfo, sections: Record<string, DataResult<unknown>>): Composite {
    return { kind: "composite", subject, chain: chain.key, chainId: chain.chainId, generatedAt: new Date().toISOString(), sections };
  }

  private blockscout(p: Provider) {
    return p as BlockscoutProvider;
  }

  // ---------------------------------------------------------------------------------- chains

  readonly chains = {
    list: () => CHAINS.map((c) => ({ ...c, default: c.key === "robinhood" })),
    /** Chain metadata plus a live chain-id verification and head block from an RPC provider. */
    info: async (options: CallOptions = {}): Promise<DataResult<unknown>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.run(
        "chain.id",
        chain,
        async (p) => {
          const rpc = p as RpcProvider;
          const chainId = await rpc.chainId(chain);
          const { result: head } = await rpc.call<string>(chain, "eth_blockNumber");
          return { data: { ...chain, verifiedChainId: chainId, chainIdMatches: chainId === chain.chainId, latestBlock: hexToDecimal(head) }, blockNumber: hexToDecimal(head) };
        },
        { fresh: true },
      );
    },
  };

  // --------------------------------------------------------------------------------- onchain

  readonly onchain = {
    latestBlock: async (options: CallOptions = {}): Promise<DataResult<ReturnType<typeof normalizeBlock>>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.run(
        "block.latest",
        chain,
        async (p) => {
          const { result } = await (p as RpcProvider).call<Raw | null>(chain, "eth_getBlockByNumber", ["latest", false]);
          if (!result) throw new ProviderError("provider returned no latest block", "invalid_response");
          const block = normalizeBlock(result);
          return { data: block, blockNumber: block.number, blockHash: block.hash };
        },
        { fresh: true },
      );
    },

    block: async (id: string | number, options: CallOptions = {}): Promise<DataResult<ReturnType<typeof normalizeBlock>>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const text = String(id).trim();
      let method: string;
      let param: string;
      if (HASH.test(text)) [method, param] = ["eth_getBlockByHash", text];
      else if (/^\d{1,15}$/.test(text)) [method, param] = ["eth_getBlockByNumber", toHexQuantity(Number(text))];
      else if (/^0x[0-9a-fA-F]{1,13}$/.test(text)) [method, param] = ["eth_getBlockByNumber", text.toLowerCase()];
      else if (text === "latest") return this.onchain.latestBlock(options);
      else return this.invalid("block.get", chain, `block must be a number, 0x-quantity, block hash or "latest": ${text}`);
      return this.run(
        "block.get",
        chain,
        async (p) => {
          const { result } = await (p as RpcProvider).call<Raw | null>(chain, method, [param, false]);
          if (!result) throw new ProviderError(`block ${text} not found on ${chain.name}`, "not_found");
          const block = normalizeBlock(result);
          return { data: block, blockNumber: block.number, blockHash: block.hash };
        },
        { ...options, ttlMs: TTL.block, cacheKey: param },
      );
    },

    /** Transaction plus receipt (from the same provider). `status: "pending"` when not yet mined. */
    transaction: async (hash: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!HASH.test(hash)) return this.invalid("tx.get", chain, `transaction hash must be 0x + 64 hex characters: ${hash}`);
      return this.run(
        "tx.get",
        chain,
        async (p) => {
          const rpc = p as RpcProvider;
          const { result: tx } = await rpc.call<Raw | null>(chain, "eth_getTransactionByHash", [hash]);
          if (!tx) throw new ProviderError(`transaction ${hash} not found on ${chain.name}`, "not_found");
          const { result: receipt } = await rpc.call<Raw | null>(chain, "eth_getTransactionReceipt", [hash]);
          const t = normalizeTx(tx);
          const r = receipt ? normalizeReceipt(receipt) : null;
          const data = { ...t, status: r?.status ?? "pending", receipt: r };
          const out: ProviderData<typeof data> = { data };
          if (t.blockNumber) out.blockNumber = t.blockNumber;
          if (t.blockHash) out.blockHash = t.blockHash;
          return out;
        },
        { ...options, ttlMs: TTL.tx, cacheKey: hash.toLowerCase() },
      );
    },

    balance: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("account.balance", chain, `address must be 0x + 40 hex characters: ${address}`);
      return this.rpcAt(
        "account.balance",
        chain,
        async (rpc, tag) => {
          const { result } = await rpc.call<string>(chain, "eth_getBalance", [address, tag]);
          const wei = hexToBigInt(result);
          return { address, symbol: chain.nativeCurrency.symbol, wei: wei.toString(), formatted: formatUnits(wei, chain.nativeCurrency.decimals) };
        },
        { ...options, ttlMs: TTL.balance, cacheKey: address.toLowerCase() },
      );
    },

    nonce: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("account.nonce", chain, `invalid address: ${address}`);
      return this.rpcAt("account.nonce", chain, async (rpc, tag) => ({ address, nonce: hexToDecimal((await rpc.call<string>(chain, "eth_getTransactionCount", [address, tag])).result) }), { ...options, ttlMs: TTL.balance, cacheKey: address.toLowerCase() });
    },

    code: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("contract.code", chain, `invalid address: ${address}`);
      return this.rpcAt(
        "contract.code",
        chain,
        async (rpc, tag) => {
          const { result } = await rpc.call<string>(chain, "eth_getCode", [address, tag]);
          const bytes = (result.length - 2) / 2;
          return { address, isContract: bytes > 0, sizeBytes: bytes, bytecode: result };
        },
        { ...options, ttlMs: TTL.code, cacheKey: address.toLowerCase() },
      );
    },

    call: async (to: string, data: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(to)) return this.invalid("contract.call", chain, `invalid contract address: ${to}`);
      if (!/^0x([0-9a-fA-F]{2}){4,}$/.test(data) || data.length > 100_002) return this.invalid("contract.call", chain, "call data must be 0x-prefixed hex (selector + arguments)");
      return this.rpcAt("contract.call", chain, async (rpc, tag) => ({ to, data, result: (await rpc.call<string>(chain, "eth_call", [{ to, data }, tag])).result }), options);
    },

    gasPrice: async (options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.rpcAt("gas.price", chain, async (rpc) => {
        const wei = hexToBigInt((await rpc.call<string>(chain, "eth_gasPrice")).result);
        return { wei: wei.toString(), gwei: formatUnits(wei, 9) };
      }, { fresh: true });
    },

    logs: async (filter: { address?: string; fromBlock?: string | number; toBlock?: string | number; topics?: Array<string | null> }, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (filter.address !== undefined && !ADDRESS.test(filter.address)) return this.invalid("logs.query", chain, `invalid address: ${filter.address}`);
      for (const t of filter.topics ?? []) if (t !== null && !HASH.test(t)) return this.invalid("logs.query", chain, `topics must be 32-byte hex or null: ${t}`);
      return this.run(
        "logs.query",
        chain,
        async (p) => {
          const rpc = p as RpcProvider;
          const head = BigInt((await rpc.call<string>(chain, "eth_blockNumber")).result);
          const parse = (v: string | number | undefined, fallback: bigint) => (v === undefined || v === "latest" ? fallback : typeof v === "number" || /^\d+$/.test(String(v)) ? BigInt(v) : hexToBigInt(String(v)));
          const to = parse(filter.toBlock, head);
          const from = parse(filter.fromBlock, to);
          if (from > to) throw new ProviderError(`fromBlock ${from} is after toBlock ${to}`, "not_found");
          if (to - from + 1n > BigInt(MAX_LOG_RANGE)) throw new ProviderError(`block range ${to - from + 1n} exceeds ${MAX_LOG_RANGE}; narrow fromBlock/toBlock`, "not_found");
          const query: Raw = { fromBlock: toHexQuantity(from), toBlock: toHexQuantity(to) };
          if (filter.address) query.address = filter.address;
          if (filter.topics?.length) query.topics = filter.topics;
          const { result } = await rpc.call<Raw[]>(chain, "eth_getLogs", [query]);
          const logs = (result ?? []).map(normalizeLog);
          return {
            data: { fromBlock: from.toString(), toBlock: to.toString(), count: logs.length, truncated: logs.length > MAX_LOGS, logs: logs.slice(0, MAX_LOGS) },
            blockNumber: to.toString(),
          };
        },
        options,
      );
    },

    /** Blockscout's indexed view of a transaction (status, method, fee, token transfers, revert reason). */
    indexedTransaction: async (hash: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!HASH.test(hash)) return this.invalid("tx.indexed", chain, `invalid transaction hash: ${hash}`);
      return this.run(
        "tx.indexed",
        chain,
        async (p) => {
          const t = await this.blockscout(p).get(chain, `/transactions/${hash}`);
          return {
            data: prune({
              hash,
              status: str(t.status),
              result: str(t.result),
              method: str(t.method),
              blockNumber: str(t.block_number) ?? str(t.block),
              timestamp: str(t.timestamp),
              confirmations: str(t.confirmations),
              fee: str((t.fee as Raw | undefined)?.value),
              revertReason: t.revert_reason ?? undefined,
              tokenTransfers: Array.isArray(t.token_transfers) ? t.token_transfers : undefined,
            }),
          };
        },
        { ...options, ttlMs: TTL.indexed, cacheKey: hash.toLowerCase() },
      );
    },

    trace: async (hash: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!HASH.test(hash)) return this.invalid("trace.transaction", chain, `invalid transaction hash: ${hash}`);
      return this.run(
        "trace.transaction",
        chain,
        async (p) => {
          if (p instanceof RpcProvider) return { data: { format: "callTracer", trace: (await p.call<unknown>(chain, "debug_traceTransaction", [hash, { tracer: "callTracer" }])).result } };
          return { data: { format: "blockscout-raw-trace", trace: await this.blockscout(p).get<unknown>(chain, `/transactions/${hash}/raw-trace`) } };
        },
        { ...options, ttlMs: TTL.tx, cacheKey: hash.toLowerCase() },
      );
    },

    transfers: async (address: string, options: CallOptions & { limit?: number } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("token.transfers", chain, `invalid address: ${address}`);
      const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
      return this.run(
        "token.transfers",
        chain,
        async (p) => {
          if (p instanceof BlockscoutProvider) {
            const res = await p.get<{ items?: Raw[] }>(chain, `/addresses/${address}/token-transfers`);
            const items = (res.items ?? []).slice(0, limit).map((t) => {
              const token = (t.token ?? {}) as Raw;
              const total = (t.total ?? {}) as Raw;
              const decimals = str(total.decimals) ?? str(token.decimals);
              const raw = str(total.value);
              return prune({
                hash: str(t.transaction_hash),
                blockNumber: str(t.block_number),
                timestamp: str(t.timestamp),
                from: str((t.from as Raw | undefined)?.hash),
                to: str((t.to as Raw | undefined)?.hash),
                type: str(t.token_type) ?? str(token.type),
                token: prune({ address: str(token.address_hash) ?? str(token.address), symbol: str(token.symbol), name: str(token.name), decimals }),
                value: raw,
                formatted: raw && decimals && /^\d+$/.test(raw) ? formatUnits(BigInt(raw), Number(decimals)) : undefined,
              });
            });
            return { data: { address, count: items.length, transfers: items } };
          }
          const rpc = p as RpcProvider;
          const base = { category: ["external", "erc20", "erc721", "erc1155"], maxCount: toHexQuantity(limit), order: "desc", withMetadata: true };
          const [sent, received] = await Promise.all([
            rpc.call<{ transfers?: Raw[] }>(chain, "alchemy_getAssetTransfers", [{ ...base, fromAddress: address }]),
            rpc.call<{ transfers?: Raw[] }>(chain, "alchemy_getAssetTransfers", [{ ...base, toAddress: address }]),
          ]);
          const all = [...(sent.result.transfers ?? []), ...(received.result.transfers ?? [])]
            .map((t) => {
              const rc = (t.rawContract ?? {}) as Raw;
              const decimals = rc.decimal ? Number(hexToBigInt(String(rc.decimal))) : t.category === "external" ? 18 : undefined;
              const raw = rc.value ? hexToDecimal(String(rc.value)) : undefined;
              return prune({
                hash: str(t.hash),
                blockNumber: t.blockNum ? hexToDecimal(String(t.blockNum)) : undefined,
                timestamp: str((t.metadata as Raw | undefined)?.blockTimestamp),
                from: str(t.from),
                to: str(t.to),
                type: str(t.category),
                token: prune({ address: str(rc.address), symbol: str(t.asset), decimals: decimals === undefined ? undefined : String(decimals) }),
                value: raw,
                formatted: raw !== undefined && decimals !== undefined ? formatUnits(BigInt(raw), decimals) : undefined,
              });
            })
            .sort((a, b) => Number(BigInt(b.blockNumber ?? "0") - BigInt(a.blockNumber ?? "0")))
            .slice(0, limit);
          return { data: { address, count: all.length, transfers: all } };
        },
        { ...options, prefer: ["blockscout", "alchemy"], ttlMs: TTL.indexed, cacheKey: `${address.toLowerCase()}:${limit}` },
      );
    },

    /** Token: metadata, total supply (eth_call), holders, market price, pools, security. */
    token: async (address: string, options: CallOptions = {}): Promise<Composite | ErrorResult> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("token", chain, `invalid token address: ${address}`);
      const metadata = await this.tokenMetadata(chain, address, options);
      const decimals = isLive(metadata) ? metadata.data.decimals : undefined;
      const [totalSupply, holders, price, pools, security] = await Promise.all([
        this.rpcAt(
          "contract.call",
          chain,
          async (rpc, tag) => {
            const { result } = await rpc.call<string>(chain, "eth_call", [{ to: address, data: "0x18160ddd" }, tag]);
            if (!result || result === "0x") throw new ProviderError("totalSupply() returned no data (not an ERC-20?)", "not_found");
            const raw = hexToBigInt(result);
            return prune({ raw: raw.toString(), formatted: decimals !== undefined ? formatUnits(raw, decimals) : undefined, method: "totalSupply()" });
          },
          options,
        ),
        this.run(
          "token.holders",
          chain,
          async (p) => {
            const bs = this.blockscout(p);
            const [token, list] = await Promise.all([bs.get(chain, `/tokens/${address}`), bs.get<{ items?: Raw[] }>(chain, `/tokens/${address}/holders`)]);
            const holdersCount = str(token.holders_count) ?? str(token.holders);
            return {
              data: prune({
                holdersCount,
                top: (list.items ?? []).slice(0, 10).map((h) => prune({ address: str((h.address as Raw | undefined)?.hash), value: str(h.value) })),
              }),
            };
          },
          { ...options, ttlMs: TTL.indexed, cacheKey: address.toLowerCase() },
        ),
        this.market.price(address, options),
        this.market.pools(address, options),
        this.security.token(address, options),
      ]);
      return this.composite(address, chain, { metadata, totalSupply, holders, price, pools, security });
    },

    /** Contract: bytecode, verified source/ABI (Blockscout), EIP-1967 proxy slots (RPC), activity counters. */
    contract: async (address: string, options: CallOptions = {}): Promise<Composite | ErrorResult> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("contract", chain, `invalid contract address: ${address}`);
      const [code, verified, proxy, activity] = await Promise.all([
        this.onchain.code(address, options),
        this.run(
          "contract.verified",
          chain,
          async (p) => {
            const c = await this.blockscout(p).get(chain, `/smart-contracts/${address}`);
            const abi = Array.isArray(c.abi) ? (c.abi as Raw[]) : undefined;
            if (c.is_verified !== true) throw new ProviderError("contract source is not verified on Blockscout", "not_listed");
            return {
              data: prune({
                verified: true,
                name: str(c.name),
                compilerVersion: str(c.compiler_version),
                language: str(c.language),
                optimizationEnabled: typeof c.optimization_enabled === "boolean" ? c.optimization_enabled : undefined,
                verifiedAt: str(c.verified_at),
                licenseType: str(c.license_type),
                proxyType: str(c.proxy_type),
                implementations: Array.isArray(c.implementations) ? (c.implementations as Raw[]).map((i) => prune({ address: str(i.address_hash) ?? str(i.address), name: str(i.name) })) : undefined,
                functions: abi?.filter((e) => e.type === "function").map((e) => `${e.name}(${((e.inputs as Raw[]) ?? []).map((i) => i.type).join(",")})`),
                events: abi?.filter((e) => e.type === "event").map((e) => `${e.name}(${((e.inputs as Raw[]) ?? []).map((i) => i.type).join(",")})`),
                abi,
              }),
            };
          },
          { ...options, ttlMs: TTL.verified, cacheKey: address.toLowerCase() },
        ),
        this.rpcAt(
          "contract.storage",
          chain,
          async (rpc, tag) => {
            const read = async (slot: string) => addressFromWord((await rpc.call<string>(chain, "eth_getStorageAt", [address, slot, tag])).result);
            const [implementation, admin, beacon] = await Promise.all([read(EIP1967.implementation), read(EIP1967.admin), read(EIP1967.beacon)]);
            return { standard: "EIP-1967", isProxy: Boolean(implementation || beacon), implementation, admin, beacon };
          },
          { ...options, ttlMs: TTL.code, cacheKey: `proxy:${address.toLowerCase()}` },
        ),
        this.run(
          "address.counters",
          chain,
          async (p) => ({ data: await this.blockscout(p).get(chain, `/addresses/${address}/counters`) }),
          { ...options, ttlMs: TTL.indexed, cacheKey: address.toLowerCase() },
        ),
      ]);
      return this.composite(address, chain, { code, verified, proxy, activity });
    },
  };

  private tokenMetadata(chain: ChainInfo, address: string, options: CallOptions) {
    return this.run<{ address: string; name?: string; symbol?: string; decimals?: number; type?: string; totalSupply?: string }>(
      "token.metadata",
      chain,
      async (p) => {
        if (p instanceof BlockscoutProvider) {
          const t = await p.get(chain, `/tokens/${address}`);
          const decimals = str(t.decimals);
          return { data: prune({ address, name: str(t.name), symbol: str(t.symbol), decimals: decimals ? Number(decimals) : undefined, type: str(t.type), totalSupply: str(t.total_supply) }) };
        }
        const { result } = await (p as RpcProvider).call<{ name?: string | null; symbol?: string | null; decimals?: number | null }>(chain, "alchemy_getTokenMetadata", [address]);
        return { data: prune({ address, name: result.name ?? undefined, symbol: result.symbol ?? undefined, decimals: result.decimals ?? undefined }) };
      },
      { ...options, ttlMs: TTL.metadata, cacheKey: address.toLowerCase(), prefer: ["blockscout", "alchemy"] },
    );
  }

  // ---------------------------------------------------------------------------------- wallet

  readonly wallet = {
    /** Native and token balances. */
    balances: async (address: string, options: CallOptions = {}): Promise<Composite | ErrorResult> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("wallet.balances", chain, `invalid address: ${address}`);
      const [native, tokens] = await Promise.all([this.onchain.balance(address, options), this.tokenBalances(chain, address, options)]);
      return this.composite(address, chain, { native, tokens });
    },

    transfers: (address: string, options: CallOptions & { limit?: number } = {}) => this.onchain.transfers(address, options),

    portfolio: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("wallet.portfolio", chain, `invalid address: ${address}`);
      return this.run(
        "wallet.portfolio",
        chain,
        async (p) => {
          const z = p as ZerionProvider;
          const [portfolio, positions] = await Promise.all([
            z.get<{ data?: { attributes?: Raw } }>(`/wallets/${address}/portfolio?filter[positions]=no_filter&currency=usd`),
            z.get<{ data?: Raw[] }>(`/wallets/${address}/positions/?filter[chain_ids]=${chain.ids.zerionChainId}&filter[positions]=no_filter&currency=usd&sort=value`),
          ]);
          const attrs = portfolio.data?.attributes ?? {};
          const byChain = (attrs.positions_distribution_by_chain ?? {}) as Record<string, unknown>;
          return {
            data: prune({
              address,
              currency: "usd",
              totalAllChains: (attrs.total as Raw | undefined)?.positions,
              valueOnChain: byChain[chain.ids.zerionChainId ?? ""],
              distributionByChain: byChain,
              changes: attrs.changes,
              positions: (positions.data ?? []).map((pos) => {
                const a = (pos.attributes ?? {}) as Raw;
                const info = (a.fungible_info ?? {}) as Raw;
                const qty = (a.quantity ?? {}) as Raw;
                return prune({ id: str(pos.id), name: str(a.name) ?? str(info.name), symbol: str(info.symbol), type: str(a.position_type), quantity: str(qty.numeric), value: a.value ?? undefined, price: a.price ?? undefined });
              }),
            }),
            notes: ["totalAllChains is Zerion's value across every chain it tracks; valueOnChain is the share on this chain"],
          };
        },
        { ...options, ttlMs: TTL.wallet, cacheKey: address.toLowerCase() },
      );
    },

    transactions: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("address.transactions", chain, `invalid address: ${address}`);
      return this.run(
        "address.transactions",
        chain,
        async (p) => {
          const res = await this.blockscout(p).get<{ items?: Raw[] }>(chain, `/addresses/${address}/transactions`);
          const items = (res.items ?? []).map((t) =>
            prune({
              hash: str(t.hash),
              blockNumber: str(t.block_number) ?? str(t.block),
              timestamp: str(t.timestamp),
              from: str((t.from as Raw | undefined)?.hash),
              to: str((t.to as Raw | undefined)?.hash),
              value: str(t.value),
              status: str(t.status),
              method: str(t.method),
              fee: str((t.fee as Raw | undefined)?.value),
            }),
          );
          return { data: { address, count: items.length, transactions: items } };
        },
        { ...options, ttlMs: TTL.indexed, cacheKey: address.toLowerCase() },
      );
    },

    /** Everything derivable about a wallet from live providers. */
    inspect: async (address: string, options: CallOptions = {}): Promise<Composite | ErrorResult> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("wallet.inspect", chain, `invalid address: ${address}`);
      const [native, nonce, code, tokens, transfers, transactions, counters, portfolio, security] = await Promise.all([
        this.onchain.balance(address, options),
        this.onchain.nonce(address, options),
        this.onchain.code(address, options),
        this.tokenBalances(chain, address, options),
        this.onchain.transfers(address, { ...options, limit: 10 }),
        this.wallet.transactions(address, options),
        this.run("address.counters", chain, async (p) => ({ data: await this.blockscout(p).get(chain, `/addresses/${address}/counters`) }), { ...options, ttlMs: TTL.indexed, cacheKey: address.toLowerCase() }),
        this.wallet.portfolio(address, options),
        this.security.address(address, options),
      ]);
      // Last observed activity is derivable from the newest indexed transaction; first activity
      // would need the full history and is reported as unavailable rather than guessed.
      const sections: Record<string, DataResult<unknown>> = { native, nonce, code, tokens, transfers, transactions, counters, portfolio, security };
      if (isLive(transactions)) {
        const newest = (transactions.data as { transactions: Array<{ timestamp?: string; hash?: string }> }).transactions[0];
        sections.lastObservedActivity = newest?.timestamp
          ? { ...transactions, capability: "address.lastActivity", data: { timestamp: newest.timestamp, transaction: newest.hash } }
          : { status: "UNAVAILABLE", code: "CAPABILITY_UNAVAILABLE", capability: "address.lastActivity", chain: chain.key, chainId: chain.chainId, provider: "blockscout", reason: "no indexed transactions for this address", timestamp: new Date().toISOString() };
      }
      sections.firstObservedActivity = { status: "UNAVAILABLE", code: "CAPABILITY_UNAVAILABLE", capability: "address.firstActivity", chain: chain.key, chainId: chain.chainId, provider: null, reason: "requires the complete transaction history; not derived from a partial page", timestamp: new Date().toISOString() };
      return this.composite(address, chain, sections);
    },
  };

  private tokenBalances(chain: ChainInfo, address: string, options: CallOptions) {
    return this.run<{ address: string; count: number; balances: TokenBalance[] }>(
      "token.balances",
      chain,
      async (p) => {
        if (p instanceof BlockscoutProvider) {
          const items = await p.get<Raw[]>(chain, `/addresses/${address}/token-balances`);
          const balances = (Array.isArray(items) ? items : []).map((b) => {
            const token = (b.token ?? {}) as Raw;
            const decimals = str(token.decimals);
            const raw = str(b.value);
            return prune({
              token: prune({ address: str(token.address_hash) ?? str(token.address), name: str(token.name), symbol: str(token.symbol), decimals, type: str(token.type) }),
              raw,
              formatted: raw && decimals && /^\d+$/.test(raw) ? formatUnits(BigInt(raw), Number(decimals)) : undefined,
              tokenId: str(b.token_id),
            });
          });
          return { data: { address, count: balances.length, balances } };
        }
        const rpc = p as RpcProvider;
        const { result: head } = await rpc.call<string>(chain, "eth_blockNumber");
        const { result } = await rpc.call<{ tokenBalances?: Array<{ contractAddress: string; tokenBalance: string | null; error?: string | null }> }>(chain, "alchemy_getTokenBalances", [address]);
        const balances = (result.tokenBalances ?? [])
          .filter((b) => b.tokenBalance && !b.error && hexToBigInt(b.tokenBalance) > 0n)
          .map((b) => ({ token: { address: b.contractAddress }, raw: hexToDecimal(b.tokenBalance!) }));
        return { data: { address, count: balances.length, balances }, blockNumber: hexToDecimal(head), notes: ["alchemy_getTokenBalances returns raw balances without token metadata"] };
      },
      { ...options, prefer: ["blockscout", "alchemy"], ttlMs: TTL.balance, cacheKey: address.toLowerCase() },
    );
  }

  // ---------------------------------------------------------------------------------- market

  readonly market = {
    /** `ETH` (native) or a token contract address on the chain. Unlisted tokens are UNAVAILABLE. */
    price: async (token: string, options: CallOptions & { vs?: string } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const vs = (options.vs ?? "usd").toLowerCase();
      if (!/^[a-z]{3,5}$/.test(vs)) return this.invalid("market.price", chain, `invalid quote currency: ${vs}`);
      const native = token.trim().toUpperCase() === chain.nativeCurrency.symbol;
      if (!native && !ADDRESS.test(token)) return this.invalid("market.price", chain, `token must be ${chain.nativeCurrency.symbol} or a token contract address: ${token}`);
      if (native) {
        const coin = chain.ids.coingeckoNativeCoin;
        if (!coin) return this.invalid("market.price", chain, `no market id for the native currency of ${chain.name}`);
        return this.run(
          "market.price",
          chain,
          async (p) => {
            const body = await (p as CoinGeckoProvider).get<Record<string, Record<string, number>>>(`/simple/price?ids=${coin}&vs_currencies=${vs}&include_last_updated_at=true&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`);
            const row = body[coin];
            if (!row || row[vs] === undefined) throw new ProviderError(`CoinGecko has no ${vs} price for ${coin}`, "not_listed");
            return { data: prune({ asset: chain.nativeCurrency.symbol, coinId: coin, vs, price: row[vs], change24hPct: row[`${vs}_24h_change`], marketCap: row[`${vs}_market_cap`], volume24h: row[`${vs}_24h_vol`], lastUpdatedAt: row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString() : undefined }) };
          },
          { ...options, ttlMs: TTL.price, cacheKey: `${coin}:${vs}` },
        );
      }
      const platform = chain.ids.coingeckoPlatform;
      if (!platform) return this.invalid("market.tokenPrice", chain, `no market platform for ${chain.name}`);
      return this.run<Record<string, unknown>>(
        "market.tokenPrice",
        chain,
        async (p) => {
          if (!(p instanceof CoinGeckoProvider)) {
            // GeckoTerminal (same capability, real fallback): its own token price for this network.
            const out = await (p as unknown as MarketSource).tokenPrice!(chainScope(chain), [token], vs);
            const row = (out.data.prices as Array<{ priceUsd: string }>)[0]!;
            return { ...out, data: { token, network: out.data.network, vs, price: row.priceUsd } };
          }
          const body = await (p as CoinGeckoProvider).get<Record<string, Record<string, number>>>(`/simple/token_price/${platform}?contract_addresses=${token}&vs_currencies=${vs}&include_last_updated_at=true&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`);
          const row = body[token.toLowerCase()];
          if (!row || row[vs] === undefined) throw new ProviderError(`CoinGecko has no market listing for ${token} on ${platform}`, "not_listed");
          return { data: prune({ token, platform, vs, price: row[vs], change24hPct: row[`${vs}_24h_change`], marketCap: row[`${vs}_market_cap`], volume24h: row[`${vs}_24h_vol`], lastUpdatedAt: row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString() : undefined }) };
        },
        { ...options, ttlMs: TTL.price, cacheKey: `${token.toLowerCase()}:${vs}` },
      );
    },

    /** DEX pools and liquidity (GeckoTerminal data via CoinGecko onchain API). */
    pools: async (token: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(token)) return this.invalid("market.pools", chain, `invalid token address: ${token}`);
      const network = chain.ids.coingeckoOnchainNetwork;
      if (!network) return this.invalid("market.pools", chain, `no onchain market network for ${chain.name}`);
      return this.run(
        "market.pools",
        chain,
        async (p) => {
          let body: { data?: Raw[] };
          try {
            body = await (p as CoinGeckoProvider).get(`/onchain/networks/${network}/tokens/${token}/pools`);
          } catch (error) {
            if (error instanceof ProviderError && error.kind === "not_found") throw new ProviderError(`no DEX pools indexed for ${token} on ${network}`, "not_listed", 404);
            throw error;
          }
          const pools = (body.data ?? []).map((pool) => {
            const a = (pool.attributes ?? {}) as Raw;
            const rel = (pool.relationships ?? {}) as Raw;
            return prune({
              address: str(a.address),
              name: str(a.name),
              dex: str(((rel.dex as Raw | undefined)?.data as Raw | undefined)?.id),
              reserveUsd: str(a.reserve_in_usd),
              baseTokenPriceUsd: str(a.base_token_price_usd),
              quoteTokenPriceUsd: str(a.quote_token_price_usd),
              volume24hUsd: str((a.volume_usd as Raw | undefined)?.h24),
              createdAt: str(a.pool_created_at),
            });
          });
          return { data: { token, network, count: pools.length, pools } };
        },
        { ...options, ttlMs: TTL.price, cacheKey: token.toLowerCase() },
      );
    },

    // DEX market data across networks (DexScreener, GeckoTerminal). `network` is a Splice chain
    // ("robinhood", 4663) or a provider-native network id ("solana", "base", "eth"…).

    /** Pairs matching a query (DexScreener search). */
    search: async (query: string, options: MarketOptions = {}) => {
      if (typeof query !== "string" || query.trim().length === 0 || query.length > 100) return this.invalid("market.search", GLOBAL_SCOPE, "query must be 1–100 characters");
      return this.run("market.search", { key: "any", name: "any network", chainId: null }, (p) => (p as unknown as MarketSource).search!(query.trim()), { ...options, ttlMs: TTL.market, cacheKey: query.trim().toLowerCase() });
    },
    /** Token data per provider (GeckoTerminal: token totals; DexScreener: the token's pairs). */
    token: async (network: string | number, address: string, options: MarketOptions = {}) => {
      const scope = this.marketScope("market.token", network, address);
      if ("status" in scope) return scope;
      return this.run("market.token", scope, (p) => (p as unknown as MarketSource).token!(scope, address), { ...options, ttlMs: TTL.market, cacheKey: address.toLowerCase() });
    },
    /** DEX pairs/pools of a token. */
    pairs: async (network: string | number, address: string, options: MarketOptions = {}) => {
      const scope = this.marketScope("market.token_pairs", network, address);
      if ("status" in scope) return scope;
      return this.run("market.token_pairs", scope, (p) => (p as unknown as MarketSource).tokenPairs!(scope, address), { ...options, ttlMs: TTL.market, cacheKey: address.toLowerCase() });
    },
    /** One pair/pool by its address. */
    pair: async (network: string | number, address: string, options: MarketOptions = {}) => {
      const scope = this.marketScope("market.pair", network, address, true);
      if ("status" in scope) return scope;
      return this.run("market.pair", scope, (p) => (p as unknown as MarketSource).pair!(scope, address), { ...options, ttlMs: TTL.market, cacheKey: address.toLowerCase() });
    },
    /** Token price on a network: CoinGecko (Robinhood platform) → GeckoTerminal. Never averaged. */
    tokenPrice: async (network: string | number, address: string, options: MarketOptions & { vs?: string } = {}) => {
      const scope = this.marketScope("market.tokenPrice", network, address);
      if ("status" in scope) return scope;
      if (scope.chain) return this.market.price(address, { ...options, chain: scope.chain.key });
      const vs = (options.vs ?? "usd").toLowerCase();
      return this.run(
        "market.tokenPrice",
        scope,
        async (p) => {
          const out = await (p as unknown as MarketSource).tokenPrice!(scope, [address], vs);
          return { ...out, data: { token: address, network: out.data.network, vs, price: (out.data.prices as Array<{ priceUsd: string }>)[0]!.priceUsd } };
        },
        { ...options, ttlMs: TTL.price, cacheKey: `${address.toLowerCase()}:${vs}` },
      );
    },
    /** OHLCV candles of a pool (GeckoTerminal). timeframe: day (1) | hour (1, 4, 12) | minute (1, 5, 15). */
    ohlcv: async (network: string | number, pool: string, options: MarketOptions & { timeframe?: string; aggregate?: number; limit?: number } = {}) => {
      const scope = this.marketScope("market.ohlcv", network, pool, true);
      if ("status" in scope) return scope;
      const timeframe = options.timeframe ?? "day";
      const aggregate = options.aggregate ?? 1;
      const limit = options.limit ?? 100;
      if (!OHLCV_TIMEFRAMES[timeframe]?.includes(aggregate)) return this.invalid("market.ohlcv", scope, `timeframe/aggregate must be one of: ${Object.entries(OHLCV_TIMEFRAMES).map(([t, a]) => `${t} (${a.join(", ")})`).join("; ")}`);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return this.invalid("market.ohlcv", scope, "limit must be 1–1000");
      return this.run("market.ohlcv", scope, (p) => (p as GeckoTerminalProvider).ohlcv(scope, pool, timeframe, aggregate, limit), { ...options, ttlMs: TTL.market, cacheKey: `${pool.toLowerCase()}:${timeframe}:${aggregate}:${limit}` });
    },
    /** Recent trades of a pool (GeckoTerminal). */
    trades: async (network: string | number, pool: string, options: MarketOptions = {}) => {
      const scope = this.marketScope("market.trades", network, pool, true);
      if ("status" in scope) return scope;
      return this.run("market.trades", scope, (p) => (p as GeckoTerminalProvider).trades(scope, pool), { ...options, ttlMs: TTL.market, cacheKey: pool.toLowerCase() });
    },
    /** Networks GeckoTerminal lists (ids usable as `network`). */
    networks: async (options: MarketOptions = {}) => this.run("market.networks", GLOBAL_SCOPE, (p) => (p as GeckoTerminalProvider).networks(), { ...options, ttlMs: 3_600_000 }),
    dexes: async (network: string | number, options: MarketOptions = {}) => {
      const scope = this.marketScope("market.dexes", network);
      if ("status" in scope) return scope;
      return this.run("market.dexes", scope, (p) => (p as GeckoTerminalProvider).dexes(scope), { ...options, ttlMs: 3_600_000 });
    },
    /** Trending pools as GeckoTerminal ranks them (CoinGecko onchain API first when its key is set). */
    trendingPools: async (network: string | number, options: MarketOptions & { duration?: string } = {}) => {
      const scope = this.marketScope("market.trending_pools", network);
      if ("status" in scope) return scope;
      if (options.duration !== undefined && !(TRENDING_DURATIONS as readonly string[]).includes(options.duration)) return this.invalid("market.trending_pools", scope, `duration must be one of ${TRENDING_DURATIONS.join(", ")}`);
      const d = options.duration;
      return this.run<PoolList>("market.trending_pools", scope, (p) => (p.name === "coingecko" ? (p as unknown as CoinGeckoProvider).pools(scope.chain!, "trending_pools", d) : (p as GeckoTerminalProvider).pools(scope, "trending_pools", d)), { ...pick(options, ["fresh"]), ttlMs: TTL.pools, prefer: POOL_SOURCES, cacheKey: d ?? "" });
    },
    /** Newest pools on a network. */
    newPools: async (network: string | number, options: MarketOptions = {}) => {
      const scope = this.marketScope("market.new_pools", network);
      if ("status" in scope) return scope;
      return this.run<PoolList>("market.new_pools", scope, (p) => (p.name === "coingecko" ? (p as unknown as CoinGeckoProvider).pools(scope.chain!, "new_pools") : (p as GeckoTerminalProvider).pools(scope, "new_pools")), { ...pick(options, ["fresh"]), ttlMs: TTL.pools, prefer: POOL_SOURCES });
    },
    /** Pools ranked by 24h volume or 24h transaction count (20 per page, pages 1–10). */
    topPools: async (network: string | number, options: MarketOptions & { sort?: "volume" | "txns"; page?: number } = {}) => {
      const scope = this.marketScope("market.top_pools", network);
      if ("status" in scope) return scope;
      const page = options.page ?? 1;
      if (!Number.isInteger(page) || page < 1 || page > 10) return this.invalid("market.top_pools", scope, "page must be 1–10 (providers list at most 200 pools)");
      const sort: GeckoPoolSort = options.sort === "txns" ? "h24_tx_count_desc" : "h24_volume_usd_desc";
      return this.run<PoolList>("market.top_pools", scope, (p) => (p.name === "coingecko" ? (p as unknown as CoinGeckoProvider).topPools(scope.chain!, sort, page) : (p as GeckoTerminalProvider).topPools(scope, sort, page)), { ...pick(options, ["fresh"]), ttlMs: TTL.pools, prefer: POOL_SOURCES, cacheKey: `${sort}:${page}` });
    },
    /**
     * Rankings computed by Splice from the providers' own per-pool fields (never invented):
     * gainers / losers (price change over the window), volume (highest volume), volume-drop
     * (6h pace vs. 24h: volume_h6×4 / volume_h24), volume-up (1h pace: volume_h1×24 / volume_h24),
     * liquidity, txns. Scans the top pools by 24h volume (plus trending pools for price moves),
     * drops thin pools (liquidity below `minLiquidity`, default $10k) and stablecoin/ETH bases, and
     * keeps the deepest pool per token. The formula is part of the result.
     */
    movers: async (network: string | number, options: MarketOptions & MoverOptions = {}): Promise<DataResult<MoverList>> => {
      const scope = this.marketScope("market.top_pools", network);
      if ("status" in scope) return scope;
      return this.rankPools(scope.key, options);
    },
    /**
     * The same token asked of every market provider separately: one section per source, each with
     * its own provenance. Values are never merged, averaged or turned into a consensus.
     */
    quotes: async (network: string | number, address: string, options: MarketOptions = {}): Promise<Composite | ErrorResult> => {
      const scope = this.marketScope("market.token", network, address);
      if ("status" in scope) return scope;
      const sources = this.registry.declaring("market.token", scope).map((p) => p.name);
      const sections: Record<string, DataResult<unknown>> = {};
      await Promise.all(sources.map(async (name) => (sections[name] = await this.run("market.token", scope, (p) => (p as unknown as MarketSource).token!(scope, address), { ...options, only: [name], ttlMs: TTL.market, cacheKey: `${address.toLowerCase()}:${name}` }))));
      // Token price for Splice chains (CoinGecko, else GeckoTerminal — the serving provider is in its provenance).
      if (scope.chain) sections.price = await this.market.price(address, { ...options, chain: scope.chain.key });
      return { kind: "composite", subject: address, chain: scope.key, chainId: scope.chainId, generatedAt: new Date().toISOString(), sections };
    },
  };

  /** Shared ranking for market movers and stock movers (see market.movers). */
  private async rankPools(network: string, options: MarketOptions & MoverOptions, keep?: (p: MarketPair) => boolean, label = "pools"): Promise<DataResult<MoverList>> {
    const kind = options.kind ?? "gainers";
    const window = options.window ?? "h24";
    const minLiquidity = options.minLiquidity ?? 10_000;
    const pages = options.pages ?? 3;
    const limit = options.limit ?? 20;
    if (!MOVER_KINDS.includes(kind)) return this.invalid("market.top_pools", null, `kind must be one of ${MOVER_KINDS.join(", ")}`);
    if (!["h1", "h6", "h24"].includes(window)) return this.invalid("market.top_pools", null, "window must be h1, h6 or h24");
    if (!Number.isInteger(pages) || pages < 1 || pages > 10) return this.invalid("market.top_pools", null, "pages must be 1–10");
    if (!Number.isFinite(minLiquidity) || minLiquidity < 0) return this.invalid("market.top_pools", null, "minLiquidity must be ≥ 0");
    const f = pick(options, ["fresh"]);
    const first = await this.market.topPools(network, { ...f, sort: kind === "txns" ? "txns" : "volume", page: 1 });
    if (!isLive(first)) return first;
    const notes: string[] = [];
    const pools: MarketPair[] = [...first.data.pools];
    for (let page = 2; page <= pages; page++) {
      const next = await this.market.topPools(network, { ...f, sort: kind === "txns" ? "txns" : "volume", page });
      if (!isLive(next)) {
        notes.push(`page ${page} not scanned: ${next.status === "UNAVAILABLE" ? next.reason : next.message}`);
        break;
      }
      pools.push(...next.data.pools);
    }
    if (kind === "gainers" || kind === "losers" || kind === "volume-up") {
      const trending = await this.market.trendingPools(network, { ...f, duration: window === "h1" ? "1h" : window === "h6" ? "6h" : "24h" });
      if (isLive(trending)) pools.push(...trending.data.pools);
      else notes.push(`trending pools not included: ${trending.status === "UNAVAILABLE" ? trending.reason : trending.message}`);
    }
    const n = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
    const seen = new Set<string>();
    const best = new Map<string, MarketPair>();
    for (const p of pools) {
      const id = p.pairAddress?.toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (keep ? !keep(p) : BASE_EXCLUDED.has((p.baseToken?.symbol ?? "").toUpperCase())) continue;
      if ((n(p.liquidityUsd) ?? 0) < minLiquidity) continue;
      const token = (p.baseToken?.address ?? id).toLowerCase();
      const current = best.get(token);
      if (!current || (n(p.liquidityUsd) ?? 0) > (n(current.liquidityUsd) ?? 0)) best.set(token, p);
    }
    const ageHours = (p: MarketPair) => (p.createdAt ? (Date.now() - Date.parse(p.createdAt)) / 3_600_000 : Infinity);
    const vol = (p: MarketPair, w: string) => n(p.volumeUsd?.[w]);
    const metricOf = (p: MarketPair): number | undefined => {
      switch (kind) {
        case "gainers":
        case "losers":
          return n(p.priceChangePct?.[window]);
        case "volume":
          return vol(p, window);
        case "liquidity":
          return n(p.liquidityUsd);
        case "txns": {
          const t = p.transactions?.[window];
          return t ? (t.buys ?? 0) + (t.sells ?? 0) : undefined;
        }
        case "volume-drop": {
          const h24 = vol(p, "h24");
          const h6 = vol(p, "h6");
          if (h24 === undefined || h6 === undefined || h24 < 50_000 || ageHours(p) < 24) return undefined;
          return (h6 * 4) / h24;
        }
        case "volume-up": {
          const h24 = vol(p, "h24");
          const h1 = vol(p, "h1");
          if (h24 === undefined || h1 === undefined || h24 < 20_000) return undefined;
          return (h1 * 24) / h24;
        }
      }
    };
    const ranked = [...best.values()]
      .map((p) => ({ p, m: metricOf(p) }))
      .filter((x): x is { p: MarketPair; m: number } => x.m !== undefined && Number.isFinite(x.m) && (kind !== "gainers" || x.m > 0) && (kind !== "losers" || x.m < 0) && (kind !== "volume-drop" || x.m < 1))
      .sort((a, b) => (kind === "losers" || kind === "volume-drop" ? a.m - b.m : b.m - a.m))
      .slice(0, limit)
      .map(({ p, m }) => ({ ...p, metric: { name: MOVER_FORMULAS[kind].metric, value: Number(m.toFixed(4)) } }));
    const formula = `${MOVER_FORMULAS[kind].text.replace("{w}", window)}; ${label} with liquidity ≥ $${minLiquidity.toLocaleString("en-US")}, deepest pool per token; scanned ${seen.size} pools`;
    const provenance = { ...first.provenance, resource: `${first.provenance.resource}${pages > 1 ? ` (+${pages - 1} pages)` : ""}`, notes: [...(first.provenance.notes ?? []), ...notes] };
    if (!provenance.notes.length) delete (provenance as { notes?: string[] }).notes;
    return { status: first.status, capability: "market.top_pools", data: { network, kind, window, formula, scanned: seen.size, pools: ranked }, provenance } as DataResult<MoverList>;
  }

  private marketScope(capability: string, network: string | number, address?: string, pair = false): Scope | ErrorResult {
    const scope = resolveMarketScope(network);
    if (!scope) return failure("INVALID_INPUT", capability, null, `invalid network "${String(network)}": use a Splice chain (robinhood, 4663) or a provider network id such as solana, base, eth (see market networks)`);
    if (address !== undefined) {
      const evm = pair ? /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/ : ADDRESS;
      if (scope.chain ? !evm.test(address) : !/^[A-Za-z0-9_.:-]{20,100}$/.test(address)) return this.invalid(capability, scope, `invalid ${pair ? "pair/pool" : "token"} address for ${scope.name}: ${address}`);
    }
    return scope;
  }

  // -------------------------------------------------------------------------------------- AI

  /** AI routing configuration (non-secret). */
  aiConfig(): { provider: string; defaultModel?: string; fallbackProvider?: string; fallbackModel?: string } {
    const v = this.env.values;
    return prune({ provider: v.AI_PROVIDER ?? "openrouter", defaultModel: v.AI_DEFAULT_MODEL, fallbackProvider: v.AI_FALLBACK_PROVIDER, fallbackModel: v.AI_FALLBACK_MODEL }) as ReturnType<SpliceData["aiConfig"]>;
  }

  readonly ai = {
    /**
     * A completion from a real model. Routing is explicit: the requested (or configured) provider and
     * model; a fallback provider is used only when AI_FALLBACK_PROVIDER/AI_FALLBACK_MODEL are configured
     * (and `fallback` is not false), and the result then states requested vs. actual provider/model and why.
     */
    generate: async (input: AiGenerateInput): Promise<DataResult<AiResult>> => {
      const config = this.aiConfig();
      const provider = input.provider ?? config.provider;
      const aiProviders = this.registry.all().filter((p) => p.kind === "ai").map((p) => p.name);
      if (!aiProviders.includes(provider)) return this.invalid("ai.generate", GLOBAL_SCOPE, `unknown AI provider "${provider}"; known: ${aiProviders.join(", ")}`);
      const configured = provider === config.provider ? config.defaultModel : provider === "gemini" ? this.env.values.GEMINI_DEFAULT_MODEL : undefined;
      // Without a configured model, a known default of that provider (stated in the result's routing).
      const model = input.model ?? configured ?? DEFAULT_AI_MODELS[provider];
      if (!model) return this.invalid("ai.generate", GLOBAL_SCOPE, `no model: pass a model, or set AI_DEFAULT_MODEL (for ${config.provider}) / GEMINI_DEFAULT_MODEL`);
      const messages: AiMessage[] = input.messages ? [...input.messages] : [];
      if (input.system) messages.unshift({ role: "system", content: input.system });
      if (input.prompt !== undefined) messages.push({ role: "user", content: input.prompt });
      const problem = validateAi({ ...input, model, messages });
      if (problem) return this.invalid("ai.generate", GLOBAL_SCOPE, problem);
      const capability: ProviderCapability = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"))
        ? "ai.multimodal"
        : input.responseSchema
          ? "ai.structured_output"
          : input.tools?.length
            ? "ai.tools"
            : input.reasoning
              ? "ai.reason"
              : "ai.generate";
      const route = [provider];
      const notes: string[] = [];
      if (input.fallback !== false && config.fallbackProvider && config.fallbackProvider !== provider) {
        if (config.fallbackModel) route.push(config.fallbackProvider);
        else notes.push(`AI_FALLBACK_PROVIDER=${config.fallbackProvider} is ignored: AI_FALLBACK_MODEL is not set`);
      }
      const request = (m: string): AiRequest => {
        const r: AiRequest = { model: m, messages };
        if (input.maxTokens !== undefined) r.maxTokens = input.maxTokens;
        if (input.temperature !== undefined) r.temperature = input.temperature;
        if (input.tools) r.tools = input.tools;
        if (input.toolChoice) r.toolChoice = input.toolChoice;
        if (input.responseSchema) r.responseSchema = input.responseSchema;
        if (input.reasoning) r.reasoning = input.reasoning;
        if (input.timeoutMs !== undefined) r.timeoutMs = input.timeoutMs;
        return r;
      };
      const result = await this.run<AiResponse>(capability, GLOBAL_SCOPE, (p) => (p as unknown as AiProvider).generate(request(p.name === provider ? model : config.fallbackModel!)), { fresh: true, ttlMs: 0, only: route });
      if (!isLive(result)) return result;
      const usedFallback = result.provenance.source !== provider;
      const routing: AiRouting = prune({
        requestedProvider: provider,
        requestedModel: model,
        actualProvider: result.data.provider,
        actualModel: result.data.model,
        fallback: usedFallback,
        fallbackReason: usedFallback ? (result.provenance.fallbackFrom ?? []).map((f) => `${f.provider}: ${f.error}`).join("; ") : undefined,
      }) as AiRouting;
      if (notes.length) result.provenance.notes = [...(result.provenance.notes ?? []), ...notes];
      return { ...result, data: { ...result.data, routing } };
    },
    /** Models a provider offers (real list), optionally filtered by a substring of id/name. */
    models: async (options: { provider?: string; search?: string; fresh?: boolean } = {}): Promise<DataResult<{ provider: string; search?: string; count: number; models: AiModel[] }>> => {
      const provider = options.provider ?? this.aiConfig().provider;
      const result = await this.run<AiModel[]>("ai.models", GLOBAL_SCOPE, (p) => (p as unknown as AiProvider).models(), { ...(options.fresh ? { fresh: true } : {}), only: [provider], ttlMs: 600_000, cacheKey: provider });
      if (!isLive(result) || !options.search) return isLive(result) ? { ...result, data: { provider, count: result.data.length, models: result.data } } : result;
      const q = options.search.toLowerCase();
      const models = result.data.filter((m) => m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
      return { ...result, data: { provider, search: options.search, count: models.length, models } };
    },
  };

  // ------------------------------------------------------------------------------------- web

  private webOptions(capability: string, o: WebCallOptions): WebSearchOptions | ErrorResult {
    const limit = o.limit ?? 5;
    const maxCharacters = o.maxCharacters ?? 5_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return this.invalid(capability, GLOBAL_SCOPE, "limit must be 1–20");
    if (!Number.isInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > 50_000) return this.invalid(capability, GLOBAL_SCOPE, "maxCharacters must be 100–50000");
    for (const d of [...(o.includeDomains ?? []), ...(o.excludeDomains ?? [])]) if (!/^[a-z0-9.-]{1,253}$/i.test(d) || !d.includes(".")) return this.invalid(capability, GLOBAL_SCOPE, `invalid domain: ${d}`);
    if ((o.includeDomains?.length ?? 0) > 20 || (o.excludeDomains?.length ?? 0) > 20) return this.invalid(capability, GLOBAL_SCOPE, "at most 20 include/exclude domains");
    const out: WebSearchOptions = { limit, content: o.content === true, maxCharacters };
    if (o.includeDomains?.length) out.includeDomains = o.includeDomains;
    if (o.excludeDomains?.length) out.excludeDomains = o.excludeDomains;
    return out;
  }

  private webRoute(o: WebCallOptions, prefer: string[]): RunOptions {
    const run: RunOptions = { ttlMs: TTL.web };
    if (o.fresh) run.fresh = true;
    if (o.provider) run.only = [o.provider];
    else run.prefer = prefer;
    return run;
  }

  /**
   * Web search, page extraction, site maps, similar pages and cited answers from Tavily, Exa and
   * Firecrawl. Results are third-party web content (untrusted text) with provider attribution.
   */
  readonly web = {
    search: async (query: string, options: WebCallOptions = {}) => {
      if (typeof query !== "string" || query.trim().length === 0 || query.length > 400) return this.invalid("web.search", GLOBAL_SCOPE, "query must be 1–400 characters");
      const o = this.webOptions("web.search", options);
      if ("status" in o) return o;
      return this.run("web.search", GLOBAL_SCOPE, (p) => (p as unknown as WebSource).search!(query.trim(), o), { ...this.webRoute(options, ["tavily", "exa", "firecrawl"]), cacheKey: JSON.stringify([query.trim(), o, options.provider]) });
    },
    /** Readable text of up to 10 pages. */
    extract: async (urls: string | string[], options: WebCallOptions = {}) => {
      const list = Array.isArray(urls) ? urls : [urls];
      if (list.length === 0 || list.length > 10) return this.invalid("web.extract", GLOBAL_SCOPE, "1–10 URLs");
      for (const u of list) {
        const problem = checkWebUrl(u);
        if (problem) return this.invalid("web.extract", GLOBAL_SCOPE, problem);
      }
      const o = this.webOptions("web.extract", options);
      if ("status" in o) return o;
      return this.run("web.extract", GLOBAL_SCOPE, (p) => (p as unknown as WebSource).extract!(list, o.maxCharacters), { ...this.webRoute(options, ["tavily", "firecrawl", "exa"]), cacheKey: JSON.stringify([list, o.maxCharacters, options.provider]) });
    },
    /** URLs of a site (site map discovered by the provider). */
    map: async (url: string, options: WebCallOptions = {}) => {
      const problem = checkWebUrl(url);
      if (problem) return this.invalid("web.map", GLOBAL_SCOPE, problem);
      const limit = options.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return this.invalid("web.map", GLOBAL_SCOPE, "limit must be 1–500");
      return this.run("web.map", GLOBAL_SCOPE, (p) => (p as unknown as WebSource).map!(url, limit), { ...this.webRoute(options, ["firecrawl", "tavily"]), cacheKey: JSON.stringify([url, limit, options.provider]) });
    },
    /** Pages similar to a URL (Exa). */
    similar: async (url: string, options: WebCallOptions = {}) => {
      const problem = checkWebUrl(url);
      if (problem) return this.invalid("web.similar", GLOBAL_SCOPE, problem);
      const o = this.webOptions("web.similar", options);
      if ("status" in o) return o;
      return this.run("web.similar", GLOBAL_SCOPE, (p) => (p as unknown as WebSource).similar!(url, o), { ...this.webRoute(options, ["exa"]), cacheKey: JSON.stringify([url, o, options.provider]) });
    },
    /** An answer generated by the search provider from web results, with its citations. */
    answer: async (query: string, options: WebCallOptions = {}) => {
      if (typeof query !== "string" || query.trim().length === 0 || query.length > 400) return this.invalid("web.answer", GLOBAL_SCOPE, "query must be 1–400 characters");
      return this.run("web.answer", GLOBAL_SCOPE, (p) => (p as unknown as WebSource).answer!(query.trim()), { ...this.webRoute(options, ["tavily", "exa"]), cacheKey: JSON.stringify([query.trim(), options.provider]) });
    },
  };

  // ------------------------------------------------------------------------------ developer

  private repoRef(capability: string, repo: string): { owner: string; repo: string } | ErrorResult {
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repo ?? "");
    if (!m || m[2] === "." || m[2] === "..") return this.invalid(capability, GLOBAL_SCOPE, `repository must be "owner/name": ${repo}`);
    return { owner: m[1]!, repo: m[2]! };
  }

  private gh<T>(capability: ProviderCapability, op: (g: GitHubProvider) => Promise<ProviderData<T>>, cacheKey: string, options: GitHubOptions, ttlMs = TTL.github): Promise<DataResult<T>> {
    return this.run(capability, GLOBAL_SCOPE, (p) => op(p as unknown as GitHubProvider), { ...options, ttlMs, cacheKey });
  }

  readonly github = {
    repository: async (repo: string, options: GitHubOptions = {}) => {
      const r = this.repoRef("developer.repository", repo);
      if ("status" in r) return r;
      return this.gh("developer.repository", (g) => g.repository(r.owner, r.repo), repo.toLowerCase(), options);
    },
    searchRepositories: async (query: string, options: GitHubOptions & ListOptions & { sort?: "stars" | "forks" | "updated" | "help-wanted-issues"; order?: "asc" | "desc" } = {}) => {
      const problem = checkQuery(query) ?? checkPage(options);
      if (problem) return this.invalid("developer.repository_search", GLOBAL_SCOPE, problem);
      return this.gh("developer.repository_search", (g) => g.searchRepositories(query, options), JSON.stringify([query, options.sort, options.order, options.page, options.perPage]), options);
    },
    contents: async (repo: string, path = "", options: GitHubOptions & { ref?: string } = {}) => {
      const r = this.repoRef("developer.repository_contents", repo);
      if ("status" in r) return r;
      const problem = checkPath(path) ?? checkRef(options.ref);
      if (problem) return this.invalid("developer.repository_contents", GLOBAL_SCOPE, problem);
      return this.gh<Record<string, unknown>>("developer.repository_contents", (g) => g.contents(r.owner, r.repo, path, options.ref), `${repo}:${options.ref ?? ""}:${path}`.toLowerCase(), options);
    },
    tree: async (repo: string, options: GitHubOptions & { ref?: string; recursive?: boolean } = {}) => {
      const r = this.repoRef("developer.repository_tree", repo);
      if ("status" in r) return r;
      const problem = checkRef(options.ref);
      if (problem) return this.invalid("developer.repository_tree", GLOBAL_SCOPE, problem);
      return this.gh("developer.repository_tree", (g) => g.tree(r.owner, r.repo, options.ref, options.recursive !== false), `${repo}:${options.ref ?? ""}:${options.recursive !== false}`.toLowerCase(), options);
    },
    commits: async (repo: string, options: GitHubOptions & ListOptions & { ref?: string; path?: string } = {}) => {
      const r = this.repoRef("developer.commits", repo);
      if ("status" in r) return r;
      const problem = checkRef(options.ref) ?? (options.path !== undefined ? checkPath(options.path) : null) ?? checkPage(options);
      if (problem) return this.invalid("developer.commits", GLOBAL_SCOPE, problem);
      return this.gh("developer.commits", (g) => g.commits(r.owner, r.repo, options), JSON.stringify([repo, options.ref, options.path, options.page, options.perPage]), options);
    },
    branches: async (repo: string, options: GitHubOptions & ListOptions = {}) => {
      const r = this.repoRef("developer.branches", repo);
      if ("status" in r) return r;
      const problem = checkPage(options);
      if (problem) return this.invalid("developer.branches", GLOBAL_SCOPE, problem);
      return this.gh("developer.branches", (g) => g.branches(r.owner, r.repo, options), JSON.stringify([repo, options.page, options.perPage]), options);
    },
    releases: async (repo: string, options: GitHubOptions & ListOptions = {}) => {
      const r = this.repoRef("developer.releases", repo);
      if ("status" in r) return r;
      const problem = checkPage(options);
      if (problem) return this.invalid("developer.releases", GLOBAL_SCOPE, problem);
      return this.gh("developer.releases", (g) => g.releases(r.owner, r.repo, options), JSON.stringify([repo, options.page, options.perPage]), options);
    },
    /** "latest", a tag, or a numeric release id. */
    release: async (repo: string, which = "latest", options: GitHubOptions = {}) => {
      const r = this.repoRef("developer.releases", repo);
      if ("status" in r) return r;
      if (!/^[A-Za-z0-9._\/+-]{1,200}$/.test(which) || which.includes("..")) return this.invalid("developer.releases", GLOBAL_SCOPE, `invalid release reference: ${which}`);
      return this.gh("developer.releases", (g) => g.release(r.owner, r.repo, which), `${repo}:release:${which}`.toLowerCase(), options);
    },
    issues: async (repo: string, options: GitHubOptions & ListOptions & { state?: "open" | "closed" | "all" } = {}) => {
      const r = this.repoRef("developer.issues", repo);
      if ("status" in r) return r;
      const problem = checkPage(options) ?? checkState(options.state);
      if (problem) return this.invalid("developer.issues", GLOBAL_SCOPE, problem);
      return this.gh("developer.issues", (g) => g.issues(r.owner, r.repo, options), JSON.stringify([repo, options.state, options.page, options.perPage]), options);
    },
    pullRequests: async (repo: string, options: GitHubOptions & ListOptions & { state?: "open" | "closed" | "all" } = {}) => {
      const r = this.repoRef("developer.pull_requests", repo);
      if ("status" in r) return r;
      const problem = checkPage(options) ?? checkState(options.state);
      if (problem) return this.invalid("developer.pull_requests", GLOBAL_SCOPE, problem);
      return this.gh("developer.pull_requests", (g) => g.pullRequests(r.owner, r.repo, options), JSON.stringify([repo, options.state, options.page, options.perPage]), options);
    },
    /** The authenticated user (needs GITHUB_TOKEN), or a public profile by login. */
    user: async (login?: string, options: GitHubOptions = {}) => {
      if (login !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return this.invalid("developer.user", GLOBAL_SCOPE, `invalid GitHub login: ${login}`);
      return this.gh("developer.user", (g) => g.user(login), `user:${login ?? "@me"}`, options);
    },
    /** Code search (GitHub requires authentication for it). */
    searchCode: async (query: string, options: GitHubOptions & ListOptions = {}) => {
      const problem = checkQuery(query) ?? checkPage(options);
      if (problem) return this.invalid("developer.code_search", GLOBAL_SCOPE, problem);
      return this.gh("developer.code_search", (g) => g.searchCode(query, options), JSON.stringify([query, options.page, options.perPage]), options);
    },
    /**
     * A public file from raw.githubusercontent.com: a raw URL, or { repo: "owner/name", ref, path }.
     * Only that host is contacted (network guard allowlist; redirects re-checked).
     */
    raw: async (target: string | { repo: string; ref: string; path: string }, options: GitHubOptions & { maxBytes?: number } = {}) => {
      let location: RawLocation;
      if (typeof target === "string") {
        const parsed = parseRawUrl(target);
        if (typeof parsed === "string") return this.invalid("developer.raw_content", GLOBAL_SCOPE, parsed);
        location = parsed;
      } else {
        const r = this.repoRef("developer.raw_content", target.repo);
        if ("status" in r) return r;
        const problem = checkRef(target.ref) ?? checkPath(target.path) ?? (target.path ? null : "path is required");
        if (problem) return this.invalid("developer.raw_content", GLOBAL_SCOPE, problem);
        location = { owner: r.owner, repo: r.repo, ref: target.ref, path: target.path };
      }
      const maxBytes = options.maxBytes ?? 1024 * 1024;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) return this.invalid("developer.raw_content", GLOBAL_SCOPE, "maxBytes must be 1–5242880");
      return this.run("developer.raw_content", GLOBAL_SCOPE, (p) => (p as unknown as GitHubRawProvider).file(location, maxBytes), { ...options, ttlMs: TTL.github, cacheKey: `${rawUrl(location)}:${maxBytes}` });
    },
  };

  // -------------------------------------------------------------------------------- security

  readonly security = {
    token: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("security.token", chain, `invalid token address: ${address}`);
      const id = chain.ids.goplusChainId;
      if (!id) return this.invalid("security.token", chain, `GoPlus has no id for ${chain.name}`);
      return this.run(
        "security.token",
        chain,
        async (p) => {
          const { result, authenticated } = await (p as GoPlusProvider).get<Record<string, Raw>>(`/api/v1/token_security/${id}?contract_addresses=${address}`);
          const row = result?.[address.toLowerCase()];
          if (!row || Object.keys(row).length === 0) throw new ProviderError(`GoPlus has no security data for ${address} on chain ${id}`, "not_listed");
          return { data: { address, report: row }, notes: [authenticated ? "authenticated GoPlus request" : "anonymous GoPlus request", "fields are GoPlus's own (strings \"0\"/\"1\" for flags)"] };
        },
        { ...options, ttlMs: TTL.security, cacheKey: address.toLowerCase() },
      );
    },

    address: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("security.address", chain, `invalid address: ${address}`);
      const id = chain.ids.goplusChainId;
      if (!id) return this.invalid("security.address", chain, `GoPlus has no id for ${chain.name}`);
      return this.run(
        "security.address",
        chain,
        async (p) => {
          const { result, authenticated } = await (p as GoPlusProvider).get<Raw>(`/api/v1/address_security/${address}?chain_id=${id}`);
          if (!result) throw new ProviderError(`GoPlus has no address data for ${address}`, "not_listed");
          return { data: { address, report: result }, notes: [authenticated ? "authenticated GoPlus request" : "anonymous GoPlus request"] };
        },
        { ...options, ttlMs: TTL.security, cacheKey: address.toLowerCase() },
      );
    },

    /** Token approvals: no provider supports Robinhood Chain (GoPlus answers "Main chain does not exist"). */
    approvals: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("security.approvals", chain, `invalid address: ${address}`);
      return this.run("security.approvals", chain, async () => {
        throw new ProviderError("unreachable", "unsupported");
      });
    },
  };

  // ---------------------------------------------------------------------------------- stocks

  readonly stocks = {
    /** Robinhood Stock Token metadata (unnormalized provider payload). */
    assets: async (options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.run("stock.assets", chain, async (p) => ({ data: await (p as RobinhoodStockProvider).get("/assets"), notes: ["unnormalized Robinhood payload"] }), { ...options, ttlMs: TTL.metadata, cacheKey: "assets" });
    },
    /** Raw underlying-equity bid/ask (not multiplier-adjusted; see the /assets multiplier). */
    price: async (symbol: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!/^[A-Za-z][A-Za-z0-9.\-]{0,15}$/.test(symbol)) return this.invalid("stock.price", chain, `invalid symbol: ${symbol}`);
      return this.run(
        "stock.price",
        chain,
        async (p) => {
          const body = await (p as RobinhoodStockProvider).get<{ quotes?: Array<Record<string, unknown>> } & Record<string, unknown>>(`/prices/${encodeURIComponent(symbol.toUpperCase())}`);
          // Live API (2026-10-03): { quotes: [ { tokenSymbol, bid, ask, tokenBid, tokenAsk, … } ] }.
          const quote = Array.isArray(body?.quotes) ? body.quotes.find((q) => String(q.tokenSymbol ?? "").toUpperCase() === symbol.toUpperCase()) ?? body.quotes[0] : body;
          if (!quote) throw new ProviderError(`Robinhood returned no quote for ${symbol.toUpperCase()}`, "not_listed");
          return { data: quote, notes: ["bid/ask: the underlying stock; tokenBid/tokenAsk: per token (corporate-action multiplier applied), as reported by Robinhood"] };
        },
        { ...options, ttlMs: 5_000, cacheKey: symbol.toUpperCase() },
      );
    },
    /**
     * Robinhood Stock Tokens deployed on the chain: symbol, name, contract address — from Robinhood's
     * official list (/rhj/assets), else CoinGecko's coin list (ids "*-robinhood-tokenized-stock").
     */
    tokens: async (options: CallOptions & { search?: string } = {}): Promise<DataResult<StockTokenList>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const result = await this.run<StockTokenList>("stock.tokens", chain, (p) => (p.name === "coingecko" ? (p as unknown as CoinGeckoProvider).stockTokens(chain) : (p as RobinhoodStockProvider).stockTokens(chain)) as Promise<ProviderData<StockTokenList>>, { ...pick(options, ["fresh"]), ttlMs: TTL.stockList, prefer: ["robinhood-stock-api", "coingecko"] });
      if (!isLive(result) || !options.search) return result;
      const q = options.search.trim().toLowerCase();
      const tokens = result.data.tokens.filter((t) => t.symbol.toLowerCase().includes(q) || t.name?.toLowerCase().includes(q) || t.address.toLowerCase() === q);
      return { ...result, data: { ...result.data, count: tokens.length, tokens } };
    },
    /**
     * One stock token from every source separately: Robinhood's official bid/ask, the Chainlink
     * oracle price (subscribed keys only) and the token's DEX market on the chain (price, volume,
     * liquidity, FDV). Values are never merged; each section keeps its own status and source.
     */
    quote: async (symbol: string, options: CallOptions & { session?: "regular" | "extended" | "overnight" } = {}): Promise<Composite | ErrorResult> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const q = symbol.trim();
      if (!/^[A-Za-z][A-Za-z0-9.\-]{0,15}$/.test(q) && !ADDRESS.test(q)) return this.invalid("stock.tokens", chain, `invalid symbol or address: ${symbol}`);
      const f = pick(options, ["fresh"]);
      const list = await this.stocks.tokens({ ...f, chain: chain.key });
      const token = isLive(list) ? list.data.tokens.find((t) => t.symbol.toUpperCase() === q.toUpperCase() || t.address.toLowerCase() === q.toLowerCase()) : undefined;
      const ticker = token?.symbol ?? q.toUpperCase();
      const sections: Record<string, DataResult<unknown>> = {};
      sections.token = isLive(list)
        ? token
          ? { ...list, data: token }
          : unavailable("stock.tokens", chain, `${q} is not in the Robinhood Stock Token list (${list.data.count} tokens; see: splice stock list)`, { provider: list.provenance.source })
        : list;
      const [official, oracle, dex, llama, codex, underlying] = await Promise.all([
        ADDRESS.test(q) ? Promise.resolve(undefined) : this.stocks.price(ticker, { ...f, chain: chain.key }),
        ADDRESS.test(q) ? Promise.resolve(undefined) : this.oracle.price(ticker, { ...f, ...(options.session ? { session: options.session } : {}) }),
        token ? this.market.token(chain.key, token.address, f) : Promise.resolve(undefined),
        token ? this.defi.tokenPrice(token.address, { ...f, chain: chain.key }) : Promise.resolve(undefined),
        token ? this.tokens.prices([token.address], { ...f, chain: chain.key }) : Promise.resolve(undefined),
        ADDRESS.test(q) ? Promise.resolve(undefined) : this.equities.quote(ticker, f),
      ]);
      if (official) sections.robinhood = official;
      if (oracle) sections.chainlink = oracle;
      if (dex) sections.dex = dex;
      if (llama) sections.defillama = llama;
      if (codex) sections.codex = codex;
      if (underlying) sections.finnhub = underlying;
      return this.composite(ticker, chain, sections);
    },
    /** Stock tokens ranked by their DEX markets on the chain (same formulas as market.movers). */
    movers: async (options: CallOptions & MoverOptions = {}): Promise<DataResult<MoverList>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const list = await this.stocks.tokens({ ...pick(options, ["fresh"]), chain: chain.key });
      if (!isLive(list)) return list;
      const addresses = new Set(list.data.tokens.map((t) => t.address.toLowerCase()));
      return this.rankPools(chain.key, { pages: 10, minLiquidity: 1_000, ...options }, (p) => addresses.has((p.baseToken?.address ?? "").toLowerCase()), "Robinhood stock-token pools");
    },
  };

  // -------------------------------------------------------------------------------- indexing

  // ----------------------------------------------------------------------------------- oracle

  /**
   * Chainlink Data Streams: the feed catalog (crypto, US equities with regular / extended / overnight
   * sessions) and decoded latest reports. A report is read only for feeds the key is subscribed to.
   */
  readonly oracle = {
    feeds: async (options: { search?: string; assetClass?: string; network?: "mainnet" | "testnet" | "all"; fresh?: boolean } = {}) => {
      const result = await this.run<OracleFeed[]>("oracle.feeds", GLOBAL_SCOPE, (p) => (p as unknown as ChainlinkStreamsProvider).feeds(), { ttlMs: 3_600_000, cacheKey: "discovery", ...(options.fresh ? { fresh: true } : {}) });
      if (!isLive(result)) return result;
      const network = options.network ?? "mainnet";
      const q = options.search?.trim().toLowerCase();
      const cls = options.assetClass?.trim().toLowerCase();
      const feeds = result.data.filter(
        (f) =>
          (network === "all" || f.networkType === network) &&
          (!cls || f.assetClass?.toLowerCase() === cls) &&
          (!q || [f.baseAsset, f.name, f.assetName, f.feedId].some((v) => v?.toLowerCase().includes(q))),
      );
      return { ...result, data: { network, count: feeds.length, feeds } };
    },
    /**
     * Latest oracle price for a symbol (ETH, BTC, TSLA, NVDA, SPY…) or a feed id. Equities default to
     * the regular-hours feed; `session` picks extended or overnight.
     */
    price: async (query: string, options: { session?: "regular" | "extended" | "overnight"; fresh?: boolean } = {}): Promise<DataResult<unknown>> => {
      const streams = await this.oracle.streamPrice(query, options);
      if (isLive(streams) || /^0x[0-9a-fA-F]{64}$/.test(query.trim()) || (streams.status === "ERROR" && streams.code === "INVALID_INPUT")) return streams;
      // Data Streams not readable for this key/symbol: the latest 1-minute candle of the Chainlink
      // Candlestick API, stated as such (provider, candle time, and why streams were not used).
      const symbol = query.trim().toUpperCase().replace(/\/?USD$/, "");
      const candles = await this.oracle.candles(symbol, { timeframe: "1m", limit: 30, ...(options.fresh ? { fresh: true } : {}) });
      if (!isLive(candles)) return streams;
      const last = candles.data.candles[candles.data.candles.length - 1]!;
      const why = streams.status === "UNAVAILABLE" ? streams.reason : streams.message;
      const notes = [...(candles.provenance.notes ?? []), `price = close of the latest 1-minute Chainlink Candlestick candle (${last.time}); Data Streams report not used: ${why}`];
      return { ...candles, capability: "oracle.candles", data: { symbol: candles.data.symbol, price: last.close, observedAt: last.time, source: "candlestick", candle: last }, provenance: { ...candles.provenance, notes } } as DataResult<unknown>;
    },
    /** OHLC candles from the Chainlink Candlestick API (crypto, US equities, forex); `timeframe` 1m…24h. */
    candles: async (symbol: string, options: { timeframe?: string; limit?: number; fresh?: boolean } = {}): Promise<DataResult<{ symbol: string; resolution: string; candles: Candle[] }>> => {
      const raw = symbol.trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,24}$/.test(raw)) return this.invalid("oracle.candles", GLOBAL_SCOPE, `invalid symbol: ${symbol}`);
      const resolution = options.timeframe ?? "1h";
      const seconds = CANDLE_RESOLUTIONS[resolution];
      if (!seconds) return this.invalid("oracle.candles", GLOBAL_SCOPE, `timeframe must be one of ${Object.keys(CANDLE_RESOLUTIONS).join(", ")}`);
      const limit = options.limit ?? 24;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return this.invalid("oracle.candles", GLOBAL_SCOPE, "limit must be 1–500");
      const ticker = /USD$|-TWAP/.test(raw) ? raw : `${raw}USD`;
      const to = Math.floor(Date.now() / 1000);
      const from = to - seconds * limit;
      return this.run("oracle.candles", GLOBAL_SCOPE, (p) => (p as unknown as ChainlinkCandlestickProvider).history(ticker, resolution, from, to), { ttlMs: Math.min(seconds * 1000, 60_000), cacheKey: `${ticker}:${resolution}:${limit}`, ...(options.fresh ? { fresh: true } : {}) });
    },
    /** Symbols the Candlestick API serves, per group (crypto, equities, forex). */
    symbols: async (options: { group?: string; fresh?: boolean } = {}) => {
      if (options.group !== undefined && !["crypto", "equities", "forex"].includes(options.group)) return this.invalid("oracle.symbols", GLOBAL_SCOPE, "group must be crypto, equities or forex");
      return this.run("oracle.symbols", GLOBAL_SCOPE, (p) => (p as unknown as ChainlinkCandlestickProvider).symbols(options.group), { ttlMs: 3_600_000, cacheKey: options.group ?? "all", ...(options.fresh ? { fresh: true } : {}) });
    },
    /** Data Streams report only (no Candlestick fallback). */
    streamPrice: async (query: string, options: { session?: "regular" | "extended" | "overnight"; fresh?: boolean } = {}): Promise<DataResult<unknown>> => {
      const q = query.trim();
      if (!q || q.length > 80) return this.invalid("oracle.report", GLOBAL_SCOPE, "symbol or feed id required");
      let feed: OracleFeed | undefined;
      if (/^0x[0-9a-fA-F]{64}$/.test(q)) feed = { feedId: q.toLowerCase() };
      else {
        const catalog = await this.oracle.feeds({ network: "mainnet", ...(options.fresh ? { fresh: true } : {}) });
        if (!isLive(catalog)) return catalog;
        const symbol = q.toUpperCase().replace(/\/?USD$/, "");
        const session = options.session ?? "regular";
        const candidates = catalog.data.feeds.filter((f) => f.baseAsset?.toUpperCase() === symbol && f.quoteAsset?.toUpperCase() === "USD" && f.status === "live");
        const equity = candidates.filter((f) => f.assetClass?.toLowerCase() === "equities");
        feed = equity.length
          ? equity.find((f) => `${f.attributeType ?? ""} ${f.marketHours ?? ""}`.toLowerCase().includes(session))
          : (candidates.find((f) => f.schemaVersion?.toUpperCase() === "V3") ?? candidates[0]);
        if (!feed) return unavailable("oracle.report", GLOBAL_SCOPE, `Chainlink lists no live ${symbol}/USD feed${equity.length ? ` for the ${session} session` : ""} on mainnet (see: splice oracle feeds --search ${symbol})`);
      }
      const chosen = feed;
      const report = await this.run<Record<string, unknown>>("oracle.report", GLOBAL_SCOPE, (p) => (p as unknown as ChainlinkStreamsProvider).report(chosen.feedId), { ttlMs: 5_000, cacheKey: chosen.feedId, ...(options.fresh ? { fresh: true } : {}) });
      if (!isLive(report)) return report;
      return { ...report, data: { feed: chosen, ...report.data } };
    },
  };

  // ------------------------------------------------------------------------------------ tokens

  /**
   * Every token on the chain with live stats (Codex): rankings, search, details, trades, charts.
   * Rankings run server-side over all tokens; thin and flagged-scam tokens are filtered out by
   * default (minLiquidity), and the applied filters are part of the result.
   */
  readonly tokens = {
    rank: async (kind: TokenRankKind, options: CallOptions & { window?: "h1" | "h4" | "h12" | "h24"; minLiquidity?: number; limit?: number } = {}): Promise<DataResult<TokenList>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const spec = TOKEN_RANKS[kind];
      if (!spec) return this.invalid("tokens.filter", chain, `kind must be one of ${Object.keys(TOKEN_RANKS).join(", ")}`);
      const window = options.window ?? spec.defaultWindow;
      const w = window.slice(1) as "1" | "4" | "12" | "24";
      if (!["1", "4", "12", "24"].includes(w)) return this.invalid("tokens.filter", chain, "window must be h1, h4, h12 or h24");
      const limit = options.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return this.invalid("tokens.filter", chain, "limit must be 1–100");
      const minLiquidity = options.minLiquidity ?? spec.minLiquidity;
      const attribute = spec.attribute.replace("{w}", spec.windowed ? w : "24");
      const filters: Record<string, unknown> = { potentialScam: false, ...spec.filters };
      if (minLiquidity > 0) filters.liquidity = { gt: minLiquidity };
      const result = await this.run<TokenList>("tokens.filter", chain, (p) => (p as unknown as CodexProvider).filterTokens(chain, { ranking: { attribute, direction: spec.direction }, filters, limit: Math.min(100, limit * 2) }) as Promise<ProviderData<TokenList>>, { ...pick(options, ["fresh"]), ttlMs: 60_000, cacheKey: `${kind}:${attribute}:${minLiquidity}:${limit}` });
      if (!isLive(result)) return result;
      // Codex filters by its own liquidity measure; the row's reported liquidity is re-checked here.
      const tokens = result.data.tokens.filter((t) => Number(t.liquidityUsd ?? 0) >= minLiquidity && (!spec.keep || spec.keep(t)));
      return { ...result, data: { ...result.data, kind, window: spec.windowed ? window : "h24", filters: `${spec.text.replace("{w}", spec.windowed ? window : "24h")}; liquidity > $${minLiquidity.toLocaleString("en-US")}; tokens flagged as potential scams excluded`, count: Math.min(tokens.length, limit), tokens: tokens.slice(0, limit) } };
    },
    /** Tokens matching a name, symbol or address, deepest liquidity first. */
    search: async (phrase: string, options: CallOptions & { limit?: number } = {}): Promise<DataResult<TokenList>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const q = phrase.trim();
      if (!q || q.length > 80) return this.invalid("tokens.filter", chain, "search phrase must be 1–80 characters");
      return this.run<TokenList>("tokens.filter", chain, (p) => (p as unknown as CodexProvider).filterTokens(chain, { ranking: { attribute: "liquidity", direction: "DESC" }, phrase: q, limit: options.limit ?? 10 }) as Promise<ProviderData<TokenList>>, { ...pick(options, ["fresh"]), ttlMs: 60_000, cacheKey: `search:${q.toLowerCase()}:${options.limit ?? 10}` });
    },
    /** Address of a symbol (exact symbol match with the deepest liquidity) or the address itself. */
    resolve: async (query: string, options: CallOptions = {}): Promise<{ address: string; stats?: CodexToken } | ErrorResult | DataResult<never>> => {
      const q = query.trim();
      const found = await this.tokens.search(q, { ...pick(options, ["fresh", "chain"]), limit: 10 });
      if (!isLive(found)) return ADDRESS.test(q) ? { address: q } : (found as DataResult<never>);
      const match = ADDRESS.test(q) ? found.data.tokens.find((t) => t.address.toLowerCase() === q.toLowerCase()) : found.data.tokens.find((t) => t.symbol?.toUpperCase() === q.toUpperCase());
      if (match) return { address: match.address, stats: match };
      if (ADDRESS.test(q)) return { address: q };
      return unavailable("tokens.filter", chainScope(resolveChain(options.chain)!), `no token with symbol ${q.toUpperCase()} found (try: splice tokens search ${q})`, { provider: "codex" });
    },
    /** One token from Codex: live stats, metadata, pairs, recent trades and a 24h hourly chart — one section each. */
    details: async (query: string, options: CallOptions = {}): Promise<Composite | ErrorResult | DataResult<never>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const resolved = await this.tokens.resolve(query, options);
      if ("status" in resolved) return resolved;
      const f = { ...pick(options, ["fresh"]), chain: chain.key };
      const [info, pairs, trades, chart] = await Promise.all([this.tokens.info(resolved.address, f), this.tokens.pairs(resolved.address, f), this.tokens.trades(resolved.address, { ...f, limit: 10 }), this.tokens.chart(resolved.address, { ...f, timeframe: "1h", limit: 24 })]);
      const sections: Record<string, DataResult<unknown>> = { info, pairs, trades, chart };
      if (resolved.stats) sections.stats = { status: "LIVE", capability: "tokens.filter", data: resolved.stats, provenance: { source: "codex", chain: chain.key, chainId: chain.chainId, fetchedAt: new Date().toISOString(), fresh: true, resource: "filterTokens" } };
      return this.composite(resolved.address, chain, sections);
    },
    info: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("tokens.info", chain, `invalid token address: ${address}`);
      return this.run("tokens.info", chain, (p) => (p as unknown as CodexProvider).token(chain, address), { ...pick(options, ["fresh"]), ttlMs: 3_600_000, cacheKey: address.toLowerCase() });
    },
    pairs: async (address: string, options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("tokens.pairs", chain, `invalid token address: ${address}`);
      return this.run("tokens.pairs", chain, (p) => (p as unknown as CodexProvider).pairs(chain, address, 10), { ...pick(options, ["fresh"]), ttlMs: 300_000, cacheKey: address.toLowerCase() });
    },
    trades: async (address: string, options: CallOptions & { limit?: number } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("tokens.events", chain, `invalid token address: ${address}`);
      const limit = options.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return this.invalid("tokens.events", chain, "limit must be 1–100");
      return this.run("tokens.events", chain, (p) => (p as unknown as CodexProvider).events(chain, address, limit), { ...pick(options, ["fresh"]), ttlMs: 15_000, cacheKey: `${address.toLowerCase()}:${limit}` });
    },
    /** OHLCV bars: timeframe 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d. */
    chart: async (address: string, options: CallOptions & { timeframe?: string; limit?: number } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("tokens.bars", chain, `invalid token address: ${address}`);
      const tf = CODEX_TIMEFRAMES[options.timeframe ?? "1h"];
      if (!tf) return this.invalid("tokens.bars", chain, `timeframe must be one of ${Object.keys(CODEX_TIMEFRAMES).join(", ")}`);
      const limit = options.limit ?? 24;
      if (!Number.isInteger(limit) || limit < 2 || limit > 500) return this.invalid("tokens.bars", chain, "limit must be 2–500");
      const to = Math.floor(Date.now() / 1000);
      return this.run("tokens.bars", chain, (p) => (p as unknown as CodexProvider).bars(chain, address, tf.resolution, to - tf.seconds * limit, to), { ...pick(options, ["fresh"]), ttlMs: Math.min(tf.seconds * 1000, 60_000), cacheKey: `${address.toLowerCase()}:${tf.resolution}:${limit}` });
    },
    /**
     * Large trades of a token from its latest swaps (Codex): trades at or above `minUsd`, with buy and
     * sell totals, net flow and the wallets involved.
     */
    whales: async (query: string, options: CallOptions & { minUsd?: number } = {}): Promise<DataResult<WhaleTrades> | ErrorResult> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const minUsd = options.minUsd ?? 5_000;
      if (!Number.isFinite(minUsd) || minUsd < 0) return this.invalid("tokens.events", chain, "minUsd must be ≥ 0");
      const resolved = await this.tokens.resolve(query, options);
      if ("status" in resolved) return resolved as ErrorResult;
      const trades = await this.tokens.trades(resolved.address, { ...pick(options, ["fresh"]), chain: chain.key, limit: 100 });
      if (!isLive(trades)) return trades;
      const swaps = ((trades.data as { trades: Array<{ type?: string; valueUsd?: string; maker?: string; time?: string; priceUsd?: string; txHash?: string }> }).trades ?? []).filter((t) => t.type === "Buy" || t.type === "Sell");
      const big = swaps.filter((t) => Number(t.valueUsd ?? 0) >= minUsd);
      const sum = (type: string) => big.filter((t) => t.type === type).reduce((s, t) => s + Number(t.valueUsd ?? 0), 0);
      const buys = sum("Buy");
      const sells = sum("Sell");
      const wallets = new Map<string, { buyUsd: number; sellUsd: number; trades: number }>();
      for (const t of big) {
        const w = wallets.get(t.maker ?? "?") ?? { buyUsd: 0, sellUsd: 0, trades: 0 };
        if (t.type === "Buy") w.buyUsd += Number(t.valueUsd ?? 0);
        else w.sellUsd += Number(t.valueUsd ?? 0);
        w.trades++;
        wallets.set(t.maker ?? "?", w);
      }
      const top = [...wallets.entries()].map(([wallet, w]) => ({ wallet, ...w, buyUsd: Math.round(w.buyUsd), sellUsd: Math.round(w.sellUsd) })).sort((a, b) => b.buyUsd + b.sellUsd - (a.buyUsd + a.sellUsd)).slice(0, 10);
      const window = swaps.length ? { from: swaps[swaps.length - 1]!.time, to: swaps[0]!.time } : undefined;
      return { ...trades, data: { address: resolved.address, symbol: resolved.stats?.symbol, minUsd, scanned: swaps.length, ...(window ? { window } : {}), count: big.length, buyUsd: Math.round(buys), sellUsd: Math.round(sells), netFlowUsd: Math.round(buys - sells), trades: big, wallets: top } } as DataResult<WhaleTrades>;
    },
    /** Current prices of up to 25 tokens (Codex). */
    prices: async (addresses: string[], options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (addresses.length === 0 || addresses.length > 25 || !addresses.every((a) => ADDRESS.test(a))) return this.invalid("tokens.price", chain, "1–25 token addresses (0x…)");
      return this.run("tokens.price", chain, (p) => (p as unknown as CodexProvider).prices(chain, addresses), { ...pick(options, ["fresh"]), ttlMs: TTL.price, cacheKey: addresses.join(",").toLowerCase() });
    },
  };

  // --------------------------------------------------------------------------------- research

  /**
   * Token research: one report with every source in its own section plus flags derived from the
   * providers' own fields (GoPlus security, Blockscout verification, Codex market stats). Each flag
   * names its source and the field it comes from; nothing is scored or guessed.
   */
  readonly research = {
    report: async (query: string, options: CallOptions = {}): Promise<ResearchReport | ErrorResult | DataResult<never>> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const resolved = await this.tokens.resolve(query, options);
      if ("status" in resolved) return resolved;
      const address = resolved.address;
      const f = { ...pick(options, ["fresh"]), chain: chain.key };
      const [security, contract, pairs] = await Promise.all([this.security.token(address, f), this.onchain.contract(address, f), this.tokens.pairs(address, f)]);
      const flags: ResearchFlag[] = [];
      const add = (level: ResearchFlag["level"], text: string, source: string) => flags.push({ level, text, source });
      const st = resolved.stats;
      if (st) {
        const liq = Number(st.liquidityUsd ?? 0);
        if (liq < 10_000) add("warn", `low liquidity: $${Math.round(liq).toLocaleString("en-US")}`, "codex liquidity");
        const ageH = st.createdAt ? (Date.now() - Date.parse(st.createdAt)) / 3_600_000 : undefined;
        if (ageH !== undefined && ageH < 24) add("warn", `new token: ${ageH < 1 ? `${Math.round(ageH * 60)} minutes` : `${Math.round(ageH)} hours`} old`, "codex createdAt");
        if (st.potentialScam) add("danger", "flagged as a potential scam by Codex", "codex isScam");
        if (st.holders !== undefined && st.holders < 100) add("warn", `few holders: ${st.holders}`, "codex holders");
        const buys = st.buys24 ?? 0;
        const sells = st.sells24 ?? 0;
        if (buys + sells > 20 && sells > buys * 2) add("warn", `sell pressure: ${sells} sells vs ${buys} buys in 24h`, "codex buy/sell counts");
      } else add("info", "no Codex market stats (token not indexed by Codex, or CODEX_API_KEY not set)", "codex");
      if (isLive(security)) {
        const r = ((security.data as { report?: Record<string, any> }).report ?? {}) as Record<string, any>;
        const yes = (k: string) => r[k] === "1" || r[k] === 1;
        const pctOf = (k: string) => (r[k] !== undefined && r[k] !== "" ? Number(r[k]) * 100 : undefined);
        if (yes("is_honeypot")) add("danger", "honeypot: buying works but selling does not", "goplus is_honeypot");
        if (yes("cannot_sell_all")) add("danger", "holders cannot sell their whole balance", "goplus cannot_sell_all");
        const buyTax = pctOf("buy_tax");
        const sellTax = pctOf("sell_tax");
        if (buyTax !== undefined && buyTax >= 10) add("danger", `buy tax ${buyTax.toFixed(1)}%`, "goplus buy_tax");
        else if (buyTax !== undefined && buyTax > 0) add("warn", `buy tax ${buyTax.toFixed(1)}%`, "goplus buy_tax");
        if (sellTax !== undefined && sellTax >= 10) add("danger", `sell tax ${sellTax.toFixed(1)}%`, "goplus sell_tax");
        else if (sellTax !== undefined && sellTax > 0) add("warn", `sell tax ${sellTax.toFixed(1)}%`, "goplus sell_tax");
        if (yes("is_mintable")) add("warn", "owner can mint new tokens", "goplus is_mintable");
        if (yes("can_take_back_ownership")) add("danger", "ownership can be taken back after renouncing", "goplus can_take_back_ownership");
        if (yes("hidden_owner")) add("danger", "hidden owner", "goplus hidden_owner");
        if (yes("transfer_pausable")) add("warn", "transfers can be paused", "goplus transfer_pausable");
        if (yes("is_blacklisted")) add("warn", "has a blacklist", "goplus is_blacklisted");
        if (yes("slippage_modifiable") || yes("personal_slippage_modifiable")) add("warn", "tax/slippage can be changed by the owner", "goplus slippage_modifiable");
        if (yes("selfdestruct")) add("danger", "contract can self-destruct", "goplus selfdestruct");
        if (yes("is_proxy")) add("info", "upgradeable proxy contract", "goplus is_proxy");
        if (r.is_open_source === "0") add("warn", "source code not verified", "goplus is_open_source");
        const holders = Array.isArray(r.holders) ? (r.holders as Array<Record<string, any>>) : [];
        const top10 = holders.slice(0, 10).reduce((sum, h) => sum + Number(h.percent ?? 0) * 100, 0);
        if (holders.length) add(top10 > 50 ? "warn" : "info", `top ${Math.min(10, holders.length)} holders own ${top10.toFixed(1)}% (incl. pools/contracts)`, "goplus holders");
        const owner = pctOf("owner_percent");
        if (owner !== undefined && owner > 5) add("warn", `owner holds ${owner.toFixed(1)}%`, "goplus owner_percent");
        const creator = pctOf("creator_percent");
        if (creator !== undefined && creator > 5) add("warn", `creator holds ${creator.toFixed(1)}%`, "goplus creator_percent");
        const lpLocked = (Array.isArray(r.lp_holders) ? (r.lp_holders as Array<Record<string, any>>) : []).filter((h) => h.is_locked === 1 || h.is_locked === "1").reduce((s, h) => s + Number(h.percent ?? 0) * 100, 0);
        if (Array.isArray(r.lp_holders) && r.lp_holders.length) add(lpLocked > 50 ? "ok" : "info", `LP tokens locked: ${lpLocked.toFixed(1)}%`, "goplus lp_holders");
        if (!flags.some((x) => x.source.startsWith("goplus") && (x.level === "danger" || x.level === "warn"))) add("ok", "no GoPlus risk flags raised", "goplus");
      } else add("info", `security report unavailable: ${security.status === "UNAVAILABLE" ? security.reason : security.message}`, "goplus");
      if ("sections" in contract) {
        const v = contract.sections.verified;
        if (v && isLive(v)) {
          const d = v.data as { verified?: boolean; name?: string };
          add(d.verified ? "ok" : "warn", d.verified ? `verified source on Blockscout${d.name ? ` (${d.name})` : ""}` : "contract source not verified on Blockscout", "blockscout smart-contracts");
        }
      }
      const order = { danger: 0, warn: 1, info: 2, ok: 3 } as const;
      flags.sort((a, b) => order[a.level] - order[b.level]);
      const sections: Record<string, DataResult<unknown>> = { security, pairs };
      if ("sections" in contract) for (const [k, v] of Object.entries(contract.sections)) if (k === "verified" || k === "proxy") sections[`contract_${k}`] = v;
      return { kind: "report", subject: query, address, chain: chain.key, chainId: chain.chainId, generatedAt: new Date().toISOString(), ...(st ? { stats: st } : {}), flags, sections };
    },
  };

  // ----------------------------------------------------------------------------------- global

  /** Global markets: crypto (CoinGecko), sentiment (alternative.me), US equities and ETFs (Chainlink candles). */
  readonly global = {
    overview: async (options: { fresh?: boolean } = {}): Promise<Composite | ErrorResult> => {
      const f = pick(options, ["fresh"]);
      const robinhood = resolveChain("robinhood")!;
      const [crypto, sentiment, equities, majors] = await Promise.all([this.global.crypto(f), this.global.sentiment({ ...f, days: 7 }), this.global.equities(DEFAULT_EQUITIES, f), this.global.coins({ ...f, limit: 10 })]);
      return { ...this.composite("global", robinhood, { crypto, sentiment, majors, equities }), chain: "global", chainId: null } as unknown as Composite;
    },
    crypto: async (options: { fresh?: boolean } = {}) => this.run("global.market", GLOBAL_SCOPE, (p) => (p as unknown as CoinGeckoProvider).globalMarket() as Promise<ProviderData<Record<string, unknown>>>, { ...pick(options, ["fresh"]), ttlMs: 120_000 }),
    coins: async (options: { limit?: number; fresh?: boolean } = {}) => {
      const limit = options.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 250) return this.invalid("global.coins", GLOBAL_SCOPE, "limit must be 1–250");
      return this.run("global.coins", GLOBAL_SCOPE, (p) => (p as unknown as CoinGeckoProvider).coinMarkets(limit), { ...pick(options, ["fresh"]), ttlMs: 60_000, cacheKey: String(limit) });
    },
    trending: async (options: { fresh?: boolean } = {}) => this.run("global.trending", GLOBAL_SCOPE, (p) => (p as unknown as CoinGeckoProvider).trendingCoins(), { ...pick(options, ["fresh"]), ttlMs: 300_000 }),
    sentiment: async (options: { days?: number; fresh?: boolean } = {}) => {
      const days = options.days ?? 7;
      if (!Number.isInteger(days) || days < 1 || days > 90) return this.invalid("global.sentiment", GLOBAL_SCOPE, "days must be 1–90");
      return this.run("global.sentiment", GLOBAL_SCOPE, (p) => (p as unknown as FearGreedProvider).index(days), { ...pick(options, ["fresh"]), ttlMs: 900_000, cacheKey: String(days) });
    },
    /** Latest price and 24h change of US equities/ETFs from Chainlink Candlestick hourly candles. */
    equities: async (symbols: string[] = DEFAULT_EQUITIES, options: { fresh?: boolean } = {}): Promise<DataResult<{ count: number; quotes: Array<{ symbol: string; priceUsd?: string; change24hPct?: number; asOf?: string; status: string }> }>> => {
      if (symbols.length === 0 || symbols.length > 30) return this.invalid("oracle.candles", GLOBAL_SCOPE, "1–30 symbols");
      const results = await Promise.all(symbols.map((s) => this.oracle.candles(s, { timeframe: "1h", limit: 26, ...pick(options, ["fresh"]) })));
      const first = results.find(isLive);
      if (!first) return results[0] as unknown as DataResult<never>;
      const quotes = results.map((r, i) => {
        if (!isLive(r)) return { symbol: symbols[i]!.toUpperCase(), status: r.status };
        const candles = r.data.candles;
        const last = candles[candles.length - 1]!;
        const dayAgo = candles.find((c) => Date.parse(c.time) >= Date.parse(last.time) - 24 * 3_600_000) ?? candles[0]!;
        const change = Number(dayAgo.close) ? ((Number(last.close) - Number(dayAgo.close)) / Number(dayAgo.close)) * 100 : undefined;
        const q: { symbol: string; priceUsd?: string; change24hPct?: number; asOf?: string; status: string } = { symbol: symbols[i]!.toUpperCase(), status: "LIVE" };
        if (last.close !== undefined) q.priceUsd = last.close;
        if (change !== undefined) q.change24hPct = Number(change.toFixed(2));
        q.asOf = last.time;
        return q;
      });
      return { ...first, capability: "oracle.candles", data: { count: quotes.length, quotes }, provenance: { ...first.provenance, notes: ["price = latest hourly Chainlink Candlestick close; change = vs. the close about 24h earlier (market hours apply)"] } } as DataResult<{ count: number; quotes: Array<{ symbol: string; priceUsd?: string; change24hPct?: number; asOf?: string; status: string }> }>;
    },
  };

  // --------------------------------------------------------------------------------- equities

  /** US equities from Finnhub: real-time quote, profile + metrics + analysts, news, earnings, market status. */
  readonly equities = {
    quote: async (symbol: string, options: { fresh?: boolean } = {}) => {
      const s = symbol.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return this.invalid("equity.quote", GLOBAL_SCOPE, `invalid ticker: ${symbol}`);
      return this.run("equity.quote", GLOBAL_SCOPE, (p) => (p as unknown as FinnhubProvider).quote(s), { ...pick(options, ["fresh"]), ttlMs: 10_000, cacheKey: s });
    },
    profile: async (symbol: string, options: { fresh?: boolean } = {}) => {
      const s = symbol.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return this.invalid("equity.profile", GLOBAL_SCOPE, `invalid ticker: ${symbol}`);
      return this.run("equity.profile", GLOBAL_SCOPE, (p) => (p as unknown as FinnhubProvider).profile(s), { ...pick(options, ["fresh"]), ttlMs: 3_600_000, cacheKey: s });
    },
    news: async (symbol: string, options: { days?: number; fresh?: boolean } = {}) => {
      const s = symbol.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return this.invalid("equity.news", GLOBAL_SCOPE, `invalid ticker: ${symbol}`);
      const days = options.days ?? 7;
      if (!Number.isInteger(days) || days < 1 || days > 30) return this.invalid("equity.news", GLOBAL_SCOPE, "days must be 1–30");
      return this.run("equity.news", GLOBAL_SCOPE, (p) => (p as unknown as FinnhubProvider).companyNews(s, days), { ...pick(options, ["fresh"]), ttlMs: 600_000, cacheKey: `${s}:${days}` });
    },
    earnings: async (options: { days?: number; symbol?: string; fresh?: boolean } = {}) => {
      const days = options.days ?? 7;
      if (!Number.isInteger(days) || days < 1 || days > 30) return this.invalid("equity.earnings", GLOBAL_SCOPE, "days must be 1–30");
      const s = options.symbol?.trim().toUpperCase();
      return this.run("equity.earnings", GLOBAL_SCOPE, (p) => (p as unknown as FinnhubProvider).earnings(days, s), { ...pick(options, ["fresh"]), ttlMs: 3_600_000, cacheKey: `${days}:${s ?? ""}` });
    },
    marketStatus: async (options: { fresh?: boolean } = {}) => this.run("equity.market_status", GLOBAL_SCOPE, (p) => (p as unknown as FinnhubProvider).marketStatus(), { ...pick(options, ["fresh"]), ttlMs: 60_000 }),
  };

  /** Market news (Finnhub): general, crypto, forex, merger. */
  readonly news = {
    market: async (category: "general" | "crypto" | "forex" | "merger" = "general", options: { fresh?: boolean } = {}) => {
      if (!["general", "crypto", "forex", "merger"].includes(category)) return this.invalid("news.market", GLOBAL_SCOPE, "category must be general, crypto, forex or merger");
      return this.run("news.market", GLOBAL_SCOPE, (p) => (p as unknown as FinnhubProvider).marketNews(category), { ...pick(options, ["fresh"]), ttlMs: 300_000, cacheKey: category });
    },
  };

  // ------------------------------------------------------------------------------------ macro

  /** US macro from FRED: rates, inflation, yields, unemployment, dollar index, VIX. */
  readonly macro = {
    series: async (id: string, options: { limit?: number; fresh?: boolean } = {}) => {
      const s = id.trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,30}$/.test(s)) return this.invalid("macro.series", GLOBAL_SCOPE, `invalid FRED series id: ${id}`);
      const limit = options.limit ?? 24;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return this.invalid("macro.series", GLOBAL_SCOPE, "limit must be 1–500");
      return this.run("macro.series", GLOBAL_SCOPE, (p) => (p as unknown as FredProvider).series(s, limit), { ...pick(options, ["fresh"]), ttlMs: 3_600_000, cacheKey: `${s}:${limit}` });
    },
    /** The latest value of each headline series (CPI as year-over-year %), with the previous value. */
    overview: async (options: { fresh?: boolean } = {}): Promise<DataResult<{ count: number; series: Array<{ id: string; label: string; unit: string; value?: number; previous?: number; date?: string; status: string }> }>> => {
      const results = await Promise.all(MACRO_SERIES.map((m) => this.macro.series(m.id, { limit: m.yoy ? 14 : 30, ...pick(options, ["fresh"]) })));
      const first = results.find(isLive);
      if (!first) return results[0] as unknown as DataResult<never>;
      const series = MACRO_SERIES.map((m, i) => {
        const r = results[i]!;
        if (!isLive(r)) return { id: m.id, label: m.label, unit: m.unit, status: r.status };
        const pts = (r.data as { points: Array<{ date: string; value: number }> }).points;
        const yoy = (k: number) => {
          const now = pts[pts.length - 1 - k];
          const ago = pts[pts.length - 13 - k];
          return now && ago ? Number((((now.value - ago.value) / ago.value) * 100).toFixed(2)) : undefined;
        };
        const value = m.yoy ? yoy(0) : pts[pts.length - 1]?.value;
        const previous = m.yoy ? yoy(1) : pts[pts.length - 2]?.value;
        const row: { id: string; label: string; unit: string; value?: number; previous?: number; date?: string; status: string } = { id: m.id, label: m.label, unit: m.unit, status: "LIVE" };
        if (value !== undefined) row.value = value;
        if (previous !== undefined) row.previous = previous;
        const date = pts[pts.length - 1]?.date;
        if (date) row.date = date;
        return row;
      });
      return { ...first, capability: "macro.series", data: { count: series.length, series }, provenance: { ...first.provenance, resource: "series/observations (8 series)" } } as DataResult<{ count: number; series: Array<{ id: string; label: string; unit: string; value?: number; previous?: number; date?: string; status: string }> }>;
    },
  };

  // ------------------------------------------------------------------------------------ perps

  /** Perpetual and spot markets on Lighter — the Robinhood Chain deployment by default (venue "robinhood"), or "mainnet". */
  readonly perps = {
    markets: async (options: { venue?: string; type?: "perp" | "spot" | "all"; sort?: "volume" | "oi" | "change" | "losers"; search?: string; limit?: number; fresh?: boolean } = {}) => {
      const venue = options.venue ?? "robinhood";
      if (!LIGHTER_VENUES[venue]) return this.invalid("perps.markets", GLOBAL_SCOPE, `venue must be ${Object.keys(LIGHTER_VENUES).join(" or ")}`);
      const result = await this.run<{ venue: string; label: string; count: number; markets: PerpMarket[] }>("perps.markets", GLOBAL_SCOPE, (p) => (p as unknown as LighterProvider).markets(venue), { ...pick(options, ["fresh"]), ttlMs: 30_000, cacheKey: venue });
      if (!isLive(result)) return result;
      const type = options.type ?? "perp";
      const q = options.search?.trim().toUpperCase();
      const key = (m: PerpMarket) => (options.sort === "oi" ? (m.openInterestUsd ?? 0) : options.sort === "change" ? (m.change24hPct ?? -Infinity) : options.sort === "losers" ? -(m.change24hPct ?? Infinity) : (m.volume24hUsd ?? 0));
      const markets = result.data.markets
        .filter((m) => (type === "all" || m.type === type) && (!q || m.symbol.toUpperCase().includes(q)))
        .sort((a, b) => key(b) - key(a))
        .slice(0, options.limit ?? 30);
      return { ...result, data: { ...result.data, type, sort: options.sort ?? "volume", count: markets.length, markets } };
    },
    funding: async (options: { venue?: string; search?: string; limit?: number; fresh?: boolean } = {}) => {
      const venue = options.venue ?? "robinhood";
      if (!LIGHTER_VENUES[venue]) return this.invalid("perps.funding", GLOBAL_SCOPE, `venue must be ${Object.keys(LIGHTER_VENUES).join(" or ")}`);
      const result = await this.run<{ venue: string; count: number; rates: Array<{ symbol: string; percentPerInterval: Record<string, number> }> }>("perps.funding", GLOBAL_SCOPE, (p) => (p as unknown as LighterProvider).funding(venue), { ...pick(options, ["fresh"]), ttlMs: 60_000, cacheKey: venue });
      if (!isLive(result)) return result;
      const q = options.search?.trim().toUpperCase();
      const rates = result.data.rates
        .filter((r) => r.percentPerInterval.lighter !== undefined && (!q || r.symbol.includes(q)))
        .sort((a, b) => Math.abs(b.percentPerInterval.lighter!) - Math.abs(a.percentPerInterval.lighter!))
        .slice(0, options.limit ?? 30);
      return { ...result, data: { ...result.data, count: rates.length, rates } };
    },
    stats: async (options: { venue?: string; fresh?: boolean } = {}) => {
      const venue = options.venue ?? "robinhood";
      if (!LIGHTER_VENUES[venue]) return this.invalid("perps.stats", GLOBAL_SCOPE, `venue must be ${Object.keys(LIGHTER_VENUES).join(" or ")}`);
      return this.run("perps.stats", GLOBAL_SCOPE, (p) => (p as unknown as LighterProvider).stats(venue), { ...pick(options, ["fresh"]), ttlMs: 60_000, cacheKey: venue });
    },
  };

  // -------------------------------------------------------------------------------------- defi

  /** DeFi on the chain from DefiLlama: TVL, protocols, DEX volume, fees, stablecoins, yields, prices. */
  readonly defi = {
    /** One section per DefiLlama dataset (TVL, DEX volume, fees, stablecoins), each with its own status. */
    overview: async (options: CallOptions = {}): Promise<Composite | ErrorResult> => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const f = pick(options, ["fresh"]);
      const [tvl, dexVolume, fees, stablecoins] = await Promise.all([this.defi.tvl({ ...f, chain: chain.key }), this.defi.dexes({ ...f, chain: chain.key }), this.defi.fees({ ...f, chain: chain.key }), this.defi.stablecoins({ ...f, chain: chain.key })]);
      return this.composite("defi", chain, { tvl, dexVolume, fees, stablecoins });
    },
    tvl: async (options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.run("defi.chain_tvl", chain, (p) => (p as unknown as DefiLlamaProvider).chainTvl(chain), { ...pick(options, ["fresh"]), ttlMs: 600_000 });
    },
    protocols: async (options: CallOptions & { search?: string; category?: string; limit?: number } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const result = await this.run<{ chain: string; count: number; protocols: Array<{ name: string; category?: string; slug?: string }> }>("defi.protocols", chain, (p) => (p as unknown as DefiLlamaProvider).protocols(chain), { ...pick(options, ["fresh"]), ttlMs: 600_000 });
      if (!isLive(result)) return result;
      const q = options.search?.trim().toLowerCase();
      const cat = options.category?.trim().toLowerCase();
      const protocols = result.data.protocols.filter((x) => (!q || x.name.toLowerCase().includes(q) || x.slug?.includes(q)) && (!cat || x.category?.toLowerCase() === cat)).slice(0, options.limit ?? 50);
      return { ...result, data: { ...result.data, count: protocols.length, protocols } };
    },
    dexes: async (options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.run("defi.dex_volume", chain, (p) => (p as unknown as DefiLlamaProvider).dexVolume(chain), { ...pick(options, ["fresh"]), ttlMs: 600_000 });
    },
    fees: async (options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.run("defi.fees", chain, (p) => (p as unknown as DefiLlamaProvider).fees(chain), { ...pick(options, ["fresh"]), ttlMs: 600_000 });
    },
    stablecoins: async (options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      return this.run("defi.stablecoins", chain, (p) => (p as unknown as DefiLlamaProvider).stablecoins(chain), { ...pick(options, ["fresh"]), ttlMs: 600_000 });
    },
    /** Yield pools, sorted by TVL (default) or APY; `minTvl` drops small pools (default $10k). */
    yields: async (options: CallOptions & { sort?: "tvl" | "apy"; minTvl?: number; search?: string; stablecoin?: boolean; limit?: number } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const result = await this.run<{ chain: string; count: number; pools: Array<{ project: string; symbol: string; tvlUsd?: number; apyPct?: number; stablecoin?: boolean }> }>("defi.yields", chain, (p) => (p as unknown as DefiLlamaProvider).yields(chain), { ...pick(options, ["fresh"]), ttlMs: 900_000 });
      if (!isLive(result)) return result;
      const minTvl = options.minTvl ?? 10_000;
      const q = options.search?.trim().toLowerCase();
      const key = options.sort === "apy" ? "apyPct" : "tvlUsd";
      const pools = result.data.pools
        .filter((x) => (x.tvlUsd ?? 0) >= minTvl && (options.stablecoin === undefined || x.stablecoin === options.stablecoin) && (!q || x.project.toLowerCase().includes(q) || x.symbol.toLowerCase().includes(q)))
        .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
        .slice(0, options.limit ?? 30);
      return { ...result, data: { ...result.data, sort: key, minTvl, count: pools.length, pools } };
    },
    /** Current token prices (DefiLlama coins API; up to 50 addresses). */
    tokenPrice: async (addresses: string | string[], options: CallOptions = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      const list = Array.isArray(addresses) ? addresses : addresses.split(",").map((a) => a.trim()).filter(Boolean);
      if (list.length === 0 || list.length > 50 || !list.every((a) => ADDRESS.test(a))) return this.invalid("defi.token_price", chain, "1–50 token addresses (0x…)");
      return this.run("defi.token_price", chain, (p) => (p as unknown as DefiLlamaProvider).tokenPrices(chain, list), { ...pick(options, ["fresh"]), ttlMs: TTL.price, cacheKey: list.join(",").toLowerCase() });
    },
    /** Token price history: `points` × `period` (1h, 4h, 1d). */
    priceChart: async (address: string, options: CallOptions & { points?: number; period?: string } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!ADDRESS.test(address)) return this.invalid("defi.price_chart", chain, `invalid token address: ${address}`);
      const period = options.period ?? "1h";
      const points = options.points ?? 24;
      if (!/^\d{1,2}[hdw]$/.test(period)) return this.invalid("defi.price_chart", chain, "period like 1h, 4h, 1d");
      if (!Number.isInteger(points) || points < 2 || points > 500) return this.invalid("defi.price_chart", chain, "points must be 2–500");
      return this.run("defi.price_chart", chain, (p) => (p as unknown as DefiLlamaProvider).priceChart(chain, address, points, period), { ...pick(options, ["fresh"]), ttlMs: 300_000, cacheKey: `${address.toLowerCase()}:${points}:${period}` });
    },
  };

  readonly indexing = {
    /** GraphQL query against a subgraph id on The Graph Network (no subgraph is assumed). */
    subgraph: async (subgraphId: string, query: string, options: CallOptions & { variables?: Record<string, unknown> } = {}) => {
      const chain = this.chain(options.chain);
      if ("status" in chain) return chain;
      if (!/^[A-Za-z0-9]{20,80}$/.test(subgraphId)) return this.invalid("subgraph.query", chain, "subgraph id must be the alphanumeric id from The Graph Explorer");
      if (query.length === 0 || query.length > 20_000) return this.invalid("subgraph.query", chain, "query must be 1–20000 characters");
      return this.run("subgraph.query", chain, async (p) => ({ data: await (p as TheGraphProvider).query(subgraphId, query, options.variables ?? {}) }), { fresh: true });
    },
  };

  // ------------------------------------------------------------------------------- providers

  readonly providers = {
    /** Real health checks for every provider (for each chain it serves). */
    check: async (options: { chain?: string | number } = {}): Promise<ProviderStatus[]> => {
      const only = options.chain !== undefined ? resolveChain(options.chain) : null;
      const rows: ProviderStatus[] = [];
      await Promise.all(
        this.registry.all().map(async (p) => {
          // Chain-bound providers are checked on their chain; global and any-network providers globally.
          const global = p.chains.includes("global") || p.chains.includes("*");
          const chain: Scope | null = global ? GLOBAL_SCOPE : resolveChain(only?.key ?? p.chains[0]!);
          if (!p.unconfigured && chain && (global || p.chains.includes(chain.key))) {
            const started = Date.now();
            this.registry.recordChecked(p.name);
            try {
              const out = await p.check(chain);
              if (out.chainId !== undefined) this.registry.recordChainId(p.name, chain, out.chainId);
              if (out.chainId !== undefined && out.chainId !== chain.chainId) {
                this.registry.recordFailure(p.name, new ProviderError(`reports chain id ${out.chainId}, expected ${chain.chainId}`, "chain_mismatch"));
              } else this.registry.recordSuccess(p.name, Date.now() - started);
              this.lastCheck.set(p.name, out.detail);
            } catch (error) {
              const err = error instanceof ProviderError ? error : new ProviderError(String((error as Error)?.message ?? error), "network");
              this.registry.recordFailure(p.name, err);
              this.lastCheck.set(p.name, err.message);
            }
          }
        }),
      );
      for (const p of this.registry.all()) rows.push(this.statusOf(p));
      return rows;
    },
    /** Current (last known) status without making requests. */
    list: (): ProviderStatus[] => this.registry.all().map((p) => this.statusOf(p)),
  };

  private statusOf(p: Provider): ProviderStatus {
    const h = this.registry.healthOf(p.name);
    return {
      provider: p.name,
      kind: p.kind,
      status: h.status,
      configured: !p.unconfigured,
      chains: p.chains,
      capabilities: p.capabilities,
      latencyMs: h.latencyMs,
      lastCheckedAt: h.lastCheckedAt,
      lastSuccessAt: h.lastSuccessAt,
      lastError: h.lastError,
      detail: this.lastCheck.get(p.name) ?? null,
      verifiedChainIds: h.verifiedChainIds,
      endpoint: p.endpoint,
      auth: p.auth,
      envVars: p.envVars.map((name) => ({ name, set: Boolean(this.env.values[name as keyof typeof this.env.values]) })),
      rateLimit: p.rateLimit,
      verification: p.verification,
      unsupportedAtRuntime: this.registry.unsupportedAtRuntime(p.name),
    };
  }

  /** Capability × provider matrix (declared and verified state). */
  capabilityMatrix(): Array<{ capability: string; providers: Array<{ provider: string; status: HealthStatus; configured: boolean }> }> {
    const caps = new Set(this.registry.all().flatMap((p) => p.capabilities));
    return [...caps].sort().map((capability) => ({
      capability,
      providers: this.registry
        .all()
        .filter((p) => (p.capabilities as string[]).includes(capability))
        .map((p) => ({ provider: p.name, status: this.registry.healthOf(p.name).status, configured: !p.unconfigured })),
    }));
  }
}
