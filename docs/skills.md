# Official skills

Splice ships a small set of official skills in the `@splice` namespace. Each one demonstrates a
different kind of capability and a different permission profile. Sources: `skills/<name>/`.

| Package | Version | Tools | Permissions | Capability type |
| --- | --- | --- | --- | --- |
| [`@splice/json`](../skills/json/SKILL.md) | 0.1.1 | `json.parse`, `json.stringify`, `json.pick` | none | pure computation |
| [`@splice/http`](../skills/http/SKILL.md) | 0.1.0 | `http.get`, `http.post` | `network: ["*"]` (public hosts only) | open network |
| [`@splice/files`](../skills/files/SKILL.md) | 0.1.1 | `files.read`, `files.write`, `files.list` | `fs.read/write: ["workspace"]` | sandboxed file system |
| [`@splice/github`](../skills/github/SKILL.md) | 0.1.0 | `github.get-repo`, `github.list-repos`, `github.search-repositories` | `network: ["api.github.com"]` | one specific API |
| `@splice/example` | 0.1.1 | `example.hello`, `example.stats` | none | package-format example |
| `@splice/web` | 0.1.0 | `web.search`, `web.read`, `web.answer` | `capabilities: web.search, web.extract, web.answer` | host capabilities (broker) |
| `@splice/market` | 0.1.0 | `market.price`, `market.pairs`, `market.candles` | `capabilities: market.price, market.pairs, market.ohlcv` | host capabilities (broker) |
| `@splice/robinhood` | 0.1.0 | `robinhood.trending`, `.rank`, `.token`, `.report`, `.whales`, `.stock`, `.perps`, `.funding`, `.defi`, `.markets` | `capabilities: tokens.*, stock.quote, perps.*, defi.overview, global.overview` | host capabilities (broker) |
| `@splice/onchain` | 0.1.0 | `onchain.balance`, `onchain.transaction`, `onchain.token` | `capabilities: onchain.*` | host capabilities (broker) |

The last three use the [capability broker](capabilities.md): they hold no keys and open no
sockets; the host answers with real provider data.

**Not included: `@splice/process`.** See [permissions.md](permissions.md#why-there-is-no-process-execution-skill).

Tool names use hyphens (`get-repo`), because tool names follow the manifest rule
`^[a-z][a-z0-9-]{0,63}$`. The MCP names are `splice_<package>_<tool>`, e.g.
`splice_github_get-repo`.

## Install

```sh
splice add @splice/json                               # no permissions: no consent needed
splice info @splice/http                              # review the permissions first
splice add @splice/http --accept-permissions
splice add @splice/files --accept-permissions
splice add @splice/github --accept-permissions
```

SDK:

```ts
import { Splice } from "@spliceloom/sdk";
const splice = new Splice({ project: "./agent" });
await splice.init();
await splice.add("@splice/json");
await splice.add("@splice/http", { acceptPermissions: true });   // after showing them to a human
```

## Discover tools

Tool descriptors come straight from each package's `manifest.json` (no hand-written schemas):

```ts
const tools = await splice.tools("@splice/json");      // or splice.tools() for everything
// [{ name: "json.parse", qualifiedName: "@splice/json.parse", mcpName: "splice_json_parse",
//    inputSchema, outputSchema, permissions, annotations, timeoutMs, ... }, ...]
```

MCP clients see the same tools through `splice mcp` (stdio) or `splice mcp --http`; see
[MCP discovery](#mcp-discovery).

## Run tools

```sh
splice run json.parse text='{"hello":"world"}'
splice run http.get url=https://api.github.com/repos/spliceloom/splice-artifacts
splice run files.write path=notes/a.md content="# A"
splice run github.search-repositories query="mcp language:typescript" sort=stars
```

```ts
const result = await splice.run("@splice/json.parse", { text: '{"hello":"world"}' });
// { ok: true, output: { value: { hello: "world" }, type: "object" }, ... }

const skill = await splice.load("@splice/json");
await skill.run("pick", { value: result.output.value, paths: ["hello"] });
```

Tool failures never throw: they return `{ ok: false, error: { code, message } }`. Runtime codes
(`INVALID_INPUT`, `PERMISSION_DENIED`, `TIMEOUT`, …) come from the sandbox; skill-specific errors
are `TOOL_ERROR` with a message that starts with the skill's own code, e.g.
`INVALID_JSON: at position 6 (line 1, column 7): …` or `PATH_OUTSIDE_SANDBOX: …`. Each SKILL.md
lists its codes.

## MCP discovery

For every installed tool, `tools/list` returns:

| Field | Source |
| --- | --- |
| `name` | `splice_<package>_<tool>` |
| `title`, `description` | the manifest |
| `inputSchema`, `outputSchema` | exactly the manifest's schemas |
| `annotations` | derived from permissions: `readOnlyHint` (no fs writes), `destructiveHint` (fs writes), `openWorldHint` (network) |
| `_meta["io.spliceloom/permissions"]` | the declared permissions the sandbox enforces |
| `_meta["io.spliceloom/package"]`, `["io.spliceloom/version"]`, `["io.spliceloom/timeoutMs"]` | package id, version, timeout |

Each package's `SKILL.md` is an MCP resource (`splice://packages/@splice/json/SKILL.md`). Tool
errors — invalid input, permission denials, skill errors — are `isError: true` results with the
code at the start of the text.

## Package layout

Every official package uses the normal package format ([spec.md](spec.md)) plus two folders:

```
skills/http/
  manifest.json      # identity, runtime.minNodeVersion, permissions, tools with input/output schemas
  SKILL.md           # when to use it, tools, errors, limits, security boundaries
  tools/*.ts         # one entry per tool (default export)
  lib/*.ts           # shared code imported by tools
  examples/*.json    # { tool, input, output? } — validated against the schemas by the tests
  tests/*.test.ts    # self-contained unit tests (node --test tests/*.test.ts)
```

`examples/` and `tests/` are published inside the artifact, so anyone can inspect and run them.
The Splice repository additionally runs every official package in the real sandbox, through the
SDK, through MCP and through a local registry (`packages/cli/src/official-skills.test.ts`).

## Versions

0.1.1 of `@splice/json` (nesting limit) and `@splice/files` (Windows path rules, hard links, descriptor re-check) are Phase 8 security fixes; `@splice/http` and `@splice/github` stay at 0.1.0 because their protections are enforced by the runtime. See [security.md](security.md).

Official packages start at `0.1.0` and follow semver. Published versions are immutable; a fix is
a new version (`0.1.1`), picked up by `splice update` within the project's range
([lifecycle.md](lifecycle.md)).
