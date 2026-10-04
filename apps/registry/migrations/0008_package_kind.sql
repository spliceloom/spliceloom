-- Agent packages: packages whose latest manifest declares an `agent` section.
-- 'skill' for everything published before this migration.
ALTER TABLE packages ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill';
CREATE INDEX packages_kind ON packages(kind);
