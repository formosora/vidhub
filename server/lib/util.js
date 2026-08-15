/** Shared helpers: HTTP body/response, sanitizing, client IP, misc. */
import { createHash, randomUUID } from 'node:crypto'

export const sha256 = buf => createHash('sha256').update(buf).digest('hex')
export const newToken = () => randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
export const nowIso = () => new Date().toISOString()
export const today = () => nowIso().slice(0, 10)

/** JSON (or other) response helper. */
export function send(res, code, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, ...headers })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

/**
 * Read a small request body (login, settings…). Rejects — and stops reading —
 * past `max`. Every terminal event settles the promise: a bare `req.destroy()`
 * used to leave the caller awaiting forever, so the request never got a reply.
 */
export const readBody = (req, max = 2_000_000) =>
  new Promise((resolve, reject) => {
    let data = '', read = 0, done = false, over = false
    const settle = (fn, arg) => { if (!done) { done = true; fn(arg) } }
    const tooLarge = () => Object.assign(new Error('body too large'), { code: 'E_TOO_LARGE' })

    if (Number(req.headers['content-length'] || 0) > max) { over = true; settle(reject, tooLarge()) }

    req.on('data', c => {
      read += c.length
      // Past the limit we stop buffering but keep draining, so the handler's
      // error response still reaches the client instead of a bare socket reset.
      // Beyond a small multiple of the cap the client is clearly abusive — cut it.
      if (over) { if (read > max * 2) req.destroy(); return }
      data += c
      if (data.length > max) { over = true; settle(reject, tooLarge()) }
    })
    req.on('end', () => settle(resolve, data))
    req.on('aborted', () => settle(reject, new Error('body aborted')))
    req.on('close', () => settle(reject, new Error('body closed')))
    req.on('error', e => settle(reject, e))
    if (over) req.resume()
  })

export const readJson = async (req, max) => {
  try { return JSON.parse(await readBody(req, max)) } catch { return {} }
}

/** Filenames coming from users are reduced to a safe charset. */
export const safeName = s => String(s || 'file').replace(/[^\w.()\-一-鿿]/g, '_').slice(-120)

/** Client IP, honoring a single reverse-proxy hop when TRUST_PROXY=1. */
export function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for']
    if (fwd) return String(fwd).split(',')[0].trim()
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown'
}

/** IPv4/IPv6 literal or CIDR match (CIDR for v4 only — good enough for ACLs). */
export function ipMatches(rule, ip) {
  rule = rule.trim()
  if (!rule) return false
  if (rule === ip) return true
  if (rule.endsWith('*')) return ip.startsWith(rule.slice(0, -1))
  const m = rule.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/)
  if (m) {
    const bits = Number(m[2])
    const toInt = a => a.split('.').reduce((acc, o) => (acc << 8) | Number(o), 0) >>> 0
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (toInt(m[1]) & mask) === (toInt(ip) & mask)
  }
  return false
}

export const fmtBytes = n =>
  n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'

/** Escape user text before embedding into server-rendered HTML (player page). */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
