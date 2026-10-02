# Releasing

Two kinds of releases exist and are independent:

1. **The Splice CLI** on npm (`@spliceloom/cli`, installs the `splice` command).
2. **Skill packages** in the Splice registry (e.g. `@splice/json@0.1.1`).

No CI/CD pipeline exists; releases are run by a maintainer from a clean checkout. Nothing here
requires storing npm or GitHub tokens in the repository.

## CLI release (npm)

### 1. Version bump

The CLI version is `packages/cli/package.json` → `version` (printed by `splice --version`). The
bundled workspace packages keep their own versions; bump them when their code changed.

### 2. Test

```sh
npm install
npm test            # builds, then runs every test
npm run typecheck
npm audit
```

### 3. Build

```sh
npm run build
```

### 4. Pack and inspect

```sh
node scripts/pack-cli.mjs --dry-run --list
```

This stages `dist-npm/cli/` — the CLI plus the bundled `@spliceloom/{spec,runtime,core,sdk,mcp}`
(declared as `bundleDependencies`, so installing needs nothing else from npm) — runs
`npm pack --dry-run`, prints every file and **fails** if anything other than `package.json`,
`README.md`, `LICENSE` and compiled `dist/` files would be published (tests, source maps, sources,
configuration, `.env`, credentials, local data).

Then create the tarball:

```sh
node scripts/pack-cli.mjs          # → dist-npm/spliceloom-cli-<version>.tgz
```

### Local installation test

Install the tarball into a throw-away prefix (your global installation is untouched) and smoke
test it with a fresh `SPLICE_HOME`:

```sh
npm install -g ./dist-npm/spliceloom-cli-0.1.0.tgz --prefix /tmp/splice-prefix
/tmp/splice-prefix/bin/splice --version        # Windows: <prefix>\splice.cmd
SPLICE_HOME=/tmp/splice-home /tmp/splice-prefix/bin/splice --help
cd "$(mktemp -d)" && splice init && splice search github && splice info @splice/github
```

### 5. Publish (manual, owner only)

Prerequisites:

- an npm account that owns the `@spliceloom` scope (npm user or organization named `spliceloom`);
- `npm login`; with two-factor authentication enabled, npm asks for a one-time password
  (`--otp=<code>`).

```sh
cd dist-npm/cli
npm publish --access public
```

`--access public` is required the first time for a scoped package (it is also set in
`publishConfig`). Publishing is irreversible for that version number: npm never allows
re-publishing a version, and unpublishing is restricted.

Verify:

```sh
npm view @spliceloom/cli version
npm install -g @spliceloom/cli && splice --version
```

### 6. Source release

Tag the release (`cli-v0.1.0`) in the source repository and attach the tarball and its SHA-512
(printed by `pack-cli.mjs`) to a release entry.

### Future improvement: trusted publishing

npm supports publishing from GitHub Actions via OIDC ("trusted publishing") with provenance
statements, without long-lived npm tokens. Adopt it once the source repository and CI exist;
until then publish manually as above.

## Skill package release (registry)

```sh
node --test skills/<name>/tests/*.test.ts        # the skill's own tests
npm test                                         # includes sandbox/SDK/MCP tests of official skills
splice publish skills/<name> --dry-run           # validate + pack, no network
splice publish skills/<name>                     # needs `splice login`
splice verify @<ns>/<name>@<version>             # sha256, size, package, metadata, provenance, source
```

Rules:

- **Versions are immutable.** The registry refuses any second artifact for a published version
  (`409`), GitHub assets are never replaced, and D1 triggers reject changes to published rows. A
  fix is always a new version.
- **Keep the source identical to the published artifact.** Editing files of a published version
  (even `SKILL.md`) without bumping the version makes the repository disagree with the registry;
  `packDirectory(dir).integrity` must equal the published `integrity`.
- After publishing, check in a clean project: `splice add`, `splice run`, `splice outdated` /
  `splice update` from the previous version.

## Production verification

After a registry deployment or a release, run a read-only check (no login needed):

```sh
curl -s https://registry.spliceloom.com/health
splice search official
splice info @splice/json
splice verify @splice/json
splice add @splice/json && splice run json.parse text='{"ok":true}' && splice remove @splice/json
```

If `/health` is fine but package routes return `503 STORAGE_UNAVAILABLE`, the database is
unavailable (for example the Cloudflare account's D1 daily quota); installed packages keep
working and the registry recovers without redeploying.

## Registry (Worker) deployment

See [deployment.md](deployment.md) (maintainers). Registry deployments never change published
packages.
