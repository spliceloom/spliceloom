/**
 * DefiLlama (public APIs, no key): chain TVL and its history, protocols with their TVL on the
 * chain, DEX volume and fees per protocol, stablecoin supply, yield pools, and token prices/charts
 * from the coins API. Values are DefiLlama's; Splice only selects fields and sorts.
 */
import type { ChainInfo } from "../chains.js";
import type { HttpClient } from "../http.js";
import type { ProviderCapability, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

type Raw = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export class DefiLlamaProvider {
  readonly name = "defillama";
  readonly kind: ProviderKind = "defi";
  readonly chains = ["robinhood"];
  readonly capabilities: ProviderCapability[] = ["defi.chain_tvl", "defi.protocols", "defi.dex_volume", "defi.fees", "defi.stablecoins", "defi.yields", "defi.token_price", "defi.price_chart"];
  readonly auth = "none (public APIs)";
  readonly envVars: string[] = [];
  readonly endpoint = "https://api.llama.fi";
  readonly rateLimit = "public API: fair use (DefiLlama asks for reasonable request rates)";
  readonly docs = "https://api-docs.defillama.com";
  readonly verification =
    'verified live 2026-10-03 for "Robinhood Chain" (chainId 4663): /v2/chains, /v2/historicalChainTvl, /protocols (chainTvls), /overview/dexs and /overview/fees, stablecoins.llama.fi/stablecoincharts, yields.llama.fi/pools, coins.llama.fi prices and charts (prefix "robinhood:")';
  readonly unconfigured: string | null = null;

  constructor(private readonly http: HttpClient) {}

  private chainName(chain: ChainInfo): string {
    const name = chain.ids.defillamaChain;
    if (!name) throw new ProviderError(`DefiLlama has no chain name for ${chain.key}`, "unsupported");
    return name;
  }

  private coinKey(chain: ChainInfo, address: string): string {
    const prefix = chain.ids.defillamaCoinsChain;
    if (!prefix) throw new ProviderError(`DefiLlama coins has no chain prefix for ${chain.key}`, "unsupported");
    return `${prefix}:${address}`;
  }

  private async get<T = Raw>(url: string, maxBytes?: number): Promise<T> {
    return (await this.http.json<T>(url, {}, maxBytes ? { maxBytes, timeoutMs: 45_000 } : {})).body;
  }

  /** Current chain TVL with 1-day and 7-day change from DefiLlama's daily history. */
  async chainTvl(chain: ChainInfo) {
    const name = this.chainName(chain);
    const history = await this.get<Array<{ date: number; tvl: number }>>(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(name)}`);
    if (!Array.isArray(history) || history.length === 0) throw new ProviderError(`DefiLlama has no TVL history for ${name}`, "not_listed");
    const last = history[history.length - 1]!;
    const back = (days: number) => history[history.length - 1 - days]?.tvl;
    const change = (days: number) => {
      const b = back(days);
      return b ? Number((((last.tvl - b) / b) * 100).toFixed(2)) : undefined;
    };
    return {
      data: prune({ chain: name, tvlUsd: Math.round(last.tvl), date: new Date(last.date * 1000).toISOString().slice(0, 10), change1dPct: change(1), change7dPct: change(7), change30dPct: change(30), history: history.slice(-30).map((h) => ({ date: new Date(h.date * 1000).toISOString().slice(0, 10), tvlUsd: Math.round(h.tvl) })) }),
      resource: `v2/historicalChainTvl/${name}`,
    };
  }

  /** Protocols with TVL on the chain, largest first. */
  async protocols(chain: ChainInfo) {
    const name = this.chainName(chain);
    const list = await this.get<Raw[]>("https://api.llama.fi/protocols", 64 * 1024 * 1024);
    const protocols = list
      .map((p) => ({ p, tvl: num(p.chainTvls?.[name]) }))
      .filter((x): x is { p: Raw; tvl: number } => x.tvl !== undefined && x.tvl > 0)
      .sort((a, b) => b.tvl - a.tvl)
      .map(({ p, tvl }) => prune({ name: String(p.name), slug: str(p.slug), category: str(p.category), tvlOnChainUsd: Math.round(tvl), totalTvlUsd: num(p.tvl) !== undefined ? Math.round(p.tvl) : undefined, change1dPct: num(p.change_1d), change7dPct: num(p.change_7d), chains: Array.isArray(p.chains) ? (p.chains as string[]).length : undefined, url: str(p.url) }));
    return { data: { chain: name, count: protocols.length, protocols }, resource: "protocols", notes: ["change1dPct / change7dPct are DefiLlama's changes of the protocol's total TVL (all chains)"] };
  }

  private async overview(chain: ChainInfo, kind: "dexs" | "fees") {
    const name = this.chainName(chain);
    const body = await this.get<Raw>(`https://api.llama.fi/overview/${kind}/${encodeURIComponent(name)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`, 32 * 1024 * 1024);
    const protocols = ((body.protocols ?? []) as Raw[])
      .filter((p) => num(p.total24h) !== undefined)
      .sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))
      .map((p) => prune({ name: String(p.displayName ?? p.name), category: str(p.category), total24hUsd: Math.round(p.total24h), total7dUsd: num(p.total7d) !== undefined ? Math.round(p.total7d) : undefined, change1dPct: num(p.change_1d) }));
    return {
      data: prune({ chain: name, total24hUsd: num(body.total24h) !== undefined ? Math.round(body.total24h) : undefined, total7dUsd: num(body.total7d) !== undefined ? Math.round(body.total7d) : undefined, change1dPct: num(body.change_1d), count: protocols.length, protocols }),
      resource: `overview/${kind}/${name}`,
    };
  }

  dexVolume(chain: ChainInfo) {
    return this.overview(chain, "dexs");
  }

  fees(chain: ChainInfo) {
    return this.overview(chain, "fees");
  }

  /** Stablecoin supply on the chain (latest day, USD-pegged totals). */
  async stablecoins(chain: ChainInfo) {
    const name = this.chainName(chain);
    const rows = await this.get<Raw[]>(`https://stablecoins.llama.fi/stablecoincharts/${encodeURIComponent(name)}`);
    if (!Array.isArray(rows) || rows.length === 0) throw new ProviderError(`DefiLlama has no stablecoin data for ${name}`, "not_listed");
    const last = rows[rows.length - 1]!;
    const prev = rows[rows.length - 8];
    const total = num(last.totalCirculatingUSD?.peggedUSD);
    const before = num(prev?.totalCirculatingUSD?.peggedUSD);
    return {
      data: prune({ chain: name, date: new Date(Number(last.date) * 1000).toISOString().slice(0, 10), circulatingUsd: total !== undefined ? Math.round(total) : undefined, mintedUsd: num(last.totalMintedUSD?.peggedUSD) !== undefined ? Math.round(last.totalMintedUSD.peggedUSD) : undefined, bridgedUsd: num(last.totalBridgedToUSD?.peggedUSD) !== undefined ? Math.round(last.totalBridgedToUSD.peggedUSD) : undefined, change7dPct: total !== undefined && before ? Number((((total - before) / before) * 100).toFixed(2)) : undefined }),
      resource: `stablecoincharts/${name}`,
    };
  }

  /** Yield pools on the chain (DefiLlama yields). */
  async yields(chain: ChainInfo) {
    const name = this.chainName(chain);
    const body = await this.get<{ data?: Raw[] }>("https://yields.llama.fi/pools", 96 * 1024 * 1024);
    const pools = (body.data ?? [])
      .filter((p) => p.chain === name)
      .map((p) => prune({ project: String(p.project), symbol: String(p.symbol), tvlUsd: num(p.tvlUsd) !== undefined ? Math.round(p.tvlUsd) : undefined, apyPct: num(p.apy), apyBasePct: num(p.apyBase), apyRewardPct: num(p.apyReward), apy7dChangePct: num(p.apyPct7D), stablecoin: typeof p.stablecoin === "boolean" ? p.stablecoin : undefined, ilRisk: str(p.ilRisk), exposure: str(p.exposure), pool: str(p.pool) }));
    return { data: { chain: name, count: pools.length, pools }, resource: "yields/pools" };
  }

  /** Current prices for up to 50 token addresses (DefiLlama coins API). */
  async tokenPrices(chain: ChainInfo, addresses: string[]) {
    const keys = addresses.map((a) => this.coinKey(chain, a));
    const body = await this.get<{ coins?: Record<string, Raw> }>(`https://coins.llama.fi/prices/current/${keys.join(",")}`);
    const prices = keys
      .map((k, i) => ({ k, a: addresses[i]!, c: body.coins?.[k] ?? body.coins?.[k.toLowerCase()] }))
      .filter((x) => x.c && num(x.c.price) !== undefined)
      .map(({ a, c }) => prune({ address: a, symbol: str(c!.symbol), priceUsd: String(c!.price), confidence: num(c!.confidence), time: num(c!.timestamp) !== undefined ? new Date(c!.timestamp * 1000).toISOString() : undefined }));
    if (prices.length === 0) throw new ProviderError(`DefiLlama has no price for ${addresses.join(", ")}`, "not_listed");
    return { data: { chain: chain.key, prices }, resource: "coins/prices/current" };
  }

  /** Price history of one token (span points, period e.g. 1h / 4h / 1d). */
  async priceChart(chain: ChainInfo, address: string, span: number, period: string) {
    const key = this.coinKey(chain, address);
    const body = await this.get<{ coins?: Record<string, Raw> }>(`https://coins.llama.fi/chart/${key}?span=${span}&period=${period}`);
    const coin = body.coins?.[key] ?? Object.values(body.coins ?? {})[0];
    const points = ((coin?.prices ?? []) as Raw[]).filter((p) => num(p.price) !== undefined).map((p) => ({ time: new Date(p.timestamp * 1000).toISOString(), priceUsd: String(p.price) }));
    if (points.length === 0) throw new ProviderError(`DefiLlama has no price history for ${address}`, "not_listed");
    return { data: prune({ chain: chain.key, address, symbol: str(coin?.symbol), period, points }), resource: "coins/chart" };
  }

  async check(): Promise<{ detail: string }> {
    const chains = await this.get<Raw[]>("https://api.llama.fi/v2/chains");
    const rh = chains.find((c) => c.chainId === 4663);
    return { detail: rh ? `Robinhood Chain TVL $${Math.round(rh.tvl).toLocaleString("en-US")}` : `reachable (${chains.length} chains)` };
  }
}
