# What is Splice?

Splice is a **capability layer for autonomous agents**. It is not a chatbot and not an agent.
It gives agents (and the developers building them) a standard way to:

1. **Describe** a capability as a package — a *skill* — with typed tools and declared permissions.
2. **Discover** skills in a registry.
3. **Install** a specific, integrity-verified version into a project.
4. **Run** a skill's tools through one runtime that enforces the declared permissions.

```
splice search github      → find a capability
splice add @splice/github → install it (version + integrity locked)
splice run github.search  → execute a tool with structured input/output
```

## Vocabulary

| Term         | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| **Skill / package** | A directory with `manifest.json`, `SKILL.md` and tool modules. Named `@namespace/name`. |
| **Tool**     | One function inside a skill, invoked as `<package>.<tool>` (e.g. `example.hello`). |
| **Manifest** | `manifest.json`: identity, version, permissions, tools and their input/output schemas. |
| **Artifact / bundle** | The immutable, content-addressed file the registry stores for one version. |
| **Registry** | HTTP service for search, metadata and artifacts.                                 |
| **Runtime**  | Loads an installed skill and runs its tools in a permission-restricted process.  |
| **Project**  | A directory with `splice.json`; skills are installed into its `.splice/` folder.  |

## What Phase 1 delivers

- `splice` CLI: `init`, `search`, `info`, `add`, `remove`, `list`, `run`.
- Package specification v1 with validation and documentation.
- Installer with semver ranges, lockfile and SHA-256 integrity verification.
- Sandboxed runtime built on the Node.js permission model.
- One official example skill: `@splice/example`.

## What Phase 2 adds

- **Hosted registry implementation**: Cloudflare Worker + D1 (metadata) + R2 (artifacts), with
  migrations and wrangler configuration ready to deploy. Runs locally without an account.
- **Publishing**: `splice publish` with server-side validation, immutable versions, SHA-256
  integrity end to end.
- **Authentication**: registry tokens (hash-only storage), admin API, `splice login`, `splice logout`, `splice whoami`.
- **Namespaces**: ownership enforcement, first-publish claims, reserved `@splice`.
- **Configurable registry**: `--registry`, `SPLICE_REGISTRY`, `splice.json`, `splice config`,
  aliases `local` / `production`.
- Tests against the real Worker in workerd with emulated D1/R2.

Deployed at https://registry.spliceloom.com (artifacts then in Workers KV) — see
[deployment.md](deployment.md).

## What Phase 3 adds

- **MCP server** (`splice mcp`): installed skills become MCP tools and SKILL.md resources for AI
  agents, executed through the same sandbox ([mcp.md](mcp.md)).
- **Scoped, expiring tokens**: publish-only tokens limited to namespaces with an expiry, managed
  by users themselves (`splice token`).
