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
  exp     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  key     TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL DEFAULT '',
  status  TEXT NOT NULL DEFAULT 'active',
  created TEXT NOT NULL
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
