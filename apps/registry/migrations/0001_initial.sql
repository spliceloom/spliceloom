-- Splice registry schema v1 (Cloudflare D1 / SQLite).
-- Applied by `wrangler d1 migrations apply`, the wrangler test harness and the local Node registry.

-- Registry accounts. Phase 2 has no self-service sign-up: an admin creates users.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- API tokens. Only the SHA-256 hash of a token is stored, never the token itself.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX tokens_user ON tokens(user_id);

-- Package namespaces (@namespace/...). owner_id NULL + reserved = 1 means only an admin can assign it.
CREATE TABLE namespaces (
  name TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id),
  reserved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX namespaces_owner ON namespaces(owner_id);

CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(name),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  latest_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX packages_namespace ON packages(namespace);

-- Immutable published versions. The artifact itself lives in object storage (R2) under artifact_key.
CREATE TABLE versions (
  package_id TEXT NOT NULL REFERENCES packages(id),
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  integrity TEXT NOT NULL,
  size INTEGER NOT NULL,
  artifact_key TEXT NOT NULL UNIQUE,
  published_by TEXT NOT NULL REFERENCES users(id),
  published_at TEXT NOT NULL,
  PRIMARY KEY (package_id, version)
);
CREATE INDEX versions_package_published ON versions(package_id, published_at);

-- Reserved official namespaces.
INSERT INTO namespaces (name, owner_id, reserved, created_at) VALUES ('splice', NULL, 1, '2026-09-30T00:00:00.000Z');
INSERT INTO namespaces (name, owner_id, reserved, created_at) VALUES ('spliceloom', NULL, 1, '2026-09-30T00:00:00.000Z');
