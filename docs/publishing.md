# Publishing & installing remote packages

## Publishing

```sh
splice login                          # once per registry
splice publish ./skills/my-skill      # or run inside the skill directory
```

```
Validating ./skills/my-skill...
Packaging @dim/my-skill@0.1.0...
Uploading and registering at https://registry.spliceloom.com...
Published @dim/my-skill@0.1.0 to https://registry.spliceloom.com
  3 files, 1734 bytes, sha256-9b2a59…
```

What happens:

1. **Validate** — the directory is packed and checked against the package spec (manifest,
   `SKILL.md`, tool entries, schemas, permissions). Hidden files (`.env`, `.git`) and
   `node_modules` are never packed; symlinks are rejected.
2. **Package** — a deterministic `<namespace>-<name>-<version>.tar.gz` and its SHA-256 are produced
   locally ([spec.md](spec.md#package-archive-targz)).
3. **Upload & register** — one `POST /publish` with your token. The server re-validates the
   archive with the same validator, checks your namespace permission and the version, uploads the
   artifact to **GitHub Releases** (verifying GitHub's digest) and then writes the metadata to D1
   (see [registry.md](registry.md#publish-pipeline-server-side)).
4. The CLI checks that the integrity the registry recorded equals the one computed locally.

`splice publish --dry-run` performs steps 1–2 only (no network, no login).

Provenance (publisher, namespace, time, artifact SHA-256/size/format, manifest hash, registry API
version) is recorded with every version — see [trust.md](trust.md).

Rules: versions are immutable (`409` on republish, with different *or* identical content — bump
`version`; stored artifacts are never overwritten); declaring `dependencies` is rejected (reserved);
hidden files/`node_modules` are rejected; build metadata (`1.0.0+x`)
is rejected; bundles are limited to 5 MB / 500 files; the first publish to an unowned namespace
claims it (see [auth.md](auth.md#namespaces-and-maintainers)).

## Installing from a remote registry

```sh
splice config set registry production     # or a URL, or `local`
splice add @splice/example
```

1. `GET /packages/:ns/:name` → versions; the highest version matching the range is chosen.
2. `GET /packages/:ns/:name/:version` → manifest + integrity.
3. `GET …/:version/download` → the `.tar.gz` (served by the registry from GitHub Releases; the
   direct GitHub URL is also listed in the version metadata as `artifact.url`).
4. Verify, in order, stopping at the first failure ([trust.md](trust.md#verification)): SHA-256
   (and the `x-splice-integrity` header), size, safe decoding + package validation + expected
   name/version, registry manifest = manifest inside the artifact, signature policy.
5. Permission consent: if the package requests permissions not already granted, stop unless
   `--accept-permissions` / `acceptPermissions` was given.
6. Extract into `.splice/tmp/…` (never outside the project), validate with the runtime loader,
   then move into `.splice/packages/@ns/name` and update `splice.json` / `splice.lock`
   (version, integrity, size, registry, download URL, granted permissions). A failure restores
   the previous version ([lifecycle.md](lifecycle.md)).

There is no option to skip verification. Check a version without installing it:
`splice verify @splice/example@0.1.1`.

**No package code runs during installation.** Tools execute only via `splice run`, inside the
runtime sandbox ([runtime.md](runtime.md)).

## Choosing a registry

Precedence: `--registry` → `SPLICE_REGISTRY` → `splice.json` `"registry"` →
`~/.splice/config.json` → default (`https://registry.spliceloom.com`).
Aliases: `local` = `http://127.0.0.1:8787`, `production` = `https://registry.spliceloom.com`.
Any other URL (e.g. a staging `*.workers.dev` deployment) works the same way.

```sh
splice config get registry          # shows the URL and where it came from
splice --registry local search example
```

## Integrity

**Implemented:** SHA-256 of every artifact, computed by the CLI and the registry at publish time,
checked against GitHub's own asset digest on upload, recorded in D1, verified by the CLI on every
download (a mismatch aborts the install before anything is extracted), and pinned in
`splice.lock`; `splice install` on another machine accepts only those bytes. Because archives are deterministic, anyone can re-pack a package directory and
compare hashes.

**Not implemented:** cryptographic signatures. A checksum proves the bytes match what the
registry recorded, not who authored them. Provenance (publisher, time, artifact hashes) is
recorded by the registry; signatures are future work.

Releasing the CLI itself on npm is described in [releasing.md](releasing.md).