- **Namespace maintainers** (`splice namespace`).
- **Rate limiting**: strongly consistent D1 limits for failed authentication and publishing, plus
  Cloudflare Rate Limiting bindings as a coarse first line ([auth.md](auth.md#rate-limits)).
- **Backups**: D1 export + verified artifact download, tested restore ([deployment.md](deployment.md#backups-and-restore)).

## What Phase 3.5 changes

- Artifacts are deterministic `.tar.gz` files stored as **GitHub Release assets**; D1 keeps all
  metadata (including SHA-256, backend and URL). **R2 is not required**; KV/R2 remain optional
  backends behind the same `ArtifactStore` interface.
- Safe failure handling: failed uploads publish nothing; a D1 failure after upload is retried
  idempotently.

## What Phase 4 adds

- **SDK** (`@spliceloom/sdk`): programmatic search/info/install/load/discover/run for agent apps;
  the CLI now runs on it ([sdk.md](sdk.md)).
- **Remote MCP**: `splice mcp --http` (Streamable HTTP, bearer token, executes in the sandbox) and
  an authenticated discovery endpoint `/mcp` on the registry Worker ([mcp.md](mcp.md)).
- **Stable tool contract**: `describeTools(manifest)` shared by SDK and all MCP servers.
- **Manifest**: optional `runtime.minNodeVersion` (backward compatible).
- **Example agent**: [examples/agent](../examples/agent/).

## What Phase 5 adds

- **Trust layer** ([trust.md](trust.md)): one verification pipeline (SHA-256, size, package,
  metadata, signature policy) before every install; `splice verify` / `splice.verify()`.
- **Immutable versions**, enforced by the registry, the artifact store and D1 triggers.
- **Provenance** recorded at publish (`/provenance`).
- **Explicit permission consent** (`--accept-permissions`) with grants recorded in the lockfile and
  checked before execution.
- **Stricter publish validation** (SKILL.md content, no hidden files/node_modules), reserved
  `dependencies` field, signing-ready verifier interfaces.

## What Phase 6 adds

- **Package lifecycle** ([lifecycle.md](lifecycle.md)): `splice outdated`, `splice update` (within
  the `splice.json` ranges, atomic with rollback) and `splice install` (reproducible installs).
- **`splice.lock`**: version, SHA-256, size, registry and permission grant per package; installs
  from it fail closed when the registry differs (`LOCK_MISMATCH`). Replaces `splice-lock.json`
  (migrated automatically). `splice init` creates only `splice.json`.
- **Local artifact cache** keyed by SHA-256 (never skips verification) and **offline installs** of
  locked versions from it.
- SDK: `splice.install()`, `splice.outdated()`, `splice.update()` on the same core as the CLI.

## What Phase 7 adds

- **Official skills** ([skills.md](skills.md)): `@splice/json` (no permissions), `@splice/http`
  (public hosts), `@splice/files` (`workspace/` only), `@splice/github` (public API, no token),
  each with SKILL.md, schemas, examples and tests, verified through the sandbox, the SDK and MCP.
- **Network hardening** in the runtime: non-public targets refused (incl. after DNS), redirects
  re-checked per hop, `network: ["*"]` for any public host ([permissions.md](permissions.md)).
- MCP tools carry the enforced permissions in `_meta`; `splice.tools(ref)` filters by package.
- **Composition** example ([composition.md](composition.md), `examples/agent-composition`).
- `@splice/process` intentionally not built ([why](permissions.md#why-there-is-no-process-execution-skill)).

## What Phase 8 hardens

- **Network guard**: address validation inside the socket's DNS lookup (closes DNS rebinding for
  tool fetches); three sandbox bypasses closed (`process.getBuiltinModule`, `node:module` hooks,
  the undici dispatcher) ([security.md](security.md#network)).
- **Installed-code integrity**: files digest in splice.lock, re-checked by SDK, CLI and MCP.
- **`@splice/files` 0.1.1**: Windows path semantics, hard links, descriptor re-check;
  **`@splice/json` 0.1.1**: nesting limit.
- **Limits and hygiene**: tool input 4 MiB / 256 levels, MCP stdio line limit, secret redaction
  in errors and logs, path placeholders.

## Not built yet

These are **future concepts**. Nothing in the current code implements them:

- **Public sign-up**, OAuth/social login, organizations and teams (accounts are created by a
  registry admin).
- **Hosted skill execution**: the registry only offers discovery over MCP; executing skills needs
  a Splice runtime you run (`splice mcp`, `splice mcp --http`, SDK).
- **Framework adapters** (LangChain, OpenAI Agents, …) on top of the SDK.
- **Robinhood Chain / onchain skills.**
- **$SPLICE token.** Live. Official contract address:
  `0xe61717414b34d1f5a1E17F5a91a980A1f4Ef2806`, announced on
  [spliceloom.com](https://spliceloom.com) and [@spliceloom on X](https://x.com/spliceloom); any
  other token using the Splice name is not ours.
- **Decentralized registry.**
- **Permissions marketplace** / reviewed permission policies.
- **Agent runtime ecosystem** (hosted execution, composition of multiple skills).
- **OS-level sandboxing** (the runtime uses the Node.js permission model; see [runtime.md](runtime.md)).
- Marketing website, registry UI, download statistics, ratings.
