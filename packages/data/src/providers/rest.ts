/**
 * HTTP API providers: Blockscout (PRO API), CoinGecko, GoPlus, Zerion, The Graph and the Robinhood
 * Stock Token API. Each declares only what was verified against the live API (see `verification`).
 * Responses are returned as the provider sent them (selected fields), with provenance attached by
 * the router â€” nothing is filled in when a field is missing.
 */
import { createHash } from "node:crypto";
import type { ChainInfo } from "../chains.js";
import type { HttpClient } from "../http.js";
import type { Provider, ProviderCapability, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";
import { geckoPool } from "./market.js";

abstract class RestProvider implements Provider {
  abstract readonly name: string;
  abstract readonly kind: ProviderKind;
  abstract readonly chains: string[];
  abstract readonly capabilities: ProviderCapability[];
  abstract readonly auth: string;
  abstract readonly envVars: string[];
  abstract readonly endpoint: string;
  abstract readonly rateLimit: string;
  abstract readonly docs: string;
  abstract readonly verification: string;
  abstract readonly unconfigured: string | null;
  abstract check(chain: ChainInfo): Promise<{ detail: string }>;
  constructor(protected readonly http: HttpClient) {}
}

// ---------------------------------------------------------------------------------- Blockscout

export class BlockscoutProvider extends RestProvider {
  readonly name = "blockscout";
  readonly kind: ProviderKind = "indexer";
  readonly chains = ["robinhood"];
  readonly capabilities: ProviderCapability[] = [
    "tx.indexed",
    "tx.stateChanges",
    "trace.transaction",
    "token.balances",
    "token.metadata",
    "token.transfers",
    "token.holders",
    "nft.balances",
    "address.transactions",
    "address.counters",
    "address.internal",
    "contract.verified",
  ];
  readonly auth = "PRO API key as ?apikey= (BLOCKSCOUT_API_KEY)";
  readonly envVars = ["BLOCKSCOUT_API_KEY"];
  readonly endpoint = "https://api.blockscout.com/{chainId}/api/v2";
  readonly rateLimit = "PRO API plan dependent; some endpoints intermittently return HTTP 500 (upstream)";
  readonly docs = "https://docs.blockscout.com/robinhood-api";
  readonly verification =
    "verified live on 4663: addresses, token-balances, token-transfers, transactions, nft, counters, internal-transactions, transactions/{hash} incl. state-changes and raw-trace, tokens, holders, smart-contracts (verified source, ABI, proxy). The public instance robinhoodchain.blockscout.com is behind a browser challenge and is not used.";
  readonly unconfigured: string | null;

  constructor(
    http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    super(http);
    this.unconfigured = apiKey ? null : "BLOCKSCOUT_API_KEY is not set";
  }

  async get<T = Record<string, unknown>>(chain: ChainInfo, path: string, query: Record<string, string> = {}): Promise<T> {
    const id = chain.ids.blockscoutChainId;
    if (!id) throw new ProviderError(`Blockscout PRO API has no id for ${chain.key}`, "unsupported");
    const params = new URLSearchParams({ ...query, apikey: this.apiKey ?? "" });
    const url = `https://api.blockscout.com/${id}/api/v2${path}?${params}`;
    try {
      return (await this.http.json<T>(url)).body;
    } catch (error) {
      // Blockscout's upstream intermittently answers 5xx / slowly: one retry of the same request.
      if (error instanceof ProviderError && (error.kind === "network" || (error.kind === "http" && (error.status ?? 0) >= 500))) return (await this.http.json<T>(url)).body;
      throw error;
    }
  }

  async check(chain: ChainInfo): Promise<{ detail: string }> {
    const stats = await this.get<{ total_blocks?: string; average_block_time?: number }>(chain, "/stats");
    return { detail: `stats: total_blocks=${stats.total_blocks ?? "?"}, average_block_time=${stats.average_block_time ?? "?"}ms` };
  }
}

// ----------------------------------------------------------------------------------- CoinGecko

export class CoinGeckoProvider extends RestProvider {
  readonly name = "coingecko";
  readonly kind: ProviderKind = "market";
  readonly chains = ["robinhood", "global"];
  readonly capabilities: ProviderCapability[] = ["market.price", "market.tokenPrice", "market.pools", "market.top_pools", "market.trending_pools", "market.new_pools", "stock.tokens", "global.market", "global.coins", "global.trending"];
  readonly auth: string;
  readonly envVars = ["COINGECKO_API_KEY"];
  readonly endpoint = "https://api.coingecko.com/api/v3";
  readonly rateLimit: string;
  readonly docs = "https://docs.coingecko.com";
  readonly verification =
    "verified live: asset platform 'robinhood' (chain_identifier 4663, native coin ethereum), /simple/price, /simple/token_price/robinhood (listed tokens only), /onchain/networks/robinhood/tokens/{address}/pools (GeckoTerminal pools with reserve_in_usd)";
  readonly unconfigured: string | null;

  constructor(
    http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    super(http);
    // Without a key the public API still answers prices (verified live: /simple/price and
    // /simple/token_price/robinhood); the onchain (pools) endpoints need a key (HTTP 401).
    this.unconfigured = null;
    this.auth = apiKey ? "Demo API key header x-cg-demo-api-key (COINGECKO_API_KEY)" : "keyless public API (prices only; set COINGECKO_API_KEY for pools and higher limits)";
    this.rateLimit = apiKey ? "Demo plan: ~30 calls/min, monthly credit cap" : "Keyless public API: low, shared per-IP limit";
  }

  async get<T = unknown>(path: string, maxBytes?: number): Promise<T> {
    if (!this.apiKey && path.startsWith("/onchain/")) throw new ProviderError("CoinGecko onchain data (DEX pools) needs COINGECKO_API_KEY; the keyless public API answers 401", "unsupported");
    const headers: Record<string, string> = this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : {};
    return (await this.http.json<T>(`https://api.coingecko.com/api/v3${path}`, { headers }, maxBytes ? { maxBytes } : {})).body;
  }

  /** Global crypto market: total market cap, volume, dominance, 24h change. */
  async globalMarket() {
    const body = await this.get<{ data?: Record<string, any> }>("/global");
    const d = body.data;
    if (!d) throw new ProviderError("CoinGecko returned no global data", "invalid_response");
    const dominance = Object.fromEntries(Object.entries((d.market_cap_percentage ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k.toUpperCase(), Number(v.toFixed(2))]));
    return { data: { totalMarketCapUsd: Math.round(d.total_market_cap?.usd ?? 0), totalVolumeUsd: Math.round(d.total_volume?.usd ?? 0), marketCapChange24hPct: Number((d.market_cap_change_percentage_24h_usd ?? 0).toFixed(2)), dominancePct: dominance, activeCryptocurrencies: d.active_cryptocurrencies, markets: d.markets, updatedAt: d.updated_at ? new Date(d.updated_at * 1000).toISOString() : undefined }, resource: "global" };
  }

  /** Top coins by market cap with 1h/24h/7d change. */
  async coinMarkets(limit: number) {
    const rows = await this.get<Array<Record<string, any>>>(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&price_change_percentage=1h,24h,7d`);
    const coins = rows.map((c) => ({ rank: c.market_cap_rank, id: c.id, symbol: String(c.symbol ?? "").toUpperCase(), name: c.name, priceUsd: c.current_price, change1hPct: c.price_change_percentage_1h_in_currency, change24hPct: c.price_change_percentage_24h_in_currency, change7dPct: c.price_change_percentage_7d_in_currency, marketCapUsd: c.market_cap, volume24hUsd: c.total_volume }));
    return { data: { count: coins.length, coins }, resource: "coins/markets" };
  }

  /** Coins trending in CoinGecko searches. */
  async trendingCoins() {
    const body = await this.get<{ coins?: Array<{ item?: Record<string, any> }> }>("/search/trending");
    const coins = (body.coins ?? []).map((c) => c.item ?? {}).map((i) => ({ id: i.id, symbol: String(i.symbol ?? "").toUpperCase(), name: i.name, marketCapRank: i.market_cap_rank, priceUsd: i.data?.price, change24hPct: i.data?.price_change_percentage_24h?.usd, marketCap: i.data?.market_cap, volume24h: i.data?.total_volume }));
    return { data: { count: coins.length, coins }, resource: "search/trending" };
  }

  private onchainNetwork(chain: ChainInfo): string {
    const id = chain.ids.coingeckoOnchainNetwork;
    if (!id) throw new ProviderError(`CoinGecko has no onchain network id for ${chain.key}`, "unsupported");
    return id;
  }

  /** DEX pools ranked like GeckoTerminal (same format, CoinGecko onchain API with the Demo key). */
  async topPools(chain: ChainInfo, sort: string, page: number) {
    const network = this.onchainNetwork(chain);
    const resource = `onchain/networks/${network}/pools?sort=${sort}&page=${page}`;
    const body = await this.get<{ data?: Array<Record<string, any>>; included?: Array<Record<string, any>> }>(`/${resource}&include=base_token,quote_token,dex`);
    return { data: { network, sort, page, pools: (body.data ?? []).map((p) => geckoPool(p, body.included ?? [], network)) }, resource };
  }

  async pools(chain: ChainInfo, kind: "trending_pools" | "new_pools", duration?: string) {
    const network = this.onchainNetwork(chain);
    const resource = `onchain/networks/${network}/${kind}`;
    const body = await this.get<{ data?: Array<Record<string, any>>; included?: Array<Record<string, any>> }>(`/${resource}?include=base_token,quote_token,dex${kind === "trending_pools" && duration ? `&duration=${duration}` : ""}`);
    return { data: { network, pools: (body.data ?? []).map((p) => geckoPool(p, body.included ?? [], network)) }, resource };
  }

  /**
   * Robinhood Stock Tokens as CoinGecko lists them: coins whose id ends in
   * "-robinhood-tokenized-stock" with a contract on the chain`s asset platform.
   */
  async stockTokens(chain: ChainInfo) {
    const platform = chain.ids.coingeckoPlatform;
    if (!platform) throw new ProviderError(`CoinGecko has no asset platform for ${chain.key}`, "unsupported");
    const list = await this.get<Array<{ id: string; symbol?: string; name?: string; platforms?: Record<string, string | null> }>>("/coins/list?include_platform=true", 40 * 1024 * 1024);
    const tokens = list
      .filter((c) => c.id.endsWith("-robinhood-tokenized-stock") && c.platforms?.[platform])
      .map((c) => ({ symbol: (c.symbol ?? "").toUpperCase(), name: c.name, address: c.platforms![platform]!, coingeckoId: c.id }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { data: { chain: chain.key, source: "coingecko coin list", count: tokens.length, tokens }, resource: "coins/list?include_platform=true" };
  }

  async check(): Promise<{ detail: string }> {
    const ping = await this.get<{ gecko_says?: string }>("/ping");
    return { detail: `ping: ${ping.gecko_says ?? "ok"}` };
  }
}

// ------------------------------------------------------------------------- Fear & Greed (alternative.me)

export class FearGreedProvider extends RestProvider {
  readonly name = "alternative-me";
  readonly kind: ProviderKind = "market";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["global.sentiment"];
  readonly auth = "none (public API)";
  readonly envVars: string[] = [];
  readonly endpoint = "https://api.alternative.me/fng/";
  readonly rateLimit = "60 requests/min (documented)";
  readonly docs = "https://alternative.me/crypto/fear-and-greed-index/";
  readonly verification = "verified live 2026-10-03: /fng/?limit=n returns value, classification and timestamp per day";
  readonly unconfigured: string | null = null;

  async index(days: number) {
    const body = (await this.http.json<{ data?: Array<{ value: string; value_classification: string; timestamp: string }> }>(`https://api.alternative.me/fng/?limit=${days}`)).body;
    const history = (body.data ?? []).map((d) => ({ date: new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10), value: Number(d.value), classification: d.value_classification }));
    if (history.length === 0) throw new ProviderError("alternative.me returned no index", "invalid_response");
    return { data: { index: "Crypto Fear & Greed Index", latest: history[0], history }, resource: "fng" };
  }

  async check(): Promise<{ detail: string }> {
    const r = await this.index(1);
    return { detail: `index ${r.data.latest!.value} (${r.data.latest!.classification})` };
  }
}

// -------------------------------------------------------------------------------------- GoPlus

export class GoPlusProvider extends RestProvider {
  readonly name = "goplus";
  readonly kind: ProviderKind = "security";
  readonly chains = ["robinhood"];
  readonly capabilities: ProviderCapability[] = ["security.token", "security.address"];
  readonly auth = "Access token from POST /api/v1/token signed with app key + secret (GOPLUS_APP_KEY, GOPLUS_APP_SECRET); anonymous access works with lower limits";
  readonly envVars = ["GOPLUS_APP_KEY", "GOPLUS_APP_SECRET"];
  readonly endpoint = "https://api.gopluslabs.io/api/v1";
  readonly rateLimit = "Anonymous: low per-minute limit; authenticated: plan dependent";
  readonly docs = "https://docs.gopluslabs.io";
  readonly verification =
    "verified live: chain 4663 listed in supported_chains; token_security/4663 and address_security?chain_id=4663 return results; token_approval_security/4663 answers 'Main chain does not exist' (approvals not supported on Robinhood)";
  readonly unconfigured: string | null = null;
  private token: { value: string; expires: number } | null = null;

  constructor(
    http: HttpClient,
    private readonly appKey: string | undefined,
    private readonly appSecret: string | undefined,
  ) {
    super(http);
  }

  /** Authorization header when app credentials are configured and accepted; anonymous otherwise. */
  private async authHeaders(): Promise<{ headers: Record<string, string>; authenticated: boolean }> {
    if (!this.appKey || !this.appSecret) return { headers: {}, authenticated: false };
    if (!this.token || this.token.expires < Date.now() + 60_000) {
      const time = Math.floor(Date.now() / 1000);
      const sign = createHash("sha1").update(`${this.appKey}${time}${this.appSecret}`).digest("hex");
      const res = await this.http.json<{ code: number; message: string; result?: { access_token: string; expires_in: number } }>("https://api.gopluslabs.io/api/v1/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_key: this.appKey, sign, time }),
      });
      if (res.body.code !== 1 || !res.body.result?.access_token) throw new ProviderError(this.http.redact(`GoPlus token request refused: ${res.body.message}`), "auth");
      this.token = { value: res.body.result.access_token, expires: Date.now() + res.body.result.expires_in * 1000 };
    }
    return { headers: { authorization: this.token.value }, authenticated: true };
  }

  async get<T = unknown>(path: string): Promise<{ result: T; authenticated: boolean }> {
    const { headers, authenticated } = await this.authHeaders();
    const res = await this.http.json<{ code: number; message: string; result: T }>(`https://api.gopluslabs.io${path}`, { headers });
    if (res.body.code === 4029 || /too many|rate/i.test(res.body.message ?? "")) throw new ProviderError(`GoPlus: ${res.body.message}`, "rate_limited");
    if (res.body.code === 2018 || /does not exist|not support/i.test(res.body.message ?? "")) throw new ProviderError(`GoPlus: ${res.body.message}`, "unsupported");
    if (res.body.code !== 1) throw new ProviderError(`GoPlus error ${res.body.code}: ${res.body.message}`, "http");
    return { result: res.body.result, authenticated };
  }

  async check(): Promise<{ detail: string }> {
    const res = await this.http.json<{ code: number; result?: Array<{ id: string; name: string }> }>("https://api.gopluslabs.io/api/v1/supported_chains");
    const listed = res.body.result?.some((c) => c.id === "4663");
    const { authenticated } = await this.authHeaders();
    return { detail: `supported_chains: 4663 ${listed ? "listed" : "NOT listed"}; ${authenticated ? "authenticated" : "anonymous"} access` };
  }
}

// -------------------------------------------------------------------------------------- Zerion

export class ZerionProvider extends RestProvider {
  readonly name = "zerion";
  readonly kind: ProviderKind = "wallet";
  readonly chains = ["robinhood"];
  readonly capabilities: ProviderCapability[] = ["wallet.portfolio", "wallet.positions", "wallet.transactions"];
  readonly auth = "HTTP Basic with the API key as user (ZERION_API_KEY)";
  readonly envVars = ["ZERION_API_KEY"];
  readonly endpoint = "https://api.zerion.io/v1";
  readonly rateLimit = "Developer plan: low per-second limit (HTTP 429 observed after a few calls)";
  readonly docs = "https://developers.zerion.io";
  readonly verification =
    "verified live: chain 'robinhood' (0x1237) listed; /wallets/{address}/portfolio, /positions/?filter[chain_ids]=robinhood and /transactions/?filter[chain_ids]=robinhood return data for EOAs; system/contract addresses are rejected as 'untrackable'";
  readonly unconfigured: string | null;

  constructor(
    http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    super(http);
    this.unconfigured = apiKey ? null : "ZERION_API_KEY is not set";
  }

  async get<T = unknown>(path: string): Promise<T> {
    const auth = `Basic ${Buffer.from(`${this.apiKey ?? ""}:`).toString("base64")}`;
    try {
      return (await this.http.json<T>(`https://api.zerion.io/v1${path}`, { headers: { authorization: auth } })).body;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 400 && /untrackable/i.test(error.message)) throw new ProviderError(`Zerion cannot track this address: ${error.message}`, "unsupported", 400);
      throw error;
    }
  }

  async check(chain: ChainInfo): Promise<{ detail: string }> {
    const res = await this.get<{ data?: Array<{ id: string; attributes?: { external_id?: string } }> }>("/chains/");
    const entry = res.data?.find((c) => c.id === chain.ids.zerionChainId);
    return { detail: `chains: ${entry ? `${entry.id} (${entry.attributes?.external_id})` : `${chain.key} not listed`}` };
  }
}

// ----------------------------------------------------------------------------------- The Graph

export class TheGraphProvider extends RestProvider {
  readonly name = "thegraph";
  readonly kind: ProviderKind = "indexer";
  readonly chains = ["robinhood"];
  readonly capabilities: ProviderCapability[] = ["subgraph.query"];
  readonly auth = "Gateway API key in the URL (THEGRAPH_API_KEY); Token API JWT as Bearer (STREAMINGFAST_API_TOKEN)";
  readonly envVars = ["THEGRAPH_API_KEY", "STREAMINGFAST_API_TOKEN"];
  readonly endpoint = "https://gateway.thegraph.com/api/{key}/subgraphs/id/{subgraphId}; https://token-api.thegraph.com";
  readonly rateLimit = "Gateway: per-query billing; Token API free tier (JWT): 200 requests/min";
  readonly docs = "https://thegraph.com/docs/en/";
  readonly verification =
    "not verified: the gateway rejects the configured key ('auth error: malformed API key'); token-api.thegraph.com resets the connection from this network. subgraph.query needs a subgraph id from the caller â€” no subgraph is assumed.";
  readonly unconfigured: string | null;

  constructor(
    http: HttpClient,
    private readonly gatewayKey: string | undefined,
    private readonly tokenApiJwt: string | undefined,
  ) {
    super(http);
    this.unconfigured = gatewayKey ? null : "THEGRAPH_API_KEY is not set";
  }

  /** GraphQL query against a subgraph deployed on The Graph Network (caller supplies the id). */
  async query<T = unknown>(subgraphId: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.gatewayKey) throw new ProviderError("THEGRAPH_API_KEY is not set", "auth");
    const res = await this.http.json<{ data?: T; errors?: Array<{ message: string }> }>(`https://gateway.thegraph.com/api/${this.gatewayKey}/subgraphs/id/${encodeURIComponent(subgraphId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.body.errors?.length) {
      const message = this.http.redact(res.body.errors.map((e) => e.message).join("; "));
      throw new ProviderError(`The Graph: ${message}`, /auth error|api key/i.test(message) ? "auth" : "http");
    }
    if (res.body.data === undefined) throw new ProviderError("The Graph: no data in response", "invalid_response");
    return res.body.data;
  }

  async check(): Promise<{ detail: string }> {
    const parts: string[] = [];
    if (this.gatewayKey) {
      const res = await this.http.json<{ errors?: Array<{ message: string }> }>(`https://gateway.thegraph.com/api/${this.gatewayKey}/subgraphs/id/QmSpliceKeyCheck`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
      });
      const message = res.body.errors?.map((e) => e.message).join("; ") ?? "";
      if (/auth error|api key/i.test(message)) throw new ProviderError(this.http.redact(`gateway: ${message}`), "auth");
      parts.push("gateway key accepted");
    }
    // The Token API backs no capability yet, so its reachability is reported but never fails the check.
    if (this.tokenApiJwt) {
      try {
        await this.http.json("https://token-api.thegraph.com/v1/health", { headers: { authorization: `Bearer ${this.tokenApiJwt}` } });
        parts.push("Token API reachable");
      } catch (error) {
        parts.push(`Token API unreachable (${(error as Error).message})`);
      }
    }
    return { detail: parts.join("; ") };
  }
}

