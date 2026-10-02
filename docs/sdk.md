# Splice SDK (`@spliceloom/sdk`)

TypeScript API for applications and agents: search the registry, install packages, load skills,
discover tools and execute them in the Splice sandbox — without shelling out to the CLI. The CLI
itself is built on this SDK.

> Package name: `@spliceloom/sdk` (the npm scope of this repository). `@splice/...` is the
> namespace of *skill packages* inside the Splice registry, not an npm scope.

## Install

Inside this monorepo the SDK is a workspace package (`npm install && npm run build`). It has no
runtime dependencies beyond the other `@spliceloom/*` packages and needs Node.js ≥ 22.18.

## Quick start

```ts
import { Splice } from "@spliceloom/sdk";

const splice = new Splice({ registry: "https://registry.spliceloom.com", project: "./agent-workspace" });

await splice.init();                                   // creates splice.json if missing
const found = await splice.search("example");          // [{ name, description, latest }]
const info = await splice.info("@splice/example");     // registry metadata + tool descriptors
await splice.add("@splice/example");                   // download, verify SHA-256, validate, install

const skill = await splice.load("@splice/example");
const result = await skill.run("example.hello", { name: "Dim" });
if (result.ok) console.log(result.output);             // { message: "Hello, Dim." }
else console.error(result.error.code, result.error.message);
```

## Configuration

```ts
new Splice({
  registry?: string;   // URL or alias ("local", "production")
  project?: string;    // directory with (or for) splice.json; default process.cwd()
  token?: string;      // registry token for publish/whoami; default SPLICE_TOKEN or `splice login`
  env?: NodeJS.ProcessEnv; // resolution + env passed (filtered by permissions) to tools
  fetch?: FetchLike;   // custom fetch
  cache?: string | false; // local artifact cache dir; default <SPLICE_HOME>/cache/artifacts, false = off
  resolver?, packages?, loader?, runtime?  // replace components (see Interfaces)
});
```

The SDK contains no registry URL. Without `registry`, it resolves exactly like the CLI:
`SPLICE_REGISTRY` → `splice.json` `"registry"` → `~/.splice/config.json` → the default configured
in `@spliceloom/core`.

## API

| Method | Returns | Notes |
| --- | --- | --- |
| `search(query, { limit? })` | `SearchResult[]` | |
| `info(ref)` | `{ package, version, tools }` | `ref` may include a range; `tools` are descriptors from the published manifest |
| `resolve(ref)` | `{ id, version }` | highest version matching the range |
| `init()` | `{ root, created }` | |
| `add(ref, { onStep?, acceptPermissions? })` | `AddResult` | verifies before installing; never executes package code; packages requesting permissions need `acceptPermissions: true` or a callback `(requested, pkg) => boolean`; with a range, a satisfying locked version is kept |
| `install({ onStep?, acceptPermissions? })` | `AddResult[]` | installs exactly what `splice.lock` records; `LOCK_MISMATCH` when the registry differs; offline from the verified cache (`offline: true`) |
| `outdated(ids?)` | `OutdatedPackage[]` | `{ id, range, current, wanted, latest, status }` — read-only |
| `update(ids?, { onStep?, acceptPermissions? })` | `UpdateResult[]` | `{ id, range, from, to, latest, status: "updated" \| "up-to-date" \| "no-match" }`; atomic per package, the previous version is kept on failure |
| `verify(ref)` | `VerificationReport` | `{ package, version, verified, publisher, publishedAt, artifact, provenance, checks[] }` — verification failures are `verified: false`, not exceptions |
| `remove(id)` | `{ id, version }` | |
| `list()` | `InstalledPackage[]` | with `ok` / `missing` / `invalid` status |
| `load(ref)` | `Skill` | `@ns/name` or unambiguous short name |
| `tools(ref?)` | `ToolDescriptor[]` | every tool of every installed package, or only those of `ref` (`@splice/json` / `json`) |
| `run("example.hello", input)` | `ToolResult` | shortcut for `load` + `skill.run` |
| `publish(dir, { dryRun?, onStep? })` | `PublishResult` | requires a token unless `dryRun` |
| `whoami()` | `WhoamiResponse` | |
| `registry()` / `registryUrl()` | `RegistryClient` / `string` | low-level registry client |
| `runtime()` | `SkillRuntime` | the runtime loaded skills use |

