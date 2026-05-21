CREATE TABLE IF NOT EXISTS archive_messages (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS archive_messages_chat_timestamp ON archive_messages (chat_id, timestamp);

CREATE TABLE IF NOT EXISTS archive_posts (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS archive_posts_timestamp ON archive_posts (timestamp);
