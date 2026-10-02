/**
 * Finance providers outside crypto DEXes:
 * - Finnhub (FINNHUB_API_KEY): US stock quotes, company profile and metrics, analyst
 *   recommendations, company and market news, earnings calendar, market status.
 * - FRED, Federal Reserve Bank of St. Louis (FRED_API_KEY): macro series (rates, inflation, yields,
 *   unemployment, dollar index, VIX).
 * - Lighter (public market data, no key): perpetual and spot markets of the Robinhood Chain
 *   deployment (api.rh.lighter.xyz, default) and of Lighter mainnet; funding rates as Lighter
 *   reports them next to Binance, Bybit and Hyperliquid.
 * Values are the providers'; Splice selects fields and converts units only where stated.
 */
import type { HttpClient, RequestOptions } from "../http.js";
import type { ProviderCapability, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

type Raw = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);
const iso = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : undefined);
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

// ------------------------------------------------------------------------------------- Finnhub

const FINNHUB = "https://finnhub.io/api/v1";

export class FinnhubProvider {
  readonly name = "finnhub";
  readonly kind: ProviderKind = "stock";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["equity.quote", "equity.profile", "equity.news", "equity.earnings", "equity.market_status", "news.market"];
  readonly auth = "API key header X-Finnhub-Token (FINNHUB_API_KEY)";
  readonly envVars = ["FINNHUB_API_KEY"];
  readonly endpoint = FINNHUB;
  readonly rateLimit = "free plan: 60 calls/min (personal use)";
  readonly docs = "https://finnhub.io/docs/api";
  readonly verification = "verified live 2026-10-03: quote, stock/market-status, stock/profile2, stock/metric, stock/recommendation, company-news, news (general, crypto), calendar/earnings. price-target, economic calendar and stock candles answer 403 on the free plan.";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "FINNHUB_API_KEY is not set";
  }

  private mapError = (status: number, _h: Headers, detail: string): ProviderError | undefined => (status === 403 ? new ProviderError(`Finnhub: not in this plan (${detail})`, "unsupported", status) : undefined);

  private async get<T = Raw>(path: string): Promise<T> {
    const options: RequestOptions = { mapError: this.mapError };
    return (await this.http.json<T>(`${FINNHUB}${path}`, { headers: { "x-finnhub-token": this.apiKey ?? "" } }, options)).body;
  }

  async quote(symbol: string) {
    const q = await this.get(`/quote?symbol=${encodeURIComponent(symbol)}`);
    if (!num(q.c) || num(q.t) === 0) throw new ProviderError(`Finnhub has no quote for ${symbol}`, "not_listed");
    return { data: prune({ symbol, priceUsd: num(q.c), change: num(q.d), changePct: num(q.dp), open: num(q.o), high: num(q.h), low: num(q.l), previousClose: num(q.pc), time: iso(q.t) }), resource: "quote" };
  }

  async marketStatus() {
    const s = await this.get(`/stock/market-status?exchange=US`);
    return { data: prune({ exchange: str(s.exchange), isOpen: typeof s.isOpen === "boolean" ? s.isOpen : undefined, session: str(s.session) ?? (s.isOpen === false ? "closed" : undefined), holiday: str(s.holiday), timezone: str(s.timezone), time: iso(s.t) }), resource: "stock/market-status" };
  }

  /** Profile, key metrics and the latest analyst recommendation counts. */
  async profile(symbol: string) {
    const [p, m, rec] = await Promise.all([this.get(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`), this.get(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`), this.get<Raw[]>(`/stock/recommendation?symbol=${encodeURIComponent(symbol)}`)]);
    if (!p || !p.name) throw new ProviderError(`Finnhub has no profile for ${symbol}`, "not_listed");
    const metric = (m?.metric ?? {}) as Raw;
    const latest = Array.isArray(rec) ? rec[0] : undefined;
    return {
      data: prune({
        symbol,
        name: str(p.name),
        exchange: str(p.exchange),
        industry: str(p.finnhubIndustry),
        country: str(p.country),
        ipo: str(p.ipo),
        website: str(p.weburl),
        marketCapUsd: num(p.marketCapitalization) !== undefined ? Math.round(p.marketCapitalization * 1e6) : undefined,
        metrics: prune({ peTTM: num(metric.peTTM) ?? num(metric.peBasicExclExtraTTM), epsTTM: num(metric.epsTTM), dividendYieldPct: num(metric.dividendYieldIndicatedAnnual), beta: num(metric.beta), high52w: num(metric["52WeekHigh"]), low52w: num(metric["52WeekLow"]), return52wPct: num(metric["52WeekPriceReturnDaily"]), return13wPct: num(metric["13WeekPriceReturnDaily"]) }),
        analysts: latest ? prune({ period: str(latest.period), strongBuy: num(latest.strongBuy), buy: num(latest.buy), hold: num(latest.hold), sell: num(latest.sell), strongSell: num(latest.strongSell) }) : undefined,
      }),
      resource: "stock/profile2+metric+recommendation",
    };
  }

  async companyNews(symbol: string, days: number) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const list = await this.get<Raw[]>(`/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
    return { data: { symbol, news: (Array.isArray(list) ? list : []).slice(0, 30).map(newsItem) }, resource: "company-news" };
  }

  async marketNews(category: "general" | "crypto" | "forex" | "merger") {
    const list = await this.get<Raw[]>(`/news?category=${category}`);
    return { data: { category, news: (Array.isArray(list) ? list : []).slice(0, 30).map(newsItem) }, resource: `news?category=${category}` };
  }

  async earnings(days: number, symbol?: string) {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const body = await this.get<{ earningsCalendar?: Raw[] }>(`/calendar/earnings?from=${from}&to=${to}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ""}`);
    const items = (body.earningsCalendar ?? []).map((e) => prune({ symbol: String(e.symbol), date: str(e.date), hour: str(e.hour), quarter: num(e.quarter), year: num(e.year), epsEstimate: num(e.epsEstimate), epsActual: num(e.epsActual), revenueEstimate: num(e.revenueEstimate), revenueActual: num(e.revenueActual) }));
    return { data: { from, to, count: items.length, earnings: items }, resource: "calendar/earnings" };
  }

  async check(): Promise<{ detail: string }> {
    const s = await this.marketStatus();
    return { detail: `US market ${s.data.isOpen ? `open (${s.data.session})` : "closed"}` };
  }
}

function newsItem(n: Raw) {
  return prune({ time: iso(n.datetime), headline: str(n.headline), source: str(n.source), summary: str(n.summary)?.slice(0, 400), url: str(n.url), related: str(n.related) });
}

// ---------------------------------------------------------------------------------------- FRED

const FRED = "https://api.stlouisfed.org/fred";

/** Macro series shown by `splice macro` (ids are FRED's). */
export const MACRO_SERIES: Array<{ id: string; label: string; unit: string; yoy?: boolean }> = [
  { id: "DFF", label: "Fed funds rate (effective)", unit: "%" },
  { id: "CPIAUCSL", label: "CPI inflation (YoY)", unit: "%", yoy: true },
  { id: "UNRATE", label: "Unemployment rate", unit: "%" },
  { id: "DGS2", label: "US 2-year Treasury yield", unit: "%" },
  { id: "DGS10", label: "US 10-year Treasury yield", unit: "%" },
  { id: "T10Y2Y", label: "10y − 2y spread", unit: "pp" },
  { id: "DTWEXBGS", label: "US dollar index (broad)", unit: "index" },
  { id: "VIXCLS", label: "VIX volatility index", unit: "index" },
];

export class FredProvider {
  readonly name = "fred";
  readonly kind: ProviderKind = "macro";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["macro.series"];
  readonly auth = "API key query parameter (FRED_API_KEY)";
  readonly envVars = ["FRED_API_KEY"];
  readonly endpoint = FRED;
  readonly rateLimit = "120 requests/min (documented)";
  readonly docs = "https://fred.stlouisfed.org/docs/api/fred/";
  readonly verification = "verified live 2026-10-03: series/observations for DFF, FEDFUNDS, CPIAUCSL, UNRATE, DGS2, DGS10, T10Y2Y, DTWEXBGS, VIXCLS; series metadata";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "FRED_API_KEY is not set";
  }

  /** Latest observations of a series, newest last ("." values — no data — are skipped). */
  async series(id: string, limit: number) {
    const params = new URLSearchParams({ series_id: id, api_key: this.apiKey ?? "", file_type: "json", sort_order: "desc", limit: String(Math.min(limit + 10, 1000)) });
    const [obs, meta] = await Promise.all([
      this.http.json<{ observations?: Array<{ date: string; value: string }> }>(`${FRED}/series/observations?${params}`, {}, { mapError: (s, _h, d) => (s === 400 ? new ProviderError(`FRED: ${d}`, "not_listed", s) : undefined) }),
      this.http.json<{ seriess?: Raw[] }>(`${FRED}/series?${new URLSearchParams({ series_id: id, api_key: this.apiKey ?? "", file_type: "json" })}`).catch(() => ({ body: { seriess: [] } })),
    ]);
    const points = (obs.body.observations ?? [])
      .filter((o) => o.value !== "." && Number.isFinite(Number(o.value)))
      .slice(0, limit)
      .reverse()
      .map((o) => ({ date: o.date, value: Number(o.value) }));
    if (points.length === 0) throw new ProviderError(`FRED has no observations for ${id}`, "not_listed");
    const m = meta.body.seriess?.[0] ?? {};
    return { data: prune({ id, title: str(m.title), units: str(m.units_short) ?? str(m.units), frequency: str(m.frequency_short) ?? str(m.frequency), lastUpdated: str(m.last_updated), points }), resource: `series/observations?series_id=${id}` };
  }

  async check(): Promise<{ detail: string }> {
    const r = await this.series("DFF", 1);
    return { detail: `Fed funds ${r.data.points[0]!.value}%` };
  }
}

// ------------------------------------------------------------------------------------- Lighter

export const LIGHTER_VENUES: Record<string, { host: string; label: string }> = {
  robinhood: { host: "https://api.rh.lighter.xyz", label: "Lighter on Robinhood Chain" },
  mainnet: { host: "https://mainnet.zklighter.elliot.ai", label: "Lighter mainnet" },
};

export interface PerpMarket {
  symbol: string;
  type: "perp" | "spot";
  markPrice?: number;
  indexPrice?: number;
  lastPrice?: number;
  change24hPct?: number;
  volume24hUsd?: number;
  trades24h?: number;
  openInterest?: number;
  openInterestUsd?: number;
  low24h?: number;
  high24h?: number;
  initialMarginPct?: number;
  status?: string;
}

export class LighterProvider {
  readonly name = "lighter";
  readonly kind: ProviderKind = "market";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["perps.markets", "perps.funding", "perps.stats"];
  readonly auth = "none (public market data)";
  readonly envVars: string[] = [];
  readonly endpoint = "https://api.rh.lighter.xyz/api/v1";
  readonly rateLimit = "public API limits per IP (see apidocs.lighter.xyz/docs/rate-limits)";
  readonly docs = "https://apidocs.lighter.xyz";
  readonly verification = "verified live 2026-10-03: orderBookDetails (perp + spot), exchangeStats, funding-rates on api.rh.lighter.xyz (Robinhood Chain deployment, 85 markets) and mainnet.zklighter.elliot.ai";
  readonly unconfigured: string | null = null;

  constructor(private readonly http: HttpClient) {}

  private base(venue: string): string {
    const v = LIGHTER_VENUES[venue];
    if (!v) throw new ProviderError(`unknown Lighter venue "${venue}" (robinhood, mainnet)`, "rejected");
    return `${v.host}/api/v1`;
  }

  async markets(venue: string) {
    const body = await this.http.json<{ order_book_details?: Raw[]; spot_order_book_details?: Raw[] }>(`${this.base(venue)}/orderBookDetails`);
    const map = (d: Raw, type: "perp" | "spot"): PerpMarket => {
      const mark = num(d.mark_price) ?? num(d.last_trade_price);
      const oi = num(d.open_interest);
      return prune({
        symbol: String(d.symbol),
        type,
        markPrice: num(d.mark_price),
        indexPrice: num(d.index_price),
        lastPrice: num(d.last_trade_price),
        change24hPct: num(d.daily_price_change),
        volume24hUsd: num(d.daily_quote_token_volume),
        trades24h: num(d.daily_trades_count),
        openInterest: oi,
        openInterestUsd: oi !== undefined && mark !== undefined && type === "perp" ? Math.round(oi * mark) : undefined,
        low24h: num(d.daily_price_low),
        high24h: num(d.daily_price_high),
        initialMarginPct: num(d.default_initial_margin_fraction) !== undefined ? d.default_initial_margin_fraction / 100 : undefined,
        status: str(d.status),
      }) as PerpMarket;
    };
    const markets = [...(body.body.order_book_details ?? []).map((d) => map(d, "perp")), ...(body.body.spot_order_book_details ?? []).map((d) => map(d, "spot"))].filter((m) => m.status !== "inactive");
    return { data: { venue, label: LIGHTER_VENUES[venue]!.label, count: markets.length, markets }, resource: "orderBookDetails" };
  }

  async stats(venue: string) {
    const b = (await this.http.json<Raw>(`${this.base(venue)}/exchangeStats`)).body;
    return { data: prune({ venue, label: LIGHTER_VENUES[venue]!.label, markets: num(b.total), volume24hUsd: num(b.daily_usd_volume) !== undefined ? Math.round(b.daily_usd_volume) : undefined, trades24h: num(b.daily_trades_count) }), resource: "exchangeStats" };
  }

  /** Funding rates per symbol as Lighter publishes them, for each exchange it lists. */
  async funding(venue: string) {
    const b = (await this.http.json<{ funding_rates?: Raw[] }>(`${this.base(venue)}/funding-rates`)).body;
    const bySymbol = new Map<string, Record<string, number>>();
    for (const r of b.funding_rates ?? []) {
      const rate = num(r.rate);
      if (rate === undefined || !r.symbol || !r.exchange) continue;
      const row = bySymbol.get(r.symbol) ?? {};
      row[String(r.exchange)] = rate;
      bySymbol.set(r.symbol, row);
    }
    const rates = [...bySymbol.entries()].map(([symbol, exchanges]) => ({ symbol, percentPerInterval: Object.fromEntries(Object.entries(exchanges).map(([k, v]) => [k, Number((v * 100).toFixed(6))])) }));
    return { data: { venue, unit: "percent per funding interval (values are already percentages: 0.01 means 0.01%, not 1%)", count: rates.length, rates }, resource: "funding-rates", notes: ["rates in % per funding interval as published by Lighter for each exchange (intervals differ between exchanges)"] };
  }

  async check(): Promise<{ detail: string }> {
    const s = await this.stats("robinhood");
    return { detail: `${s.data.markets ?? "?"} markets on Robinhood Chain, $${Math.round((s.data.volume24hUsd ?? 0) / 1e6)}M 24h volume` };
  }
}