`Skill`: `id`, `version`, `manifest`, `dir`, `tools`, `tool(name)` (accepts `hello`,
`example.hello`, `@splice/example.hello` or the MCP name), `run(name, input)`.

### Tool descriptors

`ToolDescriptor` (from `describeTools(manifest)` in `@spliceloom/spec`) is the one contract used by
the SDK, the MCP servers and the registry's MCP endpoint:

```ts
{ package, version, tool, name, qualifiedName, mcpName, description,
  inputSchema, outputSchema?, permissions, annotations: { readOnlyHint, destructiveHint, openWorldHint }, timeoutMs }
```

Schemas are exactly the manifest's; nothing is inferred.

### Results and errors

- `skill.run` / `splice.run` **never throw for tool failures**; they return
  `{ ok: false, error: { code, message, details? } }` with codes such as `INVALID_INPUT`,
  `INVALID_OUTPUT`, `TOOL_NOT_FOUND`, `PERMISSION_DENIED`, `TOOL_ERROR`, `TIMEOUT`,
  `RUNTIME_UNSUPPORTED`.
- Registry/project operations throw `CoreError` with a `code` (`PACKAGE_NOT_FOUND`,
  `NO_MATCHING_VERSION`, `INTEGRITY_MISMATCH`, `LOCK_MISMATCH`, `INVALID_PACKAGE`, `NOT_INSTALLED`,
  `NOT_A_PROJECT`, `NOT_LOGGED_IN`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, …), a message
  and often a `hint`. Invalid package names throw `SpecError`.

## Live data

`splice.onchain`, `splice.market`, `splice.security` and `splice.wallet` query real providers for
Robinhood Chain (4663 by default) through `@spliceloom/data` ([data-providers.md](data-providers.md)):

```ts
import { Splice, isLive } from "@spliceloom/sdk";

const splice = new Splice();
await splice.onchain.balance("0x…");          // native balance, pinned to a block
await splice.onchain.transaction("0x…");      // tx + receipt
await splice.onchain.block("latest");
await splice.onchain.token("0x…");            // composite: metadata, supply, holders, price, pools, security
await splice.onchain.contract("0x…");         // composite: code, verified source, proxy, counters
await splice.onchain.transfers("0x…", { limit: 25 });
await splice.onchain.logs({ address: "0x…", fromBlock: "77165000", toBlock: "77165100" });
await splice.market.price("ETH");
await splice.security.token("0x…");
await splice.wallet.portfolio("0x…");

const r = await splice.market.price("ETH", { fresh: true });
if (isLive(r)) console.log(r.data.price, r.provenance.source, r.provenance.fetchedAt);
else console.log(r.status, r.code); // UNAVAILABLE / ERROR — never a substituted value
```

Tokens, research, stock tokens, perps, DeFi, global and US data use the same result format:

```ts
await splice.tokens.rank("trending", { limit: 10 });         // every Robinhood Chain token (Codex)
await splice.tokens.rank("gainers", { window: "h1" });       // also: hot, new, losers, volume, holders, mcap
await splice.tokens.details("PONS");                         // stats, links, pairs, trades, 24h chart
await splice.tokens.whales("NVDA", { minUsd: 5000 });        // large trades, net flow, wallets
await splice.research.report("PONS");                        // flags from GoPlus, Blockscout, Codex
await splice.stocks.quote("TSLA");                           // Robinhood, Chainlink, DEX, Codex, DefiLlama, Finnhub
await splice.perps.markets({ sort: "oi" });                  // Lighter on Robinhood Chain
await splice.perps.funding({ search: "BTC" });
await splice.defi.overview();                                // TVL, DEX volume, fees, stablecoins (DefiLlama)
await splice.global.overview();                              // crypto, Fear & Greed, top coins, US stocks
await splice.equities.profile("NVDA");                       // Finnhub
await splice.macro.overview();                               // FRED
await splice.oracle.candles("ETH", { timeframe: "1h" });     // Chainlink Candlestick
```

