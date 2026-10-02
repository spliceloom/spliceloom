# Package lifecycle & reproducible projects

How a Splice project records what it depends on, installs it again on another machine, finds
and applies updates, and what happens offline.

```sh
splice init                          # splice.json only
splice add @splice/example@^0.1.0    # installs 0.1.x, creates splice.lock
splice outdated                      # current / wanted / latest
splice update                        # newest version allowed by the range
git clone … && splice install        # another machine: exactly what splice.lock records
```

## Project files

| File | Written by | Content |
| --- | --- | --- |
| `splice.json` | `init`, `add`, `remove` | What the project wants: `packages` (id → range), optional `registry`. |
| `splice.lock` | `add`, `install`, `update`, `remove` | What is installed: exact version, SHA-256, size, registry, artifact URL and granted permissions per package. |
| `.splice/packages/` | installs | Extracted package files. Not meant for version control. |

Commit `splice.json` and `splice.lock`; ignore `.splice/`.

`splice init` creates only `splice.json`. `splice.lock` (and `.splice/`) appear with the first
installed package, and removing the last package deletes `splice.lock` and the empty `.splice/`.

### `splice.lock`

```json
{
  "lockfileVersion": 1,
  "packages": {
    "@splice/example": {
      "version": "0.1.1",
      "integrity": "sha256-2c76c7c1a0deb1c351f109f283b2cd8b2f8a02ee712c48ff9d40fe0be4b98d4c",
      "size": 10263,
      "registry": "https://registry.spliceloom.com",
      "resolved": "https://registry.spliceloom.com/packages/splice/example/0.1.1/download",
      "permissions": { "fs": { "read": [], "write": [] }, "network": [], "env": [] }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Exact installed version. |
| `integrity` | `sha256-<hex>` of the artifact. Installs from the lockfile only accept these bytes. |
| `size` | Artifact size in bytes (also enforced). |
| `files` | Digest of the extracted files (Phase 8); re-checked before installed code is loaded, see [trust.md](trust.md#installed-files-phase-8). |
| `registry` | Registry base URL the package was resolved from. |
| `resolved` | Artifact download URL. |
| `permissions` | Permissions granted at install ([trust.md](trust.md#permissions-and-consent)). |

Keys are sorted so the file diffs cleanly. It contains no tokens or credentials.

**Migration.** Projects created before Phase 6 have `splice-lock.json`. It is still read (a
missing `registry` is derived from `resolved`); the next write — any `add`, `install`, `update`
or `remove` — writes `splice.lock` and deletes `splice-lock.json`. Older CLIs do not read
`splice.lock`.

## Installing

### `splice add <package>[@range]`

| Reference | Result |
| --- | --- |
| `@ns/name` | Newest stable version; recorded as `^<version>` (unchanged from earlier phases). |
| `@ns/name@<range>` | If the locked version satisfies the range it is kept (`already installed`); otherwise the highest matching version is installed. |

When the locked version is (re)installed, it is pinned to the lockfile's SHA-256 and size.

### `splice install` — reproducible installs

Installs the project exactly as recorded, e.g. after cloning:

1. Every package in `splice.lock` at its **locked version**, even when newer versions in range exist.
2. The registry's metadata for that version must report the locked SHA-256 and size, and the
   downloaded bytes must hash to it. Otherwise the command stops with `LOCK_MISMATCH` and
   installs nothing for that package (fail closed). Published versions are immutable, so a
   mismatch means a different or compromised registry.
3. A locked version the registry does not have → `LOCK_MISMATCH`.
4. A locked version that does not satisfy the range in `splice.json` (edited by hand) →
   `LOCK_MISMATCH` with the hint to run `splice update <pkg>`.
5. Packages in `splice.json` that are not locked yet are resolved from their range and locked.
6. Packages already installed at the locked version are left alone.
7. Permissions recorded in the lock count as granted; a manifest requesting more, or a lock entry
   without a grant record, needs `--accept-permissions`.

The same verification as always runs (SHA-256, size, archive safety, package validity, registry
metadata vs. manifest). SDK: `splice.install()`.

`splice add` without a package remains a usage error (exit 2), as in earlier phases.

## Finding updates: `splice outdated`

```
$ splice outdated
Package          Current  Wanted  Latest  Range
@splice/example  0.1.0    0.1.1   0.1.1   ^0.1.0  update available

