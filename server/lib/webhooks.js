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
]

const LOG_KEEP = 500

/**
 * Refuse loopback and private ranges by default. The URL comes from an admin,
 * but "admin account is compromised" should not also hand over a probe into the
 * private network — and a self-hosted box usually has plenty to find there.
 */
function isPrivateAddress(addr) {
  if (/^(127\.|0\.|169\.254\.)/.test(addr)) return true
  if (/^10\./.test(addr)) return true
  if (/^192\.168\./.test(addr)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true
  const v6 = addr.toLowerCase()
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')
}

export async function checkTarget(raw) {
  let u
  try { u = new URL(raw) } catch { return 'hook.badUrl' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'hook.badUrl'
  if (conf('webhook_allow_private')) return null
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return isPrivateAddress(host) ? 'hook.privateTarget' : null
  try {
    const { address } = await lookup(host)
    return isPrivateAddress(address) ? 'hook.privateTarget' : null
  } catch { return 'hook.unresolvable' }
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