AI, GitHub and DEX market data use the same result format:

```ts
const answer = await splice.ai.generate({ prompt: "Summarize EIP-1967 in one sentence", maxTokens: 80 });
if (isLive(answer)) console.log(answer.data.text, answer.data.usage, answer.data.routing); // requested vs. actual provider/model
await splice.ai.models({ search: "gpt-4o" });

await splice.github.repository("nodejs/node");
await splice.github.searchRepositories("language:typescript stars:>10000", { perPage: 10 });
await splice.github.contents("nodejs/node", "README.md", { ref: "main" });
await splice.github.commits("nodejs/node", { perPage: 5 });
await splice.github.raw("https://raw.githubusercontent.com/nodejs/node/main/README.md");

await splice.market.pairs("robinhood", "0x…");          // DexScreener → GeckoTerminal
await splice.market.token("solana", "So111…");           // provider network ids work too
await splice.market.tokenPrice("eth", "0x…");
await splice.market.ohlcv("robinhood", "0x<pool>", { timeframe: "hour", aggregate: 4, limit: 48 });
await splice.market.quotes("robinhood", "0x…");          // one section per provider, never merged
await splice.ai.generate({ provider: "gemini", prompt: "…" }); // GEMINI_DEFAULT_MODEL

await splice.web.search("Robinhood Chain documentation", { limit: 5 });   // Tavily → Exa → Firecrawl
await splice.web.extract(["https://docs.robinhood.com/chain/"], { maxCharacters: 3000 });
await splice.web.map("https://docs.robinhood.com", { limit: 50 });
await splice.web.similar("https://docs.robinhood.com/chain/");
await splice.web.answer("What is the chain ID of Robinhood Chain mainnet?");  // answer + citations
await splice.providers.check();                          // live health
```

On-chain calls take `{ chain?, fresh? }`; market calls take the network as their first argument.

Every call takes `{ chain?, fresh? }`. Keys are read from the provider environment variables (the
`env` option, then `.env.local` / `.env` in the project directory); `new Splice({ data: { envFile: null } })`
uses the process environment only.

## Interfaces

`Splice` composes four small interfaces; pass your own to replace one:

```ts
interface PackageResolver { resolve(ref): Promise<{ id, version }> }
interface PackageManager  { add(ref, opts?); remove(id); list(); install?(opts?); outdated?(ids?); update?(ids?, opts?) }
interface SkillLoader     { load(ref): Promise<LoadedPackage>; installed(): Promise<LoadedPackage[]> }
interface SkillRuntime    { execute(pkg, tool, input?): Promise<ToolResult> }
```

Defaults: `RegistryPackageResolver`, `ProjectPackageManager`, `ProjectSkillLoader` and the
sandboxed `SpliceRuntime` (declared file permissions are resolved from the project root).
`install`/`outdated`/`update` are optional so custom package managers written before Phase 6
keep compiling; `Splice` throws `INVALID_CONFIG` if one is called on a manager without it.
`ProjectPackageManager` calls the same `@spliceloom/core` functions as the CLI
(`installProject`, `outdatedPackages`, `updatePackages`).

## Verification

```ts
const report = await splice.verify("@splice/example@0.1.1");
if (!report.verified) for (const c of report.checks) if (c.status === "failed") console.error(c.id, c.message);
```

The lower-level pipeline is exported too: `verifyArtifact({ bytes, expected }, verifiers?)` with
`Sha256Verifier`, `SizeVerifier`, `PackageContentVerifier`, `MetadataVerifier`,
`SignaturePolicyVerifier` and the `PackageVerifier` / `PackageSignature` / `VerificationResult`
types ([trust.md](trust.md#signing-ready-architecture)).

## Security

The SDK uses the same code paths as the CLI: SHA-256 verification and package validation on
install, no code execution during install, and every tool run inside the permission-restricted
Node.js sandbox ([runtime.md](runtime.md)). Tokens are only sent to the configured registry.

See [examples/agent](../examples/agent/) for a complete agent integration.
