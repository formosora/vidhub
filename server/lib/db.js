/**
 * SQLite persistence via Node's built-in node:sqlite — zero npm dependencies.
 * One database file under DATA_DIR; WAL mode for concurrent reads during streams.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(join(DATA_DIR, 'vidhub.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'uploader',  -- admin | uploader
  status     TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  daily_limit INTEGER NOT NULL DEFAULT 0,       -- 0 = follow global
  default_visibility TEXT NOT NULL DEFAULT 'public',  -- public | private (unlisted)
  created    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exp     INTEGER NOT NULL,
  born    INTEGER NOT NULL DEFAULT 0,   -- first issued; caps how long sliding can extend
  seen    INTEGER NOT NULL DEFAULT 0    -- last activity
);
CREATE TABLE IF NOT EXISTS api_keys (
  key     TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL DEFAULT '',
  status  TEXT NOT NULL DEFAULT 'active',
  scopes  TEXT NOT NULL DEFAULT 'read,upload,manage',  -- comma separated
  expires INTEGER NOT NULL DEFAULT 0,   -- epoch ms, 0 = never
  last_used INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  url     TEXT NOT NULL,
  secret  TEXT NOT NULL DEFAULT '',      -- HMAC-SHA256 key for X-Vidhub-Signature
  events  TEXT NOT NULL DEFAULT '',      -- comma separated, '' = every event
  status  TEXT NOT NULL DEFAULT 'active',
  note    TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,   -- consecutive; resets on success
  last_at INTEGER NOT NULL DEFAULT 0,
  last_code INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id  INTEGER NOT NULL,
  event    TEXT NOT NULL DEFAULT '',
  code     INTEGER NOT NULL DEFAULT 0,   -- HTTP status, 0 = never reached
  attempts INTEGER NOT NULL DEFAULT 0,
  ok       INTEGER NOT NULL DEFAULT 0,
  msg      TEXT NOT NULL DEFAULT '',
  time     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wlog_time ON webhook_log(time);
-- Server-side keys that must never leave the box. Kept out of "settings" so
-- they cannot ride along in the admin settings payload or be overwritten by it.
CREATE TABLE IF NOT EXISTS secrets (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Share links: the access control behind "protected" visibility.
CREATE TABLE IF NOT EXISTS shares (
  token     TEXT PRIMARY KEY,
  name      TEXT NOT NULL,                 -- videos.name
  user_id   INTEGER NOT NULL DEFAULT 0,    -- who issued it
  pass_hash TEXT NOT NULL DEFAULT '',      -- '' = no password
  salt      TEXT NOT NULL DEFAULT '',
  expires   INTEGER NOT NULL DEFAULT 0,    -- epoch ms, 0 = never
  max_views INTEGER NOT NULL DEFAULT 0,    -- 0 = unlimited
  views     INTEGER NOT NULL DEFAULT 0,
  note      TEXT NOT NULL DEFAULT '',
  last_seen INTEGER NOT NULL DEFAULT 0,
  created   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_name ON shares(name);
-- Tags are per-owner: two people may both have a "raw footage" tag and neither
-- sees the other's. Names are unique within an account, not globally.
CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  name    TEXT NOT NULL,
  created TEXT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS video_tags (
  video  TEXT NOT NULL,                  -- videos.name
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_vtags_tag ON video_tags(tag_id);
-- An ordered, shareable set of one owner's videos.
CREATE TABLE IF NOT EXISTS collections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  username   TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  descr      TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',  -- public = listed | private = unlisted
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_items (
  coll_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  video   TEXT NOT NULL,                 -- videos.name
  pos     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coll_id, video)
);
CREATE INDEX IF NOT EXISTS idx_citems_coll ON collection_items(coll_id, pos);
-- Resumable uploads in progress. Bytes live in DATA_DIR/tmp/.part-<id>.
CREATE TABLE IF NOT EXISTS uploads (
  id        TEXT PRIMARY KEY,
  user_id   INTEGER NOT NULL DEFAULT 0,
  username  TEXT NOT NULL DEFAULT '',
  orig      TEXT NOT NULL DEFAULT '',
  size      INTEGER NOT NULL DEFAULT 0,   -- declared total
  received  INTEGER NOT NULL DEFAULT 0,   -- bytes on disk
  visibility TEXT NOT NULL DEFAULT 'public',
  ip        TEXT NOT NULL DEFAULT '',
  created   INTEGER NOT NULL DEFAULT 0,
  updated   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS videos (
  name      TEXT PRIMARY KEY,          -- <sha16>.<ext>, the permanent public URL key
  stored    TEXT NOT NULL DEFAULT '',  -- actual on-disk filename ('' = same as name)
  orig      TEXT NOT NULL DEFAULT '',
  size      INTEGER NOT NULL DEFAULT 0,
  sha256    TEXT NOT NULL DEFAULT '',
  ext       TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL DEFAULT 'video',     -- video | image | other
  mime      TEXT NOT NULL DEFAULT '',
  width     INTEGER NOT NULL DEFAULT 0,
  height    INTEGER NOT NULL DEFAULT 0,
  duration  REAL    NOT NULL DEFAULT 0,
  thumb     TEXT NOT NULL DEFAULT '',
  status    TEXT NOT NULL DEFAULT 'ok',        -- processing | ok | banned | recycled
  visibility TEXT NOT NULL DEFAULT 'public',   -- public = listed in the gallery
                                               -- private = unlisted; the link still plays
  mod_score REAL    NOT NULL DEFAULT -1,       -- moderation skin-ratio 0..1, -1 = unchecked
  user_id   INTEGER NOT NULL DEFAULT 0,
  username  TEXT NOT NULL DEFAULT '',
  ip        TEXT NOT NULL DEFAULT '',
  ip_region TEXT NOT NULL DEFAULT '',
  views     INTEGER NOT NULL DEFAULT 0,
  uploaded  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_uploaded ON videos(uploaded);
CREATE INDEX IF NOT EXISTS idx_videos_status   ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_user     ON videos(user_id);
CREATE TABLE IF NOT EXISTS upload_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  time    TEXT NOT NULL,
  ip      TEXT NOT NULL DEFAULT '',
  region  TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  name    TEXT NOT NULL DEFAULT '',
  orig    TEXT NOT NULL DEFAULT '',
  size    INTEGER NOT NULL DEFAULT 0,
  status  TEXT NOT NULL DEFAULT 'ok',          -- ok | rejected | banned | failed
  msg     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON upload_logs(time);
CREATE INDEX IF NOT EXISTS idx_logs_ip   ON upload_logs(ip);
CREATE TABLE IF NOT EXISTS ip_rules (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ip   TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS hash_black (
  sha256 TEXT PRIMARY KEY,
  note   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS jobs (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL,
  status  TEXT NOT NULL DEFAULT 'pending',     -- pending | running | done | failed
  msg     TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
);
`)

/** Additive migrations for databases created by an earlier build. */
for (const [table, column, decl] of [
  ['videos', 'stored', "TEXT NOT NULL DEFAULT ''"],
  ['videos', 'visibility', "TEXT NOT NULL DEFAULT 'public'"],   // public | private
  ['users', 'default_visibility', "TEXT NOT NULL DEFAULT 'public'"],
  ['sessions', 'born', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'seen', 'INTEGER NOT NULL DEFAULT 0'],
  ['api_keys', 'scopes', "TEXT NOT NULL DEFAULT 'read,upload,manage'"],
  ['api_keys', 'expires', 'INTEGER NOT NULL DEFAULT 0'],
  ['api_keys', 'last_used', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
    console.log(`[vidhub] migrated: ${table}.${column} added`)
  }
}

export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
}
