/**
 * Auth: scrypt password hashing, DB-persisted sessions, API keys,
 * per-IP login rate limiting. Multi-user with admin / uploader roles.
 */
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto'
import { q } from './db.js'
import { conf, confNum } from './config.js'
import { newToken, nowIso } from './util.js'
import { AppError } from './i18n.js'

/** Everything a session or key can authorise. A session always gets all of them. */
export const SCOPES = ['read', 'upload', 'manage']
export const ALL_SCOPES = new Set(SCOPES)

export const parseScopes = s =>
  new Set(String(s || '').split(',').map(x => x.trim()).filter(x => SCOPES.includes(x)))

const hours = () => Math.max(1, confNum('session_hours')) * 3600_000

// ---------- users ----------

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(password), salt, 32).toString('hex') }
}

/** Single source of truth for password rules — throws a localisable AppError. */
export function assertPassword(password) {
  const p = String(password ?? '')
  if (p.length < 6) throw new AppError('auth.passwordTooShort')
  if (p.length > 200) throw new AppError('auth.passwordTooLong')
  return p
}

export function createUser(username, password, role = 'uploader', dailyLimit = 0, visibility = 'public') {
  username = String(username || '').trim()
  if (!/^[a-zA-Z0-9_一-鿿-]{2,32}$/.test(username)) throw new AppError('auth.badUsername')
  assertPassword(password)
  if (q.get('SELECT id FROM users WHERE username = ?', username)) throw new AppError('auth.usernameTaken')
  const { salt, hash } = hashPassword(password)
  const r = q.run(
    `INSERT INTO users(username, pass_hash, salt, role, daily_limit, default_visibility, created)
     VALUES(?,?,?,?,?,?,?)`,
    username, hash, salt, role, dailyLimit, visibility === 'private' ? 'private' : 'public', nowIso())
  return { id: Number(r.lastInsertRowid), username, role }
}

export function verifyUser(username, password) {
  const u = q.get('SELECT * FROM users WHERE username = ?', String(username || ''))
  if (!u || u.status !== 'active') return null
  const { hash } = hashPassword(password, u.salt)
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(u.pass_hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b) ? u : null
}

/** First-run bootstrap: create the admin account from env (or a default). */
export function ensureAdmin() {
  if (q.get('SELECT id FROM users LIMIT 1')) return
  const pwd = process.env.ADMIN_PASSWORD || 'change-me'
  createUser('admin', pwd, 'admin')
  console.log(`[vidhub] admin account created (admin / ${pwd === 'change-me' ? 'change-me — PLEASE CHANGE' : 'from ADMIN_PASSWORD'})`)
}

// ---------- sessions ----------

/**
 * Open a session. `remember` swaps the short working TTL for the longer
 * "keep me signed in" one; both still slide on activity and both are capped by
 * session_max_days measured from `born`.
 */
export function openSession(userId, remember = false) {
  const token = newToken()
  const now = Date.now()
  const ttl = remember ? Math.max(1, confNum('session_remember_days')) * 86400_000 : hours()
  q.run('INSERT INTO sessions(token, user_id, exp, born, seen) VALUES(?,?,?,?,?)',
    token, userId, now + ttl, now, now)
  q.run('DELETE FROM sessions WHERE exp < ?', now)
  return token
}

/**
 * Sliding renewal: once a session is past its halfway point, push the expiry
 * out again — so someone using the site daily is never logged out mid-task,
 * while an abandoned session still dies on schedule. `session_max_days` is the
 * hard ceiling from first sign-in, so a session cannot live forever.
 */
function slide(sess, token) {
  const now = Date.now()
  const ttl = Math.max(hours(), sess.exp - sess.born)   // preserve a "remember me" window
  if (sess.exp - now > ttl / 2) {
    // not yet halfway; only refresh the activity stamp, and only once a minute
    if (now - sess.seen > 60_000) q.run('UPDATE sessions SET seen=? WHERE token=?', now, token)
    return sess.exp
  }
  const capDays = confNum('session_max_days')
  const ceiling = capDays > 0 ? (sess.born || now) + capDays * 86400_000 : Infinity
  const next = Math.min(now + ttl, ceiling)
  if (next > sess.exp) q.run('UPDATE sessions SET exp=?, seen=? WHERE token=?', next, now, token)
  else q.run('UPDATE sessions SET seen=? WHERE token=?', now, token)
  return next
}

export function closeSession(token) {
  q.run('DELETE FROM sessions WHERE token = ?', token)
}

// ---------- login rate limit (in-memory, per IP) ----------

/** Shared hourly per-IP counters, one bucket per action. */
const buckets = new Map()   // `${action}|${ip}` -> { count, reset }

function bump(action, ip) {
  const now = Date.now()
  if (buckets.size > 20_000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k)
  const key = `${action}|${ip}`
  let rec = buckets.get(key)
  if (!rec || rec.reset < now) { rec = { count: 0, reset: now + 3600_000 }; buckets.set(key, rec) }
  rec.count++
  return rec.count
}

function peek(action, ip) {
  const rec = buckets.get(`${action}|${ip}`)
  return rec && rec.reset >= Date.now() ? rec.count : 0
}

export const loginThrottled = ip => bump('login', ip) > (conf('login_rate_limit') || 10)

/**
 * Signup limiting, split in two so a human who fumbles the captcha is not
 * locked out for an hour:
 *   - attempts get a generous ceiling (blocks captcha brute-forcing)
 *   - *successful* signups get the strict configured cap (blocks mass accounts)
 */
export function registerThrottled(ip) {
  const limit = conf('register_rate_limit') || 5
  if (bump('register-try', ip) > Math.max(30, limit * 6)) return true
  return peek('register-ok', ip) >= limit
}

/** Call only after an account is actually created. */
export const noteRegistered = ip => bump('register-ok', ip)

/** Issuing challenges is cheap but not free — keep one IP from churning the store. */
export const captchaThrottled = ip => bump('captcha', ip) > 60

// ---------- request identity ----------

/**
 * Resolve the caller: Bearer session token or API key.
 * Returns { id, username, role } or null.
 */
const loadUser = id =>
  q.get('SELECT id, username, role, daily_limit, default_visibility FROM users WHERE id = ? AND status = ?', id, 'active')

export function identify(req) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || ''
  if (!raw) return null
  const now = Date.now()

  const sess = q.get('SELECT user_id, exp, born, seen FROM sessions WHERE token = ?', raw)
  if (sess && sess.exp > now) {
    const u = loadUser(sess.user_id)
    if (u) return { ...u, via: 'session', scopes: ALL_SCOPES, exp: slide(sess, raw) }
  }

  const key = q.get('SELECT user_id, scopes, expires, last_used FROM api_keys WHERE key = ? AND status = ?', raw, 'active')
  if (key) {
    if (key.expires > 0 && key.expires <= now) return null      // expired key
    const u = loadUser(key.user_id)
    if (u) {
      // one write a minute at most; the timestamp is for auditing, not billing
      if (now - key.last_used > 60_000) q.run('UPDATE api_keys SET last_used=? WHERE key=?', now, raw)
      return { ...u, via: 'key', scopes: parseScopes(key.scopes) }
    }
  }
  return null
}

export const isAdmin = u => !!u && u.role === 'admin'

/** API keys never reach the admin surface, whatever their owner's role is. */
export const isAdminSession = u => isAdmin(u) && u?.via !== 'key'

export const hasScope = (u, scope) => !!u && (u.scopes ? u.scopes.has(scope) : true)
