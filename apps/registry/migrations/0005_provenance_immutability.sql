-- Phase 5: provenance records and database-enforced immutability of published versions.

-- JSON provenance recorded at publish time (see docs/trust.md). NULL for versions published before
-- this migration; the API then derives provenance from the existing columns and marks it "derived".
ALTER TABLE versions ADD COLUMN provenance TEXT;

-- The identity of a published version (what it is and which bytes it points to) can never change.
-- artifact_backend / artifact_url may change: they describe where the same bytes are stored.
CREATE TRIGGER versions_immutable
BEFORE UPDATE OF package_id, version, manifest, integrity, size, artifact_key, published_by, published_at ON versions
BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;

CREATE TRIGGER versions_no_delete
BEFORE DELETE ON versions
BEGIN
  SELECT RAISE(ABORT, 'published versions cannot be deleted');
END;

-- Provenance is written once.
CREATE TRIGGER versions_provenance_write_once
BEFORE UPDATE OF provenance ON versions
WHEN OLD.provenance IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'provenance is write-once');
END;
