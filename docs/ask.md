# Ask anything (AI agent)

`splice ask` answers questions about Robinhood Chain, DEX markets, Robinhood Stock Tokens, oracle
prices, wallets, the web and GitHub. The AI model decides which of Splice's read-only live data
tools to call, Splice runs them against the real providers, and the model answers from the results.

```sh
splice ask "Top 5 gainers on Robinhood Chain in the last 24 hours"
splice ask "What are NVDA and TSLA trading at on Robinhood Chain?"
splice ask "Which tokens are losing volume right now?"
splice ask "Inspect wallet 0xa4b000000000000000000073657175656e636572"
splice chat
```

## What you see

- Each tool call as it happens, with its arguments, status and provider, for example
  `✓ market_movers  kind=gainers  → LIVE coingecko`.
- The answer (Markdown rendered for the terminal).
- A footer: number of tool calls, the providers used, the model and the cost reported by the AI
  provider, for example `2 tool calls · sources: coingecko, dexscreener · model openai/gpt-4o-mini · cost 0.002128 USD`.

`--json` prints the question, answer, tool calls (name, arguments, status, source), model and cost.

## How it stays honest

- The model is instructed to call tools for every price, market, token, wallet, stock, oracle, web
  or GitHub fact and never to answer them from memory.
- Tool results carry status (`LIVE`, `CACHED`, `UNAVAILABLE`, `ERROR`) and provenance; when a
  source is unavailable the answer says so.
- Only read-only tools are available. The agent cannot send transactions, write files or call
  another model.
- Tool results are trimmed before they are sent to the model (long lists, ABIs, traces).
- Market data is not financial advice; the agent does not tell you what to buy or sell.

## Tools

The same tools `splice mcp --data` exposes, except `ai_generate` and `ai_models`:

| Area | Tools |
| --- | --- |
| Markets | `market_trending`, `market_new_pools`, `market_top_pools`, `market_movers`, `market_get_price`, `market_token`, `market_pairs`, `market_token_price`, `market_ohlcv`, `market_search` |
| Stock tokens | `stock_list`, `stock_quote`, `stock_movers` |
| Oracle | `oracle_price`, `oracle_candles`, `oracle_feeds` |
| Tokens (Codex) | `tokens_rank`, `tokens_search`, `token_details`, `token_trades`, `token_chart` |
| Global | `global_overview`, `global_coins`, `global_trending`, `global_stocks` |
| Perps (Lighter) | `perps_markets`, `perps_funding` |
| Companies, news, macro | `stock_profile`, `stock_news`, `market_news`, `earnings_calendar`, `us_market_status`, `macro_overview`, `macro_series` |
| DeFi (DefiLlama) | `defi_overview`, `defi_protocols`, `defi_dexes`, `defi_fees`, `defi_yields`, `defi_stablecoins`, `defi_token_price`, `defi_price_chart` |
| Chain and wallets | `chain_info`, `onchain_get_block`, `onchain_get_transaction`, `onchain_get_balance`, `onchain_get_token`, `onchain_get_contract`, `onchain_get_transfers`, `onchain_get_logs`, `wallet_inspect`, `wallet_get_portfolio`, `security_get_token`, `security_get_address` |
| Web and GitHub | `web_search`, `web_extract`, `web_answer`, `web_map`, `web_similar`, `github_repository`, `github_search_repositories`, `github_contents`, `github_commits`, `github_releases`, `github_raw` |
| Providers | `providers_status` |

## Model and cost

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Required (or `GEMINI_API_KEY` with `--provider gemini`). |
| `AI_ASK_MODEL` | Model for `ask`/`chat` only, for example a stronger model than the default. |
| `AI_DEFAULT_MODEL` | Used when `AI_ASK_MODEL` is not set. |
| — | Without either, `openai/gpt-4o-mini` on OpenRouter (`gemini-2.5-flash` on Gemini). |

`--model <id>` overrides all of them for one question. A question typically takes one to three
tool calls and two to four model calls; the cost is printed with every answer. Some tools use
billed provider credits as well (web search and extraction).
