/**
 * Provider abstraction: Provider, ProviderCapability, ProviderHealth, ProviderRegistry,
 * ProviderRouter and the cache for previously fetched real data.
 *
 * Request flow: capability + scope (a chain, a market network, or "global") → providers that
 * declare both and are configured → health
 * filter (auth failures, chain mismatches, open circuits are skipped) → chain id verified live
 * for RPC providers → execute → normalize → provenance. Fallback only ever means "another real
 * provider with the same capability and chain"; when none succeeds the result is an explicit
 * ERROR or UNAVAILABLE — never a substituted value.
 */
import type { ChainInfo, Scope } from "./chains.js";
import { ProviderError, failure, unavailable, type DataResult, type LiveResult, type Provenance } from "./result.js";

export const CAPABILITIES = [
  "chain.id",
  "block.latest",
  "block.get",
  "tx.get",
  "tx.receipt",
  "tx.indexed",
  "tx.stateChanges",
  "trace.transaction",
  "account.balance",
  "account.nonce",
  "contract.code",
  "contract.call",
  "contract.storage",
  "contract.verified",
  "logs.query",
  "gas.price",
  "token.balances",
  "token.metadata",
  "token.transfers",
  "token.holders",
  "nft.balances",
  "address.transactions",
  "address.counters",
  "address.internal",
  "market.price",
  "market.tokenPrice",
  "market.pools",
  "security.token",
  "security.address",
  "security.approvals",
  "wallet.portfolio",
  "wallet.positions",
  "wallet.transactions",
  "stock.assets",
  "stock.price",
  "stock.tokens",
  "subgraph.query",
  // Market data across DEX networks (DexScreener, GeckoTerminal; CoinGecko for Robinhood token prices)
  "market.search",
  "market.token",
  "market.token_pairs",
  "market.pair",
  "market.ohlcv",
  "market.trades",
  "market.networks",
  "market.dexes",
  "market.trending_pools",
  "market.new_pools",
  "market.top_pools",
  // Oracle prices (Chainlink Data Streams)
  "oracle.feeds",
  "oracle.report",
  "oracle.candles",
  "oracle.symbols",
  // Every token on a chain with live stats (Codex)
  "tokens.filter",
  "tokens.price",
  "tokens.bars",
  "tokens.events",
  "tokens.info",
  "tokens.pairs",
  // Global crypto market (CoinGecko)
  "global.market",
  "global.coins",
  "global.trending",
  "global.sentiment",
  // US equities and news (Finnhub)
  "equity.quote",
  "equity.profile",
  "equity.news",
  "equity.earnings",
  "equity.market_status",
  "news.market",
  // Macro (FRED)
  "macro.series",
  // Perpetuals (Lighter)
  "perps.markets",
  "perps.funding",
  "perps.stats",
  // DeFi (DefiLlama)
  "defi.chain_tvl",
  "defi.protocols",
  "defi.dex_volume",
  "defi.fees",
  "defi.stablecoins",
  "defi.yields",
  "defi.token_price",
  "defi.price_chart",
  // AI (OpenRouter, Gemini)
  "ai.generate",
  "ai.tools",
  "ai.structured_output",
  "ai.multimodal",
  "ai.reason",
  "ai.models",
  // Developer data (GitHub REST API, raw.githubusercontent.com)
  "developer.repository",
  "developer.repository_search",
  "developer.repository_contents",
  "developer.repository_tree",
  "developer.commits",
  "developer.branches",
  "developer.releases",
  "developer.issues",
  "developer.pull_requests",
  "developer.user",
  "developer.code_search",
  "developer.raw_content",
  // Web search and page extraction (Tavily, Exa, Firecrawl)
  "web.search",
  "web.extract",
  "web.map",
  "web.similar",
  "web.answer",
] as const;

export type ProviderCapability = (typeof CAPABILITIES)[number];

export type ProviderKind = "rpc" | "indexer" | "market" | "security" | "wallet" | "stock" | "oracle" | "defi" | "macro" | "ai" | "developer" | "web";

export type HealthStatus = "healthy" | "degraded" | "down" | "auth_failed" | "chain_mismatch" | "not_configured" | "unknown";

