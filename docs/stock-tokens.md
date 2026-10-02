# Stock tokens, market rankings and oracle prices

## Robinhood Stock Tokens

Robinhood Stock Tokens are ERC-20 tokens on Robinhood Chain (chain ID 4663) that track US stocks and
ETFs, for example TSLA, NVDA, AAPL and SPY. They trade in DEX pools on the chain.

```sh
splice stock list                 # symbol, name, contract on Robinhood Chain
splice stock list --search tesla
splice stock quote NVDA           # or: splice stock NVDA
splice stock gainers --window 1h  # also: losers, volume, volume-drop, volume-up, liquidity, txns
```

**Token list.** The list comes from Robinhood's official Stock Token API (`GET /rhj/assets`). When it
cannot be reached, Splice falls back to CoinGecko's coin list (coins whose id ends in
`-robinhood-tokenized-stock` with a contract on Robinhood Chain). The source is in the result.

**Quote.** `stock quote` asks every source separately and never merges them:

| Section | Source | Notes |
| --- | --- | --- |
| `robinhood` | `GET /rhj/prices/{symbol}` | Official prices: `tokenBid`/`tokenAsk` per token (multiplier applied), `bid`/`ask` of the underlying stock, daily high/low and volume, trading halt flag. |
| `chainlink` | Chainlink Data Streams | US equity feed for the session (`--session regular\|extended\|overnight`); needs a subscribed key. |
| `dex` | DexScreener / GeckoTerminal | The token's DEX market on Robinhood Chain: price, 24h change, volume, liquidity. |

A DEX price can differ from the underlying stock, for example outside market hours. Some networks
block `*.robinhood.com` at the DNS level; the official sections are then `ERROR` with the network
error, and the other sources still answer.

## Market rankings

```sh
splice market trending            # GeckoTerminal's trending pools (--window 5m|1h|6h|24h)
splice market new                 # newest pools (new tokens)
splice market top --sort volume   # by 24h volume or txns, 20 per page (--page 1-10)
splice market gainers             # [network] defaults to robinhood
splice market losers --window 6h
splice market volume-drop
splice market volume-up
```

Rankings are computed by Splice from the providers' own per-pool fields. The formula is printed under
the table and included in `--json` output:

| Ranking | Metric |
| --- | --- |
| `gainers`, `losers` | Price change over the window (`--window 1h\|6h\|24h`, default 24h). |
| `volume` | Volume over the window. |
| `volume-drop` | 6h pace = `volume_h6 × 4 ÷ volume_h24`; below 1 means the last 6 hours traded less than the 24h average. Pools at least 24h old with at least $50k 24h volume. |
| `volume-up` | 1h pace = `volume_h1 × 24 ÷ volume_h24`; above 1 means the last hour traded more than the 24h average. At least $20k 24h volume. |
| `liquidity` | Pool liquidity (reserve in USD). |
| `txns` | Buys + sells over the window. |

Rules applied to every ranking:

- Scans the top pools by 24h volume (three pages, up to 60 pools; stock rankings scan ten pages).
  Price and acceleration rankings also include trending pools.
- Drops pools with less liquidity than `--min-liquidity` (default $10,000; $1,000 for stock tokens),
  and pools whose base token is a stablecoin or wrapped ETH.
- Keeps the deepest pool per token.

Pool lists come from the CoinGecko onchain API when `COINGECKO_API_KEY` is set, otherwise from
GeckoTerminal (10 calls per minute). Both return GeckoTerminal's data; the serving provider is in the
result. Values are cached for 60 seconds.

## Oracle prices (Chainlink)

```sh
splice oracle price ETH
splice oracle price TSLA --session extended
splice oracle candles NVDA --timeframe 1h --limit 24
splice oracle symbols equities
splice oracle feeds TSLA
```

- **Price.** `oracle price` uses a signed Data Streams report when your key is subscribed to the
  feed. Otherwise it uses the close of the latest 1-minute candle from the Chainlink Candlestick
  API, and the result says so (provider `chainlink-candlestick`, candle time, and why the report
  was not used).
- **Candlestick API.** OHLC history for crypto, US equities and forex (`1m` to `24h` candles, no
  volume). It needs `CHAINLINK_CANDLESTICK_USER` (the Data Streams username) and
  `CHAINLINK_CANDLESTICK_API_KEY` (the "API Key" shown once when the key is created at
  app.chain.link).

Data Streams details:

- **Catalog.** The feed catalog is public: crypto feeds (schema v3) and US equity feeds (schema
  v11) with regular, extended and overnight sessions.
- **Keys.** Reports need `CHAINLINK_DATA_STREAMS_API_KEY` and `CHAINLINK_DATA_STREAMS_HMAC_SECRET`.
  Requests are signed with HMAC-SHA256.
- **Subscriptions.** A key reads only the feeds it is subscribed to. Other feeds are `UNAVAILABLE`,
  with Chainlink's answer.
- **Decoding.** Reports are decoded without dependencies (schemas v3, v8, v10, v11; 18-decimal
  fixed point). `marketStatus` reports whether the equity market is open, pre-market, post-market,
  overnight or closed.
