# Public registry

The Splice registry hosts skill packages: namespaces, versions, artifacts and provenance. It runs
as a Cloudflare Worker with D1 for metadata and GitHub Releases for artifacts.

Current URL: `https://registry.spliceloom.com` (planned: `registry.spliceloom.com`).

## What it provides today

- **Namespaces** (`@splice`, `@yourname`) with an owner and maintainers. The first publish claims an
  unowned namespace; `@splice` is reserved for official skills.
- **Immutable versions.** A published version never changes; the database enforces it.
- **Integrity and provenance.** SHA-256, size, publisher and time recorded at publish.
- **Scoped tokens.** Publish-only tokens limited to namespaces, with an expiry
  ([Publishing](publishing.md)).
- **Public read API** with CORS for anonymous `GET` routes and an edge cache for search and package
  metadata ([Registry API](api.md)).
- **MCP discovery** at `/mcp` for authenticated clients (discovery only; skills never run on the
  registry).

## Using it

```sh
splice search json
splice info @splice/json
splice add @splice/json
splice verify @splice/json
```

Any compatible registry can be used instead with `--registry`, `SPLICE_REGISTRY` or
`splice config set registry <url>` ([CLI](cli.md)).

## Availability

The registry's database runs on Cloudflare's free tier. If its daily quota is exceeded it answers
`503 STORAGE_UNAVAILABLE` and nothing is changed; installed packages keep working offline from the
verified local cache.
