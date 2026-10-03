export const COMMAND_HELP: Record<string, string> = {
  init: `Usage: splice init [directory] [--registry <url>]

Create splice.json in the directory (default: current directory). splice.lock is created by
the first install. Does nothing if the directory is already a Splice project.`,

  search: `Usage: splice search <query> [--limit <n>] [--json]

Search the registry by package name and description.`,

  info: `Usage: splice info <package>[@range] [--json]

Show metadata, versions, permissions and tools of a registry package.

Examples:
  splice info @splice/example
  splice info @splice/example@0.1.0`,

  add: `Usage: splice add <package>[@range] [...more] [--accept-permissions] [--json]

Resolve, download, verify and install packages into the current project.
Ranges: 1.2.3, ^1.2.3, ~1.2.3, * or latest (default).
Without a range the newest stable version is installed and recorded as ^<version>. With a
range, the version locked in splice.lock is kept when it satisfies the range (use splice update
to move to the newest version in range).
Every artifact is verified (SHA-256, size, package validity, registry metadata) before anything
is written; there is no way to skip verification. Packages that request permissions (files,
network, environment) are refused unless you pass --accept-permissions after reviewing them
(see splice info). Version, SHA-256, registry and granted permissions are recorded in splice.lock.

Examples:
  splice add @splice/example
  splice add @splice/example@^0.1.0`,

  install: `Usage: splice install [--accept-permissions] [--json]

Install the project exactly as recorded in splice.lock (e.g. after cloning): every locked
package at its locked version, verified against the locked SHA-256. If the registry serves a
different artifact for a locked version, nothing is installed (LOCK_MISMATCH). Packages in
splice.json that are not locked yet are resolved from their range. Already installed packages
are left alone.
Offline, locked versions are installed from the verified local cache
(~/.splice/cache/artifacts); without a cached copy the command fails with a network error.`,

  outdated: `Usage: splice outdated [package ...] [--json]

Compare installed (locked) versions with the registry.
  Current  version in splice.lock
  Wanted   newest version satisfying the range in splice.json (what splice update installs)
  Latest   newest stable version, regardless of the range
Read-only. Exit code 0 whether or not updates exist.`,

  update: `Usage: splice update [package ...] [--accept-permissions] [--json]

Update packages (default: all in splice.json) to the newest version allowed by their range in
splice.json. The range itself is not changed; to move beyond it use splice add <pkg>@<range>.
Each update is resolved, verified (SHA-256, size, package, metadata), checked for new
permissions and swapped in atomically; if anything fails the previous version stays installed
and splice.lock is unchanged. Updates that request new permissions need --accept-permissions.
Exit code 1 when a range matches no registry version.`,

  verify: `Usage: splice verify <package>[@version] [--json]

Verify a published version without installing it: artifact SHA-256 and size, package validity,
registry metadata vs. the manifest inside the artifact, provenance, the direct artifact URL,
signature status, and the installed copy when the package is installed in this project.
Exit code 1 when any check fails. SHA-256 proves integrity, not authorship.`,

  remove: `Usage: splice remove <package> [...more]

Uninstall packages from the current project.`,

  list: `Usage: splice list [--json]

List packages installed in the current project.`,

  run: `Usage: splice run <package>.<tool> [key=value ...] [--input <json>] [--json]

Execute an installed tool in the Splice sandbox and print its structured output.
Input is built from key=value pairs (values are coerced using the tool's input schema)
and/or a JSON object passed with --input. Logs from the tool are printed to stderr.

Examples:
  splice run example.hello name=Dim
  splice run example.hello --input '{"name":"Dim","excited":true}'
  splice run @splice/example.stats text="hello world" --json`,

  publish: `Usage: splice publish [directory] [--dry-run] [--json]

Validate a skill directory (default: current directory), pack it and publish it to the
registry. Requires \`splice login\` (or SPLICE_TOKEN). Published versions are immutable.
The first publish to an unowned namespace claims it for you; @splice is reserved.

Examples:
  splice publish --dry-run
  splice publish ./skills/my-skill --registry local`,

  login: `Usage: splice login [--token <token>]

Verify a registry token and save it to ~/.splice/credentials.json (per registry URL).
Without --token the token is read from a hidden prompt, or from stdin when piped:
  echo "$TOKEN" | splice login --registry local`,

  logout: `Usage: splice logout

Remove the saved token for the current registry.`,

  whoami: `Usage: splice whoami [--json]

Show the user and namespaces of the saved token for the current registry.`,

  config: `Usage: splice config [list]
       splice config get registry
       splice config set registry <url|local|production>
       splice config unset registry

Manage the user-level registry setting (~/.splice/config.json).
Precedence: --registry, SPLICE_REGISTRY, splice.json "registry", user config, default.`,

  token: `Usage: splice token list
       splice token create [--label <label>] [--namespace <ns>]... [--expires <days>]
       splice token revoke <token-id>

Manage your registry tokens. Created tokens are publish-only (they cannot manage tokens or
maintainers), can be limited to namespaces and can expire (max 365 days). The new token is
printed once on stdout, e.g. for CI:
  splice token create --label ci --namespace dim --expires 90d`,

  namespace: `Usage: splice namespace info @<namespace>
       splice namespace add-maintainer @<namespace> <user>
       splice namespace remove-maintainer @<namespace> <user>

Show a namespace's owner, maintainers and packages. Owners can let other users publish into
their namespace by adding them as maintainers.`,

  chain: `Usage: splice chain list [--json]
       splice chain info [chain] [--json]

List supported chains (Robinhood Chain mainnet, chain id 4663 — the only supported chain). "info" verifies
the chain id live against an RPC provider and reports the head block.`,

  providers: `Usage: splice providers [--chain <chain>] [--json]

Live health check of every data provider: status (healthy / degraded / down / auth_failed /
chain_mismatch / unconfigured), latency, chains, capabilities, last error. Provider keys are read
only from their environment variables (process env, then .env.local / .env, else ~/.splice/.env); see
docs/data-providers.md.`,

  block: `Usage: splice block latest [--chain <c>] [--json]
       splice block get <number|hash> [--chain <c>] [--fresh] [--json]

Block data from Robinhood Chain RPC providers (Alchemy → QuickNode → others), with provenance.`,

  tx: `Usage: splice tx inspect <hash> [--chain <c>] [--fresh] [--json]

Transaction + receipt (RPC), Blockscout's indexed view (method, fee, token transfers) and a
call trace where a provider supports it. Each part has its own status.`,

  wallet: `Usage: splice wallet inspect <address> [--chain <c>] [--fresh] [--json]
       splice wallet balances <address>
       splice wallet transfers <address> [--limit <n>]
       splice wallet portfolio <address>

Live wallet data: native balance, nonce, token balances, transfers, transactions, counters,
Zerion portfolio and GoPlus address risk. Missing data is shown as UNAVAILABLE, never filled in.`,

  contract: `Usage: splice contract inspect <address> [--chain <c>] [--fresh] [--json]

Bytecode (RPC), verified source / ABI / functions / events (Blockscout), EIP-1967 proxy slots
(RPC storage reads) and activity counters.`,

  logs: `Usage: splice logs query [--address <a>] [--from-block <n>] [--to-block <n>] [--topic <t|null>]... [--json]

Event logs from RPC providers. Range at most 2000 blocks (default: the latest block).`,

  price: `Usage: splice price <ETH|token-address> [--vs usd] [--chain <c>] [--fresh] [--json]

Market price from CoinGecko. Tokens without a CoinGecko listing are UNAVAILABLE — never estimated.`,

  security: `Usage: splice security token <address> [--chain <c>] [--json]
       splice security address <address>
       splice security approvals <address>

GoPlus security reports. Approvals are not supported for Robinhood Chain by any configured
provider and are reported as UNAVAILABLE.`,

  setup: `Usage: splice setup [--json]
       splice setup --init
       splice setup --template > .env.local

What works without any key (Robinhood Chain via the official public RPC, DexScreener, GeckoTerminal,
CoinGecko prices, GoPlus, public GitHub), which provider variables unlock more, where to create
each key, and which variables are already set (names only; values are never printed).

--init      creates ~/.splice/.env from the template (never overwrites); keys there work from
            every directory
--template  prints the template (variable names and comments only), e.g. for a project .env.local

Keys are read from the process environment, then the nearest .env.local / .env (this or a parent
directory), else ~/.splice/.env.`,

  provider: `Usage: splice provider list [--json]
       splice provider health [--chain <chain>] [--json]

"list" shows every registered provider (chain, market, AI, developer) with its configuration state,
scope and authentication method — no requests. "health" runs the same live checks as
\`splice providers\`: lightweight real requests (never an AI completion), with latency, last check
and last error. Keys are never printed.`,

  ai: `Usage: splice ai models [--provider <name>] [--search <text>] [--json]
       splice ai generate "<prompt>" [--model <id>] [--provider <name>] [--system <text>]
                          [--max-tokens <n>] [--temperature <t>] [--schema <file.json>] [--no-fallback] [--json]

Real model output from OpenRouter (default; AI_PROVIDER, AI_DEFAULT_MODEL) or Gemini (when
GEMINI_API_KEY is set). Routing is explicit: a fallback provider is used only when
AI_FALLBACK_PROVIDER and AI_FALLBACK_MODEL are configured, and the result then shows requested and
actual provider/model and the reason. --schema asks for structured output matching a JSON schema.
Usage (tokens, cost) is printed as reported by the provider. Each generate call is billed by the
provider.`,

  github: `Usage: splice github repo <owner/repo>
       splice github search "<query>" [--page <n>] [--per-page <n>]
       splice github code "<query>"                       (needs GITHUB_TOKEN)
       splice github contents <owner/repo> [path] [--ref <ref>]
       splice github tree <owner/repo> [--ref <ref>]
       splice github commits <owner/repo> [path] [--ref <ref>]
       splice github branches | releases <owner/repo>
       splice github release <owner/repo> [latest|tag|id]
       splice github issues | pulls <owner/repo> [--state open|closed|all]
       splice github user [login]
       splice github raw <https://raw.githubusercontent.com/owner/repo/ref/path> [--max-bytes <n>]

Read-only GitHub REST API data. With GITHUB_TOKEN requests are authenticated (provider "github");
otherwise, or if the token is rejected, the anonymous API is used ("github-public", recorded as a
fallback). "raw" fetches public files from raw.githubusercontent.com only and prints the file.`,

  market: `Usage: splice market trending [network] [--window 5m|1h|6h|24h]
       splice market new [network]
       splice market top [network] [--sort volume|txns] [--page <1-10>]
       splice market gainers | losers | volume | volume-drop | volume-up | liquidity | txns [network]
                     [--window 1h|6h|24h] [--min-liquidity <usd>] [--limit <n>]
       splice market token | pairs | price | quotes <network> <address>
       splice market pair | ohlcv | trades <network> <pool-address> [--timeframe day|hour|minute] [--aggregate <n>] [--limit <n>]
       splice market search "<query>"
       splice market networks
       splice market dexes <network>

[network] defaults to robinhood (Robinhood Chain). Lists print as tables (--json for everything).
Rankings are computed from the providers' own per-pool fields and print their formula: gainers /
losers = price change over the window; volume = highest volume; volume-drop = 6h pace
(volume_h6 × 4 ÷ volume_h24 < 1); volume-up = 1h pace (volume_h1 × 24 ÷ volume_h24); thin pools
(liquidity below --min-liquidity, default $10,000) and stablecoin/ETH bases are left out. Pool
lists come from the CoinGecko onchain API (with COINGECKO_API_KEY) or GeckoTerminal.

DEX market data from DexScreener and GeckoTerminal (public APIs) and CoinGecko (Robinhood token
prices). <network> is a Splice chain (robinhood, 4663) or a provider network id (see
\`splice market networks\`). Unsupported networks are UNAVAILABLE — never mapped to another chain.
"quotes" asks every market provider separately and shows each answer with its own source; values
are never averaged.`,

  web: `Usage: splice web search "<query>" [--limit <n>] [--content] [--max-chars <n>] [--include-domain <d>]... [--exclude-domain <d>]...
       splice web answer "<question>"
       splice web extract <url> [url ...] [--max-chars <n>]
       splice web map <url> [--limit <n>]
       splice web similar <url> [--limit <n>]
       (all: [--provider tavily|exa|firecrawl] [--fresh] [--json])

Web search and page text from Tavily, Exa and Firecrawl (order: search Tavily → Exa → Firecrawl;
extract Tavily → Firecrawl → Exa; map Firecrawl → Tavily; similar Exa; answer Tavily → Exa).
--provider uses only that provider. URLs must be public http(s) addresses. Results are third-party
web content (untrusted text); credits/cost are shown as reported by the provider.`,

  ask: `Usage: splice ask "<question>" [--model <id>] [--provider openrouter|gemini] [--max-tokens <n>] [--json]

Ask anything about Robinhood Chain, DEX markets, stock tokens, oracle prices, wallets, the web or
GitHub. The AI model (AI_ASK_MODEL, else AI_DEFAULT_MODEL, else openai/gpt-4o-mini on OpenRouter)
calls Splice's read-only live data tools, shows each call, and answers with the sources it used.
Numbers come only from tool results. Each answer prints its tool calls, sources, model and the
provider-reported cost. Not financial advice.

Examples:
  splice ask "Top 5 gainers on Robinhood Chain in the last 24 hours"
  splice ask "What are NVDA and TSLA trading at on Robinhood Chain?"
  splice ask "Which tokens are losing volume right now?"
  splice ask "Inspect wallet 0x... on Robinhood Chain"`,

  chat: `Usage: splice chat [--model <id>] [--provider <name>]

Interactive conversation with the same live-data agent as \`splice ask\` (it remembers the
conversation). Type a question per line; "exit" to quit.`,

  stock: `Usage: splice stock profile <TICKER>             company, quote, P/E, 52w range, analysts (Finnhub)
       splice stock news <TICKER> | earnings [TICKER] | market   (Finnhub)
       splice stock list [--search <q>]
       splice stock quote <SYMBOL>          (or: splice stock <SYMBOL>)  [--session regular|extended|overnight]
       splice stock gainers | losers | volume | volume-drop | volume-up | liquidity | txns [--window 1h|6h|24h]

Robinhood Stock Tokens on Robinhood Chain (tokenized US stocks and ETFs). The list comes from
Robinhood's official API (/rhj/assets), else CoinGecko. "quote" shows every source separately:
Robinhood's official bid/ask, the Chainlink oracle price (subscribed keys) and the token's DEX
market on the chain. Rankings use the stock tokens' DEX pools. Not financial advice.`,

  tokens: `Usage: splice tokens trending | hot | new | gainers | losers | volume | holders | mcap | txns | buyers
                     [--window 1h|4h|12h|24h] [--min-liquidity <usd>] [--limit <n>]
       splice tokens search <name|symbol|address>
       splice tokens whales <SYMBOL|address> [--min <usd>]
       splice tokens info | trades | chart <SYMBOL|address> [--timeframe 1m|5m|15m|30m|1h|4h|12h|1d] [--limit <n>]

Every token on Robinhood Chain with live stats from Codex (CODEX_API_KEY): price, % change over
1h/4h/12h/24h, volume, liquidity, market cap, holders, buys/sells, unique buyers, age. Rankings run
over all tokens; tokens below --min-liquidity (default $10,000; new $1,000; hot $5,000) and tokens
Codex flags as potential scams are left out. "info" shows stats, links, pairs, recent trades and a
24h chart. Not financial advice.`,

  global: `Usage: splice global [overview] | coins [--limit <n>] | trending | sentiment | stocks [SYMBOL...]

Global markets: crypto market cap, volume and dominance, top coins and searches trending worldwide
(CoinGecko), the Crypto Fear & Greed Index (alternative.me), and US equities/ETFs with 24h change
(Chainlink Candlestick: SPY, QQQ, AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, COIN, HOOD, MSTR).`,

  report: `Usage: splice report <SYMBOL|address>

Research and risk report for a Robinhood Chain token: market stats (Codex), security flags from
GoPlus (honeypot, buy/sell tax, mintable, owner powers, blacklist, holder concentration, LP lock),
verified source (Blockscout) and pools. Every flag names the provider field it comes from;
nothing is scored. Not financial advice.`,

  compare: `Usage: splice compare <A> <B> [C …]     2–6 tokens by symbol or address

Tokens side by side (Codex): price, 1h/4h/24h change, volume, liquidity, market cap, holders,
buys/sells, unique buyers, age.`,

  watchlist: `Usage: splice watchlist                         live prices of your list
       splice watchlist add <SYMBOL|address|perp:SYMBOL> …
       splice watchlist remove <SYMBOL|address> …

A personal list stored in SPLICE_HOME/watchlist.json: Robinhood Chain tokens (Codex) and perps
(Lighter).`,

  watch: `Usage: splice watch <SYMBOL|address> [--above <price>] [--below <price>] [--change <pct>] [--interval <s>] [--count <n>] [--notify <targets>]
       splice watch whales <SYMBOL|address> [--min <usd>] [--interval <s>] [--notify <targets>]

Live monitor: one line per refresh, an alert (with a terminal bell) when the price crosses
--above/--below, moves --change % since the start, or a trade ≥ --min USD happens. Default
interval 60s (whales 30s, minimum 15s); Ctrl+C stops. Each refresh uses provider quota.

--notify discord,telegram also sends each alert to Discord (DISCORD_WEBHOOK_URL) and/or
Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), read from .env.local or ~/.splice/.env.`,

  radar: `Usage: splice radar [--min-liquidity <usd>] [--interval <s>] [--count <n>] [--notify <targets>]

New Robinhood Chain tokens as they appear (Codex), each with a quick GoPlus security check
(honeypot, sell tax, mintable, hidden owner). Default: liquidity ≥ $5,000, every 60s.
--notify discord,telegram delivers each token that appears after the first refresh.`,

  perps: `Usage: splice perps [markets] | top | gainers | losers | oi | spot [--venue robinhood|mainnet] [--search <s>] [--limit <n>]
       splice perps funding [--search <s>]
       splice perps <SYMBOL>                     e.g. splice perps BTC, splice perps NVDA

Perpetual and spot markets on Lighter — by default the Robinhood Chain deployment (the perps in
Robinhood Wallet: crypto, US stocks/ETFs, gold, pre-IPO), or --venue mainnet. Mark price, 24h
change, volume, open interest in USD, trades; funding rates next to Binance, Bybit and Hyperliquid.
Public data, no key. Not financial advice.`,

  macro: `Usage: splice macro                  US macro dashboard
       splice macro <FRED_ID> [--limit n]   any FRED series, e.g. DGS10, CPIAUCSL, UNRATE, M2SL

US economy from FRED (FRED_API_KEY): Fed funds, CPI inflation y/y, unemployment, 2y/10y yields,
10y−2y spread, dollar index, VIX.`,

  news: `Usage: splice news [general|crypto|forex|merger|<TICKER>] [--limit n]

Market or company headlines from Finnhub (FINNHUB_API_KEY). Third-party content.`,

  dash: `Usage: splice dash [--json]

One screen: ETH, Robinhood Chain TVL, DEX volume, fees and stablecoins; trending, gainers, losers
and new tokens; stock tokens by DEX volume; global crypto, sentiment and US stocks.`,

  defi: `Usage: splice defi [overview]
       splice defi protocols [--search <q>] [--limit <n>]
       splice defi dexes | fees [--limit <n>]
       splice defi yields [--sort tvl|apy] [--min-liquidity <usd>] [--search <q>] [--limit <n>]
       splice defi stablecoins
       splice defi price <token-address> [--timeframe 1h|4h|1d] [--limit <n>]

DeFi on Robinhood Chain from DefiLlama (public, no key): TVL with 1d/7d/30d change, protocols
ranked by their TVL on the chain, DEX volume and fees per protocol, stablecoin supply, yield pools,
and token prices. Values are DefiLlama's.`,

  oracle: `Usage: splice oracle price <SYMBOL|feedId> [--session regular|extended|overnight]
       splice oracle candles <SYMBOL> [--timeframe 1m|5m|15m|30m|1h|4h|24h] [--limit <n>]
       splice oracle symbols [crypto|equities|forex]
       splice oracle feeds [query] [--search <q>] [--limit <n>]

Chainlink oracle prices. "price" uses a Data Streams report when the key is subscribed to the feed
(CHAINLINK_DATA_STREAMS_API_KEY + CHAINLINK_DATA_STREAMS_HMAC_SECRET), otherwise the close of the
latest 1-minute candle from the Chainlink Candlestick API (CHAINLINK_CANDLESTICK_USER +
CHAINLINK_CANDLESTICK_API_KEY) — the result says which. "candles" prints OHLC history with a
sparkline; "feeds" is the public Data Streams catalog.`,

  mcp: `Usage: splice mcp [--project <dir>] [--data]
       splice mcp --http [--port <n>] [--host <addr>] [--project <dir>] [--data]

Run a Model Context Protocol server that exposes the tools of every skill installed in the
project (default: current directory) as MCP tools named <namespace>_<name>_<tool>, and each
SKILL.md as a resource. Tools run in the Splice sandbox.

Default transport is stdio, meant to be launched by an MCP client:
  claude mcp add splice -- splice mcp --project /path/to/project

--http serves Streamable HTTP at http://<host>:<port>/mcp (default 127.0.0.1:8788). A bearer
token is required and read from SPLICE_MCP_TOKEN (min 24 characters); clients send
"Authorization: Bearer <token>". Stop with Ctrl+C.

--data also exposes the live data tools (onchain_get_balance, onchain_get_transaction,
onchain_get_block, onchain_get_token, onchain_get_contract, onchain_get_transfers,
onchain_get_logs, market_get_price, security_get_token, security_get_address,
wallet_get_portfolio, wallet_inspect, providers_status, ai_generate, ai_models, github_repository,
github_search_repositories, github_contents, github_commits, github_releases, github_raw,
market_token, market_pairs, market_token_price, market_ohlcv, market_search, market_trending,
market_new_pools, market_top_pools, market_movers, stock_list, stock_quote, stock_movers,
oracle_price, oracle_candles, oracle_feeds, tokens_rank, tokens_search, token_details, token_trades, token_chart, token_report, token_whales,
global_overview, global_coins, global_trending, global_stocks, perps_markets, perps_funding,
stock_profile, stock_news, market_news, earnings_calendar, us_market_status, macro_overview,
macro_series, defi_overview, defi_protocols, defi_dexes,
defi_fees, defi_yields, defi_stablecoins, defi_token_price, defi_price_chart, chain_info, web_search, web_extract, web_map, web_similar,
web_answer). They query real
providers with the keys from the provider environment variables; results carry status and
provenance. ai_generate is billed by the AI provider.`,
};

