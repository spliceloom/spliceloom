/**
 * Capability broker: runs the host capabilities that sandboxed skills declare in
 * `permissions.capabilities` (see BROKER_CAPABILITIES in @spliceloom/spec) against the real data
 * layer. The runtime has already checked the declaration, the call budget and argument size; here
 * arguments are validated against strict schemas and mapped to one SpliceData call. Provider keys
 * stay in this process; the skill receives the data layer's result (LIVE / CACHED / UNAVAILABLE /
 * ERROR with provenance) and nothing else. Skills cannot bypass the cache (`fresh`) or choose AI
 * fallback behaviour: those stay host decisions.
 */
import type { CapabilityBroker, CapabilityRequest } from "@spliceloom/runtime";
import { BROKER_CAPABILITIES, validateValue, type JsonSchema } from "@spliceloom/spec";
import { failure } from "./result.js";
import type { SpliceData } from "./services.js";

type Args = Record<string, any>;
interface Entry {
  input: JsonSchema;
  run(data: SpliceData, a: Args): Promise<unknown>;
}

const str = (maxLength: number, minLength = 1): JsonSchema => ({ type: "string", minLength, maxLength });
const int = (minimum: number, maximum: number): JsonSchema => ({ type: "integer", minimum, maximum });
const address = str(42, 42);
const network = str(40);
const marketAddress = str(100, 20);
const repo = str(140, 3);
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const pick = (a: Args, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

export const BROKER: Record<(typeof BROKER_CAPABILITIES)[number], Entry> = {
  "onchain.balance": { input: obj({ address }, ["address"]), run: (d, a) => d.onchain.balance(a.address) },
  "onchain.transaction": { input: obj({ hash: str(66, 66) }, ["hash"]), run: (d, a) => d.onchain.transaction(a.hash) },
  "onchain.block": { input: obj({ block: str(66) }), run: (d, a) => (a.block === undefined || a.block === "latest" ? d.onchain.latestBlock() : d.onchain.block(a.block)) },
  "onchain.token": { input: obj({ address }, ["address"]), run: (d, a) => d.onchain.token(a.address) },
  "onchain.contract": { input: obj({ address }, ["address"]), run: (d, a) => d.onchain.contract(a.address) },
  "onchain.transfers": { input: obj({ address, limit: int(1, 100) }, ["address"]), run: (d, a) => d.onchain.transfers(a.address, pick(a, ["limit"])) },
  "onchain.logs": {
    input: obj({ address, fromBlock: str(20), toBlock: str(20), topics: { type: "array", maxItems: 4, items: { type: "string", maxLength: 66 } } }),
    run: (d, a) => d.onchain.logs({ ...pick(a, ["address", "fromBlock", "toBlock"]), ...(Array.isArray(a.topics) ? { topics: (a.topics as string[]).map((t) => (t === "" || t === "null" ? null : t)) } : {}) }),
  },
  "market.price": {
    input: obj({ token: str(100, 2), network, vs: str(5, 3) }, ["token"]),
    run: (d, a) => (a.network === undefined || a.network === "robinhood" || a.network === "4663" ? d.market.price(a.token, pick(a, ["vs"])) : d.market.tokenPrice(a.network, a.token, pick(a, ["vs"]))),
  },
  "market.token": { input: obj({ network, address: marketAddress }, ["network", "address"]), run: (d, a) => d.market.token(a.network, a.address) },
  "market.pairs": { input: obj({ network, address: marketAddress }, ["network", "address"]), run: (d, a) => d.market.pairs(a.network, a.address) },
  "market.pair": { input: obj({ network, address: marketAddress }, ["network", "address"]), run: (d, a) => d.market.pair(a.network, a.address) },
  "market.ohlcv": {
    input: obj({ network, pool: marketAddress, timeframe: { type: "string", enum: ["day", "hour", "minute"] }, aggregate: int(1, 15), limit: int(1, 1000) }, ["network", "pool"]),
    run: (d, a) => d.market.ohlcv(a.network, a.pool, pick(a, ["timeframe", "aggregate", "limit"])),
  },
  "market.trades": { input: obj({ network, pool: marketAddress }, ["network", "pool"]), run: (d, a) => d.market.trades(a.network, a.pool) },
  "market.search": { input: obj({ query: str(100) }, ["query"]), run: (d, a) => d.market.search(a.query) },
  "security.token": { input: obj({ address }, ["address"]), run: (d, a) => d.security.token(a.address) },
  "security.address": { input: obj({ address }, ["address"]), run: (d, a) => d.security.address(a.address) },
  "wallet.portfolio": { input: obj({ address }, ["address"]), run: (d, a) => d.wallet.portfolio(a.address) },
  "web.search": {
    input: obj({ query: str(400), limit: int(1, 20), content: { type: "boolean" }, maxCharacters: int(100, 50_000), includeDomains: { type: "array", maxItems: 20, items: str(253) }, excludeDomains: { type: "array", maxItems: 20, items: str(253) } }, ["query"]),
    run: (d, a) => d.web.search(a.query, pick(a, ["limit", "content", "maxCharacters", "includeDomains", "excludeDomains"])),
  },
  "web.extract": { input: obj({ urls: { type: "array", minItems: 1, maxItems: 10, items: str(2048, 8) }, maxCharacters: int(100, 50_000) }, ["urls"]), run: (d, a) => d.web.extract(a.urls, pick(a, ["maxCharacters"])) },
  "web.map": { input: obj({ url: str(2048, 8), limit: int(1, 500) }, ["url"]), run: (d, a) => d.web.map(a.url, pick(a, ["limit"])) },
  "web.similar": { input: obj({ url: str(2048, 8), limit: int(1, 20) }, ["url"]), run: (d, a) => d.web.similar(a.url, pick(a, ["limit"])) },
  "web.answer": { input: obj({ query: str(400) }, ["query"]), run: (d, a) => d.web.answer(a.query) },
  "github.repository": { input: obj({ repo }, ["repo"]), run: (d, a) => d.github.repository(a.repo) },
  "github.search": { input: obj({ query: str(256), page: int(1, 1000), perPage: int(1, 100) }, ["query"]), run: (d, a) => d.github.searchRepositories(a.query, pick(a, ["page", "perPage"])) },
  "github.contents": { input: obj({ repo, path: str(1000, 0), ref: str(255) }, ["repo"]), run: (d, a) => d.github.contents(a.repo, a.path ?? "", pick(a, ["ref"])) },
  "github.commits": { input: obj({ repo, ref: str(255), path: str(1000), page: int(1, 1000), perPage: int(1, 100) }, ["repo"]), run: (d, a) => d.github.commits(a.repo, pick(a, ["ref", "path", "page", "perPage"])) },
  "github.releases": { input: obj({ repo, release: str(200), page: int(1, 1000), perPage: int(1, 100) }, ["repo"]), run: (d, a) => (a.release ? d.github.release(a.repo, a.release) : d.github.releases(a.repo, pick(a, ["page", "perPage"]))) },
  "github.raw": { input: obj({ url: str(2048, 30), maxBytes: int(1, 5_242_880) }, ["url"]), run: (d, a) => d.github.raw(a.url, pick(a, ["maxBytes"])) },
  "ai.generate": {
    // Skills get the host's configured routing; output is capped to keep per-call cost bounded.
    input: obj({ prompt: str(100_000), system: str(20_000), model: str(200), provider: str(40), maxTokens: int(1, 2048), temperature: { type: "number", minimum: 0, maximum: 2 }, responseSchema: { type: "object" } }, ["prompt"]),
    run: (d, a) => d.ai.generate({ ...pick(a, ["prompt", "system", "model", "provider", "temperature"]), maxTokens: a.maxTokens ?? 512, ...(a.responseSchema ? { responseSchema: { name: "response", schema: a.responseSchema } } : {}) }),
  },
  "ai.models": { input: obj({ provider: str(40), search: str(100) }), run: (d, a) => d.ai.models(pick(a, ["provider", "search"])) },
  "tokens.rank": {
    input: obj({ kind: { type: "string", enum: ["trending", "hot", "new", "gainers", "losers", "volume", "holders", "mcap", "txns", "buyers"] }, window: { type: "string", enum: ["h1", "h4", "h12", "h24"] }, minLiquidity: { type: "number", minimum: 0 }, limit: int(1, 50) }, ["kind"]),
    run: (d, a) => d.tokens.rank(a.kind, pick(a, ["window", "minLiquidity", "limit"])),
  },
  "tokens.search": { input: obj({ query: str(80), limit: int(1, 25) }, ["query"]), run: (d, a) => d.tokens.search(a.query, pick(a, ["limit"])) },
  "tokens.details": { input: obj({ token: str(80) }, ["token"]), run: (d, a) => d.tokens.details(a.token) },
  "tokens.whales": { input: obj({ token: str(80), minUsd: { type: "number", minimum: 0 } }, ["token"]), run: (d, a) => d.tokens.whales(a.token, pick(a, ["minUsd"])) },
  "tokens.report": { input: obj({ token: str(80) }, ["token"]), run: (d, a) => d.research.report(a.token) },
  "stock.quote": { input: obj({ symbol: str(42), session: { type: "string", enum: ["regular", "extended", "overnight"] } }, ["symbol"]), run: (d, a) => d.stocks.quote(a.symbol, pick(a, ["session"])) },
  "stock.list": { input: obj({ search: str(60) }), run: (d, a) => d.stocks.tokens(pick(a, ["search"])) },
  "perps.markets": {
    input: obj({ venue: { type: "string", enum: ["robinhood", "mainnet"] }, type: { type: "string", enum: ["perp", "spot", "all"] }, sort: { type: "string", enum: ["volume", "oi", "change", "losers"] }, search: str(20), limit: int(1, 100) }),
    run: (d, a) => d.perps.markets(pick(a, ["venue", "type", "sort", "search", "limit"])),
  },
  "perps.funding": { input: obj({ venue: { type: "string", enum: ["robinhood", "mainnet"] }, search: str(20), limit: int(1, 100) }), run: (d, a) => d.perps.funding(pick(a, ["venue", "search", "limit"])) },
  "defi.overview": { input: obj({}), run: (d) => d.defi.overview() },
  "defi.protocols": { input: obj({ search: str(60), category: str(40), limit: int(1, 200) }), run: (d, a) => d.defi.protocols(pick(a, ["search", "category", "limit"])) },
  "defi.yields": { input: obj({ sort: { type: "string", enum: ["tvl", "apy"] }, minTvl: { type: "number", minimum: 0 }, stablecoin: { type: "boolean" }, search: str(60), limit: int(1, 100) }), run: (d, a) => d.defi.yields(pick(a, ["sort", "minTvl", "stablecoin", "search", "limit"])) },
  "global.overview": { input: obj({}), run: (d) => d.global.overview() },
  "macro.overview": { input: obj({}), run: (d) => d.macro.overview() },
  "equity.profile": { input: obj({ symbol: str(10) }, ["symbol"]), run: async (d, a) => ({ kind: "composite", subject: String(a.symbol).toUpperCase(), sections: { quote: await d.equities.quote(a.symbol), profile: await d.equities.profile(a.symbol) } }) },
  "equity.news": { input: obj({ symbol: str(10), days: int(1, 30) }, ["symbol"]), run: (d, a) => d.equities.news(a.symbol, pick(a, ["days"])) },
};

/** A CapabilityBroker over a SpliceData instance (created lazily by the caller). */
export function createCapabilityBroker(data: SpliceData | (() => SpliceData)): CapabilityBroker {
  const get = typeof data === "function" ? data : () => data;
  return {
    async call(request: CapabilityRequest): Promise<unknown> {
      const entry = (BROKER as Record<string, Entry | undefined>)[request.capability];
      if (!entry) return failure("INVALID_INPUT", request.capability, null, `unknown capability "${request.capability}"`);
      const args = request.args ?? {};
      const errors = validateValue(entry.input, args, "args");
      if (errors.length > 0) return failure("INVALID_INPUT", request.capability, null, `invalid arguments for ${request.capability}: ${errors.join("; ")}`);
      const result = await entry.run(get(), args as Args);
      // Composite results (one section per source) and reports get an overall status for skills:
      // LIVE when at least one section is LIVE/CACHED, otherwise UNAVAILABLE. Sections stay unchanged.
      if (result && typeof result === "object" && !("status" in result) && ("sections" in result)) {
        const sections = Object.values((result as { sections: Record<string, { status?: string }> }).sections ?? {});
        const live = sections.some((s) => s?.status === "LIVE" || s?.status === "CACHED");
        return { status: live ? "LIVE" : "UNAVAILABLE", ...(result as Record<string, unknown>) };
      }
      return result;
    },
  };
}
