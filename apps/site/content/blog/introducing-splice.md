---
title: Introducing Splice
description: A verified, sandboxed package layer that gives autonomous agents real capabilities — with live Robinhood Chain data from day one.
date: 2026-10-03
---

Agents are only as useful as what they can reach. Reading a chain, pricing a token, searching the web,
opening a repository — every one of those depends on an API, a key, a rate limit and a decision about
what the agent is allowed to touch. Today that wiring is rebuilt by hand, agent after agent.

Splice is the layer in between. A capability is packaged once as a **skill** — a versioned package of
tools with typed inputs and outputs and declared permissions — and any agent can find it, verify it,
install it and run it.

@video how-it-works

## What you get today

- **A public registry** at `registry.spliceloom.com`, with immutable versions, SHA-256 integrity and
  provenance for every published package.
- **The `splice` CLI** (`npm install -g @spliceloom/cli`): install, verify, update and run skills,
  reproducibly from `splice.lock`.
- **A TypeScript SDK** (`npm install @spliceloom/sdk`) with the same workflow from code.
- **MCP servers** that hand installed skills — and 70 read-only live data tools — to Claude, Cursor or
  any MCP client.
- **Eight official skills**, from `@splice/json` to `@splice/robinhood`.

## Verified before install, sandboxed on every call

When you run `splice add`, the artifact is downloaded and checked against the registry's SHA-256 and
size, the archive is decoded safely, the package is validated and its provenance recorded — before a
single file is written. Every tool call then runs in its own Node.js process, limited to the files,
hosts and capabilities the package declared. Anything else is denied.

We are explicit about the limits: packages are not signed yet, so SHA-256 proves integrity, not
authorship; and the sandbox is the Node.js permission model plus a network guard, not a VM. The
[security model](../../../../docs/security.md) lists what is guaranteed and what is not.

## Real data, never invented

Skills that need data do not carry keys. They ask the host for a **capability** — `tokens.rank`,
`stock.quote`, `perps.funding` — and the host calls its configured provider, keeps the key to itself and
returns the result with its source. Every value is labelled `LIVE`, `CACHED`, `UNAVAILABLE` or
`ERROR`; rankings print their formula; sources are shown side by side and never averaged.

Robinhood Chain is the first environment: every token on the chain, Robinhood Stock Tokens from six
sources, Chainlink prices, perps on Lighter, DeFi from DefiLlama — plus global markets and US macro.
Much of it works with no key at all.

@video stocks

## Ask anything

`splice ask` puts an AI agent on top of those read-only tools. It calls them, shows every call and its
source, and prints the model and the cost of the answer.

@video ask

## Start in a minute

```sh
npm install -g @spliceloom/cli
splice chain info
splice tokens trending
```

The [Quickstart](../../../../docs/quickstart.md) walks through keys, every feature, MCP and the SDK. The
source is on [GitHub](https://github.com/spliceloom/spliceloom) under the MIT license, and updates are
posted on [X (@spliceloom)](https://x.com/spliceloom).
