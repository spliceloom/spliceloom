# Trust model: identity, integrity, provenance, verification

Splice establishes *facts* about a package version and checks them before anything is installed
or executed. It does not compute trust or reputation scores.

```
Package ─▶ Identity ─▶ Version ─▶ Artifact ─▶ Integrity ─▶ Provenance ─▶ Verification ─▶ Install ─▶ Sandbox
```

## Identities

| Identity | What it is | Stable when… |
| --- | --- | --- |
| **Package** | `@namespace/name`, e.g. `@splice/example`. Owned via its namespace (owner + maintainers). | always — storage location, URLs and backends are not part of it |
| **Version** | `@namespace/name@1.2.3` (semver, no build metadata). Immutable once published. | always |
| **Artifact** | The exact bytes of that version: a deterministic `.tar.gz`, identified by `sha256-<hex>` and its size. | always — the same package directory always packs to the same bytes |
| **Publisher** | The registry user whose token published the version, recorded in provenance. | recorded once, never changes |
| **Location** | Where the bytes are stored (`artifact_backend`, `artifact_url`, e.g. a GitHub release asset). | may change (migration/mirror) without changing any identity above |

## Integrity

Every published version records: package name, exact version, artifact SHA-256, artifact size,
artifact reference (key + URL), publish timestamp, publisher and namespace.

**SHA-256 verifies integrity: the bytes are exactly the ones the registry recorded. It is not a
digital signature and does not, by itself, prove that the publisher is trustworthy or that the
code is safe.** It protects against corrupted or swapped artifacts, not against a malicious
publisher.

### Installed files (Phase 8)

