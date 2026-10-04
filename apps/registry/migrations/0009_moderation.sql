-- Moderation: a hidden package stays installable by its exact name (versions are immutable) but is
-- left out of search, so it no longer appears in listings.
ALTER TABLE packages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- Names nobody can claim through sign-up or a first publish; an admin can assign them.
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('dim', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('spliceloom', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('official', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('admin', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('root', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('registry', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('support', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('security', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('staff', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('team', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('api', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('docs', NULL, 1, '2026-10-04T00:00:00.000Z');
INSERT OR IGNORE INTO namespaces (name, owner_id, reserved, created_at) VALUES ('www', NULL, 1, '2026-10-04T00:00:00.000Z');
