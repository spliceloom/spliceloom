# Host capabilities (capability broker)

A skill can use host capabilities — web search, market prices, Robinhood Chain data, GitHub data,
AI completions — without holding a key or opening a socket. It declares them in its manifest and
calls them through the **capability broker**; the Splice host runs each call with its own provider
configuration and hands back the result.

```json
"permissions": {
  "fs": { "read": [], "write": [] },
  "network": [],
  "env": [],
  "capabilities": ["web.search", "market.price"]
}
```

```ts
// tools/research.ts
export default async function research(input: { query: string }, ctx) {
  const results = await ctx.capability("web.search", { query: input.query, limit: 5 });
  const eth = await ctx.capability("market.price", { token: "ETH" });
  return { results, eth };
}
```

## How a call flows

```
tool (sandbox: no network, empty env)
  └─ ctx.capability(name, args) ── IPC ──► Splice host (SpliceRuntime)
                                             ├─ declared in permissions.capabilities?   else PERMISSION_DENIED
                                             ├─ call budget (25 / execution), ≤ 4 concurrent, args ≤ 256 KiB / 32 levels
                                             └─ broker (@spliceloom/data) ── validated args ──► data layer ──► real providers
  ◄──────────── result (LIVE / CACHED / UNAVAILABLE / ERROR with provenance, ≤ 4 MiB) ──────────────┘
```

- The check happens in the host process, not only in the tool: a package that writes to the IPC
  channel directly is refused the same way (tested).
- The host's provider keys are read only by the host (provider environment variables,
  `.env.local` / `.env`). The tool process keeps its empty environment and its network guard; a
  capability never widens `network`, `env` or `fs`.
- Arguments are validated against a strict schema per capability (`additionalProperties: false`)
  before any provider is contacted. Skills cannot bypass the cache or change AI fallback routing;
  `ai.generate` output is capped at 2,048 tokens (default 512) per call.
- Results are the data layer's own objects (see [data-providers.md](data-providers.md)): never an
  invented value. Without a broker (e.g. a custom runtime) calls answer `CAPABILITY_UNAVAILABLE`.

## Consent and lockfile

