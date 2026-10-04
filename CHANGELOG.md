# Changelog

Notable changes to the `splice` CLI (`@spliceloom/cli`) and the public registry. Official skills
are versioned independently in the registry; their versions are listed per release.

## Website — 2026-10-04

New tools on spliceloom.com ([docs](docs/web-tools.md)); no CLI release needed.

- [/token](https://spliceloom.com/token): a live terminal for $SPLICE with 1m–1D candles, price from the pool's on-chain
  reserves, trades read from swap events, top holders, burns and an on-chain transparency panel.
- [/stocks](https://spliceloom.com/stocks): stock token premiums and discounts against Robinhood's quote, or the last close
  when the market is shut.
- [/screener](https://spliceloom.com/screener): newest pools with GoPlus security flags.
- [/wallet](https://spliceloom.com/wallet): holdings, values and transfers of any address.
- [/explain](https://spliceloom.com/explain): a contract's verified interface explained in plain English.
- Holder access on [/ask](https://spliceloom.com/ask): sign a message with a wallet holding 100,000+ $SPLICE for 50 questions a day.
- [/widgets](https://spliceloom.com/widgets): an embeddable live $SPLICE card.
- Telegram bot webhook in the public API (/splice, /tvl, /stock, /check, /ask).

## 0.3.0 — 2026-10-04

**Package signing**
- Publishers sign versions with Ed25519 keys registered for their namespace: `splice keys
  generate | list | register | revoke`, `splice publish --sign`, `splice sign <pkg@version> [--dir]`.
- Every install verifies signatures locally and refuses a signature that does not match the
  artifact. `--require-signed` refuses unsigned versions; the signer is pinned in `splice.lock`
  (`signedBy`) and a different signer is refused unless `--allow-signer-change`.
- `splice info` and `splice verify` show the signature status. All official `@splice` skills are
  signed with `ed25519:b44a06b812345ce6`. See [docs/signing.md](docs/signing.md).

**Alerts**
- `splice watch`, `splice watch whales` and `splice radar` take `--notify discord,telegram` and
  deliver each alert to a Discord webhook and/or a Telegram bot (`DISCORD_WEBHOOK_URL`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

**Framework adapters**
- New package [`@spliceloom/adapters`](docs/adapters.md) 0.1.0: Splice tools for OpenAI (Chat
  Completions and Responses), the OpenAI Agents SDK, LangChain and the Vercel AI SDK.

**Website**
- [spliceloom.com/live](https://spliceloom.com/live) (Robinhood Chain right now),
  [/ask](https://spliceloom.com/ask) (the agent in the browser) and
  [/token](https://spliceloom.com/token) ($SPLICE read live from the chain), served by a public API
  at `api.spliceloom.com`.

SDK: `@spliceloom/sdk` 0.2.0 (`requireSigned`, `allowSignerChange`, `signedBy` on install results).

## 0.2.1 — 2026-10-03

- Fix (Windows): tools could report `PATH_OUTSIDE_SANDBOX` for paths inside their sandbox when the
  project directory was reached through a Windows 8.3 short name (such as `RUNNER~1`), a junction or a
  symlink. The runtime now resolves the project root to its canonical path before granting
  permissions.
- The TypeScript SDK is published as [`@spliceloom/sdk`](https://www.npmjs.com/package/@spliceloom/sdk) 0.1.0.
- npm package metadata: repository, homepage and issue links.

## 0.2.0 — 2026-10-02

Live market data, research tools and an AI agent over them.

**Data**
- `splice tokens` — every Robinhood Chain token from Codex: trending, hot, new, gainers, losers,
  volume, holders, market cap, transactions, buyers; `search`, `info`, `trades`, `chart`, `whales`.
- `splice stock` — Robinhood Stock Tokens: list, quote from every source side by side (Robinhood,
  Chainlink, DEX, Codex, DefiLlama, Finnhub), movers; US company profile, news, earnings, market status.
- `splice oracle` — Chainlink prices and candles (Data Streams when subscribed, else Candlestick).
- `splice perps` — Lighter markets and funding on Robinhood Chain (and mainnet).
- `splice defi` — DefiLlama TVL, protocols, DEX volume, fees, yields, stablecoins, prices.
- `splice global`, `splice macro`, `splice news` — crypto market, Fear & Greed, US stocks, FRED
  series, Finnhub headlines.
- `splice market trending | new | top | gainers | losers | volume | volume-drop | volume-up` — pools
  with the ranking formula printed under each table.

**Research and monitoring**
- `splice dash`, `splice report`, `splice compare`, `splice radar`, `splice watch` (price and
  large-trade alerts), `splice watchlist`.

**AI**
- `splice ask` and `splice chat` — an agent that answers from the read-only data tools and prints
  every tool call, its source, the model and the cost.

**Platform**
- `splice setup --init` creates `~/.splice/.env`; keys there work from every directory.
- 16 new host capabilities for skills (`tokens.*`, `stock.*`, `perps.*`, `defi.*`, `global.overview`,
  `macro.overview`, `equity.*`); MCP `--data` now serves 70 tools; SDK namespaces `tokens`,
  `research`, `stocks`, `perps`, `defi`, `global`, `equities`, `news`, `macro`, `oracle`.
- Default registry: `https://registry.spliceloom.com`.

**Skills:** `@splice/robinhood` 0.1.0 (new).

## 0.1.0 — 2026-10-02

First public release of the `splice` CLI.

- Registry workflow: `init`, `search`, `info`, `add`, `install`, `outdated`, `update`, `verify`,
  `remove`, `list`, `run`, `publish`, `login`.
- Verification before install (SHA-256, size, archive safety, package validity, provenance);
  immutable versions; reproducible installs from `splice.lock`; offline installs from the verified
  cache.
- Sandboxed runtime: one Node.js process per tool call, limited to declared files, hosts,
  environment variables and host capabilities.
- MCP servers: `splice mcp` (stdio) and `splice mcp --http` (Streamable HTTP, bearer token); registry
  discovery over MCP.
- Live data for Robinhood Chain (4663): chain, blocks, transactions, wallets, contracts, logs,
  prices, security, DEX markets, AI, GitHub and web search, each with provenance.

**Skills:** `@splice/json` 0.1.1, `@splice/http` 0.1.0, `@splice/files` 0.1.1, `@splice/github`
0.1.0, `@splice/web` 0.1.0, `@splice/market` 0.1.0, `@splice/onchain` 0.1.0.
