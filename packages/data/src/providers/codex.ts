/**
 * Codex (codex.io, formerly Defined.fi) GraphQL API: every token on Robinhood Chain (network 4663)
 * with live stats — trending scores, price changes and volume over 1h/4h/12h/24h, liquidity, market
 * cap, holders, buys/sells, unique traders, creation time — plus prices, OHLCV bars, recent trades,
 * token metadata and pairs. Authorization: the API key itself (CODEX_API_KEY).
 *
 * Codex reports changes as fractions (0.12 = +12%); they are converted to percentages here.
 * Holders lists and top traders need a paid Codex plan and are not used.
 */
import type { ChainInfo } from "../chains.js";
import type { HttpClient, RequestOptions } from "../http.js";
import type { ProviderCapability, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

export const CODEX_GRAPHQL = "https://graph.codex.io/graphql";
export type CodexWindow = "1" | "4" | "12" | "24";

export interface CodexToken {
  address: string;
  symbol?: string;
  name?: string;
  priceUsd?: string;
  changePct: Record<string, number>;
  volumeUsd: Record<string, string>;
  liquidityUsd?: string;
  marketCapUsd?: string;
  holders?: number;
  txns24?: number;
  buys24?: number;
  sells24?: number;
  uniqueBuyers24?: number;
  uniqueSellers24?: number;
  createdAt?: string;
  imageUrl?: string;
  potentialScam?: boolean;
}

type Raw = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" && v.length && v !== "NaN" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const iso = (v: unknown) => (typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : undefined);
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

const TOKEN_FIELDS = `priceUSD change1 change4 change12 change24 volume1 volume4 volume12 volume24 liquidity marketCap holders txnCount24 buyCount24 sellCount24 uniqueBuys24 uniqueSells24 createdAt isScam token { address name symbol info { imageThumbUrl } }`;

function tokenRow(r: Raw): CodexToken {
  const changePct: Record<string, number> = {};
  const volumeUsd: Record<string, string> = {};
  for (const w of ["1", "4", "12", "24"]) {
    const c = Number(r[`change${w}`]);
    if (r[`change${w}`] !== null && r[`change${w}`] !== undefined && Number.isFinite(c)) changePct[`h${w}`] = Number((c * 100).toFixed(4));
    const v = str(r[`volume${w}`]);
    if (v !== undefined) volumeUsd[`h${w}`] = v;
  }
  return prune({
    address: String(r.token?.address ?? ""),
    symbol: str(r.token?.symbol),
    name: str(r.token?.name),
    priceUsd: str(r.priceUSD),
    changePct,
    volumeUsd,
    liquidityUsd: str(r.liquidity),
    marketCapUsd: str(r.marketCap),
    holders: int(r.holders),
    txns24: int(r.txnCount24),
    buys24: int(r.buyCount24),
    sells24: int(r.sellCount24),
    uniqueBuyers24: int(r.uniqueBuys24),
    uniqueSellers24: int(r.uniqueSells24),
    createdAt: iso(r.createdAt),
    imageUrl: str(r.token?.info?.imageThumbUrl),
    potentialScam: typeof r.isScam === "boolean" ? r.isScam : undefined,
  }) as CodexToken;
}

export interface CodexFilterInput {
  ranking: { attribute: string; direction: "ASC" | "DESC" };
  filters?: Record<string, unknown>;
  phrase?: string;
  limit: number;
}

export class CodexProvider {
  readonly name = "codex";
  readonly kind: ProviderKind = "market";
  readonly chains = ["robinhood"];
  readonly capabilities: ProviderCapability[] = ["tokens.filter", "tokens.price", "tokens.bars", "tokens.events", "tokens.info", "tokens.pairs"];
  readonly auth = "API key in the Authorization header (CODEX_API_KEY)";
  readonly envVars = ["CODEX_API_KEY"];
  readonly endpoint = CODEX_GRAPHQL;
  readonly rateLimit = "plan quota (free plan: 10,000 requests/month); results are cached";
  readonly docs = "https://docs.codex.io";
  readonly verification =
    "verified live 2026-10-03 on network 4663 (\"Robinhood\"): filterTokens (rankings trendingScore*, change*, volume*, holders, marketCap, txnCount24, uniqueBuys24, createdAt; filters network, liquidity, volume24, change24, potentialScam, trendingIgnored; phrase search), getTokenPrices, getBars (OHLCV), getTokenEvents, token, listPairsWithMetadataForToken. holders and tokenTopTraders need a paid plan.";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "CODEX_API_KEY is not set";
  }

  private network(chain: ChainInfo): number {
    const id = chain.ids.codexNetworkId;
    if (!id) throw new ProviderError(`Codex has no network id for ${chain.key}`, "unsupported");
    return id;
  }

  private mapError = (status: number, _headers: Headers, detail: string): ProviderError | undefined => {
    if (status === 401 || status === 403) return new ProviderError(`Codex HTTP ${status}: ${detail}`, "auth", status);
    if (status === 402) return new ProviderError(`Codex HTTP 402 (plan/quota): ${detail}`, "rate_limited", status);
    return undefined;
  };

  private async gql<T = Raw>(query: string, variables: Record<string, unknown>): Promise<T> {
    const options: RequestOptions = { mapError: this.mapError, timeoutMs: 20_000 };
    const r = await this.http.json<{ data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> }>(CODEX_GRAPHQL, { method: "POST", headers: { "content-type": "application/json", authorization: this.apiKey ?? "" }, body: JSON.stringify({ query, variables }) }, options);
    const error = r.body.errors?.[0];
    if (error) {
      const code = error.extensions?.code;
      if (code === "NOT_AUTHORIZED") throw new ProviderError(`Codex: ${error.message ?? "not authorized"} (not in this API plan)`, "unsupported");
      throw new ProviderError(`Codex: ${error.message ?? "GraphQL error"}`, code === "BAD_USER_INPUT" ? "rejected" : "invalid_response");
    }
    if (!r.body.data) throw new ProviderError("Codex returned no data", "invalid_response");
    return r.body.data;
  }

  /** Token rankings and searches over every token on the chain (one request). */
  async filterTokens(chain: ChainInfo, input: CodexFilterInput) {
    const network = this.network(chain);
    const data = await this.gql<{ filterTokens: { count?: number; results?: Raw[] } }>(
      `query($f: TokenFilters, $r: [TokenRanking], $p: String, $l: Int) { filterTokens(filters: $f, rankings: $r, phrase: $p, limit: $l) { count results { ${TOKEN_FIELDS} } } }`,
      prune({ f: { ...(input.filters ?? {}), network: [network] }, r: [input.ranking], p: input.phrase, l: input.limit }),
    );
    const tokens = (data.filterTokens.results ?? []).map(tokenRow).filter((t) => t.address);
    return { data: { network: chain.key, ranking: input.ranking, count: tokens.length, tokens }, resource: "filterTokens" };
  }

  async prices(chain: ChainInfo, addresses: string[]) {
    const network = this.network(chain);
    const data = await this.gql<{ getTokenPrices: Array<Raw | null> }>(`query($i: [GetPriceInput]) { getTokenPrices(inputs: $i) { address priceUsd timestamp } }`, { i: addresses.map((address) => ({ address, networkId: network })) });
    const prices = (data.getTokenPrices ?? []).filter((p): p is Raw => p !== null && str(p.priceUsd) !== undefined).map((p) => prune({ address: String(p.address), priceUsd: str(p.priceUsd)!, time: iso(p.timestamp) }));
    if (prices.length === 0) throw new ProviderError(`Codex has no price for ${addresses.join(", ")}`, "not_listed");
    return { data: { network: chain.key, prices }, resource: "getTokenPrices" };
  }

  /** OHLCV bars (resolution "1", "5", "15", "30", "60", "240", "720", "1D"). */
  async bars(chain: ChainInfo, address: string, resolution: string, from: number, to: number) {
    const network = this.network(chain);
    const data = await this.gql<{ getBars: Raw | null }>(`query($s: String!, $from: Int!, $to: Int!, $res: String!) { getBars(symbol: $s, from: $from, to: $to, resolution: $res) { t o h l c volume } }`, { s: `${address}:${network}`, from, to, res: resolution });
    const b = data.getBars;
    const t: number[] = b?.t ?? [];
    const candles = t
      .map((ts, i) => prune({ time: new Date(ts * 1000).toISOString(), open: str(b!.o?.[i]), high: str(b!.h?.[i]), low: str(b!.l?.[i]), close: str(b!.c?.[i]), volumeUsd: str(b!.volume?.[i]) }))
      .filter((c) => c.close !== undefined);
    if (candles.length === 0) throw new ProviderError(`Codex has no bars for ${address}`, "not_listed");
    return { data: { network: chain.key, address, resolution, candles }, resource: "getBars" };
  }

  /** Recent swaps and liquidity events of a token. */
  async events(chain: ChainInfo, address: string, limit: number) {
    const network = this.network(chain);
    const data = await this.gql<{ getTokenEvents: { items?: Raw[] } | null }>(
      `query($q: EventsQueryInput!, $l: Int) { getTokenEvents(query: $q, limit: $l) { items { eventDisplayType timestamp transactionHash maker data { ... on SwapEventData { priceUsd priceUsdTotal } } } } }`,
      { q: { address, networkId: network }, l: limit },
    );
    const trades = (data.getTokenEvents?.items ?? []).map((e) => prune({ type: str(e.eventDisplayType), time: iso(e.timestamp), txHash: str(e.transactionHash), maker: str(e.maker), priceUsd: str(e.data?.priceUsd), valueUsd: str(e.data?.priceUsdTotal) }));
    return { data: { network: chain.key, address, trades }, resource: "getTokenEvents" };
  }

  async token(chain: ChainInfo, address: string) {
    const network = this.network(chain);
    const data = await this.gql<{ token: Raw | null }>(`query($i: TokenInput!) { token(input: $i) { address name symbol decimals totalSupply circulatingSupply createdAt info { description imageThumbUrl } socialLinks { website twitter telegram discord } } }`, { i: { address, networkId: network } });
    const t = data.token;
    if (!t) throw new ProviderError(`Codex has no token ${address}`, "not_listed");
    const links = t.socialLinks ? prune({ website: str(t.socialLinks.website), twitter: str(t.socialLinks.twitter), telegram: str(t.socialLinks.telegram), discord: str(t.socialLinks.discord) }) : undefined;
    return {
      data: prune({ address: String(t.address), name: str(t.name), symbol: str(t.symbol), decimals: int(t.decimals), totalSupply: str(t.totalSupply), circulatingSupply: str(t.circulatingSupply), createdAt: iso(t.createdAt), description: str(t.info?.description), imageUrl: str(t.info?.imageThumbUrl), links: links && Object.keys(links).length ? links : undefined }),
      resource: "token",
    };
  }

  async pairs(chain: ChainInfo, address: string, limit: number) {
    const network = this.network(chain);
    const data = await this.gql<{ listPairsWithMetadataForToken: { results?: Raw[] } }>(`query($a: String!, $n: Int!, $l: Int) { listPairsWithMetadataForToken(tokenAddress: $a, networkId: $n, limit: $l) { results { volume liquidity pair { address } exchange { name } } } }`, { a: address, n: network, l: limit });
    const pairs = (data.listPairsWithMetadataForToken.results ?? []).map((p) => prune({ pairAddress: str(p.pair?.address), exchange: str(p.exchange?.name), volumeUsd24h: str(p.volume), liquidityUsd: str(p.liquidity) }));
    return { data: { network: chain.key, address, pairs }, resource: "listPairsWithMetadataForToken" };
  }

  async check(chain: ChainInfo): Promise<{ detail: string }> {
    const r = await this.prices(chain, ["0x0bd7d308f8e1639fab988df18a8011f41eacad73"]);
    return { detail: `WETH $${Number(r.data.prices[0]!.priceUsd).toFixed(2)}` };
  }
}
