/**
 * Live data tools for MCP (opt-in: `splice mcp --data`). Each tool calls the real provider layer
 * (@spliceloom/data) and returns its result unchanged: status (LIVE / CACHED / UNAVAILABLE /
 * ERROR), data and provenance (source, chain, chainId, fetchedAt, blockNumber, fresh).
 * Inputs are validated against the tool's schema before any provider is contacted. Provider keys
 * stay in the server process; results are redacted of them by the data layer.
 */
import type { SpliceData } from "@spliceloom/data";
import { redactSecrets, validateValue, type JsonSchema } from "@spliceloom/spec";
import { errorToolResult, jsonToolResult, type McpTool, type McpToolCallResult } from "./protocol.js";

const chain: JsonSchema = { type: "string", maxLength: 40, description: "Chain key or id: robinhood (4663, Robinhood Chain mainnet — the only supported chain)" };
const fresh: JsonSchema = { type: "boolean", description: "Bypass the cache and query a provider now" };
const address: JsonSchema = { type: "string", minLength: 42, maxLength: 42, description: "0x-prefixed 20-byte address" };
const hash: JsonSchema = { type: "string", minLength: 66, maxLength: 66, description: "0x-prefixed 32-byte transaction hash" };

export interface DataTool {
  name: string;
  title: string;
  description: string;
  input: JsonSchema;
  run(data: SpliceData, args: Record<string, unknown>): Promise<unknown>;
}

const repo: JsonSchema = { type: "string", minLength: 3, maxLength: 140, description: "owner/name" };
const ref: JsonSchema = { type: "string", maxLength: 255, description: "Branch, tag or commit sha" };
const page: JsonSchema = { type: "integer", minimum: 1, maximum: 1000 };
const perPage: JsonSchema = { type: "integer", minimum: 1, maximum: 100 };
const network: JsonSchema = { type: "string", minLength: 1, maxLength: 40, description: "Splice chain (robinhood, 4663) or provider network id (solana, base, eth…)" };
const marketAddress: JsonSchema = { type: "string", minLength: 20, maxLength: 100, description: "Token/pool address on that network" };
const webChars: JsonSchema = { type: "integer", minimum: 100, maximum: 50_000, description: "Max characters of page text per result (default 5000)" };
const domains: JsonSchema = { type: "array", maxItems: 20, items: { type: "string", maxLength: 253 } };
const webProvider: JsonSchema = { type: "string", enum: ["tavily", "exa", "firecrawl"], description: "Use only this provider" };
const fr = (a: Record<string, unknown>) => (a.fresh === true ? { fresh: true } : {});
const pick = (a: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
/** Input object for scope-less tools (no chain): only `fresh` is added. */
const scopeless = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties: { ...properties, fresh }, required, additionalProperties: false });
const opts = (a: Record<string, unknown>) => ({ ...(typeof a.chain === "string" ? { chain: a.chain } : {}), ...(a.fresh === true ? { fresh: true } : {}) });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties: { ...properties, chain, fresh }, required, additionalProperties: false });

const optNetwork: JsonSchema = { ...network, description: "Network (default robinhood = Robinhood Chain 4663), or a provider network id (solana, base, eth…)" };
const netOf = (a: Record<string, unknown>) => (typeof a.network === "string" && a.network ? a.network : "robinhood");
const moverKind: JsonSchema = { type: "string", enum: ["gainers", "losers", "volume", "volume-drop", "volume-up", "liquidity", "txns"] };
const moverWindow: JsonSchema = { type: "string", enum: ["h1", "h6", "h24"], description: "Time window (default h24)" };
const oracleSession: JsonSchema = { type: "string", enum: ["regular", "extended", "overnight"], description: "US equity session (default regular)" };
const moverOpts = (a: Record<string, unknown>) => ({
  ...fr(a),
  ...(typeof a.kind === "string" ? { kind: a.kind as "gainers" } : {}),
  ...(typeof a.window === "string" ? { window: a.window as "h24" } : {}),
  ...(typeof a.minLiquidity === "number" ? { minLiquidity: a.minLiquidity } : {}),
  ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
});