1 package(s) can be updated: splice update
```

| Column | Meaning |
| --- | --- |
| Current | Version in `splice.lock` (`-` when not installed). |
| Wanted | Highest registry version satisfying the `splice.json` range: what `splice update` installs. |
| Latest | Highest stable registry version, regardless of the range. |

Status: `up-to-date`, `update-available`, `not-installed`, `no-match` (no registry version
satisfies the range). When `Latest` is outside the range, the command says how to move to it
(`splice add <pkg>@^<latest>`). Read-only; exit code 0 either way. `--json` prints
`[{ id, range, current, wanted, latest, status }]`. Optional package arguments limit the check.
SDK: `splice.outdated(ids?)`.

## Updating: `splice update [package ...]`

Updates each package (default: all of `splice.json`) to **Wanted**. The range in `splice.json` is
never changed; moving to a new major version is an explicit `splice add <pkg>@^2.0.0`.

Per package:

1. Resolve the highest version in range.
2. Fetch and check version metadata (valid SHA-256).
3. Artifact from the verified local cache or a download (download header must match metadata).
4. Full verification: SHA-256, size, archive, package, metadata vs. manifest.
5. Permission check: a version requesting permissions beyond the current grant needs
   `--accept-permissions`.
6. Stage and validate in `.splice/tmp`.
7. Swap: the old version is moved aside, the new one moved in, `splice.json`/`splice.lock`
   written; only then is the old copy deleted.

Any failure — including a failure while writing `splice.lock` — puts the previous version back
and restores both project files. Packages updated earlier in the same run stay updated.

Output: `Updated <pkg> <from> -> <to>`, `<pkg>@<v> is up to date`, or
`no registry version satisfies "<range>"; nothing changed` (exit code 1). When everything is
current: `Everything is up to date. splice.lock was not changed.` `--json` prints
`[{ id, range, from, to, latest, status }]` with status `updated` / `up-to-date` / `no-match`.
SDK: `splice.update(ids?, { acceptPermissions?, onStep? })`.

## Local artifact cache

`<SPLICE_HOME>/cache/artifacts/sha256/<hex>` (default `~/.splice/cache/artifacts`).

- Keyed by the artifact's SHA-256; only artifacts that passed full verification are stored.
- Every read re-hashes the entry; a mismatch deletes it and the entry is treated as missing.
- Cached bytes go through the complete verification pipeline, exactly like a download. The
  cache saves a download, never a check.
- Holds artifact bytes only — no metadata, tokens or credentials.
- Safe to delete at any time. Writing to it is best effort and never fails an install.
- SDK: `new Splice({ cache: "/path" })`, or `cache: false` to disable it.

## Offline behaviour

| Operation | Registry unreachable |
| --- | --- |
| `splice install` | Locked versions are installed from the verified cache, checked against the lockfile's SHA-256 and size. Registry metadata cannot be compared; the output says `offline`. Without a cached copy: `REGISTRY_UNREACHABLE` ("not in the local cache"). |
| `splice add <pkg>` | Same, if the package is locked and the requested range (if any) is satisfied by the locked version. Otherwise `REGISTRY_UNREACHABLE`. |
| `splice outdated`, `splice update` | `REGISTRY_UNREACHABLE` (they need the registry). |
| `splice list`, `splice run`, `splice mcp` | Work (they only use installed files). |

## Error codes

| Code | When |
| --- | --- |
| `LOCK_MISMATCH` | The registry serves a different SHA-256/size for a locked version, does not have it, or the lock does not satisfy the `splice.json` range. Nothing is changed. |
| `REGISTRY_UNREACHABLE` | Network error and no usable cached copy. |
| `INTEGRITY_MISMATCH` | Downloaded bytes do not match the metadata. |
| `PERMISSIONS_NOT_ACCEPTED` | A new or updated version requests permissions not granted yet. |
| `NO_MATCHING_VERSION` | `add` with a range nothing satisfies (`update` reports `no-match` instead). |
