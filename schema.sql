-- ============================================================
-- IsaaCart — D1 schema
-- Stores contact messages and artwork booking requests
-- ============================================================

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL DEFAULT 'contact',  -- 'contact' | 'booking'
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT,
  subject       TEXT,
  message       TEXT,
  artwork_id    TEXT,
  artwork_title TEXT,
  artwork_price TEXT,
  meta          TEXT,                             -- JSON: size, medium, layers
  ip            TEXT,
  user_agent    TEXT,
  status        TEXT NOT NULL DEFAULT 'new',      -- 'new' | 'read' | 'archived'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages (created_at);
CREATE INDEX IF NOT EXISTS idx_messages_ip_time  ON messages (ip, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_status   ON messages (status, created_at);
