/**
 * Database backups.
 *
 * Two things here cannot be regenerated: the SQLite file (accounts, video
 * metadata, settings, logs) and the media directory. Media are plain files —
 * rsync, a volume snapshot, anything file-level already handles them. The
 * database is the part that needs care, because copying `vidhub.db` while the
 * server is writing to it can catch a half-written page or miss the WAL, giving
 * you a file that looks fine right up until you try to restore it.
 *
 * `VACUUM INTO` is SQLite's own answer: it runs inside a read transaction and
 * writes a fresh, internally consistent, already-compacted database. No
 * downtime, no write lock held for the duration, and no `-wal`/`-shm` sidecars
 * to keep alongside the copy — the output is a single self-contained file.
 *
 * Restoring is deliberately a plain file operation, documented in the README:
 * stop the server, drop the snapshot in as `vidhub.db`, delete any leftover
 * `-wal`/`-shm`, start it again.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './db.js'
import { conf, confNum } from './config.js'
import { DATA_DIR } from './upload.js'
import { diskInfo } from './security.js'
import { emit } from './webhooks.js'

export const BACKUP_DIR = join(DATA_DIR, 'backups')
mkdirSync(BACKUP_DIR, { recursive: true })

const DB_FILE = join(DATA_DIR, 'vidhub.db')
/** Only files we produced are ever listed, downloaded or deleted. */
const NAME_RE = /^vidhub-\d{8}-\d{6}(-\d+)?\.db$/

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '')
  .replace(/^(\d{8})(\d{6})$/, '$1-$2')

/** Newest first. Anything not matching our own naming is ignored, not touched. */
export function listBackups() {
  let files
  try { files = readdirSync(BACKUP_DIR) } catch { return [] }
  return files
    .filter(f => NAME_RE.test(f))
    .map(f => {
      const s = statSync(join(BACKUP_DIR, f))
      return { file: f, size: s.size, created: new Date(s.mtimeMs).toISOString() }
    })
    .sort((a, b) => (a.file < b.file ? 1 : -1))
}

export function backupPath(file) {
  return NAME_RE.test(file) ? join(BACKUP_DIR, file) : null
}

export function removeBackup(file) {
  const p = backupPath(file)
  if (!p || !existsSync(p)) return false
  unlinkSync(p)
  return true
}

/** Drop the oldest snapshots past the retention count. */
function prune(keep) {
  const extra = listBackups().slice(Math.max(1, keep))
  for (const b of extra) try { unlinkSync(join(BACKUP_DIR, b.file)) } catch {}
  return extra.length
}

/**
 * Take one snapshot. Throws on failure so both callers — the admin button and
 * the timer — can report it rather than silently writing nothing.
 */
export function runBackup() {
  const dbSize = existsSync(DB_FILE) ? statSync(DB_FILE).size : 0
  // A backup that fills the disk is worse than no backup: it takes the live
  // site down too. Two copies of headroom, since VACUUM builds the new file
  // before anything is pruned.
  const disk = diskInfo()
  if (disk && disk.free < dbSize * 2 + 16 * 1024 * 1024) {
    const e = new Error('not enough free disk for a snapshot')
    emit('backup.failed', { error: e.message, free: disk.free, db_size: dbSize })
    throw e
  }

  // VACUUM INTO refuses to overwrite, and the stamp only resolves to the
  // second — two clicks in the same second would otherwise fail outright.
  let file = `vidhub-${stamp()}.db`
  for (let n = 2; existsSync(join(BACKUP_DIR, file)); n++) file = `vidhub-${stamp()}-${n}.db`
  const dest = join(BACKUP_DIR, file)
  try {
    db.prepare('VACUUM INTO ?').run(dest)
  } catch (e) {
    // A partial output would look like a valid restore point next time somebody
    // is in a hurry. Take it away.
    try { unlinkSync(dest) } catch {}
    emit('backup.failed', { error: String(e.message || e) })
    throw e
  }

  const size = statSync(dest).size
  const pruned = prune(confNum('backup_keep'))
  console.log(`[vidhub] backup ${file} (${(size / 1048576).toFixed(1)} MB)${pruned ? `, pruned ${pruned}` : ''}`)
  emit('backup.completed', { file, size, pruned })
  return { file, size, created: new Date().toISOString(), pruned }
}

/** How the admin panel describes the current state. */
export function backupStatus() {
  const items = listBackups()
  const interval = Math.max(1, confNum('backup_interval_hours'))
  const last = items[0] || null
  return {
    enabled: !!conf('backup_enabled'),
    interval_hours: interval,
    keep: confNum('backup_keep'),
    total_size: items.reduce((n, b) => n + b.size, 0),
    last: last?.created || null,
    next: conf('backup_enabled') && last
      ? new Date(Date.parse(last.created) + interval * 3600_000).toISOString()
      : null,
    items,
  }
}

/**
 * Hourly tick. The schedule is derived from the newest snapshot's timestamp
 * rather than an in-memory clock, so a restart does not reset the interval and
 * a container that only runs for ten minutes a day still gets a backup.
 */
function tick() {
  if (!conf('backup_enabled')) return
  const last = listBackups()[0]
  const due = !last ||
    Date.now() - Date.parse(last.created) >= Math.max(1, confNum('backup_interval_hours')) * 3600_000
  if (!due) return
  try { runBackup() } catch (e) { console.error('[vidhub] backup failed:', e.message) }
}

export function startBackups() {
  tick()
  setInterval(tick, 3600_000).unref()
}
