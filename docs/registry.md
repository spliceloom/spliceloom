# Registry

The registry stores packages, versions and artifacts and serves the HTTP API used by the CLI.

> **Implemented now:** Cloudflare Worker + D1 (metadata) + **GitHub Releases** (artifacts),
> runnable locally with wrangler (no account needed); a Node.js/SQLite variant for lightweight
> local use; token authentication; namespaces; publishing. **R2 is not required.**
> **Deployed:** https://registry.spliceloom.com. See [deployment.md](deployment.md).

## Architecture

```
 splice CLI ──HTTP──▶ createRegistryHandler (Request → Response)      apps/registry/src/handler.ts
                              │
                        RegistryService                               apps/registry/src/service.ts
                  (validation via @spliceloom/spec,
                   auth, namespaces, publish rules)
                     │                      │
               SqlDatabase             ArtifactStore                  apps/registry/src/storage.ts
                     │                      │
   ┌─────────────────┴───┐     ┌────────────┴─────────────────┐
   │ D1   (worker.ts)    │     │ GitHub Releases (github.ts)  │  ← production Worker
   │                     │     │ KV / R2 (worker.ts, optional)│
   │ SQLite (node.ts)    │     │ files (node.ts)              │  ← local Node.js registry
   └─────────────────────┘     └──────────────────────────────┘
```

One handler and one service serve every runtime; only the adapters differ. `ArtifactStore` is the
only boundary to the artifact backend (`get`, `put`, `backend`), so GitHub is not referenced
anywhere else and another backend can be added without touching the registry. Package validation
is not duplicated: the server uses the same `decodePackageArchive` / `validateBundleFiles` from
`@spliceloom/spec` as the CLI.

## D1 schema

Source of truth: [`apps/registry/migrations/`](../apps/registry/migrations/). The same files are
applied by `wrangler d1 migrations apply`, by the wrangler test harness and by the local SQLite
registry (tracked in the same `d1_migrations` table).

| Table | Columns (key ones) | Answers |
| --- | --- | --- |
| `users` | `id`, `name` (unique), `created_at` | Who can publish |
| `tokens` | `id`, `user_id`, `token_hash` (unique, SHA-256), `label`, `scope_namespaces`, `expires_at`, `can_manage`, `last_used_at`, `revoked_at` | Authentication and token scope |
| `namespaces` | `name` (PK), `owner_id` (nullable), `reserved` | Who owns a namespace |
| `namespace_maintainers` | `(namespace, user_id)` PK, `added_at` | Who else may publish into a namespace |
| `rate_limits` | `key` (PK), `window_start`, `count` | Strongly consistent rate-limit counters |
| `packages` | `id` (`@ns/name`), `namespace`, `name`, `description`, `latest_version`, timestamps | Does it exist? What is latest? |
| `versions` | `(package_id, version)` PK, `manifest` (JSON), `integrity` (SHA-256), `size`, `artifact_key` (unique), `artifact_backend`, `artifact_url`, `published_by`, `published_at`, `provenance` (JSON, write-once) | Which versions, their metadata, where the artifact is, how to verify it, where it came from. Immutable (D1 triggers, migration `0005`). |

Indexes: `tokens(user_id)`, `namespaces(owner_id)`, `packages(namespace)`,
`versions(package_id, published_at)`, plus the unique indexes above. The migration seeds the
reserved namespaces `splice` and `spliceloom`.

## Artifacts

### Format

