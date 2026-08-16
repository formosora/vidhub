/**
 * Resumable uploads.
 *
 * A single-shot POST loses everything when the connection drops, which for a
 * multi-gigabyte video on a flaky link means never finishing at all. Here the
 * client opens a session, appends chunks at a known offset, and can ask at any
 * time how many bytes arrived — so a retry resumes instead of restarting.
 *
 *   POST   /api/uploads              {name, size, visibility} -> {id, offset, chunk_size}
 *   GET    /api/uploads/<id>                                  -> {id, offset, size}
 *   PATCH  /api/uploads/<id>?offset=N  <binary chunk>         -> {offset}
 *   POST   /api/uploads/<id>/finish                           -> the usual upload result
 *   DELETE /api/uploads/<id>                                  -> abandon
 *
 * The offset is authoritative on the server: a chunk that does not start
 * exactly at the current offset is refused with the real offset attached, so a
 * confused client can always resynchronise rather than corrupt the file.
 */
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { q } from './db.js'
import { conf, confNum } from './config.js'
import { classifyExt, storeUpload, TMP_DIR } from './upload.js'
import { hashBlocked, logUpload, storageReason } from './security.js'
import { safeName } from './util.js'

/** 8 MiB balances round-trips against how much is lost when one chunk fails. */
export const CHUNK_SIZE = 8 * 1024 * 1024
const STALE_MS = 24 * 3600_000

const partPath = id => join(TMP_DIR, `.part-${id}`)

/** Drop sessions nobody came back to, so abandoned parts don't fill the disk. */
export function sweepUploads() {
  const cutoff = Date.now() - STALE_MS
  const dead = q.all('SELECT id FROM uploads WHERE updated < ?', cutoff)
  for (const u of dead) {
    try { unlinkSync(partPath(u.id)) } catch {}
    q.run('DELETE FROM uploads WHERE id=?', u.id)
  }
  if (dead.length) console.log(`[vidhub] cleared ${dead.length} abandoned upload session(s)`)
}

export function createUpload({ user, ip, orig, size, visibility }) {
  orig = safeName(orig || 'video.mp4')
  const ext = (orig.match(/\.(\w{2,5})$/)?.[1] || '').toLowerCase()
  if (!classifyExt(ext)) return { status: 400, error: ['up.badType'] }

  const declared = Number(size) || 0
  const maxBytes = Math.max(1, confNum('max_size_mb')) * 1024 * 1024
  if (declared > maxBytes) return { status: 413, error: ['up.tooLarge', confNum('max_size_mb')] }

  const full = storageReason(declared)
  if (full) return { status: 507, error: full }

  const vis = visibility === 'private' || visibility === 'public'
    ? visibility
    : (user?.default_visibility || conf('default_visibility') || 'public')

  const id = randomUUID()
  const now = Date.now()
  q.run(`INSERT INTO uploads(id, user_id, username, orig, size, received, visibility, ip, created, updated)
         VALUES(?,?,?,?,?,0,?,?,?,?)`,
    id, user?.id ?? 0, user?.username ?? 'guest', orig, declared, vis, ip, now, now)
  createWriteStream(partPath(id)).end()
  return { status: 200, body: { id, offset: 0, size: declared, chunk_size: CHUNK_SIZE } }
}

/** The caller may only touch their own session. */
export function getUpload(id, user) {
  const u = q.get('SELECT * FROM uploads WHERE id=?', id)
  if (!u) return null
  if ((u.user_id || 0) !== (user?.id ?? 0)) return null
  return u
}

/** Append one chunk. Returns the new offset, or the real one if they disagree. */
export function appendChunk(req, u, offset) {
  return new Promise(resolve => {
    if (offset !== u.received) {
      req.resume()
      return resolve({ status: 409, body: { error: 'offset mismatch', offset: u.received } })
    }
    const maxBytes = Math.max(1, confNum('max_size_mb')) * 1024 * 1024
    const file = partPath(u.id)
    const onDisk = existsSync(file) ? statSync(file).size : 0
    if (onDisk !== u.received) {                    // disk and bookkeeping drifted
      q.run('UPDATE uploads SET received=? WHERE id=?', onDisk, u.id)
      req.resume()
      return resolve({ status: 409, body: { error: 'offset mismatch', offset: onDisk } })
    }

    let written = 0, failed = false
    const ws = createWriteStream(file, { flags: 'a' })
    const stop = (status, body) => {
      if (failed) return
      failed = true
      ws.destroy(); req.destroy()
      resolve({ status, body })
    }
    req.on('data', c => {
      written += c.length
      if (u.received + written > maxBytes)
        return stop(413, { error: 'too large', offset: u.received })
      if (!ws.write(c)) req.pause(), ws.once('drain', () => req.resume())
    })
    req.on('error', () => stop(400, { error: 'aborted', offset: u.received }))
    req.on('end', () => {
      if (failed) return
      ws.end(() => {
        const received = u.received + written
        q.run('UPDATE uploads SET received=?, updated=? WHERE id=?', received, Date.now(), u.id)
        resolve({ status: 200, body: { offset: received, size: u.size } })
      })
    })
  })
}

/** Hash the assembled file — the rolling hash cannot survive across requests. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', c => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

export async function finishUpload(u, { user, ip, region }) {
  const file = partPath(u.id)
  if (!existsSync(file)) {
    q.run('DELETE FROM uploads WHERE id=?', u.id)
    return { status: 400, error: ['up.aborted'] }
  }
  const size = statSync(file).size
  // A short file means the client stopped early; say so instead of storing a
  // truncated video that looks fine until someone plays it.
  if (u.size > 0 && size !== u.size) {
    return { status: 409, body: { error: 'incomplete', offset: size, size: u.size } }
  }

  const orig = u.orig
  const ext = (orig.match(/\.(\w{2,5})$/)?.[1] || '').toLowerCase()
  const kind = classifyExt(ext)
  const logBase = { ip, region, user, orig }
  if (!kind) {
    try { unlinkSync(file) } catch {}
    q.run('DELETE FROM uploads WHERE id=?', u.id)
    logUpload({ ...logBase, status: 'rejected', msg: ['up.badType'] })
    return { status: 400, error: ['up.badType'] }
  }

  const sha256 = await hashFile(file)
  q.run('DELETE FROM uploads WHERE id=?', u.id)
  return storeUpload({
    tmp: file, up: { size, sha256 }, orig, ext, kind,
    vis: u.visibility, user, ip, region, logBase,
  })
}

export function abortUpload(u) {
  try { unlinkSync(partPath(u.id)) } catch {}
  q.run('DELETE FROM uploads WHERE id=?', u.id)
}

export { hashBlocked }