export interface ProviderHealth {
  status: HealthStatus;
  latencyMs: number | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /** Last live health check (splice providers), ISO 8601. */
  lastCheckedAt: string | null;
  /** Chain id reported by the provider (RPC providers), per chain key. */
  verifiedChainIds: Record<string, number>;
  consecutiveFailures: number;
}

export interface ProviderDescriptor {
  name: string;
  kind: ProviderKind;
  /**
   * Scopes the provider serves: Splice chain keys (see chains.ts), "global" (AI, developer data),
   * or "*" for any market network (the provider itself rejects networks it does not know).
   */
  chains: string[];
  capabilities: ProviderCapability[];
  /** Human description of authentication (never the secret). */
  auth: string;
  envVars: string[];
  /** Endpoint for display, with secrets removed. */
  endpoint: string;
  rateLimit: string;
  docs: string;
  /** Verification state of the declared capabilities, from live probes (documentation is not enough). */
  verification: string;
}

/** Data produced by a provider operation, before provenance is attached. */
export interface ProviderData<T> {
  data: T;
  blockNumber?: string;
  blockHash?: string;
  requestId?: string;
  /** Provider resource the data came from (path without credentials). */
  resource?: string;
  rateLimit?: Provenance["rateLimit"];
  notes?: string[];
}

export interface Provider extends ProviderDescriptor {
  /** Why the provider cannot be used (missing env), or null when configured. */
  readonly unconfigured: string | null;
  /** Live, lightweight check (never an expensive call). RPC providers return the chain id they report. */
  check(scope: Scope): Promise<{ detail: string; chainId?: number; blockNumber?: string }>;
  /** RPC providers: chain id reported by the endpoint (eth_chainId). */
  chainId?(chain: ChainInfo): Promise<number>;
}

export class ProviderRegistry {
  private readonly providers: Provider[] = [];
  private readonly health = new Map<string, ProviderHealth>();
  /** Capabilities a provider turned out not to support at runtime (e.g. method not enabled on the plan). */
  private readonly runtimeUnsupported = new Map<string, Set<string>>();

  register(provider: Provider): this {
    this.providers.push(provider);
    this.health.set(provider.name, {
      status: provider.unconfigured ? "not_configured" : "unknown",
      latencyMs: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: provider.unconfigured,
      lastCheckedAt: null,
      verifiedChainIds: {},
      consecutiveFailures: 0,
    });
    return this;
  }

  all(): Provider[] {
    return [...this.providers];
  }

  get(name: string): Provider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  healthOf(name: string): ProviderHealth {
    return this.health.get(name)!;
  }

  /** Providers that declare the capability in the scope (configured or not), in priority order. */
  declaring(capability: ProviderCapability, chain: Scope): Provider[] {
    const serves = (p: Provider) => p.chains.includes(chain.key) || (p.chains.includes("*") && chain.key !== "global");
    return this.providers.filter((p) => serves(p) && p.capabilities.includes(capability) && !this.runtimeUnsupported.get(p.name)?.has(`${capability}@${chain.key}`));
  }

  markUnsupported(provider: string, capability: ProviderCapability, chain: Scope): void {
    if (!this.runtimeUnsupported.has(provider)) this.runtimeUnsupported.set(provider, new Set());
    this.runtimeUnsupported.get(provider)!.add(`${capability}@${chain.key}`);
  }

  unsupportedAtRuntime(provider: string): string[] {
    return [...(this.runtimeUnsupported.get(provider) ?? [])];
  }

  recordSuccess(name: string, latencyMs: number): void {
    const h = this.health.get(name)!;
    h.status = "healthy";
    h.latencyMs = latencyMs;
    h.lastSuccessAt = new Date().toISOString();
    h.consecutiveFailures = 0;
  }

  recordFailure(name: string, error: ProviderError | Error): void {
    const h = this.health.get(name)!;
    h.lastErrorAt = new Date().toISOString();
    h.lastError = error.message;
    h.consecutiveFailures++;
    const kind = error instanceof ProviderError ? error.kind : "network";
    if (kind === "auth") h.status = "auth_failed";
    else if (kind === "chain_mismatch") h.status = "chain_mismatch";
    else if (kind === "rate_limited") h.status = "degraded";
    else h.status = h.consecutiveFailures >= 3 ? "down" : "degraded";
  }

  recordChecked(name: string): void {
    this.health.get(name)!.lastCheckedAt = new Date().toISOString();
  }

