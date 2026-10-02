/**
 * DEX market data: DexScreener and GeckoTerminal public APIs (no keys).
 *
 * Network handling: a Splice chain (Robinhood) is mapped to the provider's own id only where that
 * mapping was verified live (ChainInfo.ids); other networks are passed as provider-native ids and
 * the provider must know them — GeckoTerminal's network list is checked, DexScreener has no list
 * (it answers [] for unknown networks, reported as "no pairs", never as data). No request is ever
 * redirected to another chain. Values are the providers' own; nothing is averaged or computed.
 */
import type { Scope } from "../chains.js";
import type { HttpClient } from "../http.js";
import type { ProviderCapability, ProviderData, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

type Raw = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" && v.length ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)) delete o[k];
  }
  return o;
}
const windows = (o: Raw | undefined, keys = ["m5", "h1", "h6", "h24"]) => (o ? prune(Object.fromEntries(keys.map((k) => [k, str(o[k])]))) : undefined);

export interface MarketToken {
  address?: string;
  name?: string;
  symbol?: string;
}

/** A DEX pair/pool as the provider reports it. USD values are decimal strings from the provider. */
export interface MarketPair {
  network: string;
  pairAddress?: string;
  name?: string;
  dex?: string;
  labels?: string[];
  url?: string;
  baseToken?: MarketToken;
  quoteToken?: MarketToken;
  priceUsd?: string;
  priceNative?: string;
  liquidityUsd?: string;
  volumeUsd?: Record<string, string>;
  priceChangePct?: Record<string, string>;
  transactions?: Record<string, { buys?: number; sells?: number }>;
  fdvUsd?: string;
  marketCapUsd?: string;
  createdAt?: string;
}

/** Market operations a provider can implement; the router only calls declared capabilities. */
export interface MarketSource {
  search?(query: string): Promise<ProviderData<{ query: string; pairs: MarketPair[] }>>;
  token?(scope: Scope, address: string): Promise<ProviderData<Record<string, unknown>>>;
  tokenPairs?(scope: Scope, address: string): Promise<ProviderData<{ network: string; token: string; pairs: MarketPair[] }>>;
  pair?(scope: Scope, address: string): Promise<ProviderData<MarketPair>>;
  tokenPrice?(scope: Scope, addresses: string[], vs: string): Promise<ProviderData<Record<string, unknown>>>;
}

// ------------------------------------------------------------------------------------ DexScreener

const DEX = "https://api.dexscreener.com";

function dexPair(p: Raw): MarketPair {
  const tx = p.txns && typeof p.txns === "object" ? prune(Object.fromEntries(Object.entries(p.txns as Raw).map(([k, v]) => [k, prune({ buys: num((v as Raw)?.buys), sells: num((v as Raw)?.sells) })]))) : undefined;
  return prune({
    network: String(p.chainId),
    pairAddress: str(p.pairAddress),
    dex: str(p.dexId),
    labels: Array.isArray(p.labels) && p.labels.length ? (p.labels as string[]) : undefined,
    url: str(p.url),
    baseToken: p.baseToken ? prune({ address: str(p.baseToken.address), name: str(p.baseToken.name), symbol: str(p.baseToken.symbol) }) : undefined,
    quoteToken: p.quoteToken ? prune({ address: str(p.quoteToken.address), name: str(p.quoteToken.name), symbol: str(p.quoteToken.symbol) }) : undefined,
    priceUsd: str(p.priceUsd),
    priceNative: str(p.priceNative),
    liquidityUsd: str(p.liquidity?.usd),
    volumeUsd: windows(p.volume),
    priceChangePct: windows(p.priceChange),
    transactions: tx as MarketPair["transactions"],
    fdvUsd: str(p.fdv),
    marketCapUsd: str(p.marketCap),
    createdAt: typeof p.pairCreatedAt === "number" ? new Date(p.pairCreatedAt).toISOString() : undefined,
  }) as MarketPair;
}

