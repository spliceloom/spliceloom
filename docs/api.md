# Registry HTTP API (v2)

The Splice registry is a Cloudflare Worker (D1 for metadata, GitHub Releases for artifacts). The
CLI, the SDK and the Splice website all use this API.

- **Base URL:** `https://registry.spliceloom.com`.
- **Format:** JSON (`application/json`), except artifact downloads.
- **API version:** `2` (`GET /` and `GET /health` report it).
- **CORS:** the anonymous read-only routes below send `Access-Control-Allow-Origin: *` and answer
  `OPTIONS` preflights, so browsers can read public metadata. Credentials are never accepted
  cross-origin; authenticated routes send no CORS headers.
- Types are defined in `packages/spec/src/registry-api.ts` (`@spliceloom/spec`).

## Errors

Every error has the same body and a matching HTTP status:

```json
{ "error": { "code": "NOT_FOUND", "message": "Package @splice/nope not found", "details": [] } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | malformed name, version, URL encoding or JSON body |
| 401 | `UNAUTHENTICATED` | token missing, invalid, expired or revoked |
| 403 | `FORBIDDEN`, `TOKEN_SCOPE`, `NAMESPACE_RESERVED` | not allowed for this user/token/namespace |
| 404 | `NOT_FOUND` | unknown package, version, namespace, token or route |
| 409 | `VERSION_EXISTS` | a version is published already (versions are immutable) |
| 413 | `PAYLOAD_TOO_LARGE` | request body over the limit |
| 422 | `INVALID_PACKAGE` | the archive fails validation (`details` lists the problems) |
| 429 | `RATE_LIMITED` | too many requests / failed logins; see `Retry-After` |
| 502 | `ARTIFACT_STORAGE_FAILED` | artifact storage (GitHub) failed; nothing was published |
| 503 | `STORAGE_UNAVAILABLE`, `METADATA_WRITE_FAILED` | database temporarily unavailable; retry later (`Retry-After`) |
| 500 | `INTERNAL_ERROR` | unexpected failure (never contains internal details) |

## Public endpoints (no authentication)

### `GET /`

Registry information.

```json
{ "name": "splice-registry", "apiVersion": 2, "admin": "enabled", "endpoints": ["GET /health", "…"] }
```

### `GET /health`

`200 {"status":"ok","apiVersion":2}`. Does not touch the database: a healthy `/health` with
failing package routes means the database is unavailable (`503 STORAGE_UNAVAILABLE`).

### `GET /packages/search?q=<query>&limit=<n>`

Searches package names and descriptions (case-insensitive substring; exact name matches first).

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `q` | string | `""` | empty lists packages |
| `limit` | integer | 20 | clamped to 1–100 |

```json
{ "query": "json", "results": [ { "name": "@splice/json", "description": "Official JSON utilities: …", "latest": "0.1.1" } ] }
```

### `GET /packages/:namespace/:name`

Package metadata and all versions (oldest first).

```json
{
  "name": "@splice/json",
  "namespace": "splice",
  "description": "Official JSON utilities: parse, stringify (deterministic) and pick values by path. No permissions.",
  "latest": "0.1.1",
  "versions": [ { "version": "0.1.0", "publishedAt": "…" }, { "version": "0.1.1", "publishedAt": "…" } ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

Errors: `404 NOT_FOUND`, `400 BAD_REQUEST` (invalid name).

### `GET /packages/:namespace/:name/versions`

Versions with integrity and size.

```json
{ "name": "@splice/json", "versions": [ { "version": "0.1.1", "publishedAt": "…", "integrity": "sha256-98fb…", "size": 30743 } ] }
```

### `GET /packages/:namespace/:name/:version`

The full version record: the validated manifest (tools, schemas, permissions), integrity, size,
artifact location and provenance.

```json
{
  "name": "@splice/json",
  "version": "0.1.1",
  "manifest": { "specVersion": 1, "namespace": "splice", "name": "json", "version": "0.1.1", "permissions": { "fs": { "read": [], "write": [] }, "network": [], "env": [] }, "tools": [ "…" ] },
  "integrity": "sha256-98fb8dabb6b3da3bf947ab7fc0058921d340529c5ba5e5b95b3648b0a5fc0568",
  "size": 30743,
  "publishedAt": "…",
  "publishedBy": "splice",
  "download": "/packages/splice/json/0.1.1/download",
  "artifact": { "filename": "splice-json-0.1.1.tar.gz", "backend": "github-releases", "url": "https://github.com/spliceloom/splice-artifacts/releases/download/pkg/splice/json/splice-json-0.1.1.tar.gz" },
  "provenance": { "schemaVersion": 1, "recorded": true, "package": "@splice/json", "version": "0.1.1", "publisher": { "user": "splice", "via": "token" }, "…": "…" }
}
```

`:version` must be an exact version (ranges are resolved by clients). Errors: `404`, `400`.

### `GET /packages/:namespace/:name/:version/download`

The artifact bytes (`application/gzip` for `.tar.gz`; `application/vnd.splice.bundle+json` for
legacy JSON bundles).

| Response header | Meaning |
| --- | --- |
| `x-splice-integrity` | `sha256-<hex>` of the body |
| `content-length` | size in bytes |
| `content-disposition` | `attachment; filename="<ns>-<name>-<version>.tar.gz"` |
| `cache-control` | `public, max-age=31536000, immutable` (versions never change) |

**Clients must verify** the SHA-256 and size against the version record before using the bytes;
the CLI/SDK refuse mismatches and never extract before verifying. The same bytes are also
available at `artifact.url` (GitHub Releases).

### `GET /packages/:namespace/:name/:version/provenance`

```json
{
  "name": "@splice/json",
  "version": "0.1.1",
  "provenance": {
    "schemaVersion": 1,
    "recorded": true,
    "registryApiVersion": 2,
    "package": "@splice/json",
    "version": "0.1.1",
    "namespace": "splice",
    "publisher": { "user": "splice", "via": "token" },
    "publishedAt": "…",
    "artifact": { "integrity": "sha256-98fb…", "size": 30743, "format": "tar.gz", "filename": "splice-json-0.1.1.tar.gz" },
    "manifestSha256": "…"
  },
  "location": { "backend": "github-releases", "url": "https://github.com/…" }
}
```

Provenance is written once at publish and cannot change. `recorded: false` marks versions
published before provenance existed (their record is derived from metadata). Provenance states
facts recorded by the registry; it is **not** a cryptographic signature.

### `GET /namespaces/:namespace`

```json
{ "namespace": "splice", "owner": "splice", "maintainers": [], "reserved": true, "packages": ["@splice/example", "@splice/files", "…"] }
```

### Resolving and verifying a package (client algorithm)

1. `GET /packages/:ns/:name` → pick the highest version matching the range.
2. `GET /packages/:ns/:name/:version` → `integrity`, `size`, `manifest`.
3. `GET …/:version/download` (or `artifact.url`) → bytes.
4. Check SHA-256 and size, decode the archive safely, validate the package, and compare the
   manifest inside the artifact with `manifest` from step 2. Only then install.

`splice verify` / `splice.verify()` implement this plus provenance and direct-URL checks
([trust.md](trust.md)).

## Authenticated endpoints

`Authorization: Bearer <registry token>` (tokens start with `splice_`; get one from a registry
admin, then `splice login`). Requests are rate limited per client; repeated authentication
failures are blocked for 10 minutes (`429`, `Retry-After`).

| Method & path | Token | Purpose |
| --- | --- | --- |
| `POST /publish` | any valid token with rights to the namespace | body: the `.tar.gz` (`application/gzip`, ≤ 5 MB); `201 { name, version, integrity, size, download }` |
| `GET /auth/whoami` | any | `{ user, namespaces, owns, maintains, token }` |
| `GET /auth/tokens` | managing token | list your tokens (never their values) |
| `POST /auth/tokens` | managing token | body `{ label?, namespaces?, expiresInDays? }` (≤ 365); the new token is returned **once** |
| `DELETE /auth/tokens/:id` | managing token | revoke |
| `PUT` / `DELETE /namespaces/:ns/maintainers/:user` | namespace owner, managing token | manage maintainers |
| `POST /mcp` | any | MCP Streamable HTTP for registry discovery (search, package info, SKILL.md); never executes skills ([mcp.md](mcp.md)) |

Publishing rules: versions are immutable (`409` on any republish), the first publish to an
unowned namespace claims it, `@splice` and `@spliceloom` are reserved, `dependencies` is
reserved (`422`). See [publishing.md](publishing.md).

Administrative endpoints (creating users, rotating tokens, migrations) exist for registry
operators and are not part of the public API.

## Examples

```sh
curl -s "https://registry.spliceloom.com/packages/search?q=github"
curl -s "https://registry.spliceloom.com/packages/splice/github"
curl -s "https://registry.spliceloom.com/packages/splice/github/0.1.0/provenance"
curl -s -D - -o github.tgz "https://registry.spliceloom.com/packages/splice/github/0.1.0/download"   # headers + bytes (GET only; HEAD is not routed)
```

```ts
import { RegistryClient } from "@spliceloom/core";
const client = new RegistryClient("https://registry.spliceloom.com");
const pkg = await client.getPackage("@splice/github");
const version = await client.getVersion("@splice/github", pkg.latest);
```
