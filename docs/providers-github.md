# GitHub

Read-only GitHub data for agents through the official REST API, plus public raw files.

| Provider id | Access | Notes |
| --- | --- | --- |
| `github` | `GITHUB_TOKEN` (Bearer) | 5,000 requests/hour; code search and the authenticated user |
| `github-public` | anonymous | 60 requests/hour per IP; used without a token or when the token is rejected (recorded as a fallback) |
| `github-raw` | anonymous | public files from `raw.githubusercontent.com` only; the token is never sent there |

`GITHUB_API_VERSION` sets the `X-GitHub-Api-Version` header (default `2022-11-28`).

## Use it

```sh
splice github repo nodejs/node
splice github search "language:typescript stars:>10000"
splice github contents nodejs/node README.md --ref main
splice github commits nodejs/node
splice github releases nodejs/node
splice github issues nodejs/node --state open
splice github code "createGuardedFetch language:typescript"
splice github raw https://raw.githubusercontent.com/nodejs/node/main/README.md
```

SDK: `splice.github.repository()`, `searchRepositories()`, `contents()`, `tree()`, `commits()`,
`branches()`, `releases()`, `release()`, `issues()`, `pullRequests()`, `user()`, `searchCode()`,
`raw()`. MCP: `github_repository`, `github_search_repositories`, `github_contents`,
`github_commits`, `github_releases`, `github_raw`.

## Behaviour

- File contents are decoded from base64 with path, ref, size, sha and URL; binary files are not
  returned as text. Directory listings, recursive trees and pagination (`page`, `perPage` up to 100,
  `nextPage` from the Link header) are supported.
- Issues lists remove pull requests (GitHub returns both) and say how many were removed.
- Errors are precise: bad credentials → the token provider is marked `auth_failed`; an exhausted
  rate limit → `RATE_LIMITED` with the reset time; other 403, 409 (empty repository) and 422 →
  `PROVIDER_ERROR`; 404 → `NOT_FOUND`. An empty list is returned only when GitHub returned one.
- Raw URLs must be exactly `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`: no other
  host, port, credentials, query, fragment, `..` segments or encoded separators.
- Rate-limit headers are reported in `provenance.rateLimit`, the request id in
  `provenance.requestId`.

There are no write operations.
