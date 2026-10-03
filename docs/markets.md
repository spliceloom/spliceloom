# Tokens, global markets and the dashboard

## Every token on Robinhood Chain (`splice tokens`)

```sh
splice tokens trending            # Codex trending score (24h; --window 1h|4h|12h|24h)
splice tokens hot                 # trending over the last hour
splice tokens new                 # newest tokens
splice tokens gainers --window 1h # also: losers, volume, holders, mcap, txns, buyers
splice tokens search pepe
splice tokens info NVDA           # stats, links, pairs, recent trades, 24h chart
splice tokens trades RBD
splice tokens chart PONS --timeframe 15m --limit 48
```

Data comes from [Codex](https://docs.codex.io), which covers every token on Robinhood Chain
(network 4663). Each row shows:

- price, and % change over 1h, 4h and 24h;
- volume, liquidity and market cap;
- holders, buys/sells and age.

Rankings run on Codex's servers over all tokens. Splice then applies these rules:

- **Liquidity.** Tokens below `--min-liquidity` are left out. The defaults are $10,000, $5,000 for
  `hot` and $1,000 for `new`. Each row's reported liquidity is checked again on the Splice side.
- **Scams.** Tokens Codex flags as potential scams are left out.
- **Percentages.** Codex reports changes as fractions; Splice shows them as percentages.
- **Transparency.** The ranking rule is printed under every table.

Needs `CODEX_API_KEY`. The free Codex plan allows 10,000 requests per month, and results are
cached for a minute. Holder lists and top traders need a paid Codex plan.

## Research and monitoring

```sh
splice report PONS                   # research and risk report
splice tokens whales NVDA --min 5000 # large trades, buy/sell totals, net flow, wallets
splice compare PONS CASHCAT RBD      # side by side
splice watchlist add PONS NVDA perp:BTC
splice watchlist                     # live prices of your list
splice watch PONS --above 0.5 --below 0.4 --change 10
splice watch whales NVDA --min 10000
splice radar                         # new tokens as they appear, each security-checked
```

- **`report`** combines three sources:
  - Codex market stats;
  - GoPlus security (honeypot, buy/sell tax, mintable, owner powers, blacklist, holder
    concentration, LP lock);
  - Blockscout source verification.

  Each flag (danger, warn, info, ok) names the provider field it comes from. The report never
  computes a score.
- **`watch` and `radar`** refresh on an interval and ring the terminal bell on alerts. The default
  interval is 60 seconds (30 seconds for whales, minimum 15); `--count n` stops after `n`
  refreshes. Every refresh uses provider quota.
- **`watchlist`** is stored in `SPLICE_HOME/watchlist.json`.

### Alerts to Discord and Telegram

Add `--notify discord`, `--notify telegram` or `--notify discord,telegram` to `watch`, `watch whales`
or `radar`. Every alert is printed in the terminal and also delivered as a plain-text message:

```sh
splice radar --notify discord
splice watch PONS --above 0.5 --notify telegram
splice watch whales NVDA --min 10000 --notify discord,telegram
```

| Target | Variables | How to get them |
| --- | --- | --- |
| Discord | `DISCORD_WEBHOOK_URL` | Channel settings → Integrations → Webhooks → New webhook → Copy URL |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Create a bot with [@BotFather](https://t.me/BotFather), send it a message, then use your chat id (or `@channel` for a channel the bot posts in) |

Put them in `.env.local` or `~/.splice/.env` like any provider key (`splice setup --init`). They
are redacted from every error, and requests only go to `discord.com` / `discordapp.com` and
`api.telegram.org`. A failed delivery is reported in the terminal and never stops the watch.
`radar` only delivers tokens that appear after its first refresh, so starting it does not flood
the channel.

## Global markets (`splice global`)

```sh
splice global                  # crypto + sentiment + top coins + US stocks
splice global coins --limit 25
splice global trending
splice global sentiment
splice global stocks SPY QQQ NVDA
```

| Section | Source |
| --- | --- |
| Crypto market cap, volume, dominance, top coins, trending searches | CoinGecko |
| Crypto Fear & Greed Index | alternative.me |
| US equities and ETFs (price, 24h change) | Chainlink Candlestick API (latest hourly close vs. about 24h earlier) |

## Perpetuals on Robinhood (`splice perps`)

```sh
splice perps                    # Robinhood Chain deployment of Lighter (the perps in Robinhood Wallet)
splice perps gainers            # also: top, losers, oi, spot
splice perps funding            # funding next to Binance, Bybit, Hyperliquid
splice perps BTC                # one market + its funding
splice perps --venue mainnet    # Lighter mainnet
```

Public Lighter market data, no key needed:

- **Prices and activity:** mark price, 24h change, volume and trades.
- **Open interest** in USD, computed as open interest × mark price.
- **Default initial margin** per market.
- **Funding rates** as Lighter publishes them for each exchange. Each exchange uses its own funding
  interval, so compare them with that in mind.

## US companies, news and macro

```sh
splice stock profile NVDA       # quote, market cap, P/E, EPS, beta, 52-week range, analysts
splice stock news NVDA
splice stock earnings           # upcoming earnings, largest expected revenue first
splice stock market             # US market open/closed and session
splice news crypto              # general, crypto, forex, merger
splice macro                    # Fed funds, CPI y/y, unemployment, 2y/10y, spread, dollar, VIX
splice macro DGS10 --limit 60   # any FRED series
```

Company data and news come from Finnhub (`FINNHUB_API_KEY`). Its free plan allows 60 calls per
minute; price targets, the economic calendar and candles are not included. Macro data comes from
FRED (`FRED_API_KEY`).

`splice stock quote <SYMBOL>` now shows the underlying US stock from Finnhub next to the token's
other sources (Robinhood, Chainlink, DEX, Codex, DefiLlama).

## Dashboard (`splice dash`)

One screen, built from the sections above:

- **Robinhood Chain:** ETH, TVL, DEX volume, fees and stablecoins.
- **Tokens:** trending, top gainers, top losers and new tokens.
- **Stock tokens:** ranked by DEX volume.
- **Global markets:** crypto, sentiment and US stocks.
- **US market and macro:** whether the US market is open, plus Fed funds, CPI, the 10-year yield
  and VIX.
- **Perps:** the top markets on Robinhood (Lighter).

`--json` prints every underlying result.
