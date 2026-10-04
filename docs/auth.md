# Authentication, tokens, namespaces & rate limits

## Implemented now

### Tokens

- A registry user authenticates with an API token: `splice_` + 256 random bits (base64url).
  The prefix makes leaked tokens easy to find with secret scanners.
- The server stores **only the SHA-256 hash** of each token (`tokens.token_hash`). Because tokens
  are 256-bit random values, a fast hash is sufficient: reversing it is as hard as guessing the
  token. The plaintext is returned exactly once, when the token is created.
- Tokens are sent as `Authorization: Bearer <token>` and are never logged by the registry, never
  written into package metadata and never returned by any listing.

Each token has:

| Property | Meaning |
| --- | --- |
| `canManage` | **Full** tokens (issued by an admin) may manage tokens and namespace maintainers. **Publish-only** tokens (created by users) may only publish and call `whoami`. |
| `namespaces` | `null` = every namespace the user may publish to; otherwise an allow-list. Publishing outside it → `403 TOKEN_SCOPE` (and never claims a namespace). |
| `expiresAt` | Optional; expired tokens get `401`. API-created tokens live at most 365 days. |
| `revokedAt` | Revoked tokens get `401`. |
| `lastUsedAt` | Updated on every authenticated request. |

### Sign-up with a GitHub account

Anyone with a personal GitHub account can get a publisher token at
[agents.spliceloom.com](https://agents.spliceloom.com), without a password or an OAuth app:

1. Enter the GitHub username. The registry returns a one-time code (valid for 30 minutes).
2. Create a **public gist** on that account with the code as its description.
3. Verify. The registry reads the account's public profile and public gists from the GitHub API,
   finds the code, and returns a token once.

The account is named after the GitHub username (lowercase) and owns the namespace of the same name.
The token is limited to that namespace (`namespaces: ["<username>"]`), expires after 365 days, and
tokens created from it inherit that limit. Verifying again issues a new token for the same account.

Refused: organizations and bots, GitHub accounts younger than 30 days, usernames that are not valid
namespace names, and any username whose registry account or namespace already belongs to someone
else (accounts created by an admin are never taken over). Sign-up is limited to 10 attempts per
10 minutes per client.

API: `POST /signup/start {"github": "<username>"}` then `POST /signup/verify {"github", "code"}`.

### Self-service tokens (CLI)

```sh
splice token create --label ci --namespace dim --expires 90d   # prints the token once (stdout)
splice token list                                               # never shows secrets
splice token revoke <token-id>
```

Typical CI setup: create a publish-only token scoped to your namespace with an expiry, store it as
a CI secret and use it as `SPLICE_TOKEN` for `splice publish`. Managing tokens requires a full token;
users can only see and revoke their own tokens (others' tokens are reported as not found).

### Admin

Besides GitHub sign-up, an operator holding the **admin token** can create users and their first
(full) token through the admin API.

- The Worker is configured with `ADMIN_TOKEN_SHA256` (a Cloudflare secret) — the hash, not the
  admin token itself. If it is unset the admin API is disabled (`403 ADMIN_DISABLED`).
- `npm run registry:admin --` wraps the admin API and reads the admin token from
  `SPLICE_ADMIN_TOKEN`, so it never appears in shell history:

```sh
npm run registry:admin -- new-admin-token          # prints a token + ADMIN_TOKEN_SHA256 value
export SPLICE_ADMIN_TOKEN=splice_admin_...
npm run registry:admin -- create-user dim --registry https://registry.spliceloom.com
npm run registry:admin -- create-token dim laptop  # full token, printed once
npm run registry:admin -- revoke-token <token-id>
npm run registry:admin -- set-owner splice dim     # assign the reserved @splice namespace
```

The admin API also accepts `namespaces`, `expiresInDays` and `canManage` when creating tokens.

### CLI credentials

```sh
splice login                 # hidden prompt; or: echo "$TOKEN" | splice login
splice whoami                # user, owned/maintained namespaces, current token scope
splice logout
```

`splice login` verifies the token with `GET /auth/whoami` before saving it to
`~/.splice/credentials.json`, keyed by registry URL (file mode `0600` on POSIX; on Windows it
inherits the user-profile ACL). `SPLICE_TOKEN` overrides the saved token. `SPLICE_HOME` relocates
`~/.splice`.

### Namespaces and maintainers

| Situation | Publishing to `@ns/...` |
| --- | --- |
| `@ns` does not exist | Allowed; the publisher becomes the owner (first publish claims it). |
| You own it | Allowed. |
| You are a maintainer | Allowed. |
| Owned by another user | `403 FORBIDDEN` |
| Reserved and unassigned (`@splice`, `@spliceloom`) | `403 NAMESPACE_RESERVED` until an admin runs `set-owner`. |
| Owner cleared by an admin (not reserved) | Claimable again by the next publisher. |

The owner (with a full token) manages maintainers:

```sh
splice namespace info dim
splice namespace add-maintainer dim alice
splice namespace remove-maintainer dim alice
```

Maintainers can publish but cannot manage maintainers. Namespace info (owner, maintainers,
packages) is public. In Windows PowerShell write `dim` or `'@dim'`: an unquoted `@dim` is
interpreted by PowerShell itself.

### MCP authentication

- Registry `/mcp`: requires a registry bearer token (any valid, unexpired, unrevoked token —
  publish-only CI tokens work). Missing/invalid tokens get `401` and count toward the
  failed-authentication limit.
- `splice mcp --http`: requires the operator-chosen `SPLICE_MCP_TOKEN` (≥ 24 characters). It is
  independent of registry tokens: it only gates execution of the skills installed on that machine.
- `splice mcp` (stdio) has no network surface; the launching process is the trust boundary.

### Rate limits

| Limit | Scope | Enforcement |
| --- | --- | --- |
| Failed authentications (user or admin token) | 20 per 10 minutes per client IP; the client is then blocked for the rest of the window (`429`, `Retry-After: 600`), even with a valid token | D1 counter (strongly consistent) |
| Publishes | 10 per minute per user (`429`) | D1 counter (strongly consistent) |
| Authenticated requests | 60 per minute per client IP | Cloudflare Rate Limiting binding (approximate) |
| Admin API | 30 per minute per client IP | Cloudflare Rate Limiting binding (approximate) |

Public reads (search, metadata, downloads) are not rate limited by the registry. Only failures
and publishes write counters, so normal traffic costs no D1 writes. The client IP is the
`cf-connecting-ip` header set by Cloudflare's edge.

Measured on the production registry: 20 requests with an invalid token returned `401`, the 21st
and later `429`, while public reads kept returning `200`. The Cloudflare bindings alone did not
throttle 200 rapid requests — they count per machine/location — which is why the security-relevant
limits use D1.

## Future (not implemented)

- Self-service accounts, OAuth / social login, email verification.
- Organizations and teams owning namespaces; per-package (rather than per-namespace) maintainers.
- Fine-grained scopes beyond namespace + publish/manage.
- Signing keys tied to individual users (today keys are registered per namespace by its owner;
  see [signing.md](signing.md)).