`splice.lock` also records `files`: a digest of the extracted files (`filesDigest` in
`@spliceloom/spec`: SHA-256 over sorted `path\0sha256(content)\n` lines, format independent). The
SDK, the CLI and MCP recompute it from disk — counting every file, hidden ones included — before
loading a package. A mismatch fails with `INSTALLED_PACKAGE_MODIFIED` (the package is neither run
nor listed over MCP); `splice list` shows it as `invalid`, and `splice install` reinstalls the
verified artifact. An edited digest in the lock is refused the same way. Lock entries from before
Phase 8 have no digest and are not checked. See [security.md](security.md#installed-code-and-supply-chain).

## Immutable versions

- Publishing an existing version is always rejected with `409 VERSION_EXISTS` — with different
  content (*"versions are immutable, publish a new version"*) and also with the identical artifact
  (*"already published with this exact artifact"*). The registry never replaces a version.
- The artifact store never overwrites a stored asset: re-uploading identical bytes is a no-op
  (used to retry after a metadata write failure); different bytes for an existing asset name are
  rejected (`409`), even if the earlier publish never completed.
- D1 enforces it too (migration `0005`): triggers abort any `UPDATE` of a version's
  `package_id`, `version`, `manifest`, `integrity`, `size`, `artifact_key`, `published_by`,
  `published_at`, any `DELETE` of a version, and any second write of `provenance`. Only the
  storage location (`artifact_backend`, `artifact_url`) can change.

## Provenance

Recorded at publish time (`versions.provenance`, JSON) and served at
`GET /packages/:ns/:name/:version/provenance` and in the version metadata:

```json
{ "schemaVersion": 1, "recorded": true, "registryApiVersion": 2,
  "package": "@splice/example", "version": "0.1.1", "namespace": "splice",
  "publisher": { "user": "splice", "via": "token" },
  "publishedAt": "…",
  "artifact": { "integrity": "sha256-…", "size": 10263, "format": "tar.gz", "filename": "splice-example-0.1.1.tar.gz" },
  "manifestSha256": "…" }
```

Versions published before provenance existed report `"recorded": false` with a record derived
from their metadata (`registryApiVersion` and `manifestSha256` are `null`). This is not an
attestation system (no SLSA/in-toto statements yet).

## Verification

One pipeline (`verifyArtifact` in `@spliceloom/spec`) is used by `splice add`, `splice verify`
and the SDK. Checks run in order and **stop at the first failure**, so untrusted bytes are never
decoded after a hash mismatch:

| Check | Fails when |
| --- | --- |
| `sha256` | the artifact's SHA-256 differs from the registry's integrity (or the integrity is malformed) |
| `size` | the byte length differs from the recorded size |
| `package` | the archive is unsafe or invalid (paths, links, SKILL.md, manifest, tool entries) or names another package/version |
| `metadata` | the manifest served by the registry differs from the manifest inside the artifact (tampered metadata) |
| `signature` | a signature does not verify over this artifact or its key id does not match its key (fail closed); with `--require-signed`, the version is unsigned. Otherwise unsigned artifacts report `skipped: unsigned`; signatures by revoked keys are ignored. See [signing.md](signing.md) |

`splice verify` / `splice.verify()` additionally check:

| Check | Meaning |
| --- | --- |
| `provenance` | the recorded provenance matches the version metadata (package, integrity, size, manifest hash) |
| `source` | the direct artifact URL (GitHub Releases) serves the same bytes as the registry |
| `installed` | the copy installed in this project is file-for-file identical to the verified artifact and requests no ungranted permissions |

`splice add` refuses to install when any artifact check fails — nothing is extracted, nothing is
executed — and there is no flag to skip verification.

## Permissions and consent

- A manifest declares everything a package may do (`fs.read`, `fs.write`, `network`, `env`);
  child processes, workers, native addons and `eval` are never allowed ([runtime.md](runtime.md)).
- **Permissions are never granted implicitly.** Installing a package that requests any permission
  requires explicit consent: `splice add <pkg> --accept-permissions` or
  `splice.add(pkg, { acceptPermissions: true | (requested, pkg) => boolean })`. Without it the
  install fails with `PERMISSIONS_NOT_ACCEPTED` and nothing is written.
- The granted permissions are recorded in `splice.lock`. Upgrades (`add`, `update`) within the
  grant need no new consent; upgrades that request more need it again. `splice install` treats the
  grant in a committed `splice.lock` as given ([lifecycle.md](lifecycle.md)).
- Before a tool runs (CLI, SDK, MCP), the installed manifest is compared with the grant: a package
  whose manifest was edited to request more is refused with `PERMISSIONS_NOT_GRANTED`, and hidden
  from MCP tool lists. The sandbox then enforces exactly the declared permissions.
- Lockfiles written before Phase 5 have no grant record; their packages keep working as installed.

## Dependencies

The manifest reserves `dependencies: { "@ns/name": "<range>" }`. The format is validated (valid
package ids, ranges other than `latest`, no self-dependency), but dependency resolution is **not
implemented**: the registry rejects packages that declare dependencies
(`422 DEPENDENCIES_UNSUPPORTED`). Nothing is resolved or installed transitively.

## Signing-ready architecture

- `PackageVerifier` — one check (`id`, `verify(input, state)`); `verifyArtifact(input, verifiers)`
  runs a list of them.
- `PackageSignature` — `{ keyId, publicKey, signature, signedAt, revokedAt }`, carried in
  `ExpectedArtifact.signatures` (see [signing.md](signing.md)).
- `VerificationResult` / `VerificationCheck` — structured, deterministic outcome.
- Today: `Sha256Verifier`, `SizeVerifier`, `PackageContentVerifier`, `MetadataVerifier`,
  `SignaturePolicyVerifier` (Ed25519 publisher signatures; `defaultVerifiers({ requireSigned })`).

Publishers generate and register keys with `splice keys` and sign with `splice publish --sign`
or `splice sign`; see [signing.md](signing.md).

## Not implemented

Transparency logs, attestations (SLSA/in-toto), per-user signing keys, dependency resolution,
malware scanning, reputation. Publisher signatures and namespace keys exist: see [signing.md](signing.md).
