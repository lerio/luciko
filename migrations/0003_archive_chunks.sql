CREATE TABLE IF NOT EXISTS archive_chunks (
  entity TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity, chunk_index)
);
