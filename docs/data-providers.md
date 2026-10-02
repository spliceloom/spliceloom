# Data providers

Splice's data layer (`@spliceloom/data`, used by the CLI, SDK and MCP server) answers on-chain,
market, security, wallet, AI, web and developer (GitHub) questions from **real providers only**. There
is no mock, sample, fixture or fallback-to-invented-value path in production code. Robinhood Chain
is the default chain.

Every request has a **scope**: the Splice chain (`robinhood`, mainnet only), a market network
(a Splice chain or a provider-native network id such as `solana`, `base`, `eth`), or `global` (AI,
web and GitHub). One registry, one capability router and one provenance format serve all of them.

| Chain | Key | Chain ID | Native currency |
| --- | --- | --- | --- |
| Robinhood Chain mainnet (the only supported chain) | `robinhood` | 4663 | ETH |

Robinhood Chain is an Arbitrum Orbit chain. Every RPC provider's `eth_chainId` is checked before
its first use; a provider that reports another chain id is marked `chain_mismatch` and never used
for that chain.

## Result states

Every answer has a `status`:

| Status | Meaning |
| --- | --- |
| `LIVE` | Fetched from a provider for this request. |
| `CACHED` | Real data fetched earlier (still within its TTL). `provenance.fresh` is `false` and `provenance.cache` gives its age. Pass `--fresh` / `fresh: true` to refetch. |
| `UNAVAILABLE` | `CAPABILITY_UNAVAILABLE`: no configured provider offers this for the chain, or the provider has no listing (e.g. no market price). Carries provider, network, reason and timestamp. **No data.** |
| `ERROR` | `INVALID_INPUT`, `NOT_FOUND`, `RATE_LIMITED`, `PROVIDER_ERROR`, `ALL_PROVIDERS_FAILED`, `CHAIN_MISMATCH`, with every attempted provider. **No data.** |

`LIVE` and `CACHED` results carry provenance:

```json
{
  "source": "alchemy",
  "chain": "robinhood",
  "chainId": 4663,
  "fetchedAt": "2026-10-01T09:12:44.101Z",
  "fresh": true,
  "blockNumber": "77165603",
  "blockHash": "0x…",
  "requestId": "…",
  "fallbackFrom": [{ "provider": "…", "error": "…" }]
}
```

`blockNumber` is set when the value is pinned to a block (balances, nonce and code are read at the
head block the provider reported). Fields a provider does not return are **absent** — never `0`,
`""` or `"unknown"`. Composite answers (`wallet inspect`, `token inspect`, `contract inspect`,
`tx inspect`) are a set of sections, each with its own status.

## Routing, fallback and cache

For each request the router picks the providers that declare the capability for the chain, skips
the unconfigured, the ones whose key was rejected (`auth_failed`), the ones with a chain-id mismatch
and the ones in a 30 s cool-down after three consecutive failures, then tries them in order.

- Fallback only goes to another **real** provider with the same capability and chain. The answer
  names the provider that served it and lists the ones that failed (`fallbackFrom`).
- A provider that refuses a method (plan limit, add-on not enabled) is marked unsupported for
  that capability at run time and the next provider is tried.
- "Not found" (unknown transaction, block, repository) is an `ERROR NOT_FOUND`, not a fallback trigger.
- "No data" from a provider (token without a listing, no pairs) moves on to the next provider with
  the same capability; the answer records it (`fallbackFrom: [{ error: "no data: …" }]`). When no
  provider has data the result is `UNAVAILABLE` naming each provider's answer.
- A request the provider refuses as such (GitHub 409/422, OpenRouter 400 invalid model) is an
  `ERROR PROVIDER_ERROR` without fallback — another provider would refuse it too.
- AI routing is explicit (`only`): the requested/configured provider, then the configured fallback
  if any. Providers that are not listed for the request are never used.
- The cache holds only real results with their original provenance (in memory, per process, at
  most 500 entries). TTLs: balances/nonce 5 s, blocks/transactions/prices/wallet/DEX market data
  30 s, indexed explorer data 15 s, bytecode and GitHub data 60 s, token metadata, verified sources,
  security reports and AI model lists 10 min, market network lists 1 h. AI completions are never
  cached. A cacheable `LIVE` result has `provenance.expiresAt`; a `CACHED` one has
  `provenance.cache` with the request identity (`key`), `cachedAt`, `ageMs`, `ttlMs` and
  `expiresAt`. Expired entries are dropped, never served (not even as stale).
