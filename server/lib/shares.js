/**
 * Share links — the real access control behind `protected` visibility.
 *
 * `private` only ever meant "unlisted": the name is a content hash nobody can
 * guess, but anyone holding the URL keeps it forever. That is fine for most
 * uploads and useless for the ones that actually matter.
 *
 * A `protected` video refuses every direct URL — /v/, /d/, /t/ and /p/ all say
 * no. It is reachable only through a share link, which its owner can give an
 * expiry, a view ceiling and a password, and can revoke at any time.
 *
 * The part that makes this workable for a video host: it does not break embeds.
 * The token lives in the URL, so `<iframe src="/s/<token>">` behaves exactly
 * like the ordinary player page — which is precisely why authenticated access
 * was rejected as the answer here.
 *
 * Streaming is authorised with a short-lived signed grant rather than a cookie
 * or a session. The share page mints `?k=<exp>.<sig>` into its own media URLs,
 * and /v/ verifies the signature. That keeps the no-cookie design intact (so
 * still no CSRF surface), survives Range requests untouched, and means a leaked
 * media URL stops working within hours instead of never.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { q } from './db.js'
import { hashPassword } from './auth.js'
import { newToken, nowIso } from './util.js'

/** How long a minted streaming grant stays valid. Long enough for a feature
 *  film plus seeking, short enough that a copied URL is not a permanent hole. */
const GRANT_TTL = 6 * 3600_000
/** Same window the site uses for video views, so a reload does not burn a view. */
const VIEW_WINDOW = 3600_000

/**
 * HMAC key for grants. Kept in its own table rather than in `settings` so it
 * can never ride along in the admin settings payload, and so `setConf` has no
 * way to overwrite it. It is created on first use and travels with the
 * database, which means a restored backup keeps issuing valid grants.
 */
let cachedSecret = null
function grantSecret() {
  if (cachedSecret) return cachedSecret
  const row = q.get("SELECT value FROM secrets WHERE key = 'share_grant'")
  if (row) return (cachedSecret = row.value)
  const s = newToken()
  q.run("INSERT OR REPLACE INTO secrets(key, value) VALUES('share_grant', ?)", s)
  return (cachedSecret = s)
}

const sigFor = (name, exp) =>
  createHmac('sha256', grantSecret()).update(`${name}.${exp}`).digest('hex').slice(0, 32)

/**
 * Mint a grant for one video. `until` clamps it, so a grant never outlives the
 * share that produced it — a link that expires in ten minutes must not hand out
 * six hours of streaming.
 */
export function mintGrant(name, until = 0) {
  let exp = Date.now() + GRANT_TTL
  if (until > 0) exp = Math.min(exp, until)
  return `${exp}.${sigFor(name, exp)}`
}

export function verifyGrant(name, k) {
  const m = String(k || '').match(/^(\d+)\.([a-f0-9]{32})$/)
  if (!m) return false
  const exp = Number(m[1])
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const want = Buffer.from(sigFor(name, exp))
  const got = Buffer.from(m[2])
  return want.length === got.length && timingSafeEqual(want, got)
}

// ---------- shares ----------

export function createShare({ name, userId, password = '', expiresInHours = 0, maxViews = 0, note = '' }) {
  const token = newToken().slice(0, 32)
  const hours = Number(expiresInHours) || 0
  const expires = hours > 0 ? Date.now() + hours * 3600_000 : 0
  const max = Math.max(0, Math.floor(Number(maxViews) || 0))
  const pass = String(password || '')
  const { salt, hash } = pass ? hashPassword(pass) : { salt: '', hash: '' }
  q.run(`INSERT INTO shares(token, name, user_id, pass_hash, salt, expires, max_views, note, created)
         VALUES(?,?,?,?,?,?,?,?,?)`,
    token, name, userId || 0, hash, salt, expires, max, String(note || '').slice(0, 200), nowIso())
  return getShare(token)
}

export const getShare = token =>
  /^[a-f0-9]{32}$/.test(String(token || '')) ? q.get('SELECT * FROM shares WHERE token = ?', token) : null

export const sharesFor = name => q.all('SELECT * FROM shares WHERE name = ? ORDER BY created DESC', name)

export const revokeShare = token => q.run('DELETE FROM shares WHERE token = ?', token).changes > 0

export const dropSharesFor = name => q.run('DELETE FROM shares WHERE name = ?', name)

/** Why a share cannot be used right now — or null when it can. */
export function shareBlocked(s) {
  if (!s) return 'share.notFound'
  if (s.expires > 0 && Date.now() > s.expires) return 'share.expired'
  if (s.max_views > 0 && s.views >= s.max_views) return 'share.exhausted'
  return null
}

export function shareNeedsPassword(s) {
  return !!(s && s.pass_hash)
}

export function checkSharePassword(s, password) {
  if (!shareNeedsPassword(s)) return true
  const { hash } = hashPassword(String(password ?? ''), s.salt)
  const a = Buffer.from(hash), b = Buffer.from(s.pass_hash)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Count one view against a share, de-duplicated per viewer for an hour — the
 * same rule the site's own view counter uses, so a reload or a seek that
 * re-opens the page cannot eat somebody's five-view limit.
 */
const seen = new Map()
export function countShareView(ip, token) {
  const now = Date.now()
  if (seen.size > 20_000) for (const [k, exp] of seen) if (exp < now) seen.delete(k)
  const key = `${ip}|${token}`
  if ((seen.get(key) || 0) > now) return
  seen.set(key, now + VIEW_WINDOW)
  q.run('UPDATE shares SET views = views + 1, last_seen = ? WHERE token = ?', now, token)
}

/** Drop links that expired long enough ago that nobody is coming back. */
export function sweepShares() {
  const cutoff = Date.now() - 30 * 86400_000
  const n = q.run('DELETE FROM shares WHERE expires > 0 AND expires < ?', cutoff).changes
  if (n) console.log(`[vidhub] cleared ${n} long-expired share link(s)`)
}

/** Shape handed to the owner in the API. Never includes the password hash. */
export const shareOut = s => ({
  token: s.token,
  name: s.name,
  url: `/s/${s.token}`,
  embed: `<iframe src="/s/${s.token}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`,
  has_password: !!s.pass_hash,
  expires: s.expires,
  max_views: s.max_views,
  views: s.views,
  note: s.note,
  created: s.created,
  last_seen: s.last_seen || 0,
  state: shareBlocked(s) || 'ok',
})
