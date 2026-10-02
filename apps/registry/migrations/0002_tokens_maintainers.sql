-- Phase 3: scoped/expiring tokens and namespace maintainers.

-- NULL = the token may publish to every namespace its user may publish to;
-- otherwise a comma-separated allow-list of namespaces.
ALTER TABLE tokens ADD COLUMN scope_namespaces TEXT;
-- NULL = never expires. ISO-8601 UTC timestamp otherwise.
ALTER TABLE tokens ADD COLUMN expires_at TEXT;
-- 1 = may manage tokens and maintainers (tokens issued by an admin);
-- 0 = publish-only (tokens users create for CI and automation).
ALTER TABLE tokens ADD COLUMN can_manage INTEGER NOT NULL DEFAULT 1;

-- Users (besides the owner) allowed to publish into a namespace. Only the owner manages this list.
CREATE TABLE namespace_maintainers (
  namespace TEXT NOT NULL REFERENCES namespaces(name),
  user_id TEXT NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (namespace, user_id)
);
CREATE INDEX namespace_maintainers_user ON namespace_maintainers(user_id);
