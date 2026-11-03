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

-- ============================================================
-- Admin dashboard tables
-- ============================================================

-- Artworks managed from /admin (gallery loads these via /api/artworks)
CREATE TABLE IF NOT EXISTS artworks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  cat        TEXT NOT NULL DEFAULT 'portrait',
  price      REAL NOT NULL DEFAULT 0,
  sz         TEXT,
  md         TEXT,
  ly         TEXT,
  img        TEXT,
  descr      TEXT,
  av         INTEGER NOT NULL DEFAULT 1,
  yr         TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uploaded images stored in D1 (served at /img/<key>)
CREATE TABLE IF NOT EXISTS artwork_images (
  key        TEXT PRIMARY KEY,
  mime       TEXT NOT NULL DEFAULT 'image/jpeg',
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Failed login attempts (blocks password brute force)
CREATE TABLE IF NOT EXISTS login_throttle (
  ip         TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_throttle_ip ON login_throttle (ip, created_at);

-- Seed the two existing artworks (ignored if already present)
INSERT OR IGNORE INTO artworks (id, title, cat, price, sz, md, ly, img, descr, av, yr)
VALUES (1, 'CR7', 'portrait', 478, '60 x 80 cm', 'Spray paint on plywood', '2 layers',
        'https://cdn.jsdelivr.net/gh/Grimzeero78/images_cdn/art/Ronaldo fanart.jpg', 'get some suiiii', 1, '2026'),
       (2, 'messi', 'landscape', 778, '50 x 70 cm', 'spray on plywood', '2 layers',
        'https://cdn.jsdelivr.net/gh/Grimzeero78/images_cdn/art/download.jpg', 'Real Goat??', 1, '2026');
