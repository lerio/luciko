-- Migration 0007: Extract external_id into a dedicated column
-- Prevents duplicate externalId values in archive tables, which caused
-- message-count drift between remote D1 and local IndexedDB.
--
-- The externalId field was previously only stored inside the JSON payload,
-- making it invisible to D1's uniqueness constraints. This migration:
--   1. Adds an external_id column
--   2. Populates it from existing payloads
--   3. Removes duplicate rows (keeping the earliest insert per external_id)
--   4. Creates a partial unique index for future inserts

-- archive_messages

ALTER TABLE archive_messages ADD COLUMN external_id TEXT;

UPDATE archive_messages
SET external_id = json_extract(payload, '$.externalId')
WHERE external_id IS NULL;

-- Remove duplicates: keep the row with the lowest rowid (first inserted)
-- for each external_id value, preserving data integrity.
DELETE FROM archive_messages
WHERE external_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM archive_messages
    WHERE external_id IS NOT NULL
    GROUP BY external_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_messages_external_id
ON archive_messages (external_id)
WHERE external_id IS NOT NULL;

-- archive_posts

ALTER TABLE archive_posts ADD COLUMN external_id TEXT;

UPDATE archive_posts
SET external_id = json_extract(payload, '$.externalId')
WHERE external_id IS NULL;

DELETE FROM archive_posts
WHERE external_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM archive_posts
    WHERE external_id IS NOT NULL
    GROUP BY external_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_posts_external_id
ON archive_posts (external_id)
WHERE external_id IS NOT NULL;
