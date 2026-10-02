# Local development

## Requirements

- Node.js ≥ 22.18 (developed on 24.x) and npm. No Cloudflare account, no Docker.
- `npm install` installs wrangler (Cloudflare's official CLI, which bundles workerd/Miniflare)
  as a dev dependency. npm 11+ may report that `workerd`/`esbuild` install scripts were not run;
  this setup works without them (their platform binaries ship as optional dependencies).

```sh
npm install
npm run build          # clean build of all packages + Worker bundle (apps/registry/dist-worker)
npm test               # all unit, integration and end-to-end tests
npm run typecheck      # also type-checks skills/*/tools  (npm run lint = the same strict checks)
```

Builds always start clean: TypeScript 7.0.2's incremental state was observed to skip re-checking
files whose dependencies changed.

## Option A — local Cloudflare Worker (D1 + KV emulated)

The production Worker code, run by wrangler in workerd with local D1 and KV state in
`apps/registry/.wrangler/` (git-ignored). Without a `GITHUB_TOKEN` in `.dev.vars` the Worker
stores artifacts in the local KV emulation, so no GitHub account is needed. To exercise the
GitHub Releases backend locally, add `GITHUB_TOKEN=...` (a token for a *test* repository) to
`apps/registry/.dev.vars` and point `GITHUB_OWNER`/`GITHUB_REPO` at that repository.

```sh
npm run registry:worker:setup   # once: .dev.vars + local admin token, D1 migrations, seed skills/*
npm run registry:worker:dev     # http://127.0.0.1:8787
```

`registry:worker:setup` creates:

| File (git-ignored) | Content |
| --- | --- |
| `apps/registry/.dev.vars` | `ADMIN_TOKEN_SHA256=<hash>` read by `wrangler dev` |
| `apps/registry/.dev.admin-token` | the matching local admin token (dev only) |

Create a user and log in:

```sh
export SPLICE_ADMIN_TOKEN=$(cat apps/registry/.dev.admin-token)   # PowerShell: $env:SPLICE_ADMIN_TOKEN = (Get-Content apps/registry/.dev.admin-token)
npm run registry:admin -- create-user dim
npm run registry:admin -- create-token dim laptop     # copy the token

splice config set registry local
splice login                                           # paste the token
splice publish path/to/skill
```

Reset: delete `apps/registry/.wrangler/` and run setup again.

## Option B — local Node.js registry (SQLite + files)

Same handler and service, lighter (no workerd). Data in `.data/` (git-ignored).

```sh
npm run registry:seed                      # publishes skills/* as the built-in `splice` user
SPLICE_ADMIN_TOKEN=dev-admin npm run registry:dev     # admin API enabled with that token
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address |
| `SPLICE_DATA_DIR` | `<repo>/.data` | SQLite DB + artifacts. Delete to reset. |
| `SPLICE_ADMIN_TOKEN` | unset | Enables the admin API (hashed at startup, never logged) |

## CLI against a local registry

`splice` below means `node <repo>/packages/cli/dist/bin.js` or a global link
(`npm link -w @spliceloom/cli`). `npm run splice -- …` runs in the repo root, so avoid it for
project commands such as `init` and `add`.

```sh
npm run splice -- --help
splice config set registry local        # or per command: --registry local, or SPLICE_REGISTRY
mkdir /tmp/demo && cd /tmp/demo
splice init && splice add @splice/example && splice run example.hello name=Dim
```

`SPLICE_HOME` points the CLI at a different `~/.splice` (tests always set it).

## Tests

| File | Covers |
| --- | --- |
| `packages/spec/src/spec.test.ts` | Manifest, names, semver, schema, permissions, bundles |
| `packages/runtime/src/runtime.test.ts` | Loading, execution, validation, sandbox |
| `packages/core/src/core.test.ts` | Project files, pack, install/upgrade, integrity (bytes and metadata), unsafe bundles, registry resolution, credentials, dry-run publish; Phase 6: `splice.lock` format + legacy migration, outdated/update, rollback of failed updates (tampered artifact, registry down, widened permissions, failed lockfile write), reproducible installs, `LOCK_MISMATCH`, cache + offline |
| `apps/registry/src/registry.test.ts` | API, admin + auth, token hashing, revocation, scoped/expiring tokens, maintainers, rate limits (memory + D1, failed-auth blocking), publish, namespaces, duplicates, 422/413, artifact keys, search, downloads, Node adapters, migrations |
| `packages/spec/src/trust.test.ts` | Verification pipeline (genuine, modified, wrong/malformed SHA-256, size, tampered metadata, wrong package/version, unverifiable signatures, custom verifiers), SKILL.md rules, hidden files, invalid names/versions/schemas, dependency field, permission grants |
| `packages/sdk/src/sdk.test.ts` | SDK offline: tool descriptors, aliases, execution, custom runtime, errors, registry resolution |
| `packages/cli/src/sdk-integration.test.ts` | SDK against a real registry over HTTP: search/info/resolve, install/discover/run/remove, publish + auth failures (no token, invalid token, forbidden namespace), invalid package, sandbox/permission enforcement, `minNodeVersion`, runtime failure, **example agent** as a separate process |
| `packages/cli/src/mcp-http.test.ts` | `splice mcp --http` with the official SDK Streamable HTTP client; 401 without/with wrong token, Origin rejection, 405/415/400/202, weak-token refusal |
| `packages/mcp/src/mcp.test.ts` | MCP protocol: version negotiation, tools/list (schemas, annotations), tools/call (structured results, isError), resources, errors, stdio framing |
| `packages/cli/src/mcp-sdk.test.ts` | `splice mcp` driven by the **official MCP TypeScript SDK client** |
| `packages/cli/src/cli.test.ts` | Help, exit codes, config/aliases, offline publish/login/token/namespace/mcp errors |
| `packages/cli/src/e2e.test.ts` | Phase 1 flow against the Node registry |
| `packages/cli/src/official-skills.test.ts` | Phase 7: official skills in the real sandbox (http valid GET/timeout/oversize/redirect re-checks/private & metadata targets refused; files traversal/absolute/credentials; permission denial with permissions removed; child processes refused), local registry + SDK (install with consent, discovery, run, composition, composition example as a process) and MCP (schemas = manifests, permission `_meta`, calls, `isError` for invalid input and denials) |
| `packages/runtime/src/net-policy.test.ts` | IPv4/IPv6 classification, `*` vs. declared hosts, literal notations, checked lookup (DNS rebinding), names resolving to private ranges, real connections through the guarded fetch, redirect re-checks (localhost, 127/8, metadata, IPv6, IPv4-mapped, private names, `file:`), header stripping, timeouts |
| `packages/runtime/src/runtime.test.ts` (Phase 8 additions) | sandbox bypass regressions (`getBuiltinModule`, `createRequire`, `registerHooks`, undici dispatcher, guard patching), input size/depth limits, secret redaction and path placeholders |
| `skills/*/tests/*.test.ts` | Self-contained unit tests of each official skill (run with Node's type stripping) |
| `packages/cli/src/lifecycle-e2e.test.ts` | Phase 6 via the real binary and the SDK: `@splice/example` 0.1.0 → 0.1.1 with `outdated`/`update`, `install` in a fresh checkout from `splice.lock`, locked version preferred, offline install from the cache, corrupted cache, `LOCK_MISMATCH`, usage errors |
| `packages/spec/src/archive.test.ts` | Deterministic `.tar.gz`, standard gzip/tar compatibility, long paths, legacy JSON bundles, traversal/links/PAX/duplicates/corruption/decompression-bomb rejection |
| `apps/registry/src/github.test.ts` | `GitHubReleaseArtifactStore` against a fake GitHub API: release/asset layout, upload, digest checks, idempotent retry, orphan replacement, redirects, auth/API/network failures (no token leaks); registry publish/download via GitHub; upload failure → nothing in D1; D1 failure after upload → retry reuses the asset; KV → GitHub migration |
| `packages/cli/src/worker-e2e.test.ts` | **Production Worker config in workerd with emulated D1 and a fake GitHub API over HTTP** (plus an R2 variant), via wrangler's test harness: login → publish → search → info → add → list → run → remove, GitHub asset contents and digest, upload failure + retry, corrupted artifact rejected on install, scoped CI tokens, maintainers, auth, namespaces, duplicates, malicious archives, D1-backed 429s |

No test needs Cloudflare credentials or network access beyond localhost.