export class DexScreenerProvider implements MarketSource {
  readonly name = "dexscreener";
  readonly kind: ProviderKind = "market";
  readonly chains = ["*"];
  readonly capabilities: ProviderCapability[] = ["market.search", "market.token", "market.token_pairs", "market.pair"];
  readonly auth = "none";
  readonly envVars: string[] = [];
  readonly endpoint = DEX;
  readonly rateLimit = "300 requests/min (pairs, search, token-pairs, tokens), enforced client-side";
  readonly docs = "https://docs.dexscreener.com/api/reference";
  readonly verification = "see docs/data-providers.md";
  readonly unconfigured: string | null = null;

  constructor(private readonly http: HttpClient) {}

  /** DexScreener chain id for a scope; Splice chains only where verified. */
  network(scope: Scope): string {
    if (scope.chain) {
      const id = scope.chain.ids.dexscreenerChainId;
      if (!id) throw new ProviderError(`DexScreener has no verified chain id for ${scope.name}`, "unsupported");
      return id;
    }
    return scope.key;
  }

  private async get<T>(path: string): Promise<{ body: T; resource: string }> {
    const res = await this.http.json<T>(`${DEX}${path}`);
    return { body: res.body, resource: path.slice(1) };
  }

  async search(query: string) {
    const r = await this.get<{ pairs?: Raw[] }>(`/latest/dex/search?q=${encodeURIComponent(query)}`);
    return { data: { query, pairs: (r.body.pairs ?? []).map(dexPair) }, resource: r.resource };
  }

  async tokenPairs(scope: Scope, address: string) {
    const network = this.network(scope);
    const r = await this.get<Raw[]>(`/token-pairs/v1/${encodeURIComponent(network)}/${address}`);
    if (!Array.isArray(r.body) || r.body.length === 0) throw this.noPairs(network, address);
    return { data: { network, token: address, pairs: r.body.map(dexPair) }, resource: r.resource, notes: ["prices are per pair as reported by DexScreener; no token-level price is computed"] };
  }

  async token(scope: Scope, address: string) {
    const network = this.network(scope);
    const r = await this.get<Raw[]>(`/tokens/v1/${encodeURIComponent(network)}/${address}`);
    if (!Array.isArray(r.body) || r.body.length === 0) throw this.noPairs(network, address);
    const pairs = r.body.map(dexPair);
    const lower = address.toLowerCase();
    const self = pairs.map((p) => (p.baseToken?.address?.toLowerCase() === lower ? p.baseToken : p.quoteToken?.address?.toLowerCase() === lower ? p.quoteToken : undefined)).find(Boolean);
    return {
      data: prune({ network, address, name: self?.name, symbol: self?.symbol, pairCount: pairs.length, pairs }),
      resource: r.resource,
      notes: ["DexScreener reports prices, liquidity, volume, FDV and market cap per pair; they are not averaged into one token value"],
    };
  }

  async pair(scope: Scope, address: string) {
    const network = this.network(scope);
    const r = await this.get<{ pairs?: Raw[] | null; pair?: Raw | null }>(`/latest/dex/pairs/${encodeURIComponent(network)}/${address}`);
    const raw = r.body.pairs?.[0] ?? r.body.pair ?? undefined;
    if (!raw) throw new ProviderError(`DexScreener has no pair ${address} on network "${network}"`, "not_listed");
    return { data: dexPair(raw), resource: r.resource };
  }

  private noPairs(network: string, address: string) {
    return new ProviderError(`DexScreener returned no pairs for ${address} on network "${network}" (DexScreener answers the same way for unlisted tokens and unknown networks)`, "not_listed");
  }

  async check(_scope: Scope): Promise<{ detail: string }> {
    const r = await this.get<{ pairs?: Raw[] }>("/latest/dex/search?q=WETH");
    return { detail: `reachable (${r.body.pairs?.length ?? 0} pairs for a search)` };
  }
}

