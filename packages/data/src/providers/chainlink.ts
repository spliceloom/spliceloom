/**
 * Chainlink Data Streams (oracle prices for crypto and US equities).
 *
 * - The feed catalog (GET /api/v1/discovery) is public.
 * - Reports need an API key and HMAC secret: every request is signed with
 *   HMAC-SHA256(secret, "METHOD path?query sha256(body) apiKey timestampMs").
 * - A report's `fullReport` is decoded here without dependencies: the ABI envelope
 *   (bytes32[3] context, bytes blob, …) and the schema-specific blob (v3 crypto, v8 RWA,
 *   v10 tokenized assets, v11 US equities). Prices are fixed-point with 18 decimals.
 * A key only reads the feeds it is subscribed to; others answer 401 "feeds not authorized",
 * reported as unavailable for this key — never substituted.
 */
import { createHash, createHmac } from "node:crypto";
import type { Scope } from "../chains.js";
import type { HttpClient, RequestOptions } from "../http.js";
import type { ProviderCapability, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

export const CHAINLINK_STREAMS = "https://api.dataengine.chain.link";

export interface OracleFeed {
  feedId: string;
  name?: string;
  assetName?: string;
  assetClass?: string;
  baseAsset?: string;
  quoteAsset?: string;
  marketHours?: string;
  feedType?: string;
  attributeType?: string;
  schemaVersion?: string;
  status?: string;
  networkType?: string;
  subscribed?: boolean;
}

/** Market status values of the RWA schemas (v8/v10/v11), as documented. */
const MARKET_STATUS_V8: Record<number, string> = { 0: "unknown", 1: "closed", 2: "open" };
const MARKET_STATUS_V11: Record<number, string> = { 0: "unknown", 1: "pre-market", 2: "regular", 3: "post-market", 4: "overnight", 5: "closed" };

function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new ProviderError("Chainlink report is not hex", "invalid_response");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function word(bytes: Uint8Array, index: number): bigint {
  const start = index * 32;
  if (start + 32 > bytes.length) throw new ProviderError("Chainlink report is shorter than its schema", "invalid_response");
  let v = 0n;
  for (let i = start; i < start + 32; i++) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

const signed = (v: bigint) => (v >= 1n << 255n ? v - (1n << 256n) : v);
const hex32 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

/** Fixed-point (18 decimals) integer → decimal string without float rounding. */
export function fixed18(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const time = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const timeNs = (ns: bigint) => (ns > 0n ? new Date(Number(ns / 1_000_000n)).toISOString() : undefined);

/** Schema version = first two bytes of the feed id (0x0003… → 3, 0x000b… → 11). */
export function schemaVersion(feedId: string): number {
  return parseInt(feedId.replace(/^0x/, "").slice(0, 4), 16);
}

/** Decodes a Data Streams `fullReport` (ABI-encoded envelope + schema blob). */
export function decodeReport(fullReport: string): Record<string, unknown> {
  const envelope = hexBytes(fullReport);
  const offset = Number(word(envelope, 3));
  if (offset % 32 !== 0 || offset + 32 > envelope.length) throw new ProviderError("Chainlink report has an invalid blob offset", "invalid_response");
  const length = Number(word(envelope, offset / 32));
  const blob = envelope.slice(offset + 32, offset + 32 + length);
  const feedId = hex32(word(blob, 0));
  const version = schemaVersion(feedId);
  const common = {
    feedId,
    schemaVersion: version,
    validFrom: time(word(blob, 1)),
    observedAt: time(word(blob, 2)),
    expiresAt: time(word(blob, 5)),
  };
  const w = (i: number) => word(blob, i);
  switch (version) {
    case 3:
      return { ...common, price: fixed18(signed(w(6))), bid: fixed18(signed(w(7))), ask: fixed18(signed(w(8))) };
    case 8:
      return { ...common, lastUpdate: timeNs(w(6)), price: fixed18(signed(w(7))), marketStatus: MARKET_STATUS_V8[Number(w(8))] ?? `code ${w(8)}` };
    case 10:
      return {
        ...common,
        lastUpdate: timeNs(w(6)),
        price: fixed18(signed(w(7))),
        marketStatus: MARKET_STATUS_V8[Number(w(8))] ?? `code ${w(8)}`,
        currentMultiplier: fixed18(signed(w(9))),
        newMultiplier: fixed18(signed(w(10))),
        multiplierActivation: Number(w(11)) > 0 ? time(w(11)) : undefined,
        tokenizedPrice: fixed18(signed(w(12))),
      };
    case 11:
      return {
        ...common,
        price: fixed18(signed(w(6))),
        lastSeen: timeNs(w(7)),
        bid: fixed18(signed(w(8))),
        bidVolume: fixed18(signed(w(9))),
        ask: fixed18(signed(w(10))),
        askVolume: fixed18(signed(w(11))),
        lastTradedPrice: fixed18(signed(w(12))),
        marketStatus: MARKET_STATUS_V11[Number(w(13))] ?? `code ${w(13)}`,
      };
    default:
      throw new ProviderError(`Chainlink report schema v${version} is not decoded by Splice (feed ${feedId})`, "unsupported");
  }
}

// ------------------------------------------------------------------------------ Candlestick API

export const CHAINLINK_CANDLESTICK = "https://priceapi.dataengine.chain.link";
/** Candle resolutions the API accepts for ranges up to 24h (seconds per candle). */
export const CANDLE_RESOLUTIONS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14_400, "24h": 86_400 };

export interface Candle {
  time: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

/** 1e18-scaled number (the API sends floats such as 2.679e+21) → decimal string. */
function unscale(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = v / 1e18;
  return n >= 1 ? String(Number(n.toFixed(6))) : String(Number(n.toPrecision(8)));
}

/** Chainlink Candlestick API: OHLC history for crypto, US equity and forex symbols (Bearer JWT from a login). */
export class ChainlinkCandlestickProvider {
  readonly name = "chainlink-candlestick";
  readonly kind: ProviderKind = "oracle";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["oracle.candles", "oracle.symbols"];
  readonly auth = "Login (POST /api/v1/authorize) with CHAINLINK_CANDLESTICK_USER (Data Streams username) and CHAINLINK_CANDLESTICK_API_KEY → Bearer JWT";
  readonly envVars = ["CHAINLINK_CANDLESTICK_USER", "CHAINLINK_CANDLESTICK_API_KEY"];
  readonly endpoint = CHAINLINK_CANDLESTICK;
  readonly rateLimit = "not documented";
  readonly docs = "https://docs.chain.link/data-streams/reference/candlestick-api";
  readonly verification =
    "verified live 2026-10-03: login (JWT), groups (equities, crypto, forex), symbol_info per group, history (t/o/h/l/c, 1e18-scaled) for ETHUSD and TSLAUSD; volume is not provided by the API.";
  readonly unconfigured: string | null;
  private token: { value: string; expires: number } | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly user: string | undefined,
    private readonly password: string | undefined,
  ) {
    this.unconfigured = user && password ? null : "CHAINLINK_CANDLESTICK_USER and CHAINLINK_CANDLESTICK_API_KEY are not set";
  }

  private async bearer(): Promise<Record<string, string>> {
    if (!this.token || this.token.expires < Date.now() + 60_000) {
      const r = await this.http.json<{ s?: string; d?: { access_token?: string; expiration?: number } }>(`${CHAINLINK_CANDLESTICK}/api/v1/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ login: this.user ?? "", password: this.password ?? "" }).toString(),
      });
      const value = r.body.d?.access_token;
      if (!value) throw new ProviderError("Chainlink Candlestick login returned no token", "auth");
      this.token = { value, expires: (r.body.d?.expiration ?? Math.floor(Date.now() / 1000) + 600) * 1000 };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  private mapError = (status: number, _headers: Headers, detail: string): ProviderError | undefined => {
    if (status === 404 && /feedID for symbol/i.test(detail)) return new ProviderError(`Chainlink Candlestick has no feed for this symbol (${detail}); see: splice oracle symbols`, "not_listed", status);
    return undefined;
  };

  async symbols(group?: string) {
    const groups = group ? [group] : ["crypto", "equities", "forex"];
    const out: Array<{ group: string; symbols: string[] }> = [];
    for (const g of groups) {
      const r = await this.http.json<{ symbol?: string[] }>(`${CHAINLINK_CANDLESTICK}/api/v1/symbol_info?group=${encodeURIComponent(g)}`, { headers: await this.bearer() }, { mapError: this.mapError });
      out.push({ group: g, symbols: [...(r.body.symbol ?? [])].sort() });
    }
    return { data: { groups: out }, resource: "api/v1/symbol_info" };
  }

  async history(symbol: string, resolution: string, from: number, to: number) {
    const path = `/api/v1/history?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}`;
    const r = await this.http.json<{ s?: string; errmsg?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[] }>(`${CHAINLINK_CANDLESTICK}${path}`, { headers: await this.bearer() }, { mapError: this.mapError });
    if (r.body.s !== "ok") throw new ProviderError(`Chainlink Candlestick: ${r.body.errmsg ?? "no data"}`, "not_listed");
    const t = r.body.t ?? [];
    const candles: Candle[] = t
      .map((ts, i) => {
        const c: Candle = { time: new Date(ts * 1000).toISOString() };
        const set = (k: "open" | "high" | "low" | "close", v: unknown) => {
          const x = unscale(v);
          if (x !== undefined) c[k] = x;
        };
        set("open", r.body.o?.[i]);
        set("high", r.body.h?.[i]);
        set("low", r.body.l?.[i]);
        set("close", r.body.c?.[i]);
        return c;
      })
      .sort((a, b) => a.time.localeCompare(b.time));
    if (candles.length === 0) throw new ProviderError(`Chainlink Candlestick returned no candles for ${symbol}`, "not_listed");
    return { data: { symbol, resolution, candles }, resource: "api/v1/history" };
  }

  async check(): Promise<{ detail: string }> {
    await this.bearer();
    return { detail: "login ok" };
  }
}

export class ChainlinkStreamsProvider {
  readonly name = "chainlink";
  readonly kind: ProviderKind = "oracle";
  readonly chains = ["global"];
  readonly capabilities: ProviderCapability[] = ["oracle.feeds", "oracle.report"];
  readonly auth = "Feed catalog: public. Reports: HMAC-SHA256 signed requests (CHAINLINK_DATA_STREAMS_API_KEY + CHAINLINK_DATA_STREAMS_HMAC_SECRET); only subscribed feeds are readable";
  readonly envVars = ["CHAINLINK_DATA_STREAMS_API_KEY", "CHAINLINK_DATA_STREAMS_HMAC_SECRET"];
  readonly endpoint = CHAINLINK_STREAMS;
  readonly rateLimit = "x-ratelimit-limit 200 (response headers); see Chainlink's fair use policy";
  readonly docs = "https://docs.chain.link/data-streams/reference/data-streams-api";
  readonly verification =
    "verified live 2026-10-02: public discovery catalog (crypto v3, US equities v11 with regular/extended/overnight sessions) and HMAC authentication (GET /api/v1/feeds → 200). Reports of feeds the key is not subscribed to answer 401 \"feeds not authorized\". Report decoding (v3/v8/v10/v11) follows the documented layouts and is unit-tested; not yet verified against a live report (no subscribed feed).";
  readonly unconfigured: string | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
    private readonly secret: string | undefined,
  ) {}

  private mapError = (status: number, _headers: Headers, detail: string): ProviderError | undefined => {
    if (status === 401 && /not authorized/i.test(detail)) return new ProviderError(`Chainlink: this API key is not subscribed to the feed (${detail}); subscribe to it in the Chainlink Data Streams portal`, "not_listed", status);
    if (status === 401) return new ProviderError(`Chainlink HTTP 401: ${detail}`, "auth", status);
    return undefined;
  };

  private signed(path: string): RequestInit {
    if (!this.apiKey || !this.secret) throw new ProviderError("Chainlink Data Streams reports need CHAINLINK_DATA_STREAMS_API_KEY and CHAINLINK_DATA_STREAMS_HMAC_SECRET", "not_listed");
    const ts = Date.now().toString();
    const bodyHash = createHash("sha256").update("").digest("hex");
    const signature = createHmac("sha256", this.secret).update(`GET ${path} ${bodyHash} ${this.apiKey} ${ts}`).digest("hex");
    return { headers: { authorization: this.apiKey, "x-authorization-timestamp": ts, "x-authorization-signature-sha256": signature } };
  }

  async feeds(_scope?: Scope) {
    const options: RequestOptions = { mapError: this.mapError };
    // Signed when keys are present (adds per-feed subscription flags); the catalog itself is public.
    const init = this.apiKey && this.secret ? this.signed("/api/v1/discovery") : {};
    const r = await this.http.json<{ feeds?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(`${CHAINLINK_STREAMS}/api/v1/discovery`, init, options);
    const list = Array.isArray(r.body) ? r.body : (r.body.feeds ?? []);
    const s = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);
    const feeds: OracleFeed[] = list
      .filter((f) => typeof f.feedId === "string")
      .map((f) => {
        const out: OracleFeed = { feedId: String(f.feedId) };
        const set = (k: keyof OracleFeed, v: unknown) => {
          const x = s(v);
          if (x !== undefined) (out as unknown as Record<string, unknown>)[k] = x;
        };
        set("name", f.name);
        set("assetName", f.assetName);
        set("networkType", f.networkType);
        set("assetClass", f.assetClass);
        set("baseAsset", f.baseAsset);
        set("quoteAsset", f.quoteAsset);
        set("marketHours", f.marketHours);
        set("feedType", f.feedType);
        set("attributeType", f.attributeType);
        set("schemaVersion", f.schemaVersion);
        set("status", f.status);
        if (typeof f.isSubscribed === "boolean") out.subscribed = f.isSubscribed;
        return out;
      });
    return { data: feeds, resource: "api/v1/discovery" };
  }

  async report(feedId: string) {
    const path = `/api/v1/reports/latest?feedID=${feedId}`;
    const r = await this.http.json<{ report?: { feedID?: string; fullReport?: string; validFromTimestamp?: number; observationsTimestamp?: number } }>(`${CHAINLINK_STREAMS}${path}`, this.signed(path), { mapError: this.mapError });
    const full = r.body.report?.fullReport;
    if (!full) throw new ProviderError("Chainlink returned no report", "invalid_response");
    return { data: decodeReport(full), resource: "api/v1/reports/latest" };
  }

  async check(): Promise<{ detail: string }> {
    const r = await this.feeds();
    return { detail: `catalog reachable (${r.data.length} feeds${this.apiKey ? `, ${r.data.filter((f) => f.subscribed).length} subscribed` : ""})` };
  }
}
