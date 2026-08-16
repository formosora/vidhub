/**
 * Outgoing webhooks.
 *
 * Events are queued and delivered out of band — a slow or dead endpoint must
 * never hold up an upload. Each delivery is signed so the receiver can tell a
 * genuine call from anyone who guessed the URL, and every attempt is logged so
 * an integration that quietly stopped working is visible in the admin panel
 * instead of being discovered weeks later.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { q } from './db.js'
import { conf, confNum } from './config.js'

export const EVENTS = [
  'upload.completed',     // pipeline finished, file is live
  'upload.rejected',      // refused before it was ever stored
  'moderation.flagged',   // quarantined or deleted by moderation
  'video.deleted',        // permanently removed
  'user.registered',      // self-service sign-up
  'storage.low',          // free disk space crossed the warning threshold
]

const LOG_KEEP = 500

/** A bare IPv4 in a blocked range. */
function isPrivateV4(a) {
  if (/^(127\.|0\.|169\.254\.)/.test(a)) return true          // loopback, this-host, link-local
  if (/^10\./.test(a)) return true                            // RFC1918
  if (/^192\.168\./.test(a)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return true  // CGNAT 100.64/10
  return false
}

/**
 * Refuse loopback and private ranges by default. The URL comes from an admin,
 * but "admin account is compromised" should not also hand over a probe into the
 * private network — and a self-hosted box usually has plenty to find there.
 *
 * IPv6 is where this used to leak: `::ffff:127.0.0.1` (an IPv4-mapped address)
 * and the compressed forms all resolve to loopback, but a naive prefix check
 * waves them through. Every mapped form is unwrapped to its IPv4 and checked.
 */
export function isPrivateAddress(addr) {
  if (!addr) return true
  let a = String(addr).toLowerCase().trim()
  a = a.replace(/%.*$/, '')                                    // drop zone id (fe80::1%eth0)
  if (isIP(a) === 4) return isPrivateV4(a)

  // IPv4-mapped / -compatible IPv6: ::ffff:127.0.0.1, ::ffff:7f00:1, ::127.0.0.1
  const mapped = a.match(/^::(?:ffff:)?(?:0:)?(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateV4(mapped[1])
  const mappedHex = a.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16)
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }

  if (a === '::' || a === '::1') return true                   // unspecified, loopback
  if (a.startsWith('fc') || a.startsWith('fd')) return true    // unique local fc00::/7
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb'))
    return true                                                // link-local fe80::/10
  return false
}

/**
 * Resolve a host and reject if ANY address it maps to is private — a hostname
 * with several A/AAAA records only needs one internal answer to be dangerous.
 * Returns the vetted address list so delivery can pin to it and skip a second,
 * separately-resolved (and therefore re-bindable) lookup.
 */
async function resolveGuard(host) {
  try {
    const addrs = (await lookup(host, { all: true })).map(r => r.address)
    if (!addrs.length) return { error: 'hook.unresolvable' }
    if (addrs.some(isPrivateAddress)) return { error: 'hook.privateTarget' }
    return { addrs }
  } catch { return { error: 'hook.unresolvable' } }
}

export async function checkTarget(raw) {
  let u
  try { u = new URL(raw) } catch { return 'hook.badUrl' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'hook.badUrl'
  if (conf('webhook_allow_private')) return null
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return isPrivateAddress(host) ? 'hook.privateTarget' : null
  return (await resolveGuard(host)).error || null
}

export const sign = (secret, body, ts) =>
  'sha256=' + createHmac('sha256', String(secret || '')).update(`${ts}.${body}`).digest('hex')

/** Exposed so receivers (and our own tests) can verify the way we intend. */
export function verify(secret, body, ts, header) {
  const want = Buffer.from(sign(secret, body, ts))
  const got = Buffer.from(String(header || ''))
  return want.length === got.length && timingSafeEqual(want, got)
}

// ---------- delivery queue ----------

const queue = []
let running = false

function logDelivery(hookId, event, { code = 0, attempts = 0, ok = false, msg = '' }) {
  q.run('INSERT INTO webhook_log(hook_id, event, code, attempts, ok, msg, time) VALUES(?,?,?,?,?,?,?)',
    hookId, event, code, attempts, ok ? 1 : 0, String(msg).slice(0, 300), Date.now())
  // keep the table from growing without bound
  q.run(`DELETE FROM webhook_log WHERE id NOT IN
         (SELECT id FROM webhook_log ORDER BY id DESC LIMIT ?)`, LOG_KEEP)
}

async function attempt(hook, event, payload) {
  const body = JSON.stringify(payload)
  const ts = Date.now()

  // Re-check the target at delivery time. checkTarget() ran when the hook was
  // saved, but DNS can change between then and now — a rebinding attacker points
  // the name at a public IP to pass the save, then flips it to loopback before
  // this fires. Resolving and validating here closes that window.
  if (!conf('webhook_allow_private')) {
    let u
    try { u = new URL(hook.url) } catch { return { code: 0, ok: false, msg: 'bad url' } }
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host)) {
      if (isPrivateAddress(host)) return { code: 0, ok: false, msg: 'blocked: private target' }
    } else if ((await resolveGuard(host)).error) {
      return { code: 0, ok: false, msg: 'blocked: private target' }
    }
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), Math.max(1, confNum('webhook_timeout_sec')) * 1000)
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'vidhub-webhook/1',
        'X-Vidhub-Event': event,
        'X-Vidhub-Delivery': payload.id,
        'X-Vidhub-Timestamp': String(ts),
        'X-Vidhub-Signature': sign(hook.secret, body, ts),
      },
      body,
      signal: ctl.signal,
      redirect: 'manual',        // a redirect could walk us somewhere unchecked
    })
    return { code: res.status, ok: res.status >= 200 && res.status < 300 }
  } catch (e) {
    return { code: 0, ok: false, msg: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally { clearTimeout(timer) }
}

async function drain() {
  if (running) return
  running = true
  while (queue.length) {
    const { hook, event, payload } = queue.shift()
    const tries = Math.max(1, confNum('webhook_retries'))
    let last = { code: 0, ok: false, msg: 'not attempted' }
    for (let i = 1; i <= tries; i++) {
      last = await attempt(hook, event, payload)
      if (last.ok) { last.attempts = i; break }
      last.attempts = i
      if (i < tries) await new Promise(r => setTimeout(r, 1000 * i * i))
    }
    logDelivery(hook.id, event, last)
    if (last.ok) {
      q.run('UPDATE webhooks SET failures=0, last_at=?, last_code=? WHERE id=?', Date.now(), last.code, hook.id)
    } else {
      const failures = (hook.failures || 0) + 1
      q.run('UPDATE webhooks SET failures=?, last_at=?, last_code=? WHERE id=?',
        failures, Date.now(), last.code, hook.id)
      // Stop hammering an endpoint that has been dead for a long while; the
      // admin panel shows the disabled state and the reason.
      if (failures >= 20) {
        q.run("UPDATE webhooks SET status='disabled' WHERE id=?", hook.id)
        console.warn(`[webhook] ${hook.url} disabled after ${failures} consecutive failures`)
      }
    }
  }
  running = false
}

/** Fire an event at every hook subscribed to it. Never throws, never blocks. */
export function emit(event, data) {
  let hooks
  try { hooks = q.all("SELECT * FROM webhooks WHERE status='active'") } catch { return }
  for (const hook of hooks) {
    const subscribed = !hook.events.trim() || hook.events.split(',').map(s => s.trim()).includes(event)
    if (!subscribed) continue
    queue.push({ hook, event, payload: { id: randomUUID(), event, at: new Date().toISOString(), data } })
  }
  if (queue.length) drain()
}

/** One-off delivery used by the "send test" button; resolves with the result. */
export async function deliverTest(hook) {
  const payload = {
    id: randomUUID(), event: 'ping', at: new Date().toISOString(),
    data: { message: 'vidhub webhook test' },
  }
  const r = await attempt(hook, 'ping', payload)
  logDelivery(hook.id, 'ping', { ...r, attempts: 1 })
  q.run('UPDATE webhooks SET last_at=?, last_code=? WHERE id=?', Date.now(), r.code, hook.id)
  return r
}
