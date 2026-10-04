# Website tools

Tools on [spliceloom.com](https://spliceloom.com) that need no install. They read the same data as
the CLI and SDK, and every panel shows its source and how fresh it is.

| Page | What it shows |
| --- | --- |
| [/live](https://spliceloom.com/live) | Robinhood Chain right now: TVL, stock tokens, perps, DeFi protocols, prediction-market odds, newest pools |
| [/token](https://spliceloom.com/token) | $SPLICE: live price from the pool, candles, trades, holders, burns, transparency |
| [/stocks](https://spliceloom.com/stocks) | Stock tokens: DEX price next to a reference price, with the premium or discount; SEC filings of the company |
| [/screener](https://spliceloom.com/screener) | Newest pools with automated GoPlus security flags, filterable |
| [/wallet](https://spliceloom.com/wallet) | Any wallet: holdings, values where a price source lists the token, recent transfers |
| [/explain](https://spliceloom.com/explain) | A contract's verified functions and security flags, explained in plain English |
| [/ask](https://spliceloom.com/ask) | The `splice ask` agent in the browser |
| [/widgets](https://spliceloom.com/widgets) | An embeddable live $SPLICE card |

## Stock token premiums

`premium = DEX price ÷ reference price − 1`.

- While Robinhood quotes a token tightly (bid and ask within 2%), the reference is the middle of
  that quote.
- When the US market is closed the quote widens (a bid of $2.72 and an ask of $11.80 has no useful
  middle), so the reference becomes the stock's last close from Finnhub × the token's multiplier.
  The row is marked "last close".
- Only pools whose token is the contract address Robinhood lists for that symbol are shown.
  Look-alike tokens that reuse a stock ticker are left out.

## SEC filings

The filings card on /stocks reads SEC EDGAR for the registrant behind the ticker: current reports
(8-K, with the reported item numbers translated: 2.02 is earnings, 5.02 a director or officer
change, and so on), quarterly and annual reports, and ownership filings. Insider forms (3, 4, 5,
144) arrive in bursts, so they are counted for the last 30 days instead of listed. Links go to the
document on sec.gov. A ticker SEC does not list (some funds) shows "no filer".

## Prediction markets

The odds card on /live reads open Polymarket events tagged Fed or inflation, plus stock events that
name a listed stock token's ticker. A contract's price is shown as a probability. Events whose
outcomes exclude each other show the most likely outcomes; events made of independent price levels
show the levels nearest 50%. These are market prices, not a forecast by Splice.

## Contract explainer

The explanation is written by an AI model from two inputs: the contract's verified interface on
Blockscout (function and event signatures) and GoPlus's automated flags. It is not a review of the
source code and not an audit. Contracts without verified source cannot be explained. One
explanation per contract is stored for a day.

## Holder access

Wallets holding at least 100,000 $SPLICE get 50 Ask questions a day instead of 10.

1. Click **Connect wallet** on the Ask page.
2. Sign the message your wallet shows. It is a `personal_sign` message: not a transaction, no gas,
   no approval.
3. The API recovers the signer, reads its $SPLICE balance with `balanceOf`, and returns a pass
   valid for 24 hours. The balance is read again on every question.

The pass is kept in your browser only. Nothing about the wallet is stored on the server except a
per-day question counter.

## Embeddable card

```html
<iframe src="https://spliceloom.com/embed/splice" width="340" height="260" style="border:0" loading="lazy" title="$SPLICE live price"></iframe>
```

The card updates itself from the pool every 15 seconds, sets no cookies and loads no third-party
scripts. `/embed/*` is the only path other sites may frame.

## Telegram bot

[@spliceloombot](https://t.me/spliceloombot) answers from the same data and can message a chat
when something happens. It greets you by your Telegram name and works in groups (it only answers
commands).

| Command | Reply |
| --- | --- |
| `/splice` | $SPLICE price, market cap, liquidity, volume, holders, burned |
| `/holders`, `/burned`, `/ca` | Top holders and the dev wallet, the burned total, the official contract |
| `/tvl`, `/perps` | Robinhood Chain TVL; perpetual markets by volume |
| `/stocks`, `/stock NVDA` | Stock token premiums; one stock token |
| `/filings NVDA` | The company's latest SEC filings |
| `/odds` | Prediction-market odds: Fed, inflation, stock events |
| `/new` | Newest tokens with security flags |
| `/check 0x…` | Verified-source status and security flags of a token contract |
| `/wallet 0x…` | What a wallet holds |
| `/ask <question>` | A plain-English question (10 per chat per day) |

### Alerts

| Command | Alert |
| --- | --- |
| `/alert above 0.00002`, `/alert below 0.00001` | $SPLICE price crosses a level (sent once, then removed) |
| `/whales on 100` | $SPLICE trades of $100 or more, from the pool's swap events |
| `/burns on` | Every new $SPLICE burn |
| `/radar on 10000` | New tokens with $10,000+ liquidity (checked every 10 minutes, at most 3 per check) |
| `/alerts`, `/alertoff 2`, `/alertoff all` | List and remove the chat's alerts (up to 10 per chat) |

Alerts are checked every 2 minutes. Price alerts use the pool price read from the chain. Large
trades are read from the last ~2,000 blocks, so a trade is reported within a few minutes.

Replies are plain text returned in the webhook response. The webhook only accepts calls that carry
the secret token registered with Telegram's `setWebhook`.

## Discord bot

The API also serves a Discord interactions endpoint (`POST /discord/interactions`) with the same
commands as slash commands. Every request is verified against the application's Ed25519 public key
before it is read, replies are plain text with mentions disabled, and alerts stay on Telegram.

## Public API

Read-only JSON at `https://api.spliceloom.com`, cached at the edge.

| Endpoint | Returns |
| --- | --- |
| `GET /v1/chain` | The data behind /live |
| `GET /v1/token`, `GET /v1/token/live` | $SPLICE summary; live price and recent swaps from the chain |
| `GET /v1/stocks` | Stock token premiums |
| `GET /v1/filings/:symbol` | Latest SEC filings of a ticker's registrant |
| `GET /v1/odds` | Prediction-market odds (Polymarket) |
| `GET /v1/screener` | Newest pools with security flags |
| `GET /v1/wallet/:address` | Wallet holdings and transfers |
| `GET /v1/contract/:address` | Contract facts (verified name, functions, flags) |

Browsers may call it from spliceloom.com only. The AI endpoints (Ask and contract explanations)
are limited per visitor and per day. Market data is not financial advice.
