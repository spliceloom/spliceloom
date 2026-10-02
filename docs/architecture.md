# Architecture

Splice is a package layer for agent capabilities: a registry that stores immutable,
SHA-256-addressed skill packages; a CLI and SDK that resolve, verify and install them; a runtime
that executes tools in restricted processes; and MCP servers that hand installed tools to agents.

## Flow

```
Developer / agent host
      │  splice add, splice.add(), splice mcp …
      ▼
CLI  ───────────►  SDK (@spliceloom/sdk)  ◄─────────  MCP server (@spliceloom/mcp)
                         │
                         ▼  HTTPS, public read API
                   Registry (Cloudflare Worker)
                   ├─ D1: packages, versions, provenance, users, token hashes
                   └─ GitHub Releases: immutable .tar.gz artifacts
                         │
                         ▼
   1. Package resolution     range in splice.json → highest matching version
   2. Artifact download      registry /download (or the direct GitHub URL)
   3. SHA-256 verification   SHA-256 + size vs. metadata, safe decoding, package validation,
                             manifest vs. metadata — before anything is extracted
   4. Permission validation  requested permissions shown; consent required; grant → splice.lock
   5. Install                staged in .splice/tmp, swapped in atomically; files digest → splice.lock
                         │
                         ▼
   6. Sandbox runtime        one Node.js process per call: --permission (files), no child
                             processes/workers/addons/eval, network guard, empty environment
   7. Tool execution         input validated → tool → output validated → structured result
                         │
                         ▼
               CLI output · SDK result · MCP tool result → the agent
```

No package code runs during steps 1–5.

## Components

| Component | Role | Code |
| --- | --- | --- |
| **Registry** | Cloudflare Worker exposing the [HTTP API](api.md). Validates publishes, records provenance, enforces immutability, serves metadata and artifacts. Also an authenticated, discovery-only MCP endpoint. Never executes skills. | `apps/registry` |
| **D1** | Cloudflare's SQLite database: packages, versions (manifest, integrity, size, artifact location, provenance), namespaces, users, **hashes** of tokens, rate-limit counters. Triggers reject changes to published version rows. | `apps/registry/migrations` |
| **GitHub Releases** | Artifact storage: one release per package (`pkg/<ns>/<name>`) in the public repository `spliceloom/splice-artifacts`, one asset per version. Assets are never replaced. | `apps/registry/src/github.ts` |
| **Spec** | The contract: manifest validation, JSON-schema subset, names, semver, deterministic archives, verification pipeline, API types, secret redaction. Pure Web APIs (usable in the Worker). | `packages/spec` |
| **Core** | Projects (`splice.json`, `splice.lock`), registry client, installer (add/install/update/remove), verification, artifact cache, publishing, credentials. | `packages/core` |
| **Runtime** | Loads packages and executes tools in sandboxed processes; network policy; input/output limits and validation; error hygiene. | `packages/runtime` |
| **SDK** | Programmatic API for applications and agents (`Splice`, `Skill`). The CLI and MCP server are built on it. | `packages/sdk` |
| **CLI** | The `splice` command: argument parsing, output, exit codes. | `packages/cli` |
| **MCP** | Protocol, stdio and Streamable HTTP transports; exposes installed skills as MCP tools and SKILL.md resources. | `packages/mcp` |
| **Official skills** | `@splice/json`, `@splice/http`, `@splice/files`, `@splice/github`. | `skills/` |
| **Website** | Static site (landing page, docs, official skills from the registry API). | `apps/site` |

Dependencies point downward (spec ← runtime ← core ← sdk ← mcp/cli). The runtime packages have
**no third-party dependencies**; development uses TypeScript, `@types/node` and Cloudflare's
`wrangler`.

## Storage

| Where | What |
| --- | --- |
| `splice.json` | What the project wants: `packages` (id → range), optional `registry`. |
| `splice.lock` | What is installed: version, SHA-256, size, registry, download URL, permission grant, files digest. |
| `.splice/packages/@ns/name/` | Extracted package files. |
| `~/.splice/cache/artifacts/sha256/` | Verified artifacts by SHA-256 (no credentials). |
| `~/.splice/config.json` | User default registry. |
| `~/.splice/credentials.json` | Registry tokens per registry URL (mode 0600). |
| D1 | Registry metadata (see above). |
| GitHub Releases | `<ns>-<name>-<version>.tar.gz`. |

## Security boundaries (summary)

- **Integrity** of artifacts is enforced end to end; **publisher authenticity** is not (no
  signatures yet) — see [security.md](security.md#integrity-is-not-authenticity).
- Files: Node.js permission model. Network: in-process guard (declared hosts, public addresses
  only, validated inside the socket's DNS lookup, redirects re-checked). Not OS-level isolation.
- Details and limits: [security.md](security.md), [permissions.md](permissions.md),
  [trust.md](trust.md).

## Design decisions

- **Zero runtime dependencies**: Node.js 22.18+/24 provides type stripping, the permission model,
  SQLite (local registry), argument parsing and fetch.
- **Deterministic `.tar.gz` artifacts**: reproducible hashes (anyone can re-pack a directory and
  compare), standard tooling can open them; decoded with strict safety checks. Legacy JSON bundles
  remain readable.
- **Permissions live in the manifest**, validated together with the tools, and are enforced by the
  runtime rather than trusted.
- **Web-standard registry handler** (`Request → Response`) shared by the Worker and a local Node.js
  registry (SQLite + files) for development and tests.
- **Storage behind an interface** (`ArtifactStore`): GitHub Releases in production; memory/file
  stores for tests. R2 is not required.
- **Tools in TypeScript without a build step**: Node strips erasable type syntax at load time.