// ---------------------------------------------------------------------------------- GeckoTerminal

const GT = "https://api.geckoterminal.com/api/v2";
const GT_HEADERS = { accept: "application/json;version=20230203" };

export const OHLCV_TIMEFRAMES: Record<string, number[]> = { day: [1], hour: [1, 4, 12], minute: [1, 5, 15] };

export class GeckoTerminalProvider implements MarketSource {
  readonly name = "geckoterminal";
  readonly kind: ProviderKind = "market";
  readonly chains = ["*", "global"];
  readonly capabilities: ProviderCapability[] = ["market.networks", "market.dexes", "market.token", "market.token_pairs", "market.pair", "market.tokenPrice", "market.ohlcv", "market.trades", "market.trending_pools", "market.new_pools", "market.top_pools"];
  readonly auth = "none";
  readonly envVars: string[] = [];
  readonly endpoint = GT;
  readonly rateLimit = "10 requests/min (free public API, per geckoterminal.com/dex-api), enforced client-side; HTTP 429 beyond it";
  readonly docs = "https://apiguide.geckoterminal.com/";
  readonly verification = "see docs/data-providers.md";
  readonly unconfigured: string | null = null;
  private networkList: { ids: Set<string>; fetchedAt: number } | null = null;

  constructor(private readonly http: HttpClient) {}

  private async get<T = Raw>(path: string): Promise<{ body: T; resource: string }> {
    const res = await this.http.json<T>(`${GT}${path}`, { headers: GT_HEADERS });
    return { body: res.body, resource: path.slice(1) };
  }