// ------------------------------------------------------------------------- Robinhood Stock Tokens

export class RobinhoodStockProvider extends RestProvider {
  readonly name = "robinhood-stock-api";
  readonly kind: ProviderKind = "stock";
  readonly chains = ["robinhood"];
  readonly capabilities: ProviderCapability[] = ["stock.assets", "stock.price", "stock.tokens"];
  readonly auth = "none (read-only public endpoints)";
  readonly envVars: string[] = [];
  readonly endpoint = "https://api.robinhood.com/rhj";
  readonly rateLimit = "not documented";
  readonly docs = "https://docs.robinhood.com/chain/stock-token-apis/";
  readonly verification =
    "verified live 2026-10-03: GET /rhj/assets ({ assets: [...] } with per-chain deployments and multipliers) and GET /rhj/prices/{symbol} ({ quotes: [{ bid, ask (underlying), tokenBid, tokenAsk (per token), dailyHigh, dailyLow, dailyTradingVolume, isTradingHalt, generatedAt }] }). Some ISP DNS filters block *.robinhood.com.";
  readonly unconfigured: string | null = null;

  async get<T = unknown>(path: string): Promise<T> {
    return (await this.http.json<T>(`https://api.robinhood.com/rhj${path}`)).body;
  }

  /** Official Stock Token list (GET /rhj/assets): symbol, name, contract on the chain, multiplier, status. */
  async stockTokens(chain: ChainInfo) {
    const body = await this.get<unknown>("/assets");
    const list = (Array.isArray(body) ? body : (Object.values((body ?? {}) as Record<string, unknown>).find(Array.isArray) ?? [])) as Array<Record<string, any>>;
    const tokens = list
      .map((a) => {
        const deployment = (Array.isArray(a.deployments) ? a.deployments : []).find((d: Record<string, unknown>) => Number(d.chainId) === chain.chainId);
        if (!deployment?.contractAddress) return undefined;
        const out: Record<string, unknown> = { symbol: String(a.tokenSymbol ?? "").toUpperCase(), name: a.tokenName, address: deployment.contractAddress };
        if (a.currentMultiplier) out.multiplier = String(a.currentMultiplier);
        if (a.status) out.status = String(a.status);
        return out;
      })
      .filter((t): t is Record<string, unknown> => t !== undefined)
      .sort((x, y) => String(x.symbol).localeCompare(String(y.symbol)));
    if (tokens.length === 0) throw new ProviderError(`Robinhood lists no stock tokens deployed on ${chain.key}`, "not_listed");
    return { data: { chain: chain.key, source: "robinhood /rhj/assets", count: tokens.length, tokens }, resource: "rhj/assets" };
  }

  async check(): Promise<{ detail: string }> {
    await this.get("/assets");
    return { detail: "/rhj/assets reachable" };
  }
}