  recordChainId(name: string, chain: Scope, chainId: number): void {
    this.health.get(name)!.verifiedChainIds[chain.key] = chainId;
  }

  /** Why a provider must be skipped right now, or null. */
  skipReason(provider: Provider): string | null {
    if (provider.unconfigured) return provider.unconfigured;
    const h = this.health.get(provider.name)!;
    if (h.status === "auth_failed") return `credential rejected: ${h.lastError}`;
    if (h.status === "chain_mismatch") return `chain id mismatch: ${h.lastError}`;
    // Open circuit: three failures in a row → wait 30 s before trying again.
    if (h.status === "down" && h.lastErrorAt && Date.now() - Date.parse(h.lastErrorAt) < 30_000) return `temporarily skipped after ${h.consecutiveFailures} consecutive failures: ${h.lastError}`;
    return null;
  }
}

/** Cache of real provider responses (performance only). Entries keep their original provenance. */
export class ResultCache {
  private readonly entries = new Map<string, { result: LiveResult<unknown>; cachedAt: number; ttlMs: number }>();
  /** Expired entries are dropped, never returned (not even as stale). */
  constructor(private readonly maxEntries = 500) {}

  get<T>(key: string): LiveResult<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.cachedAt;
    if (age > entry.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    // A cached copy is never presented as live.
    return {
      ...entry.result,
      status: "CACHED",
      provenance: { ...entry.result.provenance, fresh: false, cache: { key, cachedAt: new Date(entry.cachedAt).toISOString(), ageMs: age, ttlMs: entry.ttlMs, expiresAt: new Date(entry.cachedAt + entry.ttlMs).toISOString() } },
    } as LiveResult<T>;
  }