Capabilities are permissions: `splice info` lists them (billed ones are marked "may spend provider
credits/money"), `splice add` refuses them without `--accept-permissions`, and the grant is stored
in `splice.lock`. An installed package whose manifest later requests a capability that was not
granted is refused at load (`PERMISSIONS_NOT_GRANTED`). The `capabilities` key is omitted when
empty, so manifests, registry metadata and lockfiles of earlier packages are unchanged. MCP clients
see tools with capabilities as `openWorldHint: true`.

## Capabilities

| Capability | Arguments | Data layer call |
| --- | --- | --- |
| `onchain.balance` | `address` | native balance on Robinhood Chain (block-pinned) |
| `onchain.transaction` | `hash` | transaction + receipt |
| `onchain.block` | `block?` (`latest`, number, hash) | block |
| `onchain.token` | `address` | token composite (metadata, supply, holders, price, pools, security) |
| `onchain.contract` | `address` | contract composite |
| `onchain.transfers` | `address`, `limit?` | token transfers |
| `onchain.logs` | `address?`, `fromBlock?`, `toBlock?`, `topics?` | event logs |
| `market.price` | `token` (ETH or address), `network?`, `vs?` | CoinGecko / GeckoTerminal price |
| `market.token`, `market.pairs`, `market.pair` | `network`, `address` | DexScreener / GeckoTerminal |
| `market.ohlcv` | `network`, `pool`, `timeframe?`, `aggregate?`, `limit?` | GeckoTerminal candles |
| `market.trades` | `network`, `pool` | GeckoTerminal trades |
| `market.search` | `query` | DexScreener search |
| `security.token`, `security.address` | `address` | GoPlus |
| `wallet.portfolio` | `address` | Zerion |
| `web.search` | `query`, `limit?`, `content?`, `maxCharacters?`, `includeDomains?`, `excludeDomains?` | Tavily → Exa → Firecrawl |
| `web.extract` | `urls` (1–10), `maxCharacters?` | Tavily → Firecrawl → Exa |
| `web.map`, `web.similar` | `url`, `limit?` | Firecrawl/Tavily, Exa |
| `web.answer` | `query` | Tavily → Exa (with citations) |
| `github.repository` | `repo` | GitHub REST |
| `github.search` | `query`, `page?`, `perPage?` | repository search |
| `github.contents` | `repo`, `path?`, `ref?` | contents API |
| `github.commits` | `repo`, `ref?`, `path?`, `page?`, `perPage?` | commits |
| `github.releases` | `repo`, `release?`, `page?`, `perPage?` | releases / one release |
| `github.raw` | `url`, `maxBytes?` | raw.githubusercontent.com |
| `ai.generate` | `prompt`, `system?`, `model?`, `provider?`, `maxTokens?` (≤ 2048), `temperature?`, `responseSchema?` | OpenRouter / Gemini |
| `ai.models` | `provider?`, `search?` | model list |
| `tokens.rank` | `kind` (trending, hot, new, gainers, losers, volume, holders, mcap, txns, buyers), `window?`, `minLiquidity?`, `limit?` | Codex |
| `tokens.search` | `query`, `limit?` | Codex |
| `tokens.details` | `token` (symbol or address) | Codex (composite) |
| `tokens.whales` | `token`, `minUsd?` | Codex |
| `tokens.report` | `token` | Codex + GoPlus + Blockscout (report with flags) |
| `stock.quote` | `symbol`, `session?` | Robinhood, Chainlink, DEX, Codex, DefiLlama, Finnhub (composite) |
| `stock.list` | `search?` | Robinhood / CoinGecko |
| `perps.markets` | `venue?`, `type?`, `sort?`, `search?`, `limit?` | Lighter |
| `perps.funding` | `venue?`, `search?`, `limit?` | Lighter |
| `defi.overview`, `defi.protocols`, `defi.yields` | see the SDK (`splice.defi`) | DefiLlama |
| `global.overview` | — | CoinGecko, alternative.me, Chainlink (composite) |
| `macro.overview` | — | FRED |
| `equity.profile`, `equity.news` | `symbol`, `days?` | Finnhub |

Composite results (one section per source) reach skills with an overall `status`: `LIVE` when at
least one section is live, otherwise `UNAVAILABLE`.

Billed per call: `ai.generate` and every `web.*` capability.

## Official broker skills

| Package | Tools | Capabilities |
| --- | --- | --- |
| `@splice/web` | `web.search`, `web.read`, `web.answer` | `web.search`, `web.extract`, `web.answer` |
| `@splice/market` | `market.price`, `market.pairs`, `market.candles` | `market.price`, `market.pairs`, `market.ohlcv` |
| `@splice/onchain` | `onchain.balance`, `onchain.transaction`, `onchain.token` | `onchain.balance`, `onchain.transaction`, `onchain.token` |
| `@splice/robinhood` | `robinhood.trending`, `.rank`, `.token`, `.report`, `.whales`, `.stock`, `.perps`, `.funding`, `.defi`, `.markets` | `tokens.rank`, `tokens.details`, `tokens.report`, `tokens.whales`, `stock.quote`, `perps.markets`, `perps.funding`, `defi.overview`, `global.overview` |

Sources: `skills/web`, `skills/market`, `skills/onchain`, `skills/robinhood` (0.1.0).

## SDK

`new Splice()` attaches the data-layer broker automatically (created on first use). Pass
`broker: false` to disable it, or your own `CapabilityBroker` (`{ call({ package, tool, capability,
args }) }`) to serve capabilities differently. `createCapabilityBroker(data)` from
`@spliceloom/data` builds the default one.
