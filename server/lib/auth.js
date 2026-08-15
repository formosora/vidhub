/**
 * Auth: scrypt password hashing, DB-persisted sessions, API keys,
 * per-IP login rate limiting. Multi-user with admin / uploader roles.
 */
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto'
import { q } from './db.js'
import { conf } from './config.js'
import { newToken, nowIso } from './util.js'
import { AppError } from './i18n.js'

const SESSION_TTL = 12 * 3600_000

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

export function openSession(userId) {
  const token = newToken()
  q.run('INSERT INTO sessions(token, user_id, exp) VALUES(?,?,?)', token, userId, Date.now() + SESSION_TTL)
  q.run('DELETE FROM sessions WHERE exp < ?', Date.now())
  return token
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
export function identify(req) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || ''
  if (!raw) return null
  const sess = q.get('SELECT user_id, exp FROM sessions WHERE token = ?', raw)
  if (sess && sess.exp > Date.now()) {
    const u = q.get('SELECT id, username, role, daily_limit, default_visibility FROM users WHERE id = ? AND status = ?', sess.user_id, 'active')
    if (u) return u
  }
  const key = q.get('SELECT user_id FROM api_keys WHERE key = ? AND status = ?', raw, 'active')
  if (key) {
    const u = q.get('SELECT id, username, role, daily_limit, default_visibility FROM users WHERE id = ? AND status = ?', key.user_id, 'active')
    if (u) return u
  }
  return null
}

export const isAdmin = u => !!u && u.role === 'admin'
