-- Phase 3.5: record where each artifact lives, so versions can be resolved and verified
-- independently of the artifact backend (GitHub Releases in production).
-- artifact_backend: e.g. 'github-releases', 'kv', 'r2', 'fs'. NULL = stored before this migration
-- (in the backend that was configured at the time); `POST /admin/artifacts/migrate` moves those.
ALTER TABLE versions ADD COLUMN artifact_backend TEXT;
-- Public download URL of the artifact when the backend has one (e.g. a GitHub release asset URL).
ALTER TABLE versions ADD COLUMN artifact_url TEXT;
CREATE INDEX versions_artifact_backend ON versions(artifact_backend);
