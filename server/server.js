/**
 * vidhub — commercial self-hosted video bed.
 * Zero npm dependencies: Node's built-in http + node:sqlite + external ffmpeg.
 */
import http from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { q } from './lib/db.js'
import { ensureAdmin } from './lib/auth.js'
import { handleApi } from './lib/routes.js'
import { findFile, thumbPath, resumeJobs } from './lib/upload.js'
import { playerPage } from './lib/player.js'
import { leechBlocked } from './lib/security.js'
import { send, clientIp } from './lib/util.js'
import { t, lang } from './lib/i18n.js'
import { hasFfmpeg } from './lib/media.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8080)
const WWWROOT = join(ROOT, 'wwwroot')

/**
 * Two separate MIME tables on purpose.
 *
 * MEDIA_MIME covers *user-uploaded* bytes and deliberately contains only inert
 * video/image types — no html/js/css/svg. Anything not on this list is served as
 * an octet-stream attachment, so an uploaded .html (or .svg) can never execute
 * script on this origin and steal the session token out of localStorage.
 */
const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.3gp': 'video/3gpp',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
}

/** STATIC_MIME covers only our own built frontend assets under wwwroot/. */
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
}

/** Hardening applied to every response. */
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

/** Extra lockdown for user-uploaded bytes: no scripts, no embedding context. */
const MEDIA_HEADERS = {
  ...BASE_HEADERS,
  'Content-Security-Policy': "default-src 'none'; media-src 'self'; img-src 'self'; sandbox",
}

ensureAdmin()
hasFfmpeg().then(ok => {
  console.log(`[vidhub] ffmpeg: ${ok ? 'available' : 'MISSING — degraded mode'}`)
  resumeJobs()      // re-queue anything left mid-pipeline by a restart
})

/** RFC 7233 single-range streaming — required for seeking in <video>. */
function serveRange(req, res, file, type, extra = {}) {
  const size = statSync(file).size
  const range = req.headers.range
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    if (m) {
      let start = m[1] ? parseInt(m[1]) : NaN
      let end = m[2] ? parseInt(m[2]) : NaN
      if (isNaN(start) && !isNaN(end)) { start = Math.max(0, size - end); end = size - 1 }
      if (isNaN(end) || end >= size) end = size - 1
      if (isNaN(start)) start = 0
      if (start > end || start >= size) {
        res.writeHead(416, { ...extra, 'Content-Range': `bytes */${size}` })
        return res.end()
      }
      res.writeHead(206, {
        ...extra,
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      })
      return createReadStream(file, { start, end }).pipe(res)
    }
  }
  res.writeHead(200, { ...extra, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size })
  createReadStream(file).pipe(res)
}

const validName = n => /^[\w.-]+$/.test(n) && !n.includes('..')

function loadVideo(name) {
  if (!validName(name)) return null
  return q.get('SELECT * FROM videos WHERE name = ?', name)
}

/**
 * View counting, de-duplicated per (viewer, video) for an hour so a reload loop
 * — or anyone curling the stream URL — can't inflate the counter.
 */
const seen = new Map()          // `${ip}|${name}` -> expiry ms
const VIEW_WINDOW = 3600_000

function countView(ip, name) {
  const now = Date.now()
  if (seen.size > 20_000) for (const [k, exp] of seen) if (exp < now) seen.delete(k)
  const key = `${ip}|${name}`
  if ((seen.get(key) || 0) > now) return
  seen.set(key, now + VIEW_WINDOW)
  q.run('UPDATE videos SET views = views + 1 WHERE name = ?', name)
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    let path
    try { path = decodeURIComponent(url.pathname) }
    catch { return send(res, 400, 'bad request', 'text/plain', BASE_HEADERS) }

    if (path.startsWith('/api/')) return await handleApi(req, res, path, url)

    // ---- media stream (public for ok items; admin/owner for flagged) ----
    if (path.startsWith('/v/') || path.startsWith('/d/')) {
      const name = path.slice(3)
      const v = loadVideo(name)
      if (!v || v.status === 'recycled') return send(res, 404, 'not found', 'text/plain', MEDIA_HEADERS)
      if (v.status === 'banned') return send(res, 451, 'content under review', 'text/plain', MEDIA_HEADERS)
      if (leechBlocked(req)) return send(res, 403, 'hotlink blocked', 'text/plain', MEDIA_HEADERS)
      const file = findFile(v)
      if (!file) return send(res, 404, 'not found', 'text/plain', MEDIA_HEADERS)

      const headers = { ...MEDIA_HEADERS }
      // Only inert media types render inline. Everything else (and every /d/
      // request) is forced to download as an opaque blob.
      const type = MEDIA_MIME[extname(file).toLowerCase()]
      const download = !type || path.startsWith('/d/')
      if (download) {
        headers['Content-Disposition'] =
          `attachment; filename*=UTF-8''${encodeURIComponent(v.orig || name)}`
      }
      if (!download) {
        const range = req.headers.range || ''
        if (!range || /^bytes=0-/.test(range)) countView(clientIp(req), name)
      }
      return serveRange(req, res, file, type || 'application/octet-stream', headers)
    }

    // ---- thumbnail ----
    if (path.startsWith('/t/')) {
      const name = path.slice(3)
      if (!validName(name)) return send(res, 400, 'bad name', 'text/plain', BASE_HEADERS)
      const v = q.get('SELECT status FROM videos WHERE name = ?', name)
      const tp = thumbPath(name)
      if (!v || v.status !== 'ok' || !existsSync(tp)) return send(res, 404, 'not found', 'text/plain', BASE_HEADERS)
      res.writeHead(200, { ...MEDIA_HEADERS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' })
      return createReadStream(tp).pipe(res)
    }

    // ---- player page (embeddable by design → no X-Frame-Options here) ----
    if (path.startsWith('/p/')) {
      const name = path.slice(3)
      const v = loadVideo(name)
      const L = lang(req, url)
      if (!v || v.status === 'recycled') return send(res, 404, t(L, 'c.notFound'), 'text/plain', BASE_HEADERS)
      if (v.status === 'banned')
        return send(res, 451, `<h1>${t(L, 'c.underReview')}</h1>`, 'text/html; charset=utf-8', BASE_HEADERS)
      return send(res, 200, playerPage(v, L), 'text/html; charset=utf-8', BASE_HEADERS)
    }

    // ---- static + SPA fallback ----
    let file = normalize(join(WWWROOT, path))
    if (!file.startsWith(WWWROOT)) return send(res, 403, 'forbidden', 'text/plain', BASE_HEADERS)
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(path)) return send(res, 404, 'not found', 'text/plain', BASE_HEADERS)
      file = join(WWWROOT, 'index.html')
    }
    const ext = extname(file).toLowerCase()
    const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    send(res, 200, readFileSync(file), STATIC_MIME[ext] || 'application/octet-stream', {
      ...BASE_HEADERS,
      'X-Frame-Options': 'SAMEORIGIN',      // the admin SPA must not be framed
      'Cache-Control': cache,
    })
  } catch (err) {
    console.error(err)
    send(res, 500, { error: 'internal' })
  }
}).listen(PORT, () => console.log(`vidhub on :${PORT}`))
