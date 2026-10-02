# Environment variables

Splice reads configuration only from the variables listed here. Provider variables are read from the
process environment first, then from the file named by `SPLICE_ENV_FILE`, else the nearest
`.env.local` / `.env` (current folder or a parent), else `~/.splice/.env` (`SPLICE_HOME/.env`); no
other variable in those files is parsed. Values are never printed — `splice setup` shows only
whether each one is set.

```sh
splice setup --init                      # creates ~/.splice/.env (keys for every folder)
splice setup                             # what is set, what each key unlocks
splice setup --template > .env.local     # a per-project file instead
```

## CLI and registry

| Variable | Purpose |
| --- | --- |
| `SPLICE_REGISTRY` | Registry URL or alias (`local`, `production`) |
| `SPLICE_TOKEN` | Registry token (overrides the saved one) |
| `SPLICE_HOME` | Splice user folder (default `~/.splice`) |
| `SPLICE_MCP_TOKEN` | Bearer token for `splice mcp --http` (at least 24 characters) |
| `SPLICE_ENV_FILE` | Explicit provider env file |
| `NO_COLOR` | Disable colored output |

## Providers

| Variable | Provider | Without it |
| --- | --- | --- |
| `ALCHEMY_RPC_URL` or `ALCHEMY_API_KEY` | Alchemy RPC | other RPC providers answer |
| `QUICKNODE_RPC_URL` | QuickNode RPC | — |
| `GOLDSKY_API_KEY` | Goldsky Edge RPC (`gs_edge_…` key) | — |
| `ROBINHOOD_PUBLIC_RPC_URL` | Public RPC override; `off` disables it | the official public RPC is used |
| `BLOCKSCOUT_API_KEY` | Blockscout PRO (indexed data) | indexed sections are unavailable |
| `COINGECKO_API_KEY` | CoinGecko demo key | keyless prices; no DEX pools |
| `GOPLUS_APP_KEY` + `GOPLUS_APP_SECRET` | GoPlus authenticated access | anonymous access, lower limits |
| `ZERION_API_KEY` | Zerion portfolios | portfolio unavailable |
| `THEGRAPH_API_KEY`, `STREAMINGFAST_API_TOKEN` | The Graph gateway / Token API | subgraph queries unavailable |
| `OPENROUTER_API_KEY` | OpenRouter | AI unavailable unless Gemini is configured |
| `GEMINI_API_KEY` | Gemini | — |
| `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY` | Web search and extraction | web capabilities unavailable without one |
| `GITHUB_TOKEN` | GitHub (5,000 requests/hour, code search) | anonymous API, 60 requests/hour |

## Routing (not secret)

| Variable | Purpose |
| --- | --- |
| `AI_PROVIDER` | Default AI provider (`openrouter`) |
| `AI_DEFAULT_MODEL` | Default model for `AI_PROVIDER` |
| `GEMINI_DEFAULT_MODEL` | Default model when the Gemini provider is requested |
| `AI_FALLBACK_PROVIDER`, `AI_FALLBACK_MODEL` | Explicit AI fallback (both required) |
| `GITHUB_API_VERSION` | `X-GitHub-Api-Version` header (default `2022-11-28`) |

Sandboxed skills receive none of these. A skill gets an environment variable only if it declares it
in `permissions.env` and you grant it at install.
