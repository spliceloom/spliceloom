# @splice/github

Read-only access to **public** GitHub data through the GitHub REST API: repository details, the
repositories of a user or organization, and repository search.

**Permissions: `network: ["api.github.com"]`.** Installing needs `--accept-permissions`. The
sandbox refuses every other host. No files, no environment variables.

## Authentication

None. Requests are anonymous, which means:

- only public repositories are visible;
- GitHub allows about **60 requests per hour** per IP address (search: about 10 per minute).
  Every result includes `rateLimit` (`limit`, `remaining`, `resetAt`); when it is used up the tool
  fails with `RATE_LIMITED: …` and the reset time.

The package declares no environment variables, so it cannot read a `GITHUB_TOKEN` — never put a
personal token into a package. Authenticated operations are intentionally not part of this
version.

## Tools

### `github.get-repo`

Input: `owner` (user/org login), `repo`.
Output: `{ repository, rateLimit }`.

### `github.list-repos`

Input: `owner`, `type` (`owner` default, `all`, `member`), `sort` (`updated` default, `created`,
`pushed`, `full_name`), `perPage` (1–50, default 20), `page` (1–100).
Output: `{ owner, page, perPage, repositories: [repository], hasMore, rateLimit }`.

### `github.search-repositories`

Input: `query` (GitHub search syntax, e.g. `mcp language:typescript stars:>100`), `sort`
(`best-match` default, `stars`, `forks`, `updated`), `order` (`desc` | `asc`), `perPage` (1–50,
default 10), `page` (1–10).
Output: `{ query, totalCount, incompleteResults, page, perPage, repositories, rateLimit }`.

### `repository`

```json
{ "fullName": "owner/name", "name": "name", "owner": "owner", "description": "…" , "url": "https://github.com/owner/name",
  "homepage": null, "defaultBranch": "main", "language": "TypeScript", "license": "MIT", "topics": [],
  "stars": 0, "forks": 0, "openIssues": 0, "archived": false, "fork": false,
  "createdAt": "…", "updatedAt": "…", "pushedAt": "…" }
```

### Errors

`INVALID_INPUT` (malformed owner/repo/query, or GitHub validation failure), `NOT_FOUND` (missing
or not public), `RATE_LIMITED`, `TIMEOUT` (10 s), `NETWORK_ERROR`, `GITHUB_ERROR` (other HTTP
errors), `RESPONSE_TOO_LARGE` (> 1 MiB).

## Examples

```sh
splice add @splice/github --accept-permissions
splice run github.get-repo owner=spliceloom repo=splice-artifacts
splice run github.search-repositories query="mcp language:typescript" sort=stars
```

See `examples/`.
