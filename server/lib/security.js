/**
 * Security layer: IP allow/deny lists, daily quotas, hash blacklist,
 * anti-leech, upload logging with IP geolocation.
 */
import { q } from './db.js'
import { conf, confNum } from './config.js'
import { statfsSync } from 'node:fs'
import { join } from 'node:path'
import { ipMatches, nowIso, today } from './util.js'

// ---------- IP black/white list ----------

/**
 * null = pass; otherwise `[messageKey, ...params]` so the caller can render it
 * in the requester's language.
 */
export function ipBlockReason(ip) {
  const mode = conf('check_ip')
  if (!mode) return null
  const rules = q.all('SELECT ip FROM ip_rules').map(r => r.ip)
  const hit = rules.some(rule => ipMatches(rule, ip))
  if (mode === 1 && hit) return ['sec.ipBlacklisted']
  if (mode === 2 && !hit) return ['sec.ipNotWhitelisted']
  return null
}

// ---------- daily quotas ----------

export function quotaReason(ip, user) {
  const day = today() + '%'
  if (user) {
    const perUser = user.daily_limit || confNum('daily_limit_user')
    if (perUser > 0) {
      const n = q.get(
        "SELECT COUNT(*) c FROM videos WHERE user_id = ? AND uploaded LIKE ? AND status != 'recycled'",
        user.id, day).c
      if (n >= perUser) return ['up.quotaUser', perUser]
    }
  }
  // Counted off `videos`, not `upload_logs` — the log table is optional and
  // turning it off used to silently disable the per-IP limit along with it.
  const perIp = confNum('daily_limit_ip')
  if (perIp > 0 && ip) {
    const n = q.get(
      "SELECT COUNT(*) c FROM videos WHERE ip = ? AND uploaded LIKE ? AND status != 'recycled'", ip, day).c
    if (n >= perIp) return ['up.quotaIp', perIp]
  }
  return null
}

/** Global storage cap (storage_quota_gb, 0 = unlimited). */
export function storageReason(incomingBytes = 0) {
  const gb = confNum('storage_quota_gb')
  if (gb <= 0) return null
  const used = q.get("SELECT COALESCE(SUM(size),0) s FROM videos WHERE status != 'recycled'").s
  const cap = gb * 1024 ** 3
  if (used + incomingBytes > cap) return ['up.storageFull', gb]
  return null
}

// ---------- real disk space ----------

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')

/** Actual filesystem figures for the data directory, or null if unavailable. */
export function diskInfo() {
  try {
    const s = statfsSync(DATA_DIR)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch { return null }
}

/**
 * `storage_quota_gb` is a policy the operator sets; this is the physical limit
 * underneath it. Without this check a full disk shows up as half-written files
 * and 500s from SQLite — the first sign of trouble being a user complaint.
 * Refusing early keeps a reserve so the database can still write.
 */
export function diskReason(incomingBytes = 0) {
  const reserve = confNum('disk_reserve_gb') * 1024 ** 3
  if (reserve <= 0) return null
  const d = diskInfo()
  if (!d) return null                       // platform without statfs — don't block
  if (d.free - incomingBytes < reserve) return ['up.diskFull']
  return null
}

/** True while free space is under the warning threshold. */
export function diskLow() {
  const warnGb = confNum('disk_warn_gb')
  if (warnGb <= 0) return false
  const d = diskInfo()
  return !!d && d.free < warnGb * 1024 ** 3
}

// ---------- hash blacklist ----------

export const hashBlocked = sha =>
  conf('hash_black') ? !!q.get('SELECT sha256 FROM hash_black WHERE sha256 = ?', sha) : false

// ---------- anti-leech (Referer check for streams) ----------

export function leechBlocked(req) {
  if (!conf('anti_leech')) return false
  const ref = req.headers.referer || ''
  // No Referer means either a direct open or a client that suppresses it — which
  // is also the trivial way to bypass this check. `leech_allow_empty=0` closes it.
  if (!ref) return !conf('leech_allow_empty')
  let host
  try { host = new URL(ref).host } catch { return true }   // malformed → treat as foreign
  const allowed = (conf('leech_hosts') || '').split(',').map(s => s.trim()).filter(Boolean)
  if (req.headers.host) allowed.push(req.headers.host)
  return !allowed.some(h => h && (host === h || host.endsWith('.' + h)))
}

// ---------- IP geolocation (online, cached, graceful) ----------

const geoCache = new Map()   // ip -> region

export async function locateIp(ip) {
  if (!conf('ip_locate')) return ''
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip === '::1' ||
      ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
    return '内网'
  if (geoCache.has(ip)) return geoCache.get(ip)
  let region = ''
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 2500)
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,isp`, { signal: ctl.signal })
    clearTimeout(t)
    const j = await res.json()
    if (j.status === 'success') region = [j.country, j.regionName, j.city].filter(Boolean).join(' ')
  } catch { /* offline or rate-limited — leave empty */ }
  geoCache.set(ip, region)
  if (geoCache.size > 5000) geoCache.delete(geoCache.keys().next().value)
  return region
}

// ---------- upload log ----------

/**
 * `msg` may be a plain string or a `[messageKey, ...params]` tuple. Tuples are
 * stored as `key|p0|p1` so the admin panel can render an old log line in
 * whichever language the operator is currently using.
 */
export function logUpload({ ip, region = '', user = null, name = '', orig = '', size = 0, status = 'ok', msg = '' }) {
  if (!conf('upload_logs')) return
  const text = Array.isArray(msg) ? msg.join('|') : String(msg ?? '')
  q.run(
    'INSERT INTO upload_logs(time, ip, region, user_id, username, name, orig, size, status, msg) VALUES(?,?,?,?,?,?,?,?,?,?)',
    nowIso(), ip, region, user?.id ?? 0, user?.username ?? '', name, orig, size, status, text)
}
