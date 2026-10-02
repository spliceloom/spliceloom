# @splice/market

Token prices, DEX pairs and OHLCV candles for agents — through the **Splice capability broker**.
The package declares host capabilities instead of network access:

```json
"permissions": { "network": [], "env": [], "capabilities": ["market.price", "market.pairs", "market.ohlcv"] }
```

The Splice host answers from CoinGecko, DexScreener and GeckoTerminal with its own configuration;
the package never sees a key or opens a socket.

## Tools

| Tool | Input | Host capability |
| --- | --- | --- |
| `price` | `token` (ETH or address), `network` (default `robinhood`), `vs` | `market.price` |
| `pairs` | `network`, `token` | `market.pairs` |
| `candles` | `network`, `pool`, `timeframe` (day/hour/minute), `aggregate`, `limit` | `market.ohlcv` |

`network` is `robinhood` (Robinhood Chain, 4663) or a provider network id such as `eth`, `base` or
`solana`. Unsupported networks are `UNAVAILABLE` — never mapped to another chain. Outputs are the
host results (`LIVE` / `CACHED` with provenance, or `UNAVAILABLE` / `ERROR`); provider values are
never averaged or estimated. GeckoTerminal's free API allows 10 calls per minute.

## Usage

```sh
splice add @splice/market --accept-permissions
splice run market.price token=ETH
splice run market.pairs network=robinhood token=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
splice run market.candles --input '{"network":"robinhood","pool":"0x…","timeframe":"hour","aggregate":4,"limit":24}'
```
