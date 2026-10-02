# Introduction

Splice is infrastructure for composing capabilities into autonomous agents. It gives an agent a
safe way to discover, install, verify and run reusable capabilities — and to reach real data
providers through them — without every agent rebuilding the same integrations.

**Splice** is the `splice` CLI, the TypeScript SDK (`@spliceloom/sdk`), the MCP server, the registry
and the runtime. Packages are published under the `@spliceloom` npm scope, and the website lives at
spliceloom.com.

## The building blocks

| Concept | What it is | Read more |
| --- | --- | --- |
| **Skill** | A versioned package of tools (input/output schemas, code, docs) with declared permissions. | [Skills](packages.md) |
| **Capability** | Something a skill may do: touch a project path, reach a host, read a variable, or call a host capability such as `web.search`. | [Host capabilities](capabilities.md) |
| **Provider** | A real external service the host uses to answer capabilities: Alchemy, Blockscout, CoinGecko, GitHub, OpenRouter, Tavily, … | [Providers reference](data-providers.md) |
| **Registry** | Public package registry: namespaces, immutable versions, SHA-256 integrity and provenance. | [Public registry](public-registry.md) |
| **Runtime** | Runs each tool call in its own restricted Node.js process. | [Runtime](runtime.md) |
| **Agent** | Your agent or application — Claude Code, Cursor, a custom agent — using Splice through the CLI, SDK or MCP. | [MCP](mcp.md) |

## How it fits together

```
agent (MCP client · SDK · CLI)
  └─ skill tool  ── verified package, sandboxed process
       └─ ctx.capability("onchain.balance", …)   ── declared + granted permission
            └─ host broker → provider router → provider (e.g. Alchemy, chain id verified)
                 └─ result: LIVE / CACHED / UNAVAILABLE / ERROR, with provenance
```

- Packages are verified (SHA-256, size, manifest, provenance) before a file is written.
- Everything a package may touch is declared and needs consent; the grant is pinned in
  `splice.lock`.
- Data results always state their source, time, chain and block — and never contain invented
  values: when no provider can answer, the result says `UNAVAILABLE`.

## What Splice is not

- **Not an agent or a model.** Bring your own; Splice supplies capabilities.
- **Not a blockchain.** Robinhood Chain and other networks are data sources Splice reads from (see
  [Robinhood Chain](robinhood-chain.md)).
- **Not a hosted execution service.** Skills run on your machine or server, in the Splice sandbox.

## Next

- [Install the CLI](installation.md), then follow the [quickstart](quickstart.md).
- Read the [security model](security.md) before running third-party skills.
