# Changelog

Notable changes to the `splice` CLI (`@spliceloom/cli`) and the public registry. Official skills
are versioned independently in the registry; their versions are listed per release.

## 0.2.0 — 2026-10-02

Live market data, research tools and an AI agent over them.

**Data**
- `splice tokens` — every Robinhood Chain token from Codex: trending, hot, new, gainers, losers,
  volume, holders, market cap, transactions, buyers; `search`, `info`, `trades`, `chart`, `whales`.
- `splice stock` — Robinhood Stock Tokens: list, quote from every source side by side (Robinhood,
  Chainlink, DEX, Codex, DefiLlama, Finnhub), movers; US company profile, news, earnings, market status.
- `splice oracle` — Chainlink prices and candles (Data Streams when subscribed, else Candlestick).
- `splice perps` — Lighter markets and funding on Robinhood Chain (and mainnet).
- `splice defi` — DefiLlama TVL, protocols, DEX volume, fees, yields, stablecoins, prices.
- `splice global`, `splice macro`, `splice news` — crypto market, Fear & Greed, US stocks, FRED
  series, Finnhub headlines.
- `splice market trending | new | top | gainers | losers | volume | volume-drop | volume-up` — pools
  with the ranking formula printed under each table.

**Research and monitoring**
- `splice dash`, `splice report`, `splice compare`, `splice radar`, `splice watch` (price and
  large-trade alerts), `splice watchlist`.

**AI**
- `splice ask` and `splice chat` — an agent that answers from the read-only data tools and prints
  every tool call, its source, the model and the cost.

**Platform**
- `splice setup --init` creates `~/.splice/.env`; keys there work from every directory.
- 16 new host capabilities for skills (`tokens.*`, `stock.*`, `perps.*`, `defi.*`, `global.overview`,
  `macro.overview`, `equity.*`); MCP `--data` now serves 70 tools; SDK namespaces `tokens`,
  `research`, `stocks`, `perps`, `defi`, `global`, `equities`, `news`, `macro`, `oracle`.
- Default registry: `https://registry.spliceloom.com`.

**Skills:** `@splice/robinhood` 0.1.0 (new).

## 0.1.0 — 2026-10-02

First public release of the `splice` CLI.

- Registry workflow: `init`, `search`, `info`, `add`, `install`, `outdated`, `update`, `verify`,
  `remove`, `list`, `run`, `publish`, `login`.
- Verification before install (SHA-256, size, archive safety, package validity, provenance);
  immutable versions; reproducible installs from `splice.lock`; offline installs from the verified
  cache.
- Sandboxed runtime: one Node.js process per tool call, limited to declared files, hosts,
  environment variables and host capabilities.
- MCP servers: `splice mcp` (stdio) and `splice mcp --http` (Streamable HTTP, bearer token); registry
  discovery over MCP.
- Live data for Robinhood Chain (4663): chain, blocks, transactions, wallets, contracts, logs,
  prices, security, DEX markets, AI, GitHub and web search, each with provenance.

**Skills:** `@splice/json` 0.1.1, `@splice/http` 0.1.0, `@splice/files` 0.1.1, `@splice/github`
0.1.0, `@splice/web` 0.1.0, `@splice/market` 0.1.0, `@splice/onchain` 0.1.0.