  /** All networks GeckoTerminal lists (real list, paginated; kept for an hour). */
  async listNetworks(): Promise<{ data: Array<{ id: string; name?: string; coingeckoAssetPlatformId?: string }>; resource: string }> {
    const all: Array<{ id: string; name?: string; coingeckoAssetPlatformId?: string }> = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.get<{ data?: Raw[]; links?: { next?: string | null } }>(`/networks?page=${page}`);
      for (const n of r.body.data ?? []) all.push(prune({ id: String(n.id), name: str(n.attributes?.name), coingeckoAssetPlatformId: str(n.attributes?.coingecko_asset_platform_id) }));
      if (!r.body.links?.next) break;
    }
    this.networkList = { ids: new Set(all.map((n) => n.id)), fetchedAt: Date.now() };
    return { data: all, resource: "networks" };
  }

  /** GeckoTerminal network id for a scope, verified against its network list. */
  async network(scope: Scope): Promise<string> {
    if (scope.chain) {
      const id = scope.chain.ids.geckoterminalNetwork;
      if (!id) throw new ProviderError(`GeckoTerminal has no verified network id for ${scope.name}`, "unsupported");
      return id;
    }
    if (!this.networkList || Date.now() - this.networkList.fetchedAt > 3_600_000) await this.listNetworks();
    if (!this.networkList!.ids.has(scope.key)) throw new ProviderError(`GeckoTerminal does not list a network "${scope.key}" (see market networks)`, "unsupported");
    return scope.key;
  }

  private pool(p: Raw, included: Raw[], network: string): MarketPair {
    return geckoPool(p, included, network);
  }

  /** Pools ranked by GeckoTerminal: sort = h24_volume_usd_desc | h24_tx_count_desc; page 1–10 (20 pools each). */
  async topPools(scope: Scope, sort: GeckoPoolSort, page: number) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw[]; included?: Raw[] }>(`/networks/${network}/pools?sort=${sort}&page=${page}&include=base_token,quote_token,dex`);
    return { data: { network, sort, page, pools: (r.body.data ?? []).map((p) => geckoPool(p, r.body.included ?? [], network)) }, resource: r.resource };
  }
  private notFound(what: string, network: string) {
    return (error: unknown) => {
      if (error instanceof ProviderError && error.kind === "not_found") throw new ProviderError(`GeckoTerminal has no ${what} on network "${network}"`, "not_listed", 404);
      throw error;
    };
  }

  async networks() {
    const r = await this.listNetworks();
    return { data: { count: r.data.length, networks: r.data }, resource: r.resource };
  }

  async dexes(scope: Scope) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw[] }>(`/networks/${network}/dexes`);
    return { data: { network, dexes: (r.body.data ?? []).map((d) => prune({ id: String(d.id), name: str(d.attributes?.name) })) }, resource: r.resource };
  }

  async token(scope: Scope, address: string) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw }>(`/networks/${network}/tokens/${address}`).catch(this.notFound(`token ${address}`, network));
    const a = r.body.data?.attributes ?? {};
    return {
      data: prune({
        network,
        address: str(a.address) ?? address,
        name: str(a.name),
        symbol: str(a.symbol),
        decimals: num(a.decimals),
        coingeckoCoinId: str(a.coingecko_coin_id),
        totalSupply: str(a.total_supply),
        priceUsd: str(a.price_usd),
        fdvUsd: str(a.fdv_usd),
        marketCapUsd: str(a.market_cap_usd),
        totalReserveUsd: str(a.total_reserve_in_usd),
        volumeUsd: windows(a.volume_usd),
      }),
      resource: r.resource,
    };
  }

  async tokenPairs(scope: Scope, address: string) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw[]; included?: Raw[] }>(`/networks/${network}/tokens/${address}/pools?include=base_token,quote_token,dex`).catch(this.notFound(`pools for token ${address}`, network));
    const pairs = (r.body.data ?? []).map((p) => this.pool(p, r.body.included ?? [], network));
    if (pairs.length === 0) throw new ProviderError(`GeckoTerminal lists no pools for ${address} on network "${network}"`, "not_listed");
    return { data: { network, token: address, pairs }, resource: r.resource };
  }

  async pair(scope: Scope, address: string) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw; included?: Raw[] }>(`/networks/${network}/pools/${address}?include=base_token,quote_token,dex`).catch(this.notFound(`pool ${address}`, network));
    if (!r.body.data) throw new ProviderError(`GeckoTerminal has no pool ${address} on network "${network}"`, "not_listed");
    return { data: this.pool(r.body.data, r.body.included ?? [], network), resource: r.resource };
  }

  async tokenPrice(scope: Scope, addresses: string[], vs: string) {
    if (vs !== "usd") throw new ProviderError(`GeckoTerminal token prices are in USD only (requested ${vs})`, "not_listed");
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw }>(`/simple/networks/${network}/token_price/${addresses.join(",")}`).catch(this.notFound("token price", network));
    const prices = (r.body.data?.attributes?.token_prices ?? {}) as Record<string, string | null>;
    const lower = Object.fromEntries(Object.entries(prices).map(([k, v]) => [k.toLowerCase(), v]));
    const found = addresses.map((a) => ({ address: a, priceUsd: str(lower[a.toLowerCase()]) })).filter((p) => p.priceUsd !== undefined);
    if (found.length === 0) throw new ProviderError(`GeckoTerminal has no price for ${addresses.join(", ")} on network "${network}"`, "not_listed");
    return { data: { network, vs, prices: found }, resource: r.resource };
  }

  async ohlcv(scope: Scope, pool: string, timeframe: string, aggregate: number, limit: number) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw; meta?: Raw }>(`/networks/${network}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`).catch(this.notFound(`pool ${pool}`, network));
    const list: unknown[][] = r.body.data?.attributes?.ohlcv_list ?? [];
    const candles = list.map((c) => ({ time: new Date(Number(c[0]) * 1000).toISOString(), open: str(c[1]), high: str(c[2]), low: str(c[3]), close: str(c[4]), volumeUsd: str(c[5]) }));
    const meta = r.body.meta ?? {};
    return {
      data: prune({ network, pool, timeframe, aggregate, currency: "usd", base: meta.base ? prune({ address: str(meta.base.address), symbol: str(meta.base.symbol) }) : undefined, quote: meta.quote ? prune({ address: str(meta.quote.address), symbol: str(meta.quote.symbol) }) : undefined, candles }),
      resource: r.resource,
    };
  }

  async trades(scope: Scope, pool: string) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw[] }>(`/networks/${network}/pools/${pool}/trades`).catch(this.notFound(`pool ${pool}`, network));
    const trades = (r.body.data ?? []).map((t) => {
      const a = t.attributes ?? {};
      return prune({ kind: str(a.kind), blockNumber: str(a.block_number), time: str(a.block_timestamp), txHash: str(a.tx_hash), from: str(a.tx_from_address), fromTokenAmount: str(a.from_token_amount), toTokenAmount: str(a.to_token_amount), priceFromUsd: str(a.price_from_in_usd), priceToUsd: str(a.price_to_in_usd), volumeUsd: str(a.volume_in_usd) });
    });
    return { data: { network, pool, trades }, resource: r.resource };
  }

  async pools(scope: Scope, kind: "trending_pools" | "new_pools", duration?: string) {
    const network = await this.network(scope);
    const r = await this.get<{ data?: Raw[]; included?: Raw[] }>(`/networks/${network}/${kind}?include=base_token,quote_token,dex${kind === "trending_pools" && duration ? `&duration=${duration}` : ""}`);
    return { data: { network, pools: (r.body.data ?? []).map((p) => this.pool(p, r.body.included ?? [], network)) }, resource: r.resource };
  }

  async check(_scope: Scope): Promise<{ detail: string }> {
    const r = await this.get<{ data?: Raw[] }>("/networks?page=1");
    return { detail: `reachable (${r.body.data?.length ?? 0} networks on the first page)` };
  }
}


