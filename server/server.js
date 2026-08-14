import http from 'node:http'
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data')
const VIDEOS_DIR = join(DATA_DIR, 'videos')
const META_FILE = join(DATA_DIR, 'videos.json')
const WWWROOT = join(ROOT, 'wwwroot')
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me'
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024

mkdirSync(VIDEOS_DIR, { recursive: true })

const ALLOWED = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'])
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

const loadMeta = () => (existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : {})
const saveMeta = m => writeFileSync(META_FILE, JSON.stringify(m, null, 2))

const tokens = new Map()
const authed = req => {
  const exp = tokens.get((req.headers.authorization || '').replace('Bearer ', ''))
  return !!exp && exp > Date.now()
}

function send(res, code, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, ...headers })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

const readBody = (req, max = 1_000_000) =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > max) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

/** Stream an upload to disk with a rolling sha256 — never buffers the whole file. */
function streamUpload(req, tmpPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let size = 0
    const ws = createWriteStream(tmpPath)
    req.on('data', c => {
      size += c.length
      if (size > MAX_UPLOAD) {
        req.destroy()
        ws.destroy()
        try { unlinkSync(tmpPath) } catch {}
        return reject(new Error('too large'))
      }
      hash.update(c)
      ws.write(c)
    })
    req.on('end', () => ws.end(() => resolve({ size, hash: hash.digest('hex').slice(0, 16) })))
    req.on('error', reject)
  })
}

/** RFC 7233 single-range streaming — required for seeking in <video>. */
function serveVideo(req, res, file) {
  const size = statSync(file).size
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
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
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        return res.end()
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      })
      return createReadStream(file, { start, end }).pipe(res)
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': size,
  })
  createReadStream(file).pipe(res)
}

const playerPage = (name, orig) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${orig}</title>
<style>body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh}
video{max-width:100%;max-height:100vh;outline:none}</style></head>
<body><video src="/v/${name}" controls autoplay playsinline></video></body></html>`

async function handleApi(req, res, path, url) {
  if (path === '/api/login' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req).catch(() => '{}'))
    if (body.password !== ADMIN_PASSWORD) return send(res, 401, { error: 'unauthorized' })
    const token = randomUUID().replaceAll('-', '')
    tokens.set(token, Date.now() + 12 * 3600_000)
    return send(res, 200, { token })
  }

  // public listing for the explore page (no auth, no secrets)
  if (path === '/api/public/videos' && req.method === 'GET') {
    const meta = loadMeta()
    return send(res, 200, Object.entries(meta).map(([name, m]) => ({ name, ...m })))
  }

  // site statistics (public)
  if (path === '/api/stats' && req.method === 'GET') {
    const meta = loadMeta()
    const items = Object.values(meta)
    const byDay = {}
    let totalSize = 0
    for (const m of items) {
      const day = (m.uploaded || '').slice(0, 10)
      if (!day) continue
      byDay[day] = byDay[day] || { date: day, count: 0, size: 0 }
      byDay[day].count++
      byDay[day].size += m.size || 0
      totalSize += m.size || 0
    }
    return send(res, 200, {
      total: items.length,
      totalSize,
      byDay: Object.values(byDay).sort((a, b) => (a.date < b.date ? -1 : 1)),
    })
  }

  if (path === '/api/admin/check')
    return authed(req) ? send(res, 200, { ok: true }) : send(res, 401, { error: 'unauthorized' })

  if (path === '/api/videos' && req.method === 'GET') {
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' })
    const meta = loadMeta()
    return send(res, 200, Object.entries(meta).map(([name, m]) => ({ name, ...m })))
  }

  if (path === '/api/videos' && req.method === 'POST') {
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' })
    const orig = (url.searchParams.get('name') || 'video.mp4').replace(/[^\w.-]/g, '_')
    const ext = (orig.match(/\.(\w{2,5})$/)?.[1] || '').toLowerCase()
    if (!ALLOWED.has(ext)) return send(res, 400, { error: 'unsupported type' })

    const tmp = join(VIDEOS_DIR, `.uploading-${Date.now()}`)
    let result
    try {
      result = await streamUpload(req, tmp)
    } catch (e) {
      return send(res, 413, { error: e.message })
    }
    const name = `${result.hash}.${ext}`
    renameSync(tmp, join(VIDEOS_DIR, name))
    const meta = loadMeta()
    meta[name] = { orig, size: result.size, uploaded: new Date().toISOString() }
    saveMeta(meta)
    return send(res, 200, {
      name,
      size: result.size,
      url: `/v/${name}`,
      player: `/p/${name}`,
      embed: `<iframe src="/p/${name}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`,
    })
  }

  const del = path.match(/^\/api\/videos\/([\w.-]+)$/)
  if (del && req.method === 'DELETE') {
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' })
    const file = join(VIDEOS_DIR, del[1])
    if (existsSync(file)) unlinkSync(file)
    const meta = loadMeta()
    delete meta[del[1]]
    saveMeta(meta)
    return send(res, 200, { ok: true })
  }

  return send(res, 404, { error: 'not found' })
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const path = decodeURIComponent(url.pathname)

    if (path.startsWith('/api/')) return await handleApi(req, res, path, url)

    // video stream (public, with Range support)
    if (path.startsWith('/v/')) {
      const name = path.slice(3)
      if (!/^[\w.-]+$/.test(name)) return send(res, 400, 'bad name', 'text/plain')
      const file = join(VIDEOS_DIR, name)
      if (!existsSync(file)) return send(res, 404, 'not found', 'text/plain')
      return serveVideo(req, res, file)
    }

    // shareable player page
    if (path.startsWith('/p/')) {
      const name = path.slice(3)
      if (!/^[\w.-]+$/.test(name)) return send(res, 400, 'bad name', 'text/plain')
      const file = join(VIDEOS_DIR, name)
      if (!existsSync(file)) return send(res, 404, 'not found', 'text/plain')
      const orig = loadMeta()[name]?.orig || name
      return send(res, 200, playerPage(name, orig), 'text/html; charset=utf-8')
    }

    // static + SPA fallback
    let file = normalize(join(WWWROOT, path))
    if (!file.startsWith(WWWROOT)) return send(res, 403, 'forbidden', 'text/plain')
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(path)) return send(res, 404, 'not found', 'text/plain')
      file = join(WWWROOT, 'index.html')
    }
    const ext = extname(file).toLowerCase()
    const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    send(res, 200, readFileSync(file), MIME[ext] || 'application/octet-stream', { 'Cache-Control': cache })
  } catch (err) {
    console.error(err)
    send(res, 500, { error: 'internal' })
  }
}).listen(PORT, () => console.log(`vidhub on :${PORT}, data at ${DATA_DIR}`))