- The registry database is never a source of chain data.

## Configuration

Keys are read **only** from these variables — in the process environment first, then from the
file named by `SPLICE_ENV_FILE`, else the nearest `.env.local` / `.env`, else `~/.splice/.env`
(created by `splice setup --init`). No other variable in those files is read.

| Variable | Provider |
| --- | --- |
| `ALCHEMY_RPC_URL` or `ALCHEMY_API_KEY` | Alchemy |
| `QUICKNODE_RPC_URL` | QuickNode |
| `ROBINHOOD_PUBLIC_RPC_URL` | Robinhood public RPC: on by default (official endpoint, no key); another URL to override, `off` to disable |
| `BLOCKSCOUT_API_KEY` | Blockscout PRO API |
| `COINGECKO_API_KEY` | CoinGecko demo key (optional: prices work keyless; pools need the key) |
| `GOPLUS_APP_KEY`, `GOPLUS_APP_SECRET` | GoPlus (optional; anonymous access otherwise) |
| `ZERION_API_KEY` | Zerion |
| `GOLDSKY_API_KEY` | Goldsky Edge RPC |
| `THEGRAPH_API_KEY`, `STREAMINGFAST_API_TOKEN` | The Graph gateway / Token API |
| `OPENROUTER_API_KEY` | OpenRouter (AI) |
| `GEMINI_API_KEY` | Gemini (AI, optional) |
| `AI_PROVIDER`, `AI_DEFAULT_MODEL` | AI routing: default provider (`openrouter`) and model — not secret |
| `AI_FALLBACK_PROVIDER`, `AI_FALLBACK_MODEL` | Optional explicit AI fallback — not secret |
| `GEMINI_DEFAULT_MODEL` | Default model when `provider: "gemini"` (configured: `gemini-2.5-flash`) — not secret |
| `TAVILY_API_KEY` | Tavily (web search, extract, map, answer) |
| `EXA_API_KEY` | Exa (web search, contents, similar, answer) |
| `FIRECRAWL_API_KEY` | Firecrawl (web search, scrape, map) |
| `GITHUB_TOKEN` | GitHub REST API (optional; anonymous otherwise) |
| `GITHUB_API_VERSION` | `X-GitHub-Api-Version` header (default `2022-11-28`) — not secret |

DexScreener, GeckoTerminal and raw.githubusercontent.com need no key.

**Without any key** Splice uses: the official Robinhood public RPC (on-chain core data, chain id
verified live), CoinGecko's keyless public API (ETH and token prices; DEX pools need a key),
DexScreener and GeckoTerminal, GoPlus anonymous access, and the public GitHub API. `splice setup`
shows this per feature, which variables unlock more and where each key is created.

Keys never appear in CLI output, logs, errors, MCP or SDK responses: every provider error passes
through redaction of the configured values (including keys embedded in RPC URLs), and provider
endpoints are shown as templates (`…/v2/{key}`).

All provider traffic goes through the Splice network guard (`createGuardedFetch` from
`@spliceloom/runtime`): each provider may only reach its own hosts, addresses are checked at DNS
resolution time (no private, loopback or metadata addresses), redirects are re-checked, TLS is
always verified, responses are size-limited (5 MiB; 20 MiB for the OpenRouter model list; 1 MiB by
default for raw files) and time-limited (15 s; 30 s for Blockscout; 60 s by default, max 120 s, for
AI completions). Providers with a documented public limit are throttled client-side before a
request is sent (DexScreener 300/min, GeckoTerminal 10/min).

## Providers

Status below is what the live integration tests (`npm run test:live`) verified on 2026-10-01 with
the configured credentials. `splice providers` runs the same health checks on demand.

### Alchemy — RPC (primary)