export type GeckoPoolSort = "h24_volume_usd_desc" | "h24_tx_count_desc";
export const GECKO_POOL_SORTS: GeckoPoolSort[] = ["h24_volume_usd_desc", "h24_tx_count_desc"];
export const TRENDING_DURATIONS = ["5m", "1h", "6h", "24h"] as const;

/** A GeckoTerminal-format pool (GeckoTerminal API and CoinGecko onchain API share the format). */
export function geckoPool(p: Raw, included: Raw[], network: string): MarketPair {
    const a = p.attributes ?? {};
    const rel = p.relationships ?? {};
    const tokenOf = (id: string | undefined): MarketToken | undefined => {
      if (!id) return undefined;
      const inc = included.find((i) => i.id === id && i.type === "token");
      const address = id.startsWith(`${network}_`) ? id.slice(network.length + 1) : undefined;
      return prune({ address: str(inc?.attributes?.address) ?? address, name: str(inc?.attributes?.name), symbol: str(inc?.attributes?.symbol) });
    };
    const tx = a.transactions && typeof a.transactions === "object" ? prune(Object.fromEntries(Object.entries(a.transactions as Raw).map(([k, v]) => [k, prune({ buys: num((v as Raw)?.buys), sells: num((v as Raw)?.sells) })]))) : undefined;
    return prune({
      network,
      pairAddress: str(a.address),
      name: str(a.name),
      dex: str(rel.dex?.data?.id),
      url: a.address ? `https://www.geckoterminal.com/${network}/pools/${a.address}` : undefined,
      baseToken: tokenOf(rel.base_token?.data?.id),
      quoteToken: tokenOf(rel.quote_token?.data?.id),
      priceUsd: str(a.base_token_price_usd),
      priceNative: str(a.base_token_price_native_currency),
      liquidityUsd: str(a.reserve_in_usd),
      volumeUsd: windows(a.volume_usd),
      priceChangePct: windows(a.price_change_percentage),
      transactions: tx as MarketPair["transactions"],
      fdvUsd: str(a.fdv_usd),
      marketCapUsd: str(a.market_cap_usd),
      createdAt: str(a.pool_created_at),
    }) as MarketPair;
}