Each version is one deterministic `.tar.gz` (ustar) containing the validated package files —
see [spec.md](spec.md#package-archive-targz). Identical contents give identical bytes, so the
SHA-256 (`versions.integrity`) is reproducible on any machine. Phase 1/2 JSON bundles remain
readable.

Key (recorded in `versions.artifact_key`):

```
packages/<namespace>/<name>/<version>/<sha256-hex>.tar.gz
```

### Backends

| Backend | `artifact_backend` | Where | Used by |
| --- | --- | --- | --- |
| **GitHub Releases** | `github-releases` | configured repo; release tag `pkg/<ns>/<name>`, asset `<ns>-<name>-<version>.tar.gz` | **production Worker** |
| Workers KV | `kv` | binding `ARTIFACTS_KV`, key as above | optional (Phase 2 store, kept for migration) |
| R2 | `r2` | binding `ARTIFACTS` | optional, not configured (needs R2 billing) |
| Files | `fs` | `.data/artifacts/<key>` | local Node.js registry |

Selection in the Worker: GitHub when `GITHUB_OWNER`, `GITHUB_REPO` and the `GITHUB_TOKEN` secret are
set; otherwise R2 if bound; otherwise KV.

### GitHub Releases backend

- One release per package (tag `pkg/<namespace>/<name>`, created on first publish) keeps each
  release far below GitHub's 1,000-assets-per-release limit.
- Upload: `POST uploads.github.com/.../releases/<id>/assets?name=<ns>-<name>-<version>.tar.gz`.
  GitHub's reported asset `digest` and `size` must match the SHA-256 and length the registry
  computed, otherwise the asset is deleted and the publish fails.
- `versions.artifact_url` stores the public `browser_download_url`. The registry's
  `/download` endpoint serves the bytes (fetching that URL, or the API for private repositories),
  and `GET /packages/:ns/:name/:version` exposes `artifact: { filename, backend, url }` so clients
  can also fetch directly. Either way the client verifies the SHA-256.
- The token is used only inside the Worker (secret `GITHUB_TOKEN`); it never appears in D1,
  responses, logs, error messages or package metadata.

### Failure handling

| Failure | Result |
| --- | --- |
| Artifact upload fails (GitHub down, bad token, repo misconfigured) | `502 ARTIFACT_STORAGE_FAILED`; **nothing written to D1**; publish can be retried. |
| Upload succeeded, D1 write failed | `503 METADATA_WRITE_FAILED`; D1 does not reference the asset. **Retry the publish with the same package**: the identical asset is reused (no second upload). Different contents for that version are rejected (`409`) — stored artifacts are never overwritten (Phase 5); publish a new version, or have an admin delete the unreferenced asset in GitHub. |
| GitHub reports a different digest/size | the asset is deleted, publish fails (`502`). |
| Download bytes don't match `integrity` | the CLI refuses to install; nothing is written to the project. |

### Edge cache and database usage

The Worker answers anonymous `GET` requests for public data from the Cloudflare edge cache (Cache
API, per data center) after the first request, so repeated reads cost no D1 rows:

| Route | Cached for |
| --- | --- |
| `/packages/search`, `/packages/:ns/:name`, `/packages/:ns/:name/versions`, `/namespaces/:ns` | 60 s |
| `/packages/:ns/:name/:version`, `.../provenance` | 1 day (published versions are immutable) |

A successful publish purges that package's entries (package, versions, namespace) and a
maintainer/owner change purges the namespace entry in the data center that handled the write;
other data centers and search results catch up within 60 s. Artifact downloads are **not** cached:
the bytes come from storage and clients verify their SHA-256, so a tampered storage copy stays
detectable (`splice verify`). Health, authenticated routes (`Authorization` header), publish/admin/MCP and error responses are
never cached. Responses carry `x-splice-cache: HIT|MISS` and `server-timing: d1;desc="rows_read=N
rows_written=M"` — the rows D1 reported for that request (0 on a cache hit), which is what the
daily D1 quota counts. Measure capacity with them, e.g.
`curl -sI https://<registry>/packages/search?q=json | grep -i -E "server-timing|x-splice-cache"`.

### Migration from KV

`POST /admin/artifacts/migrate` (`npm run registry:admin -- migrate-artifacts`) copies every version
whose `artifact_backend` is not the current backend from the legacy store (KV/R2) into GitHub,
verifying the SHA-256 first, then updates `artifact_backend`/`artifact_url`. It is idempotent;
corrupted or missing legacy artifacts are reported as skipped.

## HTTP API (v2)

| Method & path | Auth | Response |
| --- | --- | --- |
| `GET /health` | — | `{ status, apiVersion }` |
| `GET /packages/search?q=&limit=` | — | `{ query, results: [{ name, description, latest }] }` |
| `GET /packages/:ns/:name` | — | `{ name, namespace, description, latest, versions: [{ version, publishedAt }], createdAt, updatedAt }` |
| `GET /packages/:ns/:name/versions` | — | `{ name, versions: [{ version, publishedAt, integrity, size }] }` |
| `GET /packages/:ns/:name/:version` | — | `{ name, version, manifest, integrity, size, publishedAt, publishedBy, download, artifact: { filename, backend, url } }` |
| `GET /packages/:ns/:name/:version/download` | — | artifact bytes (`application/gzip`); headers `x-splice-integrity`, `cache-control: immutable` |
| `GET /packages/:ns/:name/:version/provenance` | — | `{ name, version, provenance, location }` — see [trust.md](trust.md#provenance) |
| `POST /publish` | user token | body = `.tar.gz` artifact → `201 { name, version, integrity, size, download }` |
| `GET /auth/whoami` | user token | `{ user, namespaces, owns, maintains, token }` |
| `GET /auth/tokens` | full token | `{ tokens: [TokenInfo & { current }] }` (no secrets) |
| `POST /auth/tokens` | full token | `{ label?, namespaces?, expiresInDays? }` → `201` publish-only token (shown once) |
| `DELETE /auth/tokens/:id` | full token | revoke one of your own tokens |
| `GET /namespaces/:ns` | — | `{ namespace, owner, maintainers, reserved, packages }` |
| `POST /mcp` | user token | MCP Streamable HTTP, discovery only (`registry_search`, `registry_package_info`, SKILL.md template) — see [mcp.md](mcp.md#remote-discovery-the-registry-mcp) |
| `PUT /namespaces/:ns/maintainers/:user` | owner, full token | add a maintainer → namespace |
| `DELETE /namespaces/:ns/maintainers/:user` | owner, full token | remove a maintainer → namespace |
| `POST /admin/users` | admin | `{ "name": "dim" }` → `201` user |
| `POST /admin/users/:name/tokens` | admin | `{ label?, namespaces?, expiresInDays?, canManage? }` → `201` token (shown once) |
| `POST /admin/tokens/:id/revoke` | admin | `{ id, revoked: true }` |
| `PUT /admin/namespaces/:ns` | admin | `{ "owner": "dim" \| null }` → `{ namespace, owner, reserved }` |
| `POST /admin/artifacts/migrate` | admin | `{ migrated: [...], skipped: [...] }` (legacy store → current backend) |

Errors: `{ "error": { "code", "message", "details"? } }`.

| Status | Codes |
| --- | --- |
| 400 | `BAD_REQUEST` (bad name, malformed URL/JSON) |
| 401 | `UNAUTHENTICATED` (missing, invalid or revoked token) |
| 403 | `FORBIDDEN` (namespace owned by someone else, not the owner, bad admin token), `NAMESPACE_RESERVED`, `ADMIN_DISABLED`, `TOKEN_SCOPE` (publish-only token or namespace outside the token's scope) |
| 404 | `NOT_FOUND` |
| 409 | `VERSION_EXISTS`, `USER_EXISTS` |
| 413 | `PAYLOAD_TOO_LARGE` (bundles > 5 MB) |
| 422 | `INVALID_PACKAGE` (fails the spec, unsafe paths, build metadata in version) |
| 429 | `RATE_LIMITED` with `Retry-After` — see [auth.md](auth.md#rate-limits) |
| 502 | `ARTIFACT_STORAGE_FAILED` (artifact backend unavailable; nothing was published) |
| 503 | `METADATA_WRITE_FAILED` (artifact stored, D1 write failed; retry the publish) |
| 500 | `INTERNAL_ERROR` (logged without headers or bodies) |

Types for every response live in `@spliceloom/spec` (`registry-api.ts`).

## Publish pipeline (server side)

1. Rate-limit and authenticate the bearer token (429 / 401), then the per-user publish limit (429).
2. Decode the bundle and validate it with the shared spec validator (422).
3. Authorize the namespace: token scope, then owner or maintainer; claim it if unowned; reject if
   reserved or owned by another user (403).
4. Reject an existing version (409). Versions are immutable.
5. Compute the SHA-256 integrity and upload the `.tar.gz` to the artifact store (GitHub Releases)
   under the deterministic key; the store verifies GitHub's digest (502 on failure, nothing in D1).
6. Write the package row (latest version recomputed) and the version row — including
   `artifact_backend` and `artifact_url` — in one D1 `batch` (atomic). A concurrent publish of the
   same version fails on the primary key → 409. Any other D1 failure → 503; retrying is safe.

See [auth.md](auth.md) for tokens and namespaces, [publishing.md](publishing.md) for the CLI side.