- Endpoint `https://robinhood-mainnet.g.alchemy.com/v2/{key}`; chain 4663.
- Verified: `eth_chainId` = 4663, blocks, transactions, receipts, balances, nonce, code, storage,
  `eth_call`, logs, gas price; `alchemy_getTokenBalances`, `alchemy_getTokenMetadata`,
  `alchemy_getAssetTransfers`.
- Not available: `debug_traceTransaction`, `trace_transaction` (free tier).
- Limits: compute-unit based free tier.

### QuickNode — RPC (fallback) and traces

- Endpoint `https://{name}.robinhood-mainnet.quiknode.pro/{token}/`; chain 4663.
- Verified: `eth_chainId` = 4663, core JSON-RPC, `debug_traceTransaction` (callTracer).
- Not available on this endpoint: Token & NFT API add-on (`qn_getWalletTokenBalance`).

### Robinhood public RPC

- Endpoint `https://rpc.mainnet.chain.robinhood.com`; no key.
- Not verified: from the network used for verification, TLS to `*.robinhood.com` is intercepted
  (the certificate presented belongs to another host). Splice never disables TLS verification, so
  the provider reports `degraded` there. It works on networks without interception.

### Blockscout — explorer / indexer

- Endpoint `https://api.blockscout.com/4663/api/v2/…` (PRO API, key as `apikey`). The public
  explorer UI is behind a browser challenge and is not used.
- Verified: indexed transactions (method, fee, token transfers), state changes, raw traces,
  token balances, token metadata and holders, token transfers, address transactions, counters,
  verified contract source / ABI.
- Limits: some endpoints are slow (up to ~15 s) or intermittently return 5xx; Splice retries once.
  Internal transactions are declared but have been unreliable (5xx).

### CoinGecko — market data

- Endpoint `https://api.coingecko.com/api/v3` with the demo key header; platform `robinhood`
  (= chain 4663), GeckoTerminal network `robinhood`.
- Verified: ETH price, token price by contract (`/simple/token_price/robinhood`), DEX pools
  (`/onchain/networks/robinhood/tokens/{address}/pools`).
- Tokens without a listing are `UNAVAILABLE` (provider `coingecko`) — never estimated.
- Prices are CoinGecko's aggregated values (update interval per CoinGecko), not a tick feed.

### GoPlus — security

- Endpoint `https://api.gopluslabs.io/api/v1`; chain id `4663` supported. With
  `GOPLUS_APP_KEY`/`GOPLUS_APP_SECRET` an access token is requested; otherwise anonymous limits apply.
- Verified: token security, address security.
- Not available: approval security ("Main chain does not exist" for 4663) — `security approvals`
  is `UNAVAILABLE`.

### Zerion — wallet portfolio

- Endpoint `https://api.zerion.io/v1`; chain `robinhood`.
- Verified: portfolio, positions, transactions for regular wallets. System/contract addresses are
  rejected as "untrackable" (reported as unsupported).
- Limits: strict per-key rate limit; `RATE_LIMITED` is returned as an error, never filled in.
- The portfolio total is across all chains Zerion tracks; positions are filtered to the chain.

### Goldsky — Edge RPC

