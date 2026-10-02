# Contributing to Splice

## Setup

Requirements: Node.js ≥ 22.18 (developed on 24.x) and npm. No Cloudflare account or Docker is
needed for development and tests.

```sh
npm install
npm run build        # clean build of all packages + Worker bundle
npm test             # build, then every unit, integration and end-to-end test
npm run typecheck    # strict type-check incl. skills/, examples/ and apps/site
npm audit
```

Builds always start clean: TypeScript's incremental state was observed to skip re-checking
changed dependencies.

**Windows:** if PowerShell refuses to run `npm` ("running scripts is disabled", `npm.ps1`), that is
the machine's execution policy. Use `npm.cmd …` or change the policy for your user; do not change
application code to work around it.

Local registries (Worker in workerd or Node.js + SQLite): [docs/local-development.md](docs/local-development.md).

## Where things live

See the repository table in [README.md](README.md) and [docs/architecture.md](docs/architecture.md).
Tests sit next to the code (`*.test.ts`, compiled to `dist/`), plus `skills/*/tests/*.test.ts`
and `apps/site/tests/*.test.ts` (run with Node's type stripping).

## Changes

- Keep the zero-runtime-dependency policy. New dependencies need a clear reason and must not add
  `npm audit` findings.
- Match the style of the surrounding code; TypeScript strict mode.
- Every behaviour change needs tests; keep existing coverage.
- User-facing errors say what happened, why, and what to do next — and never contain secrets
  (`redactSecrets` in `@spliceloom/spec`).

### Skill packages

Follow [docs/authoring-skills.md](docs/authoring-skills.md). A published version is immutable:
never edit files of a published version (including `SKILL.md`) without bumping the version — the
repository must stay byte-identical to the registry artifact.

### Documentation

Docs are plain Markdown in `docs/` and are also rendered into the website. `npm test` checks that
relative links resolve and that every documented `splice` command and option exists. Only document
what the implementation does.

### Security-sensitive changes

Changes to the runtime/sandbox (`packages/runtime`), network policy, verification
(`packages/spec/src/verify.ts`, `packages/core`), the registry's auth/publish paths or the
`@splice/files` / `@splice/http` path and URL rules need:

- regression tests for the attack being prevented (see `runtime.test.ts`, `net-policy.test.ts`,
  `official-skills.test.ts`);
- an update of [docs/security.md](docs/security.md) that states guarantees precisely — no
  stronger claims than the code provides;
- no weakening of existing restrictions to make something work.

Never commit `.env` files, tokens, private keys, `apps/registry/.dev.vars`,
`apps/registry/.dev.admin-token`, `.data/` or `backups/` (all git-ignored).

## Pull requests

- One topic per PR, with a description of what changed and why.
- `npm test`, `npm run typecheck` and `npm audit` pass.
- Docs updated when behaviour or commands change.
- For releases see [docs/releasing.md](docs/releasing.md).