export const MAIN_HELP = `splice - composable capabilities for autonomous agents

Usage: splice <command> [options]

Commands:
  init [dir]                 Create a Splice project (splice.json)
  search <query>             Search the registry
  info <package>             Show package details
  add <package>              Install a package (verified before install)
  install                    Install everything in splice.lock (reproducible)
  outdated                   Show packages with newer versions
  update [package]           Update packages within their splice.json ranges
  verify <package>           Verify a published version (integrity, provenance)
  remove <package>           Uninstall a package
  list                       List installed packages
  run <pkg>.<tool> [args]    Run an installed tool
  publish [dir]              Validate, pack and publish a skill
  login | logout | whoami    Manage your registry token
  config                     Show or change the registry URL
  token                      Create, list and revoke your registry tokens
  namespace                  Show a namespace, manage its maintainers
  mcp                        Serve installed skills to AI agents over MCP (stdio, or --http)

Dashboard and research:
  dash                       One screen: Robinhood Chain, trending/new tokens, stocks, perps, macro, global
  report <token>             Research and risk report (market, security, contract, pools)
  compare <a> <b> …          Tokens side by side
  watchlist [add|remove]     Your tokens and perps with live prices
  watch <token> [--above p]  Live monitor with alerts (also: watch whales <token> --min usd)
  radar                      New tokens as they appear, each security-checked (--notify discord,telegram)

Ask (AI over live data):
  ask "<question>"           Ask anything: markets, stocks, wallets, chain, web, GitHub (tools + sources)
  chat                       Interactive conversation with the same agent

Live data (real providers only; Robinhood Chain is the default chain):
  providers                  Provider health, chains and capabilities
  chain list | info          Chains; verify the chain id live
  block latest | get <n>     Blocks
  tx inspect <hash>          Transaction, receipt, explorer view, trace
  wallet inspect <address>   Balances, tokens, transfers, portfolio, risk (also: balances, transfers, portfolio)
  token inspect <address>    Metadata, supply, holders, price, pools, security
  contract inspect <addr>    Bytecode, verified source/ABI, proxy, activity
  logs query                 Event logs (--address, --from-block, --to-block, --topic)
  price <ETH|token>          Market price (CoinGecko)
  security token <address>   Security report (GoPlus; also: address, approvals)
  tokens trending | hot | new  Every Robinhood Chain token (Codex); also gainers, losers, volume, holders, mcap
  tokens info <SYMBOL>       Stats, pairs, recent trades, chart (also: search, trades, chart)
  global [coins|stocks]      Global crypto market, Fear & Greed, top coins, US stocks/ETFs
  perps [funding|<SYMBOL>]   Perps on Robinhood (Lighter): BTC, ETH, SPY, NVDA, gold…; funding vs CEXes
  stock profile|news <TICK>  US companies: quote, P/E, analysts, news, earnings (Finnhub)
  macro | news               US macro (FRED: rates, CPI, yields, VIX) · market news (Finnhub)
  market trending | new | top  Robinhood Chain DEX pools (tables); [network] defaults to robinhood
  market gainers | losers    Movers by price change (also: volume, volume-drop, volume-up, liquidity, txns)
  market <sub> <network> ... DEX market data: token, pairs, price, ohlcv, trades, search, networks
  stock list | quote <SYM>   Robinhood Stock Tokens (TSLA, NVDA, SPY…): list, quotes, gainers/losers
  oracle price | candles     Chainlink prices and OHLC candles (crypto, US equities, forex)
  defi [protocols|yields]    Robinhood Chain DeFi: TVL, protocols, DEX volume, fees, yields (DefiLlama)
  ai models | generate       AI models and completions (OpenRouter; Gemini when configured)
  github <sub> ...           GitHub repos, contents, commits, releases, issues, code, raw files
  web search | extract ...   Web search, page text, site maps, cited answers (Tavily, Exa, Firecrawl)
  setup                      What works without keys; which keys unlock more (and where to get them)
  provider list | health     Registered providers, configuration state, live health

Global options:
  --registry <url|alias>  Registry URL or alias: local, production
                          (default: SPLICE_REGISTRY, splice.json, ~/.splice/config.json, production)
  --json             Machine-readable output
  --no-color         Disable colors
  -h, --help         Show help
  -v, --version      Show version

Try:
  splice dash
  splice tokens trending
  splice market gainers
  splice stock quote NVDA
  splice ask "Which tokens are pumping on Robinhood Chain?"

Get started:
  splice init && splice search json && splice add @splice/json
  splice run json.parse text='{"hello":"world"}'

Run \`splice <command> --help\` for command details.`;
