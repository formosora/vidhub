/**
 * Upload orchestration: stream to disk with rolling sha256, validate,
 * dedupe, probe, thumbnail, then queue transcode + moderation jobs.
 * A serial in-process job queue keeps weak servers from melting.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { q } from './db.js'
import { conf, confNum } from './config.js'
import * as media from './media.js'
import { moderate } from './moderate.js'
import { hashBlocked, logUpload, storageReason } from './security.js'
import { safeName, nowIso } from './util.js'
import { emit } from './webhooks.js'

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
export const VIDEOS_DIR = join(DATA_DIR, 'videos')
export const THUMBS_DIR = join(DATA_DIR, 'thumbs')
export const TMP_DIR = join(DATA_DIR, 'tmp')
for (const d of [VIDEOS_DIR, THUMBS_DIR, TMP_DIR]) mkdirSync(d, { recursive: true })

const VIDEO_EXTS = new Set('mp4,webm,mov,m4v,mkv,avi,ts,flv,wmv,3gp,mpg,mpeg,rmvb,rm'.split(','))

export function classifyExt(ext) {
  const vids = new Set((conf('extensions') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const imgs = new Set((conf('image_extensions') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  if (vids.has(ext)) return 'video'
  if (imgs.has(ext) && conf('allow_images')) return 'image'
  if (conf('allow_other')) return 'other'
  return null
}

/** Stream request body to disk with rolling hash + size cap. */
export function streamUpload(req, tmpPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let size = 0, failed = false
    const ws = createWriteStream(tmpPath)
    req.on('data', c => {
      size += c.length
      if (size > maxBytes && !failed) {
        failed = true
        req.destroy(); ws.destroy()
        try { unlinkSync(tmpPath) } catch {}
        return reject(new Error('too large'))
      }
      hash.update(c)
      if (!ws.write(c)) req.pause(), ws.once('drain', () => req.resume())
    })
    req.on('end', () => !failed && ws.end(() => resolve({ size, sha256: hash.digest('hex') })))
    req.on('error', e => { ws.destroy(); try { unlinkSync(tmpPath) } catch {}; reject(e) })
  })
}

