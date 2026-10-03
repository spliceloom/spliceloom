-- Phase 9: publisher signatures (Ed25519). See docs/signing.md.

-- Public keys a namespace owner registered. Keys are never deleted, only revoked.
CREATE TABLE signing_keys (
  key_id TEXT PRIMARY KEY,          -- "ed25519:" + first 16 hex of SHA-256(raw public key)
  namespace TEXT NOT NULL REFERENCES namespaces(name),
  public_key TEXT NOT NULL,         -- raw 32-byte Ed25519 key, base64
  added_by TEXT NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX signing_keys_namespace ON signing_keys(namespace);

CREATE TRIGGER signing_keys_immutable
BEFORE UPDATE OF key_id, namespace, public_key, added_by, added_at ON signing_keys
BEGIN
  SELECT RAISE(ABORT, 'signing keys are immutable (revoke instead)');
END;

CREATE TRIGGER signing_keys_revoke_once
BEFORE UPDATE OF revoked_at ON signing_keys
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a revoked key stays revoked');
END;

CREATE TRIGGER signing_keys_no_delete
BEFORE DELETE ON signing_keys
BEGIN
  SELECT RAISE(ABORT, 'signing keys cannot be deleted (revoke instead)');
END;

-- Signatures over published versions (payload: scheme, package id, version, integrity). Write-once.
CREATE TABLE signatures (
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  key_id TEXT NOT NULL REFERENCES signing_keys(key_id),
  signature TEXT NOT NULL,          -- 64-byte Ed25519 signature, base64
  signed_by TEXT NOT NULL REFERENCES users(id),
  signed_at TEXT NOT NULL,
  PRIMARY KEY (package_id, version, key_id),
  FOREIGN KEY (package_id, version) REFERENCES versions(package_id, version)
);

CREATE TRIGGER signatures_immutable
BEFORE UPDATE ON signatures
BEGIN
  SELECT RAISE(ABORT, 'signatures are immutable');
END;

CREATE TRIGGER signatures_no_delete
BEFORE DELETE ON signatures
BEGIN
  SELECT RAISE(ABORT, 'signatures cannot be deleted');
END;
