# CLI

```
splice <command> [options]
```

## Install

```sh
npm install -g @spliceloom/cli     # Node.js >= 22.18; installs the `splice` command
```

Install it with `npm install -g @spliceloom/cli` (Node.js >= 22.18), or use a local tarball
([releasing.md](releasing.md#local-installation-test)) or `npm link -w @spliceloom/cli` from a
source checkout. The unscoped npm name `splice` belongs to an unrelated package, hence the scope.
New to Splice? Start with [getting-started.md](getting-started.md).

## Commands

| Command | Description |
| --- | --- |
| `splice init [dir]` | Create `splice.json` (only). No-op if the project exists. `splice.lock` is created by the first install. |
| `splice search <query> [--limit n]` | Search package names and descriptions. |
| `splice info <package>[@range]` | Show versions, integrity, permissions and tools. |
| `splice add <package>[@range] [...] [--accept-permissions]` | Resolve, download, verify and install. With a range, a locked version that satisfies it is kept. Packages requesting permissions need `--accept-permissions`. |
| `splice install [--accept-permissions]` | Install exactly what `splice.lock` records (fail closed on mismatch; offline from the verified cache). See [lifecycle.md](lifecycle.md). |
| `splice outdated [package ...]` | Current (locked), wanted (newest in range) and latest versions. Read-only. |
| `splice update [package ...] [--accept-permissions]` | Update within the `splice.json` ranges; atomic, the previous version is kept on failure. Exit 1 when a range matches nothing. |
| `splice verify <package>[@version] [--json]` | Verify a published version (SHA-256, size, package, metadata, signature status, provenance, direct URL, installed copy). Exit 1 on failure. See [trust.md](trust.md). |
| `splice remove <package> [...]` | Uninstall and update `splice.json` / lockfile. |
| `splice list` | List installed packages and their status. |
| `splice run <pkg>.<tool> [key=value ...] [--input json]` | Execute a tool in the sandbox. |
| `splice publish [dir] [--dry-run]` | Validate, pack and publish a skill ([publishing.md](publishing.md)). |
| `splice login [--token t]` | Verify and save a registry token (hidden prompt or stdin). |
| `splice logout` | Remove the saved token for the current registry. |
| `splice whoami` | Show the user and owned namespaces for the saved token. |
| `splice config [list\|get\|set\|unset] registry [value]` | Manage the user default registry. |
| `splice token list \| create [--label] [--namespace ns]... [--expires 90d] \| revoke <id>` | Manage your registry tokens ([auth.md](auth.md#self-service-tokens-cli)). |
| `splice namespace info \| add-maintainer \| remove-maintainer <ns> [user]` | Namespace owner and maintainers. |
| `splice mcp [--project dir]` | Serve installed skills to AI agents over MCP stdio ([mcp.md](mcp.md)). |
| `splice mcp --http [--port 8788] [--host 127.0.0.1]` | Same over Streamable HTTP; requires `SPLICE_MCP_TOKEN`. |
| `splice mcp --data` | Also expose the live data tools ([data-providers.md](data-providers.md)). |

### Live data commands

Real provider data for Robinhood Chain mainnet (4663, the only supported chain). Every
result is shown as `● LIVE`, `○ CACHED` (not live; `--fresh` refetches), `– UNAVAILABLE` or
`✗ ERROR`, with its provider and block. Keys come from provider environment variables only; see
[data-providers.md](data-providers.md).

| Command | Description |
| --- | --- |
| `splice providers [--chain c]` | Live health check of every provider: status, latency, chain ids, capabilities, last error. |
| `splice chain list \| info [chain]` | Chains; `info` verifies `eth_chainId` live and reports the head block. |
| `splice block latest \| get <number\|hash>` | Blocks. |
| `splice tx inspect <hash>` | Transaction + receipt, Blockscout view, call trace. |
| `splice wallet inspect \| balances \| transfers \| portfolio <address> [--limit n]` | Wallet data. |
| `splice token inspect <address>` | Metadata, supply, holders, price, pools, security. |
| `splice contract inspect <address>` | Bytecode, verified source/ABI, EIP-1967 proxy, counters. |
| `splice logs query [--address a] [--from-block n] [--to-block n] [--topic t]...` | Event logs (≤ 2000 blocks). |
| `splice price <ETH\|token> [--vs usd]` | CoinGecko price; unlisted tokens are UNAVAILABLE. |
| `splice security token \| address \| approvals <address>` | GoPlus reports. |
| `splice setup [--init] [--template]` | What works without keys, which provider keys unlock more and where to get them; `--init` creates `~/.splice/.env` (keys for every folder, never overwritten); `--template` prints a `.env.local` template (names only). |
| `splice provider list \| health` | Registered providers with configuration state (no requests) / live health. |
| `splice ask "<question>" [--model id] [--json]` | AI agent over live data: the model calls Splice's read-only tools (markets, stock tokens, oracle prices, wallets, chain, web, GitHub), shows each call and answers with its sources and cost. See [ask.md](ask.md). |
| `splice chat` | Interactive conversation with the same agent. |
| `splice agent run <pkg> "<task>"`, `splice agent info <pkg>` | Run an installed [agent package](agents.md): the model gets only the tools of the skills the agent lists. |
| `splice ai models [--search q]` | Real model list (OpenRouter; Gemini when configured). |
| `splice ai generate "<prompt>" [--model id] [--provider p] [--system s] [--max-tokens n] [--schema file]` | Real completion with usage and requested/actual provider and model. Billed by the provider. |
| `splice github repo \| contents \| tree \| commits \| branches \| releases \| release \| issues \| pulls <owner/repo>` | GitHub REST API (token or anonymous), read-only. |
| `splice github search \| code "<query>"`, `splice github user [login]`, `splice github raw <url>` | Search, code search (token), users, public raw files. |
| `splice market token \| pairs \| price \| quotes <network> <address>` | DEX market data (DexScreener, GeckoTerminal, CoinGecko). |
| `splice market pair \| ohlcv \| trades <network> <pool>`, `splice market search \| networks` | Pools, candles, trades, discovery. |
| `splice market trending \| new \| top [network] [--window w] [--sort volume\|txns]` | Pool lists as tables; network defaults to `robinhood`. |
| `splice market gainers \| losers \| volume \| volume-drop \| volume-up \| liquidity \| txns [network] [--window 1h\|6h\|24h] [--min-liquidity usd]` | Rankings computed from the providers' pool fields, with the formula printed. See [stock-tokens.md](stock-tokens.md#market-rankings). |
| `splice stock list \| quote <SYMBOL> \| gainers \| losers …` | Robinhood Stock Tokens: list, per-source quotes, rankings. See [stock-tokens.md](stock-tokens.md). |
| `splice tokens trending \| hot \| new \| gainers \| losers \| volume \| holders \| mcap \| txns \| buyers`, `splice tokens search \| info \| trades \| chart` | Every Robinhood Chain token from Codex. See [markets.md](markets.md). |
| `splice global [coins \| trending \| sentiment \| stocks]`, `splice dash` | Global crypto market, Fear & Greed, US stocks; one-screen dashboard. |
| `splice perps [markets \| gainers \| losers \| oi \| spot \| funding \| <SYMBOL>] [--venue robinhood\|mainnet]` | Perps on Robinhood (Lighter), funding vs CEXes. |
| `splice stock profile \| news \| earnings \| market`, `splice news [topic]`, `splice macro [FRED_ID]` | US companies, news, earnings, market status (Finnhub); US macro (FRED). |
| `splice defi [overview] \| protocols \| dexes \| fees \| yields \| stablecoins \| price <token>` | Robinhood Chain DeFi from DefiLlama: TVL, protocols, DEX volume, fees, stablecoins, yields, token prices. |
| `splice oracle feeds [query] \| price <SYMBOL> [--session s]` | Chainlink Data Streams catalog and decoded prices (subscribed keys). |
| `splice web search \| answer "<query>"`, `splice web extract <url>...`, `splice web map \| similar <url>` | Web search, page text, site maps, similar pages, cited answers (Tavily, Exa, Firecrawl). |

Options: `--chain <key|id>`, `--fresh` (bypass the cache), `--json`; `ai`: `--model`, `--provider`, `--system`, `--max-tokens`, `--temperature`, `--schema`, `--no-fallback`, `--search`; `github`: `--ref`, `--page`, `--per-page`, `--state`, `--max-bytes`; `market`: `--vs`, `--timeframe`, `--aggregate`, `--limit`; `web`: `--provider`, `--limit`, `--content`, `--max-chars`, `--include-domain`, `--exclude-domain`. Exit codes for these commands:
`0` live or cached, `3` unavailable, `1` provider error, `2` invalid input.

## Global options

| Option | Meaning |
| --- | --- |
| `--registry <url\|alias>` | Registry for this invocation. Aliases: `local` (`http://127.0.0.1:8787`), `production` (`https://registry.spliceloom.com`). |
| `--json` | Machine-readable JSON on stdout. |
| `--no-color` | Disable ANSI colors (also honoured: `NO_COLOR`). |
| `-h, --help` | Help for the CLI or a command (`splice run --help`, `splice help run`). |
| `-v, --version` | Print the CLI version. |

Registry precedence: `--registry` → `SPLICE_REGISTRY` → `splice.json` `registry` →
`~/.splice/config.json` (`splice config set registry …`) → `https://registry.spliceloom.com`
(the live production registry). For a local registry: `splice config set registry local`.

Environment: `SPLICE_REGISTRY`, `SPLICE_TOKEN` (overrides the saved token), `SPLICE_HOME`
(default `~/.splice`), `NO_COLOR`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Operation failed: package not found, no matching version, registry unreachable, integrity mismatch, lockfile mismatch, tool error, not in a project, not logged in, rejected token, forbidden namespace, version already published, rate limited, … |
| `2` | Invalid usage: unknown command/option, missing argument, malformed package name, range or registry URL. |

## Package references

- `@splice/example` — latest stable version (saved as `^<version>` in `splice.json`).
- `@splice/example@0.1.0` — exact version.
- `@splice/example@^0.1.0`, `@splice/example@~0.1.0`, `@splice/example@*`.

## Tool references

- `example.hello` — short form, resolved among installed packages by name.
- `@splice/example.hello` — full form; required when two installed packages share a name.

## Tool input

```sh
splice run example.hello name=Dim excited=true
splice run example.hello --input '{"name":"Dim","excited":true}'
splice run example.hello --input '{"name":"Dim"}' excited=true   # pairs override --input
```

`key=value` values are coerced using the tool's input schema: `string` properties stay strings,
`number`/`integer`/`boolean` are converted, untyped properties are parsed as JSON when possible.

Output: the tool's JSON output on stdout; tool logs on stderr, prefixed with the tool name.
With `--json`, stdout contains the full result envelope:

```json
{ "ok": true, "package": "@splice/example", "tool": "hello",
  "output": { "message": "Hello, Dim!" }, "logs": "", "durationMs": 118 }
```

On failure `ok` is `false` and `error` holds `{ code, message, details? }`
(codes: `INVALID_INPUT`, `INVALID_OUTPUT`, `TOOL_NOT_FOUND`, `PERMISSION_DENIED`,
`TOOL_LOAD_FAILED`, `TOOL_ERROR`, `TIMEOUT`, `OUTPUT_TOO_LARGE`, `TOOL_CRASHED`).

## Example session

```
$ splice search example
@splice/example
Official example skill: greetings and text statistics. No external APIs.
latest: 0.1.1

$ splice add @splice/example
Resolving @splice/example...
Downloading @splice/example@0.1.1...
Verifying sha256-6da7…...
Installing .splice/packages/@splice/example...
Installed @splice/example@0.1.1
  permissions: none (sandboxed: no file, network or environment access)
  tools: example.hello, example.stats

$ splice list
@splice/example  0.1.1

$ splice run example.hello name=Dim
{
  "message": "Hello, Dim."
}

$ splice outdated
Package          Current  Wanted  Latest  Range
@splice/example  0.1.1    0.1.1   0.1.1   ^0.1.1  up to date

All packages are up to date within their ranges.
```

`--json` output of `add`/`install`: `[{ name, version, integrity, alreadyInstalled,
previousVersion, fromCache, offline, permissions, tools }]` (`fromCache`/`offline` added in
Phase 6; existing fields unchanged).
