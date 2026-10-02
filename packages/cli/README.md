# @spliceloom/cli

The `splice` command. Live Robinhood Chain data — tokens, Robinhood Stock Tokens, perps, DeFi,
oracle prices, wallets — plus global and US markets, an AI agent that answers from that data with
sources, and verified *skills* (versioned tool packages with declared permissions) that run in a
sandbox and plug into AI agents over MCP.

Every value comes from a real provider and is labelled `LIVE`, `CACHED`, `UNAVAILABLE` or `ERROR`
with its source. Nothing is estimated or filled in; rankings print their formula.

## Install

Requires **Node.js 22.18+** ([nodejs.org](https://nodejs.org)).

```sh
npm install -g @spliceloom/cli
splice --version
```

Windows PowerShell: if scripts are disabled, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
once (then open a new terminal), or use `splice.cmd`.

The package name is scoped because the unscoped npm name `splice` belongs to an unrelated package;
the command is still `splice`.

## Works without keys

```sh
splice chain info           # Robinhood Chain, chain id verified live
splice perps                # perps on Robinhood (Lighter); splice perps funding
splice defi                 # TVL, DEX volume, fees, stablecoins (DefiLlama)
splice global               # crypto market, Fear & Greed, top coins
splice market trending      # trending pools; new, top, gainers, losers, volume, volume-drop
splice stock quote TSLA     # a Robinhood Stock Token from every source, side by side
```

## Add keys once

```sh
splice setup --init         # creates ~/.splice/.env with every variable name (no values)
splice setup                # what works, what each key unlocks, where to get it (free tiers)
```

Paste your keys into `~/.splice/.env` (Windows: `notepad $HOME\.splice\.env`). They work from every
folder; a project `.env.local` or real environment variables take precedence. Values are never
printed. Most useful free keys: `CODEX_API_KEY` (every Robinhood Chain token), `OPENROUTER_API_KEY`
(AI agent), `COINGECKO_API_KEY`, `FINNHUB_API_KEY` (US companies, news), `FRED_API_KEY` (macro).

## Features

```sh
splice dash                              # everything on one screen

splice tokens trending                   # hot, new, gainers, losers, volume, mcap, txns, buyers
splice tokens info PONS                  # stats, links, pairs, trades, chart
splice tokens whales NVDA --min 5000     # large trades and net flow
splice report PONS                       # token report with GoPlus / Blockscout / Codex flags
splice compare PONS HOOKR
splice radar                             # new tokens as they appear, with a security check
splice watchlist add PONS perp:BTC       # then: splice watchlist
splice watch PONS --above 0.5            # price alerts; splice watch whales <token>

splice stock list | quote NVDA | gainers | profile NVDA | news TSLA | earnings | market
splice oracle price TSLA                 # Chainlink; oracle candles TSLA --timeframe 1h
splice perps BTC
splice defi protocols | dexes | fees | yields | stablecoins
splice global coins | trending | stocks
splice macro                             # Fed funds, CPI, yields, unemployment (FRED)
splice news crypto

splice wallet inspect 0x… | contract inspect 0x… | tx inspect 0x… | security token 0x…
splice web search "…" | github repo owner/name
```

Data commands accept `--json` (full result with provenance) and `--fresh`. Exit codes: `0` live,
`3` unavailable, `1` error, `2` usage.

## Ask anything

```sh
splice ask "Top 5 gainers on Robinhood Chain in the last 24 hours"
splice ask "What are NVDA and TSLA trading at on Robinhood Chain?"
splice chat
```

The agent calls Splice's read-only live data tools, shows every call and its source, and prints the
model and cost (needs `OPENROUTER_API_KEY`).

## Skills

```sh
mkdir my-agent && cd my-agent
splice init
splice search robinhood
splice info @splice/robinhood            # permissions and tools
splice add @splice/robinhood --accept-permissions
splice run robinhood.trending limit=5
splice verify @splice/robinhood
```

On `splice add` the artifact is downloaded and verified (SHA-256 and size against the registry,
archive safety, package validity) before anything is extracted; packages that request permissions
need `--accept-permissions`, recorded in `splice.lock`. Tools run in a separate Node.js process per
call, limited to the declared files, hosts and capabilities.

| Command | Purpose |
| --- | --- |
| `splice init` | create `splice.json` |
| `splice search <query>` / `splice info <pkg>` | discover packages |
| `splice add <pkg>[@range]` / `splice remove <pkg>` | install / uninstall |
| `splice install` | install exactly what `splice.lock` records |
| `splice outdated` / `splice update` | newer versions within your ranges |
| `splice verify <pkg>[@version]` | verify a published version and the installed copy |
| `splice list` / `splice run <pkg>.<tool>` | installed packages / execute a tool |
| `splice publish [dir]` | publish a skill (needs `splice login`) |

## MCP

```sh
claude mcp add splice -- splice mcp --project /path/to/my-agent --data
```

Installed skills plus, with `--data`, every live data tool become available to Claude Code, Claude
Desktop, Cursor or any MCP client. `splice mcp --http` serves the same over Streamable HTTP with a
required bearer token (`SPLICE_MCP_TOKEN`).

## Update and uninstall

```sh
npm install -g @spliceloom/cli@latest
npm uninstall -g @spliceloom/cli         # user data stays in ~/.splice
```

`splice <command> --help` shows every option. Full docs:
https://docs.spliceloom.com/quickstart

## Registry

Default: `https://registry.spliceloom.com`. Override with `--registry <url>`,
`SPLICE_REGISTRY`, `"registry"` in `splice.json` or `splice config set registry <url>`.

## Security notes

SHA-256 verification proves that you received the bytes the registry recorded — **not** who wrote
them; package signing is not implemented yet. The sandbox is a strong guardrail, not OS-level
isolation. Market data is not financial advice.

## License

MIT
