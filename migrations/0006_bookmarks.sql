-- Migration 0006: Bookmarks sync table
-- Stores bookmarks so they can be synced across devices.
-- One row per bookmark scope (e.g., a chat or "posts").

CREATE TABLE IF NOT EXISTS archive_bookmarks (
  chat_id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