  set(key: string, result: LiveResult<unknown>, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { result, cachedAt: Date.now(), ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface RunOptions {
  /** Bypass the cache and ask a provider now. */
  fresh?: boolean;
  /** Cache TTL for the result (0 = never cache). */
  ttlMs?: number;
  /** Cache key parts (beyond capability and chain). */
  cacheKey?: string;
  /** Preferred provider order for this request (others follow in registration order). */
  prefer?: string[];
  /**
   * Only these providers, in this order (explicit routing — e.g. AI: the requested provider, then
   * configured fallbacks). Providers not listed are never used.
   */
  only?: string[];
}

export class ProviderRouter {
  constructor(
    readonly registry: ProviderRegistry,
    readonly cache = new ResultCache(),
  ) {}

  private async verifyChain(provider: Provider, scope: Scope): Promise<void> {
    if (!provider.chainId) return;
    const chain = "ids" in scope ? (scope as ChainInfo) : scope.chain;
    if (!chain) return;
    const known = this.registry.healthOf(provider.name).verifiedChainIds[chain.key];
    if (known !== undefined) {
      if (known !== chain.chainId) throw new ProviderError(`endpoint reports chain id ${known}, expected ${chain.chainId}`, "chain_mismatch");
      return;
    }
    const reported = await provider.chainId(chain);
    this.registry.recordChainId(provider.name, chain, reported);
    if (reported !== chain.chainId) throw new ProviderError(`endpoint reports chain id ${reported}, expected ${chain.chainId}`, "chain_mismatch");
  }

  /** Runs a capability against the first healthy provider that supports it, with real fallback. */
  async run<T>(capability: ProviderCapability, chain: Scope, op: (provider: Provider) => Promise<ProviderData<T>>, options: RunOptions = {}): Promise<DataResult<T>> {
    const key = `${capability}|${chain.key}|${options.cacheKey ?? ""}`;
    if (!options.fresh) {
      const cached = this.cache.get<T>(key);
      if (cached) return cached;
    }
    const rank = (name: string) => {
      const i = options.prefer?.indexOf(name) ?? -1;
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    let declaring = this.registry.declaring(capability, chain).sort((a, b) => rank(a.name) - rank(b.name));
    if (options.only) {
      const only = options.only;
      declaring = only.map((name) => declaring.find((p) => p.name === name)).filter((p): p is Provider => p !== undefined);
    }
    const where = chain.chainId === null ? chain.name : `${chain.name} (${chain.chainId})`;
    if (declaring.length === 0) return unavailable(capability, chain, `no Splice provider offers ${capability} on ${where}${options.only ? ` among ${options.only.join(", ")}` : ""}`);

    const skipped: Array<{ provider: string; reason: string }> = [];
    const attempts: Array<{ provider: string; error: string; status?: number }> = [];
    const notListed: Array<{ provider: string; reason: string }> = [];
    let rateLimited = 0;
    for (const provider of declaring) {
      const reason = this.registry.skipReason(provider);
      if (reason) {
        skipped.push({ provider: provider.name, reason });
        continue;
      }
      const started = Date.now();
      try {
        await this.verifyChain(provider, chain);
        const out = await op(provider);
        this.registry.recordSuccess(provider.name, Date.now() - started);
        const provenance: Provenance = { source: provider.name, chain: chain.key, chainId: chain.chainId, fetchedAt: new Date().toISOString(), fresh: true };
        if (out.blockNumber !== undefined) provenance.blockNumber = out.blockNumber;
        if (out.blockHash !== undefined) provenance.blockHash = out.blockHash;
        if (out.requestId !== undefined) provenance.requestId = out.requestId;
        if (out.resource !== undefined) provenance.resource = out.resource;
        if (out.rateLimit !== undefined) provenance.rateLimit = out.rateLimit;
        if (out.notes?.length) provenance.notes = out.notes;
        // With explicit routing, a skipped requested provider is part of the trail too (never hidden).
        const trail = [
          ...attempts.map((a) => ({ provider: a.provider, error: a.error })),
          ...notListed.map((n) => ({ provider: n.provider, error: `no data: ${n.reason}` })),
          ...(options.only ? skipped.map((s) => ({ provider: s.provider, error: `skipped: ${s.reason}` })) : []),
        ];
        if (trail.length) provenance.fallbackFrom = trail;
        if ((options.ttlMs ?? 0) > 0) provenance.expiresAt = new Date(Date.now() + options.ttlMs!).toISOString();
        const result: LiveResult<T> = { status: "LIVE", capability, data: out.data, provenance };
        this.cache.set(key, result as LiveResult<unknown>, options.ttlMs ?? 0);
        return result;
      } catch (error) {
        const err = error instanceof ProviderError ? error : new ProviderError(String((error as Error)?.message ?? error), "network");
        if (err.kind === "not_found") {
          this.registry.recordSuccess(provider.name, Date.now() - started);
          return failure("NOT_FOUND", capability, chain, err.message, [...attempts, { provider: provider.name, error: err.message, ...(err.status ? { status: err.status } : {}) }]);
        }
        if (err.kind === "not_listed") {
          // A real answer: this provider has no data for the object. Never replaced by a value; the
          // next provider with the same capability may have it (recorded in the fallback trail).
          this.registry.recordSuccess(provider.name, Date.now() - started);
          notListed.push({ provider: provider.name, reason: err.message });
          continue;
        }
        if (err.kind === "rejected") {
          this.registry.recordSuccess(provider.name, Date.now() - started);
          return failure("PROVIDER_ERROR", capability, chain, err.message, [...attempts, { provider: provider.name, error: err.message, ...(err.status ? { status: err.status } : {}) }]);
        }
        if (err.kind === "unsupported") {
          // The provider answered: the method/feature is not available on this plan/network.
          this.registry.markUnsupported(provider.name, capability, chain);
          skipped.push({ provider: provider.name, reason: `does not support ${capability} here: ${err.message}` });
          continue;
        }
        this.registry.recordFailure(provider.name, err);
        if (err.kind === "rate_limited") rateLimited++;
        attempts.push({ provider: provider.name, error: err.message, ...(err.status ? { status: err.status } : {}) });
      }
    }
    if (attempts.length === 0 && notListed.length > 0) {
      return unavailable(capability, chain, notListed[0]!.reason, { provider: notListed[0]!.provider, providers: [...notListed.slice(1), ...skipped] });
    }
    if (attempts.length === 0) {
      return unavailable(capability, chain, `no usable provider for ${capability} on ${where} right now`, { providers: skipped });
    }
    const all = [...attempts, ...skipped.map((s) => ({ provider: s.provider, error: `skipped: ${s.reason}` }))];
    if (rateLimited === attempts.length) return failure("RATE_LIMITED", capability, chain, "every provider for this capability is rate limiting this client; retry later", all);
    return failure("ALL_PROVIDERS_FAILED", capability, chain, `all providers for ${capability} failed`, all);
  }
}