const storagePath = (name) => {
  const d = nowIso().slice(0, 7)                    // YYYY-MM
  const dir = join(VIDEOS_DIR, d)
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

/**
 * Locate the bytes for a video. Accepts a row or a name.
 *
 * `name` is the permanent public URL key; `stored` is what is actually on disk.
 * They diverge once the pipeline transcodes mkv → mp4, which is why the URL
 * handed to the user right after upload keeps working.
 */
export function findFile(v) {
  const row = typeof v === 'string' ? q.get('SELECT name, stored FROM videos WHERE name = ?', v) : v
  const file = (row && row.stored) || (typeof v === 'string' ? v : row?.name)
  if (!file) return null
  const direct = join(VIDEOS_DIR, file)
  if (existsSync(direct)) return direct
  // stored under YYYY-MM/<file>
  for (const d of safeReaddir(VIDEOS_DIR)) {
    const p = join(VIDEOS_DIR, d, file)
    if (existsSync(p)) return p
  }
  return null
}
import { readdirSync } from 'node:fs'
const safeReaddir = d => { try { return readdirSync(d) } catch { return [] } }

export const thumbPath = name =>
  join(THUMBS_DIR, name.replace(/\.[^.]+$/, '') + '.jpg')

/** The shape a webhook receiver sees for a stored item. */
export const videoEvent = v => ({
  name: v.name, orig: v.orig, size: v.size, kind: v.kind, ext: v.ext,
  width: v.width, height: v.height, duration: v.duration,
  status: v.status, visibility: v.visibility, username: v.username,
  url: `/v/${v.name}`, player: `/p/${v.name}`, thumb: `/t/${v.name}`,
})

// ---------- serial job queue ----------

const queue = []
let running = false

function enqueue(name, type) {
  const id = randomUUID()
  q.run('INSERT INTO jobs(id, name, type, status, created) VALUES(?,?,?,?,?)', id, name, type, 'pending', nowIso())
  queue.push({ id, name, type })
  drain()
}

/**
 * Called once at boot. The queue lives in memory, so a restart mid-transcode
 * used to strand videos in 'processing' forever with no way back.
 */
export function resumeJobs() {
  q.run("UPDATE jobs SET status='failed', msg='中断于服务重启' WHERE status IN ('pending','running')")
  const stuck = q.all("SELECT name FROM videos WHERE status = 'processing'")
  if (!stuck.length) return
  console.log(`[vidhub] resuming ${stuck.length} interrupted upload(s)`)
  for (const v of stuck) {
    if (findFile(v.name)) enqueue(v.name, 'pipeline')
    // bytes are gone — nothing to reprocess, don't leave it stuck forever
    else q.run("UPDATE videos SET status='recycled' WHERE name=?", v.name)
  }
}

async function drain() {
  if (running) return
  running = true
  while (queue.length) {
    const job = queue.shift()
    q.run("UPDATE jobs SET status='running' WHERE id=?", job.id)
    try {
      if (job.type === 'pipeline') await runPipeline(job.name)
      q.run("UPDATE jobs SET status='done' WHERE id=?", job.id)
    } catch (e) {
      console.error(`[job ${job.type}:${job.name}]`, e.message)
      q.run("UPDATE jobs SET status='failed', msg=? WHERE id=?", String(e.message).slice(0, 300), job.id)
      // pipeline failure shouldn't lose the file — publish the original
      q.run("UPDATE videos SET status='ok' WHERE name=? AND status='processing'", job.name)
    }
  }
  running = false
}

/**
 * Swap in a pipeline output. The public `name` never changes — only the on-disk
 * `stored` filename and the derived ext/mime/size do, so links already copied by
 * the uploader (and the frontend's status poll) stay valid across a transcode.
 */
function adoptOutput(row, currentFile, outPath, newExt, mime) {
  const target = currentFile.replace(/\.[^.]+$/, '.' + newExt)
  renameSync(outPath, target)
  if (target !== currentFile) { try { unlinkSync(currentFile) } catch {} }
  const stored = row.name.replace(/\.[^.]+$/, '.' + newExt)
  q.run('UPDATE videos SET stored=?, ext=?, mime=?, size=? WHERE name=?',
    stored, newExt, mime, statSync(target).size, row.name)
  return target
}

/** Transcode/watermark/compress + moderation for one stored video. */
async function runPipeline(name) {
  const row = q.get('SELECT * FROM videos WHERE name = ?', name)
  if (!row) return
  let file = findFile(row)
  if (!file) return

  // A swallowed ffmpeg error used to look exactly like "nothing to do" — the
  // file was published unprocessed with no trace anywhere. Surface it instead.
  const attempt = (label, p) => p.catch(e => {
    console.error(`[pipeline ${name}] ${label} failed: ${e.message}`)
    q.run("UPDATE jobs SET msg=? WHERE name=? AND status='running'",
      `${label}: ${String(e.message).slice(0, 200)}`, name)
    return null
  })

  let changed = false
  if (row.kind === 'video') {
    const meta = await attempt('probe', media.probe(file))
    if (meta) q.run('UPDATE videos SET width=?, height=?, duration=? WHERE name=?',
      meta.width, meta.height, meta.duration, name)
    const result = await attempt('transcode', media.processVideo(file, row.ext, meta || {}))
    if (result && existsSync(result.out)) {
      file = adoptOutput(row, file, result.out, result.ext, `video/${result.ext}`)
      changed = true
    }
  } else if (row.kind === 'image') {
    const meta = await attempt('probe', media.probe(file))
    if (meta) q.run('UPDATE videos SET width=?, height=? WHERE name=?', meta.width, meta.height, name)
    const result = await attempt('image processing', media.processImage(file, row.ext))
    if (result && existsSync(result.out)) {
      file = adoptOutput(row, file, result.out, 'jpg', 'image/jpeg')
      changed = true
    }
  }

  // Re-probe: scaling/compression changes the real dimensions, and the numbers
  // taken before the pipeline ran would otherwise be reported to clients forever.
  if (changed) {
    const after = await attempt('re-probe', media.probe(file))
    if (after) q.run('UPDATE videos SET width=?, height=?, duration=? WHERE name=?',
      after.width, after.height, after.duration || 0, name)
  }

  // moderation on the final stored file
  const finalFile = file
  if (finalFile && conf('check_img')) {
    const { score, flagged } = await moderate(finalFile, name, row.kind, `/v/${name}`)
    q.run('UPDATE videos SET mod_score=? WHERE name=?', score, name)
    if (flagged) {
      if (conf('check_action') === 'delete') {
        try { unlinkSync(finalFile) } catch {}
        try { unlinkSync(thumbPath(name)) } catch {}
        q.run("UPDATE videos SET status='recycled' WHERE name=?", name)
        q.run("UPDATE upload_logs SET status='banned', msg='mod.deleted' WHERE name=?", name)
        emit('moderation.flagged', { name, orig: row.orig, username: row.username, score, action: 'delete' })
      } else {
        q.run("UPDATE videos SET status='banned' WHERE name=?", name)
        q.run("UPDATE upload_logs SET status='banned', msg='mod.quarantined' WHERE name=?", name)
        emit('moderation.flagged', { name, orig: row.orig, username: row.username, score, action: 'ban' })
      }
      return
    }
  }
  q.run("UPDATE videos SET status='ok' WHERE name=? AND status='processing'", name)
  const done = q.get('SELECT * FROM videos WHERE name=?', name)
  if (done) emit('upload.completed', videoEvent(done))
}

// ---------- the public upload entry ----------

/**
 * Full upload flow. Returns { status, body } — the HTTP response.
 * `user` may be null for guest uploads.
 */
export async function acceptUpload(req, { user, ip, region, orig, visibility }) {
  const maxBytes = Math.max(1, confNum('max_size_mb')) * 1024 * 1024
  orig = safeName(orig || 'video.mp4')
  const ext = (orig.match(/\.(\w{2,5})$/)?.[1] || '').toLowerCase()
  const kind = classifyExt(ext)
  const logBase = { ip, region, user, orig }
  if (!kind) {
    logUpload({ ...logBase, status: 'rejected', msg: ['up.badType'] })
    emit('upload.rejected', { orig, reason: 'up.badType', username: user?.username ?? 'guest', ip })
    return { status: 400, error: ['up.badType'] }
  }

  // uploader's own default unless the request asks for something specific
  const vis = visibility === 'private' || visibility === 'public'
    ? visibility
    : (user?.default_visibility || conf('default_visibility') || 'public')

  const tooLarge = ['up.tooLarge', confNum('max_size_mb')]

  // Reject on the declared length before reading a byte. Browsers always send
  // Content-Length for a file body, so this is what makes the 413 actually reach
  // the client — tearing the socket down mid-stream only surfaces a network error.
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > maxBytes) {
    req.resume()
    logUpload({ ...logBase, size: declared, status: 'rejected', msg: tooLarge })
    emit('upload.rejected', { orig, reason: 'up.tooLarge', size: declared, username: user?.username ?? 'guest', ip })
    return { status: 413, error: tooLarge }
  }

  const tmp = join(TMP_DIR, `.up-${randomUUID()}`)
  let up
  try { up = await streamUpload(req, tmp, maxBytes) }
  catch (e) {
    const why = e.message === 'too large' ? tooLarge : ['up.aborted']
    logUpload({ ...logBase, status: 'failed', msg: why })
    return { status: 413, error: why }
  }

  return storeUpload({ tmp, up, orig, ext, kind, vis, user, ip, region, logBase })
}