- Endpoint `https://edge.goldsky.com/standard/evm/4663?key={key}` (third RPC provider for mainnet).
- Verified: `eth_chainId` = 4663, head blocks, core JSON-RPC.
- The key is the Edge RPC key (`gs_edge_…`, shown in the dashboard's Edge RPC page), not a
  project id or API-key id — those return HTTP 401. Without a key the endpoint answers HTTP 402
  (x402 pay-per-request).

### The Graph — subgraphs / Token API

- Gateway `https://gateway.thegraph.com/api/{key}/subgraphs/id/{id}`; Token API
  `https://token-api.thegraph.com`.
- Verified: the gateway accepts the configured key (an unknown subgraph id returns "subgraph not
  found", not an auth error). No Robinhood subgraph is assumed; `subgraph.query` takes an explicit
  subgraph id from the caller.
- The Token API connection is reset from the verification network; it backs no capability and is
  only reported in the health detail.

### Robinhood stock token API

- Endpoint `https://api.robinhood.com/rhj` (no key): stock token assets and underlying prices.
- Not verified: same TLS interception as the public RPC. Payloads are passed through unnormalized
  when reachable.

### DexScreener — DEX pairs (any network)

- Endpoint `https://api.dexscreener.com` (no key); throttled client-side to 300 requests/min.
- Capabilities: `market.search` (`/latest/dex/search`), `market.token` (`/tokens/v1/{chain}/{address}`),
  `market.token_pairs` (`/token-pairs/v1/{chain}/{address}`), `market.pair` (`/latest/dex/pairs/{chain}/{pair}`).
- Robinhood Chain: chain id `robinhood` — verified live (search, pair and token pairs return
  Robinhood pairs).
- Values per pair as reported: price (USD and native), liquidity, volume, price change and buy/sell
  transaction counts per window, FDV, market cap, pair creation time. Nothing is averaged into a
  token-level value.
- DexScreener answers `[]` both for unlisted tokens and unknown networks; Splice reports that as
  `UNAVAILABLE` ("no pairs … DexScreener answers the same way for unlisted tokens and unknown
  networks") and asks the next provider.

### GeckoTerminal — pools, OHLCV, trades (any listed network)

- Endpoint `https://api.geckoterminal.com/api/v2` (no key). The free API allows **10 calls/min**
  (geckoterminal.com/dex-api); Splice throttles to that and reports HTTP 429 as `RATE_LIMITED`.
  The limit is shared per IP and was hit during verification.
- Capabilities: `market.networks`, `market.dexes`, `market.token`, `market.token_pairs` (token
  pools), `market.pair` (pool), `market.tokenPrice` (`/simple/networks/{n}/token_price/{addresses}`,
  USD), `market.ohlcv` (day 1; hour 1, 4, 12; minute 1, 5, 15; up to 1000 candles), `market.trades`,
  `market.trending_pools`, `market.new_pools`.
- Networks are checked against GeckoTerminal's own network list (kept 1 h); an unknown network is
  `UNAVAILABLE` for GeckoTerminal. Robinhood Chain: network `robinhood` — verified live (listed;
  pools, trending pools, OHLCV, trades).

### Market routing

- `network` is a Splice chain (`robinhood`, `4663`) — mapped to `dexscreenerChainId` /
  `geckoterminalNetwork` / CoinGecko platform only where verified — or a provider-native id passed
  through unchanged. A request is never
  sent for another chain.
- Order: DexScreener → GeckoTerminal for token / pairs / pair; CoinGecko → GeckoTerminal for token
  prices on Robinhood; GeckoTerminal alone for OHLCV, trades, networks, trending and new pools.
- `market quotes` / `splice.market.quotes()` asks each provider separately and returns one section
  per source with its own provenance — no consensus value.

### OpenRouter — AI (primary)

- Endpoint `https://openrouter.ai/api/v1` (`OPENROUTER_API_KEY`, Bearer). Default provider; the
  model comes from the request or `AI_DEFAULT_MODEL` (configured: `openai/gpt-4o-mini`, listed on
  `/models` with tools and structured outputs). No model is hardcoded in code.
- Verified live: chat completion, tool calling (`tools`, `toolChoice`), structured output
  (`response_format` JSON schema → `structured`), image input (`image_url` parts), model list with
  context length, pricing and supported features, usage (prompt/completion/total/reasoning tokens
  and cost reported by OpenRouter), actual model and upstream provider (e.g. "Azure", "OpenAI").
- Health check: `GET /key` (free; reports the per-key spending limit remaining, not the account
  balance). Completions are never used for health.
- Errors: 401 → `auth_failed`; 429 → `RATE_LIMITED` (one retry when retry-after ≤ 5 s); 400/403/
  404/413/422 → `PROVIDER_ERROR` (no fallback); 402 credits and 5xx → provider failure (configured
  fallback may be tried; one retry for 5xx/network). Timeout 60 s by default (max 120 s).
- Streaming is not offered: Splice results are complete objects with provenance (SDK, CLI and MCP
  have no streaming result type).

### Gemini — AI (optional second provider)

- Endpoint `https://generativelanguage.googleapis.com/v1beta` (`GEMINI_API_KEY`, `x-goog-api-key`).
- generateContent with system instruction, tools (function declarations), structured output
  (`responseJsonSchema`), images as `data:` URLs (http(s) image URLs are refused, Gemini does not
  fetch them here), thinking budget, usage metadata including thinking tokens; model list.
- Verified live: model list (61 models), completion, function calling and structured output with
  `gemini-2.5-flash` (`GEMINI_DEFAULT_MODEL`). Health check: model list (free).
- Not a fallback by default: OpenRouter stays the default provider; Gemini is used when a request
  asks for `provider: "gemini"`, or as the fallback when `AI_FALLBACK_PROVIDER=gemini` and
  `AI_FALLBACK_MODEL` are set.

### AI routing

- A request uses the requested provider (or `AI_PROVIDER`) with the requested model (or
  `AI_DEFAULT_MODEL`). Nothing else is tried unless `AI_FALLBACK_PROVIDER` **and**
  `AI_FALLBACK_MODEL` are set (and the request does not pass `fallback: false`).
- Every answer carries `routing`: `requestedProvider`, `requestedModel`, `actualProvider`,
  `actualModel`, `fallback`, and `fallbackReason` (the failed provider's error) — substitution is
  never hidden. Provider-side model routing is reported too (`model` as returned, `upstreamProvider`).
- Limits: ≤ 100 messages, ≤ 200,000 characters, `maxTokens` ≤ 16,384, ≤ 32 tools, images https or
  `data:image/*` ≤ 5 MB.

### Web — Tavily, Exa, Firecrawl

The providers fetch the web on their side; Splice only reaches `api.tavily.com`, `api.exa.ai` and
`api.firecrawl.dev` through the network guard. Target URLs (extract, map, similar) are validated
with the runtime's skill rule (`network: ["*"]`): http(s), public hosts only — no localhost,
private, link-local, metadata or `.local`/`.internal` hosts, no credentials. Results are
third-party web content: untrusted text (MCP tells clients to treat it as data, never as
instructions). Page text is capped per result (`maxCharacters`, default 5,000, max 50,000) and
marked `truncated: true` when cut. Credits / cost are passed through as each provider reports them
(`usage.credits`, `usage.costUsd`).

| Capability | Order (fallback) | Tavily | Exa | Firecrawl |
| --- | --- | --- | --- | --- |
| `web.search` | Tavily → Exa → Firecrawl | `/search` | `/search` | `/v2/search` (domain filters applied by Splice, noted) |
| `web.extract` (≤ 10 URLs) | Tavily → Firecrawl → Exa | `/extract` | `/contents` | `/v2/scrape` per URL (partial failures listed) |
| `web.map` | Firecrawl → Tavily | `/map` | – | `/v2/map` |
| `web.similar` | Exa | – | `/findSimilar` | – |
| `web.answer` (with citations) | Tavily → Exa | `/search` + answer | `/answer` | – |

- `provider` pins one provider (no fallback). Results are cached 5 min.
- Health checks spend no credits: Tavily `GET /usage`, Exa an intentionally empty search request
  (HTTP 400 = key accepted, nothing searched), Firecrawl `GET /v2/team/credit-usage`.
- Errors: 401/403 → `auth_failed`; 429, Tavily 432/433 (plan / pay-as-you-go limit) →
  `RATE_LIMITED`; 400/422 → `PROVIDER_ERROR`; 402 (credits) and 5xx → provider failure (next
  provider is tried).
- Verified live (2026-10-02): search on each provider; extract of the same search-result page by
  each provider; map (Firecrawl, Tavily); similar (Exa); answers with citations (Tavily, Exa); the
  metadata address `169.254.169.254` is refused before any request.

### GitHub — developer data (read-only)

- `github`: `https://api.github.com` with `GITHUB_TOKEN` (Bearer), `X-GitHub-Api-Version` from
  `GITHUB_API_VERSION` (default `2022-11-28`; `2026-03-10` is also accepted by GitHub). 5,000
  requests/h core, 10/min code search.
- `github-public`: the same API anonymously (60 requests/h per IP). Used when no token is set, or —
  recorded as fallback — when the token is rejected (401). Code search is not offered anonymously
  (GitHub answers 401 "Requires authentication"); the authenticated user needs the token.
- Capabilities: repository, repository search, contents (file decoded from base64 with sha, size,
  ref, download URL; directory listing), tree (recursive), commits, branches, releases (list,
  latest, by tag or id), issues (pull requests removed and counted), pull requests, user
  (authenticated or by login), code search. Pagination: `page`/`perPage` (≤ 100) with `nextPage` /
  `lastPage` from the Link header; search results include `totalCount`.
- Errors: 401 bad credentials → `auth_failed` (token provider); 403/429 with an exhausted rate
  limit → `RATE_LIMITED` (reset time in the message); other 403, 409 (empty repository), 422, 451 →
  `PROVIDER_ERROR`; 404 → `NOT_FOUND`. An empty list is returned only when GitHub returned one.
  Rate-limit headers are in `provenance.rateLimit`, the request id in `provenance.requestId`.
- Verified live: search, repository, contents (directory and file), commits, branches, releases,
  authenticated user, code search with the token; repository anonymously.

### GitHub raw content

- `github-raw`: public files from `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`.
  The URL must use exactly that host over https — no other host, port, credentials, query,
  fragment, `..` segments or encoded separators; the network guard allows only that host (redirects
  re-checked); 1 MiB by default (max 5 MiB); binary files are not returned as text. The GitHub
  token is never sent there.
- Verified live: a file fetched raw is byte-identical to the same file from the contents API.

## Capability matrix

✓ verified live · ✗ refused by the provider · ? declared, not verified · – not offered

| Capability | Alchemy | QuickNode | Blockscout | CoinGecko | GoPlus | Zerion | Goldsky | Public RPC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chain id, blocks, tx, receipts | ✓ | ✓ | – | – | – | – | ✓ | ? |
| balance, nonce, code, call, storage, logs, gas | ✓ | ✓ | – | – | – | – | ✓ (core RPC) | ? |
| traces | ✗ | ✓ | ✓ (raw-trace) | – | – | – | – | – |
| token balances / metadata / transfers | ✓ | ✗ | ✓ | – | – | – | – | – |
| token holders, address tx / counters, verified source | – | – | ✓ | – | – | – | – | – |
| internal transactions | – | – | ? (5xx) | – | – | – | – | – |
| market price, token price, pools | – | – | – | ✓ | – | – | – | – |
| token / address security | – | – | – | – | ✓ | – | – | – |
| approval security | – | – | – | – | ✗ | – | – | – |
| wallet portfolio / positions / transactions | – | – | – | – | – | ✓ (rate-limited) | – | – |

| Provider | Capability | Scope | Auth | Status (2026-10-02) | Live tested |
| --- | --- | --- | --- | --- | --- |
| OpenRouter | AI generation, tools, structured output, image input, models, usage | global | API key | healthy | yes |
| Gemini | AI generation, tools, structured output, models | global | API key | healthy | yes |
| Tavily | web search, extract, map, answer | global | API key | healthy | yes |
| Exa | web search, contents, similar, answer | global | API key | healthy | yes |
| Firecrawl | web search, scrape, map | global | API key | healthy | yes |
| GitHub (token) | repository, search, contents, tree, commits, branches, releases, issues, pulls, user, code search | global | token | healthy | yes (repo, search, contents, commits, branches, releases, user, code search) |
| GitHub (public) | same, without code search / authenticated user | global | none | healthy | yes (repository) |
| GitHub raw | raw file content | raw.githubusercontent.com | none | healthy | yes |
| DexScreener | search, token, token pairs, pair (price, liquidity, volume, txns, FDV, market cap per pair) | any DexScreener chain; `robinhood` verified | none | healthy | yes |
| GeckoTerminal | networks, token, pools, pool, token price, OHLCV, trades, trending/new/top pools (sort by 24h volume or txns, pages 1–10), dexes | listed networks; `robinhood` verified | none | healthy (10 calls/min; rate-limited during tests) | yes |
| CoinGecko | token price (Robinhood platform); onchain trending/new/top pools (GeckoTerminal format); Robinhood Stock Token list (coin list) | robinhood | demo key | healthy | yes |
| Robinhood Stock Token API | stock token list (`/rhj/assets`), underlying bid/ask (`/rhj/prices/{symbol}`) | robinhood | none | documented; not reachable from the verification network (DNS filter) | no |
| Chainlink Data Streams | feed catalog (public), latest reports (crypto v3, US equities v11; HMAC-signed) | global | API key + HMAC secret | catalog and auth verified; reports need a feed subscription | partly (catalog, auth; decoding unit-tested) |
| Codex | every token on the chain: rankings (trending, new, gainers, volume, holders, mcap…), search, prices, OHLCV bars, trades, metadata, pairs | robinhood (network 4663) | API key | healthy (free plan) | yes |
| CoinGecko (global) | global market cap/volume/dominance, top coins, trending searches | global | demo key or none | healthy | yes |
| alternative.me | Crypto Fear & Greed Index | global | none | healthy | yes |
| Lighter | perpetual and spot markets, exchange stats, funding rates vs Binance/Bybit/Hyperliquid | Robinhood Chain deployment (api.rh.lighter.xyz) and mainnet | none | healthy | yes |
| Finnhub | US quotes, profile + metrics + analysts, company/market news, earnings calendar, market status | global | API key | healthy (free plan) | yes |
| FRED | US macro series (rates, CPI, yields, unemployment, dollar index, VIX, any series id) | global | API key | healthy | yes |
| DefiLlama | chain TVL + history, protocols (TVL on the chain), DEX volume, fees, stablecoins, yields, token prices and charts | robinhood ("Robinhood Chain") | none | healthy | yes |
| Chainlink Candlestick | OHLC history and latest candle for crypto, US equities, forex | global | username + API key → JWT | healthy | yes (login, symbols, ETH/TSLA/NVDA history) |

Market rankings (`splice market gainers|losers|volume|volume-drop|volume-up|liquidity|txns`, MCP
`market_movers`, `stock_movers`) are computed by Splice from these providers' per-pool fields; see
[stock-tokens.md](stock-tokens.md#market-rankings) for the formulas.

Not available from any configured provider: approval security, the first activity of an address
(needs full history).

## Using it

```sh
splice providers
splice chain info
splice block latest
splice tx inspect 0x<hash>
splice wallet inspect 0x<address>
splice token inspect 0x<token>
splice contract inspect 0x<address>
splice logs query --address 0x<contract> --from-block 77165000 --to-block 77165100
splice price ETH --fresh
splice security token 0x<token>
splice mcp --data
splice provider list
splice ai models --search gpt-4o
splice ai generate "Summarize EIP-1967 in one sentence" --max-tokens 80
splice github repo nodejs/node
splice github contents nodejs/node README.md --ref main
splice github raw https://raw.githubusercontent.com/nodejs/node/main/README.md
splice market pairs robinhood 0x<token>
splice market price eth 0x<token>
splice market ohlcv robinhood 0x<pool> --timeframe hour --aggregate 4 --limit 48
splice ai generate "Reply with one word" --provider gemini
splice web search "Robinhood Chain documentation" --limit 5
splice web extract https://docs.robinhood.com/chain/ --max-chars 3000
splice web answer "What is the chain ID of Robinhood Chain mainnet?"
```

Exit codes: 0 live/cached, 3 unavailable, 1 provider error, 2 invalid input.

```ts
import { Splice, isLive } from "@spliceloom/sdk";

const splice = new Splice();
const balance = await splice.onchain.balance("0x…");
if (isLive(balance)) console.log(balance.data.formatted, balance.provenance.source, balance.provenance.blockNumber);
else console.log(balance.status, balance.code);
```

## Tests

- `npm test` — unit tests. Provider HTTP is replaced only inside test files through the
  `SpliceDataOptions.fetch` test seam, to test routing, fallback, cache labelling, redaction and
  validation.
- `npm run test:live` — real requests with the configured credentials. Blocks, transactions,
  wallets, repositories, pairs, pools and tokens are discovered at run time (chain, search,
  trending lists); nothing is hardcoded. GitHub raw content is cross-checked against the contents
  API. A step rate-limited by GeckoTerminal waits for the window and is retried once (and says so).
  The run fails if any result contains a configured key.
- `npm run secret-scan` — configured credential values (from the env files, never printed) and
  well-known key formats in the repository, build output and the staged npm package.
