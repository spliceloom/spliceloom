# Getting started

This guide installs the `splice` CLI, creates a project, installs an official skill, verifies it
and runs one of its tools. It takes about five minutes.

Requirements: **Node.js 22.18 or newer** (Windows, macOS or Linux).

## 1. Install the CLI

The CLI is distributed on npm as `@spliceloom/cli` and installs the `splice` command:

```sh
npm install -g @spliceloom/cli
splice --version
```

> **Install:** `npm install -g @spliceloom/cli` (Node.js >= 22.18). Contributors can instead use a
> local build (see [releasing.md](releasing.md#local-installation-test)) or the source checkout:
>
> ```sh
> npm install && npm run build
> npm link -w @spliceloom/cli      # makes `splice` available globally
> ```
>
> The scoped name is used because the unscoped npm name `splice` belongs to an unrelated package.

The CLI talks to the Splice registry at `https://registry.spliceloom.com` by default
(see [cli.md](cli.md#global-options) to use another registry).

## 2. Create a project

A Splice project is a directory with a `splice.json` file:

```sh
mkdir my-agent && cd my-agent
splice init
```

`splice init` only writes `splice.json`. `splice.lock` and the `.splice/` folder appear with the
first installed package.

## 3. Search the registry

```sh
splice search github
```

```
@splice/github
Official read-only GitHub tools over the public REST API (no token): …
latest: 0.1.0
```

## 4. Inspect a package

```sh
splice info @splice/github
```

`info` shows versions, the SHA-256 integrity, the **permissions** the package requests and every
tool with its inputs. Read the permissions before installing.

## 5. Install

```sh
splice add @splice/github --accept-permissions
```

`@splice/github` requests network access to `api.github.com`, so it needs explicit consent
(`--accept-permissions`). Packages without permissions (for example `@splice/json`) install
without it.

During `add`, Splice resolves the version, downloads the artifact, verifies its SHA-256 and size
against the registry metadata, validates the package, checks the permissions, and only then
extracts it into `.splice/packages/`. No package code runs during installation.

## 6. Verify

```sh
splice verify @splice/github
```

`verify` re-downloads the published version and checks it end to end (SHA-256, size, package
validity, registry metadata, provenance, the direct artifact URL) and compares the installed copy
with the verified artifact. Exit code 1 means a check failed.

SHA-256 proves you received the bytes the registry recorded. It does **not** prove who wrote
them; see [security.md](security.md#integrity-is-not-authenticity).

## 7. List installed packages

```sh
splice list
```

## 8. Discover tools

```sh
splice info @splice/github
```

Tools are referred to as `<package>.<tool>`, e.g. `github.get-repo` (or the full form
`@splice/github.get-repo`). From code, `splice.tools()` returns the same descriptors
([sdk.md](sdk.md)); MCP clients see them through `splice mcp` ([mcp.md](mcp.md)).

## 9. Run a tool

```sh
splice run github.get-repo owner=spliceloom repo=splice-artifacts
```

`key=value` arguments are converted using the tool's input schema; `--input '<json>'` passes a
JSON object instead. The tool runs in a separate, sandboxed Node.js process limited to the
package's declared permissions ([permissions.md](permissions.md)). Output is printed as JSON;
`--json` prints the full result envelope.

## 10. Update and remove

```sh
splice outdated
splice update
splice remove @splice/github
```

## 11. Live data — no keys needed to start

```sh
splice chain info                 # Robinhood Chain via the official public RPC (chain id verified live)
splice price ETH                  # CoinGecko keyless prices
splice market search robinhood    # DexScreener pairs
splice setup                      # what works without keys, and which free keys unlock more
```

`splice setup --init` creates `~/.splice/.env` with every provider variable name (no values); fill
in the keys you have and run `splice providers` to check them live. Keys there work from every
folder; `splice setup --template > .env.local` makes a per-project file instead. The
[Quickstart](quickstart.md) tours every live data command. Without a key a
feature answers `UNAVAILABLE` with a hint — never invented data. See
[data-providers.md](data-providers.md).

## Next steps

- Reproducible installs with `splice.lock`: [lifecycle.md](lifecycle.md)
- Use skills from TypeScript: [sdk.md](sdk.md)
- Give skills to an AI agent over MCP: [mcp.md](mcp.md)
- Official skills: [skills.md](skills.md) · write your own: [authoring-skills.md](authoring-skills.md)
- Everything the CLI can do: [cli.md](cli.md)