export const DATA_TOOLS: DataTool[] = [
  { name: "onchain_get_balance", title: "onchain.get_balance", description: "Native (ETH) balance of an address, pinned to the block it was read at.", input: obj({ address }, ["address"]), run: (d, a) => d.onchain.balance(a.address as string, opts(a)) },
  { name: "onchain_get_transaction", title: "onchain.get_transaction", description: "Transaction and receipt (status success/reverted/pending) by hash.", input: obj({ hash }, ["hash"]), run: (d, a) => d.onchain.transaction(a.hash as string, opts(a)) },
  {
    name: "onchain_get_block",
    title: "onchain.get_block",
    description: "Block by number or hash, or the latest block.",
    input: obj({ block: { type: "string", maxLength: 66, description: '"latest" (default), a block number, or a block hash' } }),
    run: (d, a) => (a.block === undefined || a.block === "latest" ? d.onchain.latestBlock(opts(a)) : d.onchain.block(String(a.block), opts(a))),
  },
  { name: "onchain_get_token", title: "onchain.get_token", description: "Token metadata, total supply, holders, market price, DEX pools and security report — each with its own status.", input: obj({ address }, ["address"]), run: (d, a) => d.onchain.token(a.address as string, opts(a)) },
  { name: "onchain_get_contract", title: "onchain.get_contract", description: "Contract bytecode, verified source metadata/ABI, EIP-1967 proxy slots and activity counters.", input: obj({ address }, ["address"]), run: (d, a) => d.onchain.contract(a.address as string, opts(a)) },
  {
    name: "onchain_get_transfers",
    title: "onchain.get_transfers",
    description: "Recent token (and native) transfers of an address.",
    input: obj({ address, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["address"]),
    run: (d, a) => d.onchain.transfers(a.address as string, { ...opts(a), ...(typeof a.limit === "number" ? { limit: a.limit } : {}) }),
  },
  {
    name: "onchain_get_logs",
    title: "onchain.get_logs",
    description: "Event logs for a block range (max 2000 blocks), optionally filtered by address and topics.",
    input: obj({
      address: { ...address, description: "Contract address filter" },
      fromBlock: { type: "string", maxLength: 20 },
      toBlock: { type: "string", maxLength: 20 },
      topics: { type: "array", maxItems: 4, items: { type: "string", maxLength: 66 } },
    }),
    run: (d, a) => {
      const filter: { address?: string; fromBlock?: string; toBlock?: string; topics?: Array<string | null> } = {};
      if (typeof a.address === "string") filter.address = a.address;
      if (typeof a.fromBlock === "string") filter.fromBlock = a.fromBlock;
      if (typeof a.toBlock === "string") filter.toBlock = a.toBlock;
      if (Array.isArray(a.topics)) filter.topics = (a.topics as string[]).map((t) => (t === "" || t === "null" ? null : t));
      return d.onchain.logs(filter, opts(a));
    },
  },
  {
    name: "market_get_price",
    title: "market.get_price",
    description: "Market price from CoinGecko: ETH or a token address. Unlisted tokens are UNAVAILABLE (never estimated).",
    input: obj({ token: { type: "string", minLength: 2, maxLength: 42, description: "ETH or a token contract address" }, vs: { type: "string", maxLength: 5, description: "Quote currency, default usd" } }, ["token"]),
    run: (d, a) => d.market.price(a.token as string, { ...opts(a), ...(typeof a.vs === "string" ? { vs: a.vs } : {}) }),
  },
  { name: "security_get_token", title: "security.get_token", description: "GoPlus token security report (honeypot, taxes, ownership flags, holders…).", input: obj({ address }, ["address"]), run: (d, a) => d.security.token(a.address as string, opts(a)) },
  { name: "security_get_address", title: "security.get_address", description: "GoPlus address risk flags.", input: obj({ address }, ["address"]), run: (d, a) => d.security.address(a.address as string, opts(a)) },
  { name: "wallet_get_portfolio", title: "wallet.get_portfolio", description: "Zerion portfolio value and positions for a wallet (positions filtered to the chain).", input: obj({ address }, ["address"]), run: (d, a) => d.wallet.portfolio(a.address as string, opts(a)) },
  { name: "wallet_inspect", title: "wallet.inspect", description: "Everything derivable about a wallet from live providers: balances, tokens, transfers, transactions, counters, portfolio, security.", input: obj({ address }, ["address"]), run: (d, a) => d.wallet.inspect(a.address as string, opts(a)) },
  // ----- AI (billed by the provider per call)
  {
    name: "ai_generate",
    title: "ai.generate",
    description: "Real model completion (OpenRouter by default; Gemini when configured). Supports a system prompt, model choice, tool definitions and structured output (responseSchema). The result states requested vs. actual provider/model and usage.",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 100_000 },
        system: { type: "string", maxLength: 20_000 },
        model: { type: "string", maxLength: 200, description: "Provider model id, e.g. openai/gpt-4o-mini (default: AI_DEFAULT_MODEL)" },
        provider: { type: "string", maxLength: 40, description: "openrouter (default) or gemini" },
        maxTokens: { type: "integer", minimum: 1, maximum: 16384 },
        temperature: { type: "number", minimum: 0, maximum: 2 },
        fallback: { type: "boolean", description: "false: never use the configured fallback provider" },
        responseSchema: { type: "object", description: "JSON schema the answer must match (structured output)" },
        tools: {
          type: "array",
          maxItems: 32,
          items: { type: "object", properties: { name: { type: "string", maxLength: 64 }, description: { type: "string", maxLength: 2000 }, parameters: { type: "object" } }, required: ["name", "parameters"], additionalProperties: false },
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    run: (d, a) => {
      const input: Record<string, unknown> = { prompt: a.prompt };
      for (const k of ["system", "model", "provider", "maxTokens", "temperature", "fallback", "tools"]) if (a[k] !== undefined) input[k] = a[k];
      if (a.responseSchema) input.responseSchema = { name: "response", schema: a.responseSchema };
      return d.ai.generate(input as Parameters<SpliceData["ai"]["generate"]>[0]);
    },
  },
  {
    name: "ai_models",
    title: "ai.models",
    description: "Models offered by an AI provider (real list with context length, pricing, tool/structured-output support).",
    input: { type: "object", properties: { provider: { type: "string", maxLength: 40 }, search: { type: "string", maxLength: 100 } }, additionalProperties: false },
    run: (d, a) => d.ai.models({ ...(typeof a.provider === "string" ? { provider: a.provider } : {}), ...(typeof a.search === "string" ? { search: a.search } : {}) }),
  },
  // ----- GitHub (read-only)
  { name: "github_repository", title: "github.repository", description: "GitHub repository metadata (stars, forks, default branch, license, topics…).", input: scopeless({ repo }, ["repo"]), run: (d, a) => d.github.repository(a.repo as string, fr(a)) },
  {
    name: "github_search_repositories",
    title: "github.search_repositories",
    description: "Search GitHub repositories (GitHub search syntax).",
    input: scopeless({ query: { type: "string", minLength: 1, maxLength: 256 }, page, perPage, sort: { type: "string", enum: ["stars", "forks", "updated", "help-wanted-issues"] }, order: { type: "string", enum: ["asc", "desc"] } }, ["query"]),
    run: (d, a) => d.github.searchRepositories(a.query as string, pick(a, ["page", "perPage", "sort", "order", "fresh"])),
  },
  {
    name: "github_contents",
    title: "github.contents",
    description: "A file (decoded text) or directory listing from a repository via the GitHub contents API, with sha, size and ref.",
    input: scopeless({ repo, path: { type: "string", maxLength: 1000 }, ref }, ["repo"]),
    run: (d, a) => d.github.contents(a.repo as string, typeof a.path === "string" ? a.path : "", pick(a, ["ref", "fresh"])),
  },
  {
    name: "github_commits",
    title: "github.commits",
    description: "Commits of a repository (optionally for a ref and/or path).",
    input: scopeless({ repo, ref, path: { type: "string", maxLength: 1000 }, page, perPage }, ["repo"]),
    run: (d, a) => d.github.commits(a.repo as string, pick(a, ["ref", "path", "page", "perPage", "fresh"])),
  },
  {
    name: "github_releases",
    title: "github.releases",
    description: "Releases of a repository, or one release (release: latest | tag | id).",
    input: scopeless({ repo, release: { type: "string", maxLength: 200 }, page, perPage }, ["repo"]),
    run: (d, a) => (typeof a.release === "string" ? d.github.release(a.repo as string, a.release, fr(a)) : d.github.releases(a.repo as string, pick(a, ["page", "perPage", "fresh"]))),
  },
  {
    name: "github_raw",
    title: "github.raw_content",
    description: "A public file from raw.githubusercontent.com (only that host; https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}).",
    input: scopeless({ url: { type: "string", minLength: 30, maxLength: 2048 }, maxBytes: { type: "integer", minimum: 1, maximum: 5_242_880 } }, ["url"]),
    run: (d, a) => d.github.raw(a.url as string, pick(a, ["maxBytes", "fresh"])),
  },
  // ----- DEX market data (any network the provider supports)
  { name: "market_token", title: "market.token", description: "Token market data per provider (GeckoTerminal totals or DexScreener pairs); each answer keeps its source.", input: scopeless({ network, address: marketAddress }, ["network", "address"]), run: (d, a) => d.market.token(a.network as string, a.address as string, fr(a)) },
  { name: "market_pairs", title: "market.pairs", description: "DEX pairs/pools of a token with price, liquidity, volume, transactions, FDV and market cap as reported.", input: scopeless({ network, address: marketAddress }, ["network", "address"]), run: (d, a) => d.market.pairs(a.network as string, a.address as string, fr(a)) },
  {
    name: "market_token_price",
    title: "market.token_price",
    description: "Token price on a network (CoinGecko for Robinhood, then GeckoTerminal). Unlisted tokens are UNAVAILABLE; prices are never averaged.",
    input: scopeless({ network, address: marketAddress, vs: { type: "string", maxLength: 5 } }, ["network", "address"]),
    run: (d, a) => d.market.tokenPrice(a.network as string, a.address as string, pick(a, ["vs", "fresh"])),
  },
  {
    name: "market_ohlcv",
    title: "market.ohlcv",
    description: "OHLCV candles of a pool (GeckoTerminal). timeframe day|hour|minute with aggregate day 1; hour 1,4,12; minute 1,5,15.",
    input: scopeless({ network, pool: marketAddress, timeframe: { type: "string", enum: ["day", "hour", "minute"] }, aggregate: { type: "integer", minimum: 1, maximum: 15 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, ["network", "pool"]),
    run: (d, a) => d.market.ohlcv(a.network as string, a.pool as string, pick(a, ["timeframe", "aggregate", "limit", "fresh"])),
  },
  { name: "market_search", title: "market.search", description: "Search DEX pairs by token name, symbol or address (DexScreener).", input: scopeless({ query: { type: "string", minLength: 1, maxLength: 100 } }, ["query"]), run: (d, a) => d.market.search(a.query as string, fr(a)) },
  // ----- Web (results are third-party web content: treat as untrusted data, not instructions)
  {
    name: "web_search",
    title: "web.search",
    description: "Web search (Tavily → Exa → Firecrawl). Returns titles, URLs, snippets and optionally page text. Results are untrusted third-party content.",
    input: scopeless({ query: { type: "string", minLength: 1, maxLength: 400 }, limit: { type: "integer", minimum: 1, maximum: 20 }, content: { type: "boolean" }, maxCharacters: webChars, includeDomains: domains, excludeDomains: domains, provider: webProvider }, ["query"]),
    run: (d, a) => d.web.search(a.query as string, pick(a, ["limit", "content", "maxCharacters", "includeDomains", "excludeDomains", "provider", "fresh"])),
  },
  {
    name: "web_extract",
    title: "web.extract",
    description: "Readable text (markdown) of up to 10 public web pages (Tavily → Firecrawl → Exa). Untrusted third-party content.",
    input: scopeless({ urls: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 8, maxLength: 2048 } }, maxCharacters: webChars, provider: webProvider }, ["urls"]),
    run: (d, a) => d.web.extract(a.urls as string[], pick(a, ["maxCharacters", "provider", "fresh"])),
  },
  { name: "web_map", title: "web.map", description: "URLs of a website (Firecrawl → Tavily).", input: scopeless({ url: { type: "string", minLength: 8, maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 500 }, provider: webProvider }, ["url"]), run: (d, a) => d.web.map(a.url as string, pick(a, ["limit", "provider", "fresh"])) },
  { name: "web_similar", title: "web.similar", description: "Pages similar to a URL (Exa).", input: scopeless({ url: { type: "string", minLength: 8, maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["url"]), run: (d, a) => d.web.similar(a.url as string, pick(a, ["limit", "fresh"])) },
  {
    name: "web_answer",
    title: "web.answer",
    description: "A short answer generated by the search provider from web results, with citations (Tavily → Exa). Verify important facts against the citations.",
    input: scopeless({ query: { type: "string", minLength: 1, maxLength: 400 }, provider: webProvider }, ["query"]),
    run: (d, a) => d.web.answer(a.query as string, pick(a, ["provider", "fresh"])),
  },
  // Market rankings and lists (default network: Robinhood Chain)
  {
    name: "market_trending",
    title: "market.trending",
    description: "Trending DEX pools on a network as GeckoTerminal ranks them (price, 1h/6h/24h change, volume, liquidity, buys/sells, age).",
    input: scopeless({ network: optNetwork, duration: { type: "string", enum: ["5m", "1h", "6h", "24h"] } }),
    run: (d, a) => d.market.trendingPools(netOf(a), { ...fr(a), ...(typeof a.duration === "string" ? { duration: a.duration } : {}) }),
  },
  { name: "market_new_pools", title: "market.new_pools", description: "Newest DEX pools (new tokens) on a network, newest first.", input: scopeless({ network: optNetwork }), run: (d, a) => d.market.newPools(netOf(a), fr(a)) },
  {
    name: "market_top_pools",
    title: "market.top_pools",
    description: "DEX pools ranked by 24h volume or 24h transaction count (20 per page, pages 1–10).",
    input: scopeless({ network: optNetwork, sort: { type: "string", enum: ["volume", "txns"] }, page: { type: "integer", minimum: 1, maximum: 10 } }),
    run: (d, a) => d.market.topPools(netOf(a), { ...fr(a), ...(a.sort === "txns" ? { sort: "txns" as const } : {}), ...(typeof a.page === "number" ? { page: a.page } : {}) }),
  },
  {
    name: "market_movers",
    title: "market.movers",
    description:
      "Token rankings computed from real pool data: gainers, losers (price change), volume (highest), volume-drop (volume slowing: 6h pace vs 24h), volume-up (1h pace vs 24h), liquidity, txns. Thin pools (< minLiquidity, default $10k) and stablecoin/ETH bases are dropped; the formula is in the result.",
    input: scopeless({ network: optNetwork, kind: moverKind, window: moverWindow, minLiquidity: { type: "number", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
    run: (d, a) => d.market.movers(netOf(a), moverOpts(a)),
  },
  // Robinhood Stock Tokens and oracle prices
  {
    name: "stock_list",
    title: "stock.list",
    description: "Robinhood Stock Tokens on Robinhood Chain (tokenized US stocks/ETFs): symbol, name, contract address. Optional search by symbol or name.",
    input: scopeless({ search: { type: "string", maxLength: 60 } }),
    run: (d, a) => d.stocks.tokens({ ...fr(a), ...(typeof a.search === "string" ? { search: a.search } : {}) }),
  },
  {
    name: "stock_quote",
    title: "stock.quote",
    description: "A stock token (e.g. TSLA, NVDA, AAPL, SPY) from every source separately: Robinhood official bid/ask, Chainlink oracle price, and its DEX market on Robinhood Chain (price, volume, liquidity, FDV). Some sources may be UNAVAILABLE.",
    input: scopeless({ symbol: { type: "string", minLength: 1, maxLength: 42 }, session: oracleSession }, ["symbol"]),
    run: (d, a) => d.stocks.quote(a.symbol as string, { ...fr(a), ...(typeof a.session === "string" ? { session: a.session as "regular" } : {}) }),
  },
  {
    name: "stock_movers",
    title: "stock.movers",
    description: "Robinhood stock tokens ranked by their DEX markets: gainers, losers, volume, volume-drop, volume-up, liquidity, txns.",
    input: scopeless({ kind: moverKind, window: moverWindow, limit: { type: "integer", minimum: 1, maximum: 50 } }),
    run: (d, a) => d.stocks.movers(moverOpts(a)),
  },
  {
    name: "oracle_price",
    title: "oracle.price",
    description: "Latest Chainlink Data Streams price for a symbol (ETH, BTC, TSLA, NVDA, SPY…) or feed id; equities by session (regular, extended, overnight). Needs a subscribed Chainlink key.",
    input: scopeless({ symbol: { type: "string", minLength: 1, maxLength: 80 }, session: oracleSession }, ["symbol"]),
    run: (d, a) => d.oracle.price(a.symbol as string, { ...fr(a), ...(typeof a.session === "string" ? { session: a.session as "regular" } : {}) }),
  },
  {
    name: "oracle_candles",
    title: "oracle.candles",
    description: "OHLC candles from the Chainlink Candlestick API for crypto (ETH, BTC, SOL…), US equities (TSLA, NVDA, SPY…) and forex; timeframe 1m–24h.",
    input: scopeless({ symbol: { type: "string", minLength: 1, maxLength: 24 }, timeframe: { type: "string", enum: ["1m", "5m", "15m", "30m", "1h", "4h", "24h"] }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["symbol"]),
    run: (d, a) => d.oracle.candles(a.symbol as string, { ...fr(a), ...(typeof a.timeframe === "string" ? { timeframe: a.timeframe } : {}), ...(typeof a.limit === "number" ? { limit: a.limit } : {}) }),
  },
  {
    name: "oracle_feeds",
    title: "oracle.feeds",
    description: "Chainlink Data Streams feed catalog (mainnet): crypto and US equity feeds, schema, market hours, subscription state.",
    input: scopeless({ search: { type: "string", maxLength: 60 } }),
    run: (d, a) => d.oracle.feeds({ ...fr(a), ...(typeof a.search === "string" ? { search: a.search } : {}) }),
  },
  // Every token on Robinhood Chain (Codex)
  {
    name: "tokens_rank",
    title: "tokens.rank",
    description:
      "Rank ALL tokens on Robinhood Chain (Codex): trending, hot (trending over 1h), new, gainers, losers, volume, holders, mcap, txns, buyers; window h1/h4/h12/h24. Returns price, % change 1h/4h/12h/24h, volume, liquidity, market cap, holders, buys/sells, age. Thin and potential-scam tokens are filtered out.",
    input: scopeless({ kind: { type: "string", enum: ["trending", "hot", "new", "gainers", "losers", "volume", "holders", "mcap", "txns", "buyers"] }, window: { type: "string", enum: ["h1", "h4", "h12", "h24"] }, minLiquidity: { type: "number", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["kind"]),
    run: (d, a) => d.tokens.rank(a.kind as "trending", { ...fr(a), ...pick(a, ["window", "minLiquidity", "limit"]) }),
  },
  { name: "tokens_search", title: "tokens.search", description: "Find Robinhood Chain tokens by name, symbol or address (Codex), deepest liquidity first, with live stats.", input: scopeless({ query: { type: "string", minLength: 1, maxLength: 80 }, limit: { type: "integer", minimum: 1, maximum: 25 } }, ["query"]), run: (d, a) => d.tokens.search(a.query as string, { ...fr(a), ...pick(a, ["limit"]) }) },
  { name: "token_details", title: "token.details", description: "Everything about one Robinhood Chain token by symbol or address (Codex): live stats, metadata and links, pairs, recent trades, 24h hourly chart.", input: scopeless({ token: { type: "string", minLength: 1, maxLength: 80 } }, ["token"]), run: (d, a) => d.tokens.details(a.token as string, fr(a)) },
  {
    name: "token_trades",
    title: "token.trades",
    description: "Recent buys/sells of a Robinhood Chain token (Codex): time, type, USD value, price, wallet.",
    input: scopeless({ address, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["address"]),
    run: (d, a) => d.tokens.trades(a.address as string, { ...fr(a), ...pick(a, ["limit"]) }),
  },
  {
    name: "token_chart",
    title: "token.chart",
    description: "OHLCV candles of a Robinhood Chain token (Codex) with USD volume; timeframe 1m–1d.",
    input: scopeless({ address, timeframe: { type: "string", enum: ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"] }, limit: { type: "integer", minimum: 2, maximum: 500 } }, ["address"]),
    run: (d, a) => d.tokens.chart(a.address as string, { ...fr(a), ...pick(a, ["timeframe", "limit"]) }),
  },
  // Perpetuals (Lighter: Robinhood Chain deployment by default)
  {
    name: "perps_markets",
    title: "perps.markets",
    description: "Perpetual (and spot) markets on Lighter — venue 'robinhood' (the perps inside Robinhood Wallet, on Robinhood Chain) or 'mainnet': mark/index price, 24h change, volume, open interest (USD), trades. Sort by volume, oi, change (gainers) or losers; search by symbol (BTC, ETH, SPY, NVDA, XAU…).",
    input: scopeless({ venue: { type: "string", enum: ["robinhood", "mainnet"] }, type: { type: "string", enum: ["perp", "spot", "all"] }, sort: { type: "string", enum: ["volume", "oi", "change", "losers"] }, search: { type: "string", maxLength: 20 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
    run: (d, a) => d.perps.markets({ ...fr(a), ...pick(a, ["venue", "type", "sort", "search", "limit"]) }),
  },
  {
    name: "perps_funding",
    title: "perps.funding",
    description: "Funding rates (% per funding interval) on Lighter next to Binance, Bybit and Hyperliquid as Lighter publishes them; largest absolute Lighter rates first.",
    input: scopeless({ venue: { type: "string", enum: ["robinhood", "mainnet"] }, search: { type: "string", maxLength: 20 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
    run: (d, a) => d.perps.funding({ ...fr(a), ...pick(a, ["venue", "search", "limit"]) }),
  },
  // US equities, news, macro (Finnhub, FRED)
  { name: "stock_profile", title: "stock.profile", description: "US-listed company (e.g. NVDA, TSLA, AAPL) from Finnhub: real-time quote, profile, market cap, P/E, EPS, beta, 52-week range and analyst recommendation counts.", input: scopeless({ symbol: { type: "string", minLength: 1, maxLength: 10 } }, ["symbol"]), run: async (d, a) => ({ kind: "composite", sections: { quote: await d.equities.quote(a.symbol as string, fr(a)), profile: await d.equities.profile(a.symbol as string, fr(a)) } }) },
  { name: "stock_news", title: "stock.news", description: "Recent company news for a US ticker (Finnhub), newest first.", input: scopeless({ symbol: { type: "string", minLength: 1, maxLength: 10 }, days: { type: "integer", minimum: 1, maximum: 30 } }, ["symbol"]), run: (d, a) => d.equities.news(a.symbol as string, { ...fr(a), ...pick(a, ["days"]) }) },
  { name: "market_news", title: "market.news", description: "Market news headlines (Finnhub): general, crypto, forex or merger.", input: scopeless({ category: { type: "string", enum: ["general", "crypto", "forex", "merger"] } }), run: (d, a) => d.news.market((a.category as "general") ?? "general", fr(a)) },
  { name: "earnings_calendar", title: "earnings.calendar", description: "Upcoming US earnings (Finnhub) for the next N days, optionally for one ticker: date, before open / after close, EPS and revenue estimates.", input: scopeless({ days: { type: "integer", minimum: 1, maximum: 30 }, symbol: { type: "string", maxLength: 10 } }), run: (d, a) => d.equities.earnings({ ...fr(a), ...pick(a, ["days", "symbol"]) }) },
  { name: "us_market_status", title: "us_market.status", description: "Whether the US stock market is open now (session: pre-market, regular, post-market) or closed, with holidays (Finnhub).", input: scopeless({}), run: (d, a) => d.equities.marketStatus(fr(a)) },
  { name: "macro_overview", title: "macro.overview", description: "US macro dashboard (FRED): Fed funds rate, CPI inflation y/y, unemployment, 2y and 10y Treasury yields, 10y−2y spread, dollar index, VIX — latest and previous values.", input: scopeless({}), run: (d, a) => d.macro.overview(fr(a)) },
  { name: "macro_series", title: "macro.series", description: "Any FRED series by id (e.g. DGS10, CPIAUCSL, UNRATE, M2SL, SP500) with its latest observations.", input: scopeless({ id: { type: "string", minLength: 1, maxLength: 30 }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["id"]), run: (d, a) => d.macro.series(a.id as string, { ...fr(a), ...pick(a, ["limit"]) }) },
  // Research
  {
    name: "token_report",
    title: "token.report",
    description: "Research/risk report for a Robinhood Chain token by symbol or address: market stats (Codex), security flags (GoPlus: honeypot, taxes, mint, owner powers, holder concentration, LP lock), verified source (Blockscout), pools. Each flag names its source field.",
    input: scopeless({ token: { type: "string", minLength: 1, maxLength: 80 } }, ["token"]),
    run: (d, a) => d.research.report(a.token as string, fr(a)),
  },
  {
    name: "token_whales",
    title: "token.whales",
    description: "Large trades (whales) of a Robinhood Chain token from its latest ~100 swaps (Codex): trades ≥ minUsd, buy/sell totals, net flow, biggest wallets.",
    input: scopeless({ token: { type: "string", minLength: 1, maxLength: 80 }, minUsd: { type: "number", minimum: 0 } }, ["token"]),
    run: (d, a) => d.tokens.whales(a.token as string, { ...fr(a), ...pick(a, ["minUsd"]) }),
  },
  // Global markets
  { name: "global_overview", title: "global.overview", description: "Global markets: crypto market cap/volume/dominance (CoinGecko), Fear & Greed index, top 10 coins, and US stocks/ETFs (SPY, QQQ, AAPL, NVDA…) with 24h change (Chainlink).", input: scopeless({}), run: (d, a) => d.global.overview(fr(a)) },
  { name: "global_coins", title: "global.coins", description: "Top cryptocurrencies by market cap (CoinGecko) with 1h/24h/7d change, market cap and volume.", input: scopeless({ limit: { type: "integer", minimum: 1, maximum: 100 } }), run: (d, a) => d.global.coins({ ...fr(a), ...pick(a, ["limit"]) }) },
  { name: "global_trending", title: "global.trending", description: "Coins trending in CoinGecko searches worldwide.", input: scopeless({}), run: (d, a) => d.global.trending(fr(a)) },
  {
    name: "global_stocks",
    title: "global.stocks",
    description: "Latest price and 24h change of US equities/ETFs from Chainlink Candlestick (e.g. SPY, QQQ, AAPL, MSFT, NVDA, TSLA, COIN, HOOD).",
    input: scopeless({ symbols: { type: "array", minItems: 1, maxItems: 30, items: { type: "string", maxLength: 12 } } }),
    run: (d, a) => d.global.equities(Array.isArray(a.symbols) ? (a.symbols as string[]) : undefined, fr(a)),
  },
  // DeFi on Robinhood Chain (DefiLlama)
  { name: "defi_overview", title: "defi.overview", description: "Robinhood Chain DeFi overview from DefiLlama: TVL (with 1d/7d/30d change), DEX volume, fees, stablecoin supply.", input: obj({}), run: (d, a) => d.defi.overview(opts(a)) },
  {
    name: "defi_protocols",
    title: "defi.protocols",
    description: "Protocols on Robinhood Chain ranked by their TVL on the chain (DefiLlama), with category and total TVL; optional search or category filter.",
    input: obj({ search: { type: "string", maxLength: 60 }, category: { type: "string", maxLength: 40 }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
    run: (d, a) => d.defi.protocols({ ...opts(a), ...pick(a, ["search", "category", "limit"]) }),
  },
  { name: "defi_dexes", title: "defi.dexes", description: "DEX volume on Robinhood Chain per DEX (24h, 7d, 1d change) from DefiLlama.", input: obj({}), run: (d, a) => d.defi.dexes(opts(a)) },
  { name: "defi_fees", title: "defi.fees", description: "Fees on Robinhood Chain per protocol (24h, 7d) from DefiLlama.", input: obj({}), run: (d, a) => d.defi.fees(opts(a)) },
  {
    name: "defi_yields",
    title: "defi.yields",
    description: "Yield pools on Robinhood Chain (DefiLlama): project, pool, TVL, APY (base/reward), sorted by TVL or APY.",
    input: obj({ sort: { type: "string", enum: ["tvl", "apy"] }, minTvl: { type: "number", minimum: 0, description: "Minimum pool TVL in USD (default 10000); raise it to skip tiny pools with extreme APYs" }, stablecoin: { type: "boolean", description: "true = stablecoin pools only (as flagged by DefiLlama)" }, search: { type: "string", maxLength: 60 }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
    run: (d, a) => d.defi.yields({ ...opts(a), ...pick(a, ["sort", "minTvl", "stablecoin", "search", "limit"]) }),
  },
  { name: "defi_stablecoins", title: "defi.stablecoins", description: "Stablecoin supply on Robinhood Chain (circulating, minted, bridged, 7d change) from DefiLlama.", input: obj({}), run: (d, a) => d.defi.stablecoins(opts(a)) },
  {
    name: "defi_token_price",
    title: "defi.token_price",
    description: "Current token prices on Robinhood Chain from DefiLlama's coins API (with confidence).",
    input: obj({ addresses: { type: "array", minItems: 1, maxItems: 50, items: address } }, ["addresses"]),
    run: (d, a) => d.defi.tokenPrice(a.addresses as string[], opts(a)),
  },
  {
    name: "defi_price_chart",
    title: "defi.price_chart",
    description: "Price history of a Robinhood Chain token from DefiLlama (points × period: 1h, 4h, 1d).",
    input: obj({ address, points: { type: "integer", minimum: 2, maximum: 500 }, period: { type: "string", maxLength: 4 } }, ["address"]),
    run: (d, a) => d.defi.priceChart(a.address as string, { ...opts(a), ...pick(a, ["points", "period"]) }),
  },
  { name: "chain_info", title: "chain.info", description: "Robinhood Chain metadata with a live chain-id check and the head block.", input: obj({}), run: (d, a) => d.chains.info(opts(a)) },
  { name: "providers_status", title: "providers.status", description: "Live health check of every data provider (status, latency, chains, capabilities, last error).", input: { type: "object", properties: { chain }, additionalProperties: false }, run: (d, a) => d.providers.check(typeof a.chain === "string" ? { chain: a.chain } : {}) },
];

export function dataToolDefinitions(): McpTool[] {
  return DATA_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: `${t.description}\n\n(Splice live data: real providers only; result.status is LIVE, CACHED, UNAVAILABLE or ERROR, with provenance.)`,
    inputSchema: JSON.parse(JSON.stringify(t.input)) as Record<string, unknown>,
    annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { "io.spliceloom/kind": "data", "io.spliceloom/network": "provider APIs via the Splice network guard" },
  }));
}

/** Runs a data tool; undefined when `name` is not a data tool. */
export async function callDataTool(data: SpliceData, name: string, args: Record<string, unknown>): Promise<McpToolCallResult | undefined> {
  const tool = DATA_TOOLS.find((t) => t.name === name);
  if (!tool) return undefined;
  const errors = validateValue(tool.input, args, "input");
  if (errors.length > 0) return errorToolResult(`INVALID_INPUT: Invalid input for ${tool.title}\n${errors.map((e) => `- ${e}`).join("\n")}`);
  try {
    const result = await tool.run(data, args);
    const status = (result as { status?: string } | null)?.status;
    const payload = Array.isArray(result) ? { providers: result } : (result as Record<string, unknown>);
    const out = jsonToolResult(payload);
    if (status === "ERROR") out.isError = true;
    return out;
  } catch (error) {
    return errorToolResult(redactSecrets(`ERROR: ${(error as Error)?.message ?? String(error)}`, data.env.secrets));
  }
}