/**
 * Everything after the bytes have landed in `tmp`: blocklist, quota, dedupe,
 * move into place, probe, thumbnail, queue. Shared by the single-shot upload
 * and by the resumable one, which assembles its bytes across many requests.
 */
export async function storeUpload({ tmp, up, orig, ext, kind, vis, user, ip, region, logBase }) {
  /** One place to both answer and announce a refusal. */
  const refuse = (status, why) => {
    emit('upload.rejected', {
      orig, reason: Array.isArray(why) ? why[0] : why,
      username: user?.username ?? 'guest', ip,
    })
    return { status, error: why }
  }

  if (hashBlocked(up.sha256)) {
    try { unlinkSync(tmp) } catch {}
    logUpload({ ...logBase, size: up.size, status: 'rejected', msg: ['up.hashBlocked'] })
    return refuse(403, ['up.hashBlocked'])
  }

  const overQuota = storageReason(up.size)
  if (overQuota) {
    try { unlinkSync(tmp) } catch {}
    logUpload({ ...logBase, size: up.size, status: 'rejected', msg: overQuota })
    return refuse(507, overQuota)
  }

  const name = `${up.sha256.slice(0, 16)}.${ext}`

  // Content dedupe. Keyed on `name` — which is derived from the content hash and
  // the *uploaded* extension, and never changes afterwards. Matching on the
  // `ext` column instead would miss once the pipeline rewrites it (mkv → mp4),
  // and the follow-up INSERT would then collide on this same primary key.
  const dup = q.get('SELECT name, status, stored, visibility FROM videos WHERE name = ?', name)
  if (dup && dup.status !== 'recycled') {
    try { unlinkSync(tmp) } catch {}
    // Quarantined content must not come back as a "successful" upload handing
    // out a link that only ever answers 451.
    if (dup.status === 'banned') {
      logUpload({ ...logBase, name: dup.name, size: up.size, status: 'rejected', msg: ['up.banned'] })
      return refuse(403, ['up.banned'])
    }
    logUpload({ ...logBase, name: dup.name, size: up.size, status: 'ok', msg: ['up.dedup'] })
    return { status: 200, body: links(dup.name, up.size, orig, dup.status, true, dup.visibility, kind) }
  }
  if (dup) {
    // Recycled row holding this exact key — drop it so the re-upload can take
    // the name over cleanly instead of tripping the primary key.
    const old = findFile(dup)
    if (old) try { unlinkSync(old) } catch {}
    try { unlinkSync(thumbPath(name)) } catch {}
    q.run('DELETE FROM videos WHERE name=?', name)
  }

  const dest = storagePath(name)
  renameSync(tmp, dest)

  const willProcess = conf('process_enabled') && kind !== 'other' && await media.hasFfmpeg()
  q.run(
    `INSERT INTO videos(name, stored, orig, size, sha256, ext, kind, mime, status, visibility,
                        user_id, username, ip, ip_region, uploaded)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    name, name, orig, up.size, up.sha256, ext, kind,
    kind === 'image' ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : `${kind}/${ext}`,
    willProcess ? 'processing' : 'ok', vis,
    user?.id ?? 0, user?.username ?? 'guest', ip, region, nowIso())

  // fast path: metadata + thumbnail inline (cheap), heavy work in queue
  if (await media.hasFfmpeg() && kind !== 'other') {
    const meta = await media.probe(dest).catch(() => null)
    if (meta) {
      const mw = confNum('min_width'), mh = confNum('min_height')
      if ((mw > 0 && meta.width < mw) || (mh > 0 && meta.height < mh)) {
        try { unlinkSync(dest) } catch {}
        try { unlinkSync(thumbPath(name)) } catch {}
        q.run('DELETE FROM videos WHERE name=?', name)   // rejected outright, not recycled
        const why = ['up.tooSmall', meta.width, meta.height, mw, mh]
        logUpload({ ...logBase, name, size: up.size, status: 'rejected', msg: why })
        return refuse(400, why)
      }
      q.run('UPDATE videos SET width=?, height=?, duration=? WHERE name=?',
        meta.width, meta.height, meta.duration || 0, name)
    }
    if (conf('thumbnail') && kind === 'video')
      await media.makeThumb(dest, thumbPath(name), conf('thumbnail_w')).catch(() => {})
    else if (conf('thumbnail') && kind === 'image')
      await media.makeImageThumb(dest, thumbPath(name), conf('thumbnail_w')).catch(() => {})
  }

  if (willProcess) enqueue(name, 'pipeline')
  else if (conf('check_img') && kind !== 'other' && await media.hasFfmpeg()) enqueue(name, 'pipeline')

  logUpload({ ...logBase, name, size: up.size, status: 'ok' })
  if (!willProcess) {
    const row = q.get('SELECT * FROM videos WHERE name=?', name)
    if (row) emit('upload.completed', videoEvent(row))
  }
  return { status: 200, body: links(name, up.size, orig, willProcess ? 'processing' : 'ok', false, vis, kind) }
}

function links(name, size, orig, status, dedup, visibility = 'public', kind = 'video') {
  return {
    name, size, orig, status, dedup, visibility, kind,
    url: `/v/${name}`,
    player: `/p/${name}`,
    thumb: `/t/${name}`,
    download: `/d/${name}`,
    embed: `<iframe src="/p/${name}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`,
  }
}
