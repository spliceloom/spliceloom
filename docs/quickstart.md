# Quickstart

From nothing to live Robinhood Chain data, an AI agent with sources, and verified skills. Every
command below is real and prints where its data came from.

## 1. Install

Splice needs **Node.js 22.18 or newer** ([nodejs.org](https://nodejs.org), LTS). Check with
`node --version`, then:

```sh
npm install -g @spliceloom/cli
splice --version
```

**Windows (PowerShell):** if you see `running scripts is disabled on this system`, run this once and
open a new terminal (or use `splice.cmd` instead of `splice`):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

More options (source install, uninstall): [Installation](installation.md).

## 2. Try it without any key

```sh
splice chain info          # Robinhood Chain: chain id verified live, head block
splice perps               # perpetual markets on Robinhood (Lighter)
splice defi                # TVL, DEX volume, fees, stablecoins (DefiLlama)
splice global              # crypto market, Fear & Greed, top coins
splice market trending     # trending Robinhood Chain pools
splice stock quote TSLA    # a Robinhood Stock Token from every source that has it
```

Every result is labelled `LIVE`, `CACHED`, `UNAVAILABLE` or `ERROR` and names its provider. A
feature without its key answers `UNAVAILABLE` with a hint; nothing is estimated or filled in.

## 3. Add your keys (once)

```sh
splice setup --init        # creates ~/.splice/.env with every variable name, no values
splice setup               # what works now, what each key unlocks, where to create it
```

Open the file, paste the keys you have after the `=` signs, save, and run `splice setup` again —
set keys show `✓ set` (values are never printed).

| OS | File |
| --- | --- |
| Windows | `%USERPROFILE%\.splice\.env` (`notepad $HOME\.splice\.env`) |
| macOS / Linux | `~/.splice/.env` (`nano ~/.splice/.env`) |

Keys in `~/.splice/.env` work from every folder. A `.env.local` or `.env` in the current folder (or
a parent) takes precedence, and real environment variables win over both. Only Splice's own
provider variable names are read from these files.

Free keys that unlock the most:

| Key | Unlocks | Where |
| --- | --- | --- |
| `CODEX_API_KEY` | every Robinhood Chain token: trending, new, gainers, holders, trades, charts | [dashboard.codex.io](https://dashboard.codex.io/signup) |
| `OPENROUTER_API_KEY` | `splice ask` / `splice chat` (AI agent over live data) | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `COINGECKO_API_KEY` | higher limits, Robinhood DEX pools and movers | [coingecko.com](https://www.coingecko.com/en/developers/dashboard) |
| `FINNHUB_API_KEY` | US company profiles, news, earnings, market status | [finnhub.io](https://finnhub.io/register) |
| `FRED_API_KEY` | US macro: Fed funds, CPI, yields, unemployment | [fred.stlouisfed.org](https://fredaccount.stlouisfed.org/apikeys) |
| `ALCHEMY_API_KEY` | faster RPC, token balances and transfers | [alchemy.com](https://dashboard.alchemy.com) |

The full list (Chainlink, Blockscout, GoPlus, Zerion, GitHub, Tavily, Exa, Firecrawl, Gemini…) is in
`splice setup` and [Environment variables](environment-variables.md). Check every configured
provider live with `splice providers`.

## 4. Use the features

### One-screen overview

```sh
splice dash                         # tokens, stocks, perps, DeFi, global, macro in one view
```

### Tokens on Robinhood Chain

```sh
splice tokens trending              # also: hot, new, gainers, losers, volume, mcap, txns, buyers
splice tokens gainers --window 1h   # windows: 1h, 4h, 12h, 24h
splice tokens search hood
splice tokens info PONS             # stats, links, pairs, recent trades, 24h chart
splice tokens trades PONS
splice tokens chart PONS --timeframe 1h
```

### Pools and movers

```sh
splice market trending              # trending pools; new, top
splice market gainers               # also: losers, volume, volume-drop, volume-up, liquidity, txns
splice market search robinhood
splice price ETH
```

Rankings print the formula they use under the table.

### Robinhood Stock Tokens and US markets

```sh
splice stock list
splice stock quote NVDA             # Robinhood, Chainlink, DEX, Codex, DefiLlama, Finnhub side by side
splice stock gainers                # also: losers, volume
splice stock profile NVDA
splice stock news TSLA
splice stock earnings
splice stock market                 # is the US market open
splice oracle price TSLA            # Chainlink prices; oracle candles TSLA --timeframe 1h
```

Sources are shown side by side and never averaged.

### Perps, DeFi, global, macro, news

```sh
splice perps                        # markets by volume; perps BTC, perps funding
splice defi protocols               # also: dexes, fees, yields, stablecoins, price
splice global coins                 # also: trending, stocks
splice macro                        # FRED overview; macro DGS10 for one series
splice news crypto
```

### Research and monitoring

```sh
splice report PONS                  # one-page token report with flags from GoPlus, Blockscout, Codex
splice tokens whales NVDA --min 5000   # large trades, net flow, most active wallets
splice compare PONS HOOKR           # 2–6 tokens side by side
splice radar                        # new tokens as they appear, each with a GoPlus check
splice watchlist add PONS perp:BTC  # then `splice watchlist` for live prices; remove to drop
splice watch PONS --above 0.5 --interval 30   # alerts: --above, --below, --change
splice watch whales NVDA --min 10000          # alert on large trades
```

### Wallets, contracts and blocks

```sh
splice wallet inspect 0x…           # balance, tokens, transfers, risk
splice contract inspect 0x…         # code, verified source, proxy
splice tx inspect 0x…
splice block latest
splice security token 0x…           # GoPlus token checks
```

### Web and GitHub

```sh
splice web search "Robinhood Chain docs"
splice web answer "What is the chain id of Robinhood Chain?"
splice github repo nodejs/node
```

### Output for scripts

Every data command accepts `--json` (full result with status and provenance) and `--fresh` (skip
the cache). Exit codes: `0` live, `3` unavailable, `1` error.

## 5. Ask anything

Needs `OPENROUTER_API_KEY`.

```sh
splice ask "Top 5 gainers on Robinhood Chain in the last 24 hours"
splice ask "What are NVDA and TSLA trading at on Robinhood Chain?"
splice chat                         # follow-up questions in one session
```

The agent calls Splice's read-only live data tools, shows each call with its source, and prints
the model and cost. Details: [Ask](ask.md).

## 6. Skills

Skills are versioned packages of tools with declared permissions that run in Splice's sandbox.

```sh
mkdir my-agent && cd my-agent
splice init
splice search robinhood
splice info @splice/robinhood       # versions, integrity, permissions, tools
splice add @splice/robinhood --accept-permissions
splice run robinhood.trending limit=5
splice verify @splice/robinhood
splice list
```

`splice add` downloads the artifact, checks its SHA-256 and size against the registry, validates
the package and only then installs it, recording version, hash and the permission grant in
`splice.lock`. Official skills: [Skills](skills.md).

## 7. Give it to an AI agent (MCP)

```sh
claude mcp add splice -- splice mcp --project /path/to/my-agent --data
```

`--data` adds every live data tool (tokens, stocks, perps, DeFi, global, macro, oracle, wallets,
web, GitHub) next to the installed skills. Claude Desktop, Cursor and Windows setups: [MCP](mcp.md).

## 8. Use it from code (SDK)

```ts
import { Splice, isLive } from "@spliceloom/sdk";

const splice = new Splice();
const trending = await splice.tokens.rank("trending", { limit: 10 });
if (isLive(trending)) console.log(trending.data, trending.provenance.source);
await splice.stocks.quote("TSLA");
await splice.run("robinhood.trending", { limit: 5 });
```

All namespaces: [SDK](sdk.md).

## Update, uninstall, troubleshooting

```sh
npm install -g @spliceloom/cli@latest    # update
npm uninstall -g @spliceloom/cli         # uninstall (user data stays in ~/.splice)
```

| Symptom | Fix |
| --- | --- |
| `splice: command not found` / not recognized | open a new terminal; check that `npm prefix -g` is on your PATH |
| `running scripts is disabled` (Windows) | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `splice.cmd` |
| `UNAVAILABLE … is not set` | add that key to `~/.splice/.env`; `splice setup` shows where to get it |
| A key is set but `splice setup` shows `· not set` | a `.env.local` in the current folder takes precedence; run from another folder or add the key there |
| `robinhood` source fails on `stock quote` | some ISP DNS filters block `*.robinhood.com`; other sources still answer |
| Quotes in PowerShell arguments | escape inner double quotes: `splice run json.parse 'text={\"ok\":true}'` |

## Next

- [Walkthrough](getting-started.md) of every lifecycle command
- [Write your first skill](creating-a-skill.md)
- [CLI reference](cli.md)
