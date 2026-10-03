# Package signing

SHA-256 proves you received the bytes the registry recorded. A **signature** adds who produced
them: a publisher signs each version with an Ed25519 key, the public key is registered for the
namespace, and every client checks the signature itself before installing.

```sh
splice keys generate                       # once: creates ~/.splice/keys/default.key
splice keys register @acme                 # once per namespace (namespace owner)
splice publish --sign                      # publish and sign in one step
splice add @acme/tool --require-signed     # consumers: refuse anything unsigned
```

## What is signed

The signature covers this exact text, so it can never be moved to other bytes or another version:

```text
splice-package-signature-v1
@acme/tool
1.2.0
sha256-<hex of the artifact>
```

| Part | Meaning |
| --- | --- |
| Algorithm | Ed25519 (WebCrypto). 32-byte public keys, 64-byte signatures, both base64. |
| Key id | `ed25519:` + the first 16 hex characters of SHA-256 of the raw public key. |
| Integrity | The artifact's SHA-256, which clients already verify against the downloaded bytes. |

## For publishers

| Command | What it does |
| --- | --- |
| `splice keys generate [name]` | Creates an Ed25519 key in `~/.splice/keys/<name>.key` (PKCS#8 PEM, owner-only permissions where the OS supports it). Never overwrites a key. |
| `splice keys register @ns [--key name]` | Registers the public key for a namespace you own (needs a managing token: `splice login` with your admin-issued token). |
| `splice publish --sign [--key name]` | Publishes, then signs the integrity of the package that was just packed locally. |
| `splice sign @ns/name@1.2.0 [--dir path] [--key name]` | Signs a version that is already published. With `--dir`, the directory is packed locally and the registry must report the same SHA-256; without it, the artifact is downloaded and fully verified first. |
| `splice keys list [@ns]` | Local keys, or the keys registered for a namespace. |
| `splice keys revoke @ns <keyId>` | Revokes a key (owner). Clients stop trusting its signatures; it cannot sign again. |

The private key never leaves your machine; the registry only stores the public key. Back it up:
a lost key cannot sign new versions (register a new key, and consumers will see a signer change).
In CI, mount the key file into `SPLICE_HOME/keys/` from your secret store.

## For consumers

Every install checks signatures locally, with or without flags:

- A signature that does not verify over the downloaded artifact stops the install
  (`SIGNATURE_INVALID`): the package or its metadata was tampered with.
- `--require-signed` (SDK: `{ requireSigned: true }`) also refuses unsigned versions
  (`SIGNATURE_REQUIRED`).
- The verified key id is recorded in `splice.lock` as `signedBy`. A later version signed by a
  different key, or unsigned, is refused (`SIGNER_CHANGED`) unless you pass
  `--allow-signer-change` (SDK: `{ allowSignerChange: true }`) after checking
  `splice keys list @ns`.
- Signatures by revoked keys are ignored; such versions count as unsigned.

`splice info` shows the signature status of a version, checked locally.

## What a signature does and does not prove

It proves that the holder of a private key registered for the namespace signed exactly these
bytes. It protects against a modified artifact in storage, modified integrity values in the
registry database, and a different package published under the namespace by someone without the
key.

It does not prove that the publisher's code is safe, and the list of registered keys comes from
the registry: someone who controls the registry and the namespace owner's account could register
a new key. Pinning the signer in `splice.lock` turns that into a visible `SIGNER_CHANGED` for
existing installs. Keep reviewing permissions, and keep using the sandbox.

## Registry API

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/namespaces/:ns/keys` | anyone |
| `POST` | `/namespaces/:ns/keys` `{ "publicKey": "<base64>" }` | namespace owner (managing token) |
| `DELETE` | `/namespaces/:ns/keys/:keyId` | namespace owner (managing token) |
| `POST` | `/packages/:ns/:name/:version/signatures` `{ "keyId", "signature" }` | owner or maintainer |

The registry verifies every signature before storing it, and version metadata
(`GET /packages/:ns/:name/:version`) returns `signatures` with each public key and its revocation
time. Keys and signatures are write-once in the database (triggers refuse updates and deletes;
keys can only be revoked).
