# Market data

Token prices, DEX pairs and pools, candles and trades — on Robinhood Chain and on other DEX
networks — from CoinGecko, DexScreener and GeckoTerminal.

| Provider | Key | Capabilities |
| --- | --- | --- |
| CoinGecko | optional (`COINGECKO_API_KEY`) | ETH and token prices on Robinhood Chain; DEX pools with a key |
| DexScreener | none | search, token, token pairs, pair |
| GeckoTerminal | none | networks, dexes, token, pools, pool, token price, OHLCV, trades, trending and new pools |

## Use it

```sh
splice price ETH
splice market search robinhood
splice market pairs robinhood 0x<token>
splice market price eth 0x<token>
splice market ohlcv robinhood 0x<pool> --timeframe hour --aggregate 4 --limit 48
splice market quotes robinhood 0x<token>
splice market networks
```

SDK: `splice.market.price()`, `tokenPrice()`, `token()`, `pairs()`, `pair()`, `ohlcv()`,
`trades()`, `search()`, `networks()`, `quotes()`. MCP: `market_token`, `market_pairs`,
`market_token_price`, `market_ohlcv`, `market_search`, `market_get_price`.

## Networks

`network` is a Splice chain (`robinhood`, `4663`) — mapped to each provider's own id only where it
was verified — or a provider-native id (`eth`, `base`, `solana`, … — see `splice market networks`).
Unknown networks are `UNAVAILABLE`; a request is never sent for another chain.

## Values are never merged

DexScreener reports price, liquidity, volume, transactions, FDV and market cap per pair; they are
not averaged into one token value. `market quotes` asks each provider separately and returns one
section per source with its own provenance. Tokens without a listing are `UNAVAILABLE`, never
estimated.

## Limits

GeckoTerminal's free API allows 10 calls per minute (per IP) and DexScreener 300; Splice throttles
to those limits client-side and reports HTTP 429 as `RATE_LIMITED`. CoinGecko's keyless API has
lower, shared limits than a demo key.
