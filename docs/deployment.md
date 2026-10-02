# Deployment (Cloudflare)

> **Production:** https://registry.spliceloom.com — Worker + D1 (metadata) +
> **GitHub Releases** (artifacts, repository `spliceloom/splice-artifacts`).
> **R2 is not required** and not configured (it needs a payment method). The custom domain is
> declared in `wrangler.toml` (`routes`, `custom_domain = true`); the Worker's workers.dev URL
> stays enabled for older clients. The website is the
> `spliceloom` Worker (`apps/site/wrangler.jsonc`: spliceloom.com, www) and the docs are the
> `splice-docs` Worker (`apps/site/wrangler.docs.jsonc`: docs.spliceloom.com). The repository
> contains no credentials; the D1/KV ids in `wrangler.toml` are useless without account access.

Configuration: [`apps/registry/wrangler.toml`](../apps/registry/wrangler.toml) — Worker
`splice-registry`, D1 binding `DB`, vars `GITHUB_OWNER` / `GITHUB_REPO`, rate-limit bindings.
No KV or R2 binding (the Phase 2 KV artifacts were migrated to GitHub on 2026-10-01). Migrations live in
`apps/registry/migrations/`. All commands use the repo-pinned wrangler through
`node scripts/wrangler.mjs` (telemetry disabled), run from the repo root.

## Required configuration

| Name | Kind | Value |
| --- | --- | --- |
| `GITHUB_OWNER` | var (`wrangler.toml`) | owner of the artifact repository, e.g. `spliceloom` |
| `GITHUB_REPO` | var (`wrangler.toml`) | artifact repository, e.g. `splice-artifacts` |
| `GITHUB_TOKEN` | **secret** | fine-grained PAT: *Only select repositories* → the artifact repo; *Repository permissions → Contents: Read and write*; nothing else |
| `GITHUB_TAG_PREFIX` | var, optional | release tag prefix (default `pkg/`) |
| `ADMIN_TOKEN_SHA256` | **secret** | SHA-256 of the admin token |

The artifact repository must be **public** (so `artifact_url` is a public download URL; private
repositories also work — downloads then go through the Worker with the token) and must have at
least one commit (e.g. created with a README): GitHub cannot create release tags in an empty
repository. When the token expires, publishing fails with `502` until a new token is set with
`secret put GITHUB_TOKEN`; installs of already-published versions keep working for public repos.

## One-time setup

```sh
npm install && npm run build

node scripts/wrangler.mjs login

# 1. D1 database — copy the printed database_id into wrangler.toml (replace the zero UUID).
node scripts/wrangler.mjs d1 create splice-registry

# 2. Artifact storage — GitHub Releases:
#    create a public repository with a README, set GITHUB_OWNER/GITHUB_REPO in wrangler.toml,
#    create the fine-grained token (see the table above) and store it as a secret:
node scripts/wrangler.mjs secret put GITHUB_TOKEN          # paste the token at the prompt
#    (KV or R2 remain possible alternatives; R2 needs a payment method.)

# 3. Schema
node scripts/wrangler.mjs d1 migrations apply splice-registry --remote

# 4. Admin token: generate locally, store ONLY the hash as a Worker secret.
npm run registry:admin -- new-admin-token
node scripts/wrangler.mjs secret put ADMIN_TOKEN_SHA256     # paste the hash
# Keep the admin token itself in a password manager.
```

## Deploy

```sh
npm run build          # type-check, tests are separate: npm test
npm run registry:deploy
```

Custom domain: the `routes` entry in `wrangler.toml` (`registry.spliceloom.com`, `custom_domain = true`;
the zone must be on the same account) — Cloudflare creates the DNS record and certificate on deploy.

## Migrating Phase 2 artifacts (KV → GitHub)

With both GitHub configured and the KV binding present:

```sh
export SPLICE_ADMIN_TOKEN=...   # PowerShell: $env:SPLICE_ADMIN_TOKEN = ...
npm run registry:admin -- migrate-artifacts --registry https://registry.spliceloom.com
```

Each artifact is verified against its recorded SHA-256 before and after copying. Once
`migrated` lists every version and `skipped` is empty, remove the `[[kv_namespaces]]` block from
`wrangler.toml` and deploy again.

## Bootstrap users and the official namespace

```sh
export SPLICE_ADMIN_TOKEN=splice_admin_...          # the plaintext admin token
export SPLICE_REGISTRY=https://registry.spliceloom.com   # or the workers.dev URL
npm run registry:admin -- create-user splice
npm run registry:admin -- set-owner splice splice
npm run registry:admin -- create-token splice ci
echo "<token>" | splice login
splice publish skills/example
```

## Updating

1. `npm test` (applies every migration to fresh local D1/SQLite databases).
2. `npm run registry:backup` (see below).
3. Schema changes: `node scripts/wrangler.mjs d1 migrations apply splice-registry --remote`.
   Migrations must stay backward compatible with the currently deployed Worker (add, don't drop).
4. `npm run build && npm run registry:deploy`.

Applied so far in production: `0001_initial`, `0002_tokens_maintainers`, `0003_rate_limits`,
`0004_artifact_location`, `0005_provenance_immutability`.

## Backups and restore

```sh
npm run registry:backup            # production; needs `wrangler login`
npm run registry:backup -- --local # local wrangler state
```

Creates `backups/<timestamp>/` (git-ignored) with:

- `d1.sql` — full D1 export (schema + data, including token **hashes**; keep backups private);
- `artifacts/packages/...` — every artifact referenced by D1, downloaded from its GitHub release URL
  (or legacy KV), each verified against the SHA-256 in its key;
- `backup.json` — summary.

The command is read-only against the registry. Run it before every migration.

**Restore options**

- Recent mistakes: D1 Time Travel (point-in-time, managed by Cloudflare) —
  `node scripts/wrangler.mjs d1 time-travel info splice-registry` and
  `node scripts/wrangler.mjs d1 time-travel restore splice-registry --timestamp=<ISO-8601>`.
- From a backup into a new/empty database:
  `node scripts/wrangler.mjs d1 execute <database> --remote --file backups/<ts>/d1.sql`, then
  `d1 migrations apply <database> --remote` to reach the latest schema. Verified locally: restoring
  the production export into an empty D1 database reproduced all packages, versions, users and
  the migration history.
- Artifacts: GitHub release assets are durable on their own; if one is lost, re-upload the backed-up
  file to release `pkg/<ns>/<name>` with the asset name `<ns>-<name>-<version>.tar.gz` (GitHub web UI
  or API). The SHA-256 is unchanged, so D1 needs no change.

## Still required before a public launch

- Schedule backups (e.g. a CI job running `npm run registry:backup` with a scoped Cloudflare API token).
- Rotate `GITHUB_TOKEN` before it expires (fine-grained tokens have an expiry date).
