# @splice/robinhood

Robinhood Chain toolkit for agents: every token, research, whales, stock tokens, perps, DeFi and global
markets. The package holds no keys and opens no sockets: each tool calls a Splice host capability, and
the host runs it against real providers (Codex, GoPlus, Blockscout, Robinhood, Chainlink, Finnhub,
Lighter, DefiLlama, CoinGecko) with its own keys.

```sh
splice add @splice/robinhood --accept-permissions
splice run robinhood.trending limit=5
splice run robinhood.rank kind=gainers window=h1
splice run robinhood.report token=PONS
splice run robinhood.whales token=NVDA minUsd=5000
splice run robinhood.stock symbol=TSLA
splice run robinhood.perps sort=oi
```

## Tools

| Tool | Capability | What it returns |
| --- | --- | --- |
| `trending` | `tokens.rank` | Trending tokens on Robinhood Chain (Codex trending score): price, % change 1h/4h/12h/24h, volume, liquidity, market cap, holders, buys/sells, age. Thin and potential-scam tokens are filtered out. |
| `rank` | `tokens.rank` | Rank every Robinhood Chain token: trending, hot, new, gainers, losers, volume, holders, mcap, txns, buyers (Codex). |
| `token` | `tokens.details` | One token by symbol or address: live stats, metadata and links, pairs, recent trades and a 24h hourly chart (Codex). |
| `report` | `tokens.report` | Research and risk report: market stats (Codex), GoPlus security flags (honeypot, taxes, mint, owner powers, holder concentration, LP lock), verified source (Blockscout), pools. Each flag names its provider field. |
| `whales` | `tokens.whales` | Large trades of a token in its latest ~100 swaps (Codex): trades at or above minUsd, buy/sell totals, net flow, biggest wallets. |
| `stock` | `stock.quote` | A Robinhood Stock Token (TSLA, NVDA, SPY…) from every source separately: Robinhood official, Chainlink, DEX market, Codex, DefiLlama and the underlying US stock (Finnhub). Never averaged. |
| `perps` | `perps.markets` | Perpetual (and spot) markets on Lighter — venue robinhood (Robinhood Chain deployment, default) or mainnet: mark price, 24h change, volume, open interest (USD), trades. |
| `funding` | `perps.funding` | Funding rates (percent per funding interval) on Lighter next to Binance, Bybit and Hyperliquid. |
| `defi` | `defi.overview` | Robinhood Chain DeFi from DefiLlama: TVL with 1d/7d/30d change, DEX volume, fees, stablecoin supply. |
| `markets` | `global.overview` | Global markets: crypto market cap, volume and dominance (CoinGecko), Fear & Greed index, top coins, US stocks/ETFs with 24h change (Chainlink). |

## Results

Every tool returns the host capability result unchanged: `LIVE` / `CACHED` with data and provenance
(provider, fetch time), or `UNAVAILABLE` / `ERROR` with the reason. Values are never invented or
averaged. Market data is not financial advice.

## Permissions

`capabilities: tokens.rank, tokens.details, tokens.report, tokens.whales, stock.quote, perps.markets, perps.funding, defi.overview, global.overview` — no files, network hosts or environment
variables. Granted with `--accept-permissions` and pinned in `splice.lock`.
