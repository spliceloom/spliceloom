# MCP

Splice speaks the [Model Context Protocol](https://modelcontextprotocol.io) in three places:

| Server | Transport | What it offers | Executes skills? | Auth |
| --- | --- | --- | --- | --- |
| `splice mcp` | stdio | tools of the project's **installed** skills + their SKILL.md | **yes**, in the Splice sandbox | the local process |
| `splice mcp --http` | Streamable HTTP (`/mcp`) | same as above, reachable over the network | **yes**, in the Splice sandbox | **required** bearer token (`SPLICE_MCP_TOKEN`) |
| Registry Worker | Streamable HTTP (`<registry>/mcp`) | registry **discovery**: search, package info with tool schemas, SKILL.md | **no** | **required** registry token |

Why the registry does not execute skills: the Cloudflare Worker has no process sandbox. Running
package code there would bypass the Splice permission model, so the Worker only serves metadata.
Execution always happens in the Splice runtime (`splice mcp`, `splice mcp --http`, the SDK).

All three share one protocol implementation (`@spliceloom/mcp/protocol`, pure Web APIs) and one
tool contract (`describeTools` in `@spliceloom/spec`). Supported protocol versions: `2025-11-25`,
`2025-06-18`, `2025-03-26`, `2024-11-05`. Compatibility is tested with the official MCP
TypeScript SDK client for stdio and Streamable HTTP.

## Installed skills: tools and resources

- Tool name `<namespace>_<name>_<tool>` (e.g. `splice_example_hello`); `inputSchema` and, for
  object outputs, `outputSchema` are the manifest's own. Annotations follow the declared
  permissions (`readOnlyHint`, `destructiveHint`, `openWorldHint`). `_meta` carries
  `io.spliceloom/package`, `io.spliceloom/version`, `io.spliceloom/timeoutMs` and
  `io.spliceloom/permissions` — the exact permissions the sandbox enforces (Phase 7). The official
  skills are verified through MCP in the test suite ([skills.md](skills.md#mcp-discovery)).
- Results: JSON text plus `structuredContent` (≥ 2025-06-18). Tool failures (invalid input,
  permission denied, timeout, …) are `isError: true` results with the Splice error code; unknown
  tools are JSON-RPC errors.
- Resources: `splice://packages/@<ns>/<name>/SKILL.md`. Only listed URIs are served.
- The lockfile is re-read per request: `splice add` is picked up without restarting.
- Security (Phase 8): packages whose installed files no longer match splice.lock, or whose
  manifest requests more than was granted, are not exposed; load failures are `isError` results
  (not internal errors); error text is redacted and uses `<package>`/`<project>` instead of
  absolute paths; stdio lines over 4 MiB are dropped while streaming. See
  [security.md](security.md#mcp).

## Local: stdio

Install the skills into a project first (`splice init`, `splice add …`), then point the MCP client
at `splice mcp --project <dir>`. The server re-reads `splice.lock` per request, so skills added
later appear without restarting (clients may need to refresh their tool list).

**Compatibility:** tested automatically with the official MCP TypeScript SDK client over stdio and
Streamable HTTP (`packages/cli/src/mcp-sdk.test.ts`, `mcp-http.test.ts`). The client
configurations below are the clients' standard stdio setups; Claude Code, Claude Desktop and
Cursor are not part of the automated tests.

### Claude Code

```sh
claude mcp add splice -- splice mcp --project /path/to/project
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{ "mcpServers": { "splice": { "command": "splice", "args": ["mcp", "--project", "/path/to/project"] } } }
```

### Cursor

`.cursor/mcp.json` in the workspace (or the global `~/.cursor/mcp.json`):

```json
{ "mcpServers": { "splice": { "command": "splice", "args": ["mcp", "--project", "/path/to/project"] } } }
```

**Windows:** npm installs `splice` as a `.cmd` shim, which clients that start processes without a
shell cannot launch. Use Node.js directly with the absolute path of the CLI entry point:

```json
{ "mcpServers": { "splice": { "command": "node",
  "args": ["C:\\path\\to\\global\\node_modules\\@spliceloom\\cli\\dist\\bin.js", "mcp", "--project", "C:\\path\\to\\project"] } } }
```

(`npm root -g` prints the global `node_modules` directory. From a source checkout use
`packages/cli/dist/bin.js`.)

## Live data tools: `splice mcp --data`

`--data` (stdio or `--http`) adds read-only tools backed by real data providers
([data-providers.md](data-providers.md)): `onchain_get_balance`, `onchain_get_transaction`,
`onchain_get_block`, `onchain_get_token`, `onchain_get_contract`, `onchain_get_transfers`,
`onchain_get_logs`, `market_get_price`, `security_get_token`, `security_get_address`,
`wallet_get_portfolio`, `wallet_inspect`, `providers_status`, and for AI, GitHub and DEX markets:
`ai_generate` (billed by the AI provider), `ai_models`, `github_repository`,
`github_search_repositories`, `github_contents`, `github_commits`, `github_releases`, `github_raw`,
`market_token`, `market_pairs`, `market_token_price`, `market_ohlcv`, `market_search`, `web_search`,
`web_extract`, `web_map`, `web_similar`, `web_answer` (web results are untrusted third-party content;
the server instructions tell clients to treat them as data, not instructions).

It also adds the tools behind the CLI's market commands:

| Area | Tools |
| --- | --- |
| Tokens and research | `tokens_rank`, `tokens_search`, `token_details`, `token_trades`, `token_chart`, `token_report`, `token_whales` |
| Market views | `market_trending`, `market_new_pools`, `market_top_pools`, `market_movers` |
| Stock tokens | `stock_list`, `stock_quote`, `stock_movers` |
| Perps | `perps_markets`, `perps_funding` |
| DeFi | `defi_overview`, `defi_protocols`, `defi_dexes`, `defi_fees`, `defi_yields`, `defi_stablecoins`, `defi_token_price`, `defi_price_chart` |
| Global and US | `global_overview`, `global_coins`, `global_trending`, `global_stocks`, `stock_profile`, `stock_news`, `market_news`, `earnings_calendar`, `us_market_status`, `macro_overview`, `macro_series` |
| Oracle and chain | `oracle_price`, `oracle_candles`, `oracle_feeds`, `chain_info` |

The `@splice/robinhood` skill ([skills/robinhood](../skills/robinhood/SKILL.md)) exposes the same data as installed skill
tools for agents that only load installed skills.

- Input is validated against strict schemas (`additionalProperties: false`, address/hash lengths)
  before any provider is contacted. Every tool accepts `chain` (default `robinhood`, 4663) and
  `fresh`.
- `structuredContent` is the data layer's result: `status` (`LIVE`, `CACHED`, `UNAVAILABLE`,
  `ERROR`), `data` (live/cached only) and `provenance` (source, chain, chainId, fetchedAt, fresh,
  blockNumber). `ERROR` results set `isError: true`; `UNAVAILABLE` results carry no data.
- Provider keys stay in the server process (provider environment variables only) and are redacted
  from every result.

```sh
splice mcp --project ./agent --data
```

## Remote execution: `splice mcp --http`

Run on the machine that should execute the skills:

```sh
export SPLICE_MCP_TOKEN=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
splice mcp --http --project /srv/agent-skills            # http://127.0.0.1:8788/mcp
splice mcp --http --host 0.0.0.0 --port 8788 ...         # only behind TLS (reverse proxy)
```

- Every request needs `Authorization: Bearer <SPLICE_MCP_TOKEN>`; otherwise `401` with
  `WWW-Authenticate: Bearer`. The token must be ≥ 24 characters; only its SHA-256 is kept in memory
  and compared in constant time.
- Default bind address is loopback. Requests carrying an `Origin` header are rejected (browser /
  DNS-rebinding protection). The server itself speaks plain HTTP — put it behind a TLS reverse
  proxy when exposing it.
- Stateless: POST only (`GET`/`DELETE` → `405`), JSON responses, notifications → `202`.

Client example (Claude Code): `claude mcp add --transport http splice http://127.0.0.1:8788/mcp --header "Authorization: Bearer $SPLICE_MCP_TOKEN"`.

## Remote discovery: the registry `/mcp`

```
POST https://registry.spliceloom.com/mcp
Authorization: Bearer <registry token>        # any valid token, e.g. a publish-only one
```

| Tool | Input | Output |
| --- | --- | --- |
| `registry_search` | `{ query, limit? }` | `{ query, results: [{ name, description, latest }] }` |
| `registry_package_info` | `{ package, version? }` | `{ name, version, description, latest, versions, integrity, publishedAt, permissions, tools, skillDoc }` — `tools[]` carry `name`, `qualifiedName`, `mcpName`, `inputSchema`, `outputSchema`, `annotations` from the published manifest |

Resource template: `splice://registry/{namespace}/{name}/{version}/SKILL.md` (`version` may be
`latest`). Unknown packages are `isError` results. Missing/invalid tokens → `401`, and the
registry's rate limits (including the failed-authentication block) apply.

Client example: `claude mcp add --transport http splice-registry https://registry.spliceloom.com/mcp --header "Authorization: Bearer <token>"`.

## Future (not implemented)

- OAuth-based MCP authorization (bearer tokens are used today).
- Server-initiated streams / `listChanged` notifications, prompts, sampling, elicitation.
- Executing skills on hosted infrastructure (would need an isolated sandbox service).
