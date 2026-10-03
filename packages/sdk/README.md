# @spliceloom/sdk

The TypeScript SDK for **Splice** — the composable layer for autonomous agents. Search, verify,
install and run sandboxed skills, and read live Robinhood Chain and market data with provenance,
from your own application or agent. The `splice` CLI is built on this SDK.

```sh
npm install @spliceloom/sdk      # Node.js 22.18+, zero runtime dependencies
```

## Skills

```ts
import { Splice } from "@spliceloom/sdk";

const splice = new Splice({ project: "./agent" });   // registry: https://registry.spliceloom.com

await splice.init();                                   // creates splice.json if missing
await splice.add("@splice/json");                      // download, verify SHA-256, validate, install
const tools = await splice.tools("@splice/json");      // schemas from the published manifest

const result = await splice.run("json.parse", { text: '{"hello":"world"}' });
if (result.ok) console.log(result.output);
else console.error(result.error.code, result.error.message);   // tool failures never throw
```

Every tool runs in its own Node.js process, limited to the files, hosts, environment variables and
host capabilities the package declares. Packages that request permissions need
`{ acceptPermissions: true }` (or a callback) on `add`.

## Live data

```ts
import { Splice, isLive } from "@spliceloom/sdk";

const splice = new Splice();

const trending = await splice.tokens.rank("trending", { limit: 10 });   // every Robinhood Chain token
if (isLive(trending)) console.log(trending.data, trending.provenance.source, trending.provenance.fetchedAt);
else console.log(trending.status, trending.code);                      // UNAVAILABLE / ERROR — never invented

await splice.stocks.quote("TSLA");          // Robinhood, Chainlink, DEX, Codex, DefiLlama, Finnhub — side by side
await splice.perps.markets({ sort: "oi" }); // Lighter on Robinhood Chain
await splice.defi.overview();               // DefiLlama
await splice.onchain.balance("0x…");        // RPC, pinned to a block
await splice.research.report("PONS");       // flags from GoPlus, Blockscout, Codex
```

Namespaces: `onchain`, `market`, `security`, `wallet`, `tokens`, `research`, `stocks`, `perps`,
`defi`, `global`, `equities`, `news`, `macro`, `oracle`, `ai`, `github`, `web`, `providers`.

Provider keys are read only from their environment variables (the `env` option, the process
environment, then `.env.local` / `.env` in the project, else `~/.splice/.env`). Many sources need no
key (public Robinhood Chain RPC, DexScreener, GeckoTerminal, DefiLlama, Lighter, CoinGecko).

## Docs

- SDK reference: https://docs.spliceloom.com/sdk
- Live data providers: https://docs.spliceloom.com/data-providers
- Security model: https://docs.spliceloom.com/security
- Source: https://github.com/spliceloom/spliceloom

SHA-256 verification proves integrity; publisher signatures (`{ requireSigned: true }` on `add`) prove
which registered key signed a version; the sandbox is a
strong guardrail, not OS-level isolation. Market data is not financial advice.

## License

MIT
