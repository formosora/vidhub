/**
 * All /api endpoints. Pure functions of (req, res, url) — server.js does routing-in.
 */
import { q } from './db.js'
import { conf, confNum, confAll, setConf, publicConf } from './config.js'
import {
  identify, verifyUser, createUser, openSession, closeSession,
  loginThrottled, registerThrottled, noteRegistered, captchaThrottled,
  isAdmin, isAdminSession, hasScope, SCOPES, parseScopes, hashPassword, assertPassword,
} from './auth.js'
import { issueCaptcha, verifyCaptcha } from './captcha.js'
import {
  ipBlockReason, quotaReason, logUpload, locateIp, storageReason, diskReason, diskInfo,
} from './security.js'
import { acceptUpload, findFile, thumbPath } from './upload.js'
import {
  createUpload, getUpload, appendChunk, finishUpload, abortUpload, CHUNK_SIZE,
} from './resumable.js'
import { hasFfmpeg } from './media.js'
import { send, readJson, clientIp, today, newToken, nowIso } from './util.js'
import { t, lang, AppError } from './i18n.js'
import { EVENTS, checkTarget, deliverTest, emit } from './webhooks.js'
import { listBackups, backupPath, removeBackup, runBackup, backupStatus } from './backup.js'
import { createShare, sharesFor, getShare, revokeShare, dropSharesFor, shareOut } from './shares.js'
import {
  listTags, ensureTag, tagsOf, tagVideo, untagVideo, deleteTag, renameTag, dropTagsFor,
  collectionsOf, getCollection, createCollection, updateCollection, deleteCollection,
  addToCollection, removeFromCollection, reorderCollection, collectionItems,
  dropCollectionRefs, collectionOut,
} from './organize.js'
import { unlinkSync, statSync, createReadStream } from 'node:fs'

const tokenOf = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
const page = (url, def = 20, max = 100) => {
  const p = Math.max(1, parseInt(url.searchParams.get('page') || '1'))
  const size = Math.min(max, Math.max(1, parseInt(url.searchParams.get('size') || String(def))))
  return { p, size, off: (p - 1) * size }
}

/** Fields any viewer may see. Deliberately free of uploader IP / moderation data. */
const publicVideoOut = v => ({
  name: v.name, orig: v.orig, size: v.size, kind: v.kind, ext: v.ext,
  width: v.width, height: v.height, duration: v.duration,
  status: v.status, views: v.views, uploaded: v.uploaded,
  url: `/v/${v.name}`, player: `/p/${v.name}`, thumb: `/t/${v.name}`, download: `/d/${v.name}`,
  embed: `<iframe src="/p/${v.name}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`,
})

/** Owner/admin view — adds the operational fields. */
const videoOut = v => ({
  ...publicVideoOut(v),
  visibility: v.visibility || 'public',
  tags: tagsOf(v.name),
  mod_score: v.mod_score, username: v.username, ip: v.ip, ip_region: v.ip_region,
})

/** Number of accounts that can still reach the admin panel. */
const activeAdmins = () =>
  q.get("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'").c

/**
 * public    — listed in the gallery, direct link works
 * private   — unlisted, direct link still works (an obscure URL, not a lock)
 * protected — every direct URL refused; reachable only via a share link
 */
const VISIBILITIES = ['public', 'private', 'protected']
const asVisibility = v => (VISIBILITIES.includes(v) ? v : null)

/** One file does not need dozens of live links; a runaway loop should not make them. */
const MAX_SHARES_PER_VIDEO = 50

/**
 * Sort keys are resolved through this table rather than interpolated: the value
 * arrives in a query string and lands in an ORDER BY, which is the one place
 * parameter binding cannot protect us.
 */
const SORTS = {
  uploaded: 'uploaded',
  size: 'size',
  duration: 'duration',
  views: 'views',
  name: 'orig',
}
function orderBy(url, fallback = 'uploaded') {
  const col = SORTS[url.searchParams.get('sort')] || SORTS[fallback]
  const dir = url.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC'
  // A stable tiebreaker, or paging through equal sizes silently repeats rows.
  return `${col} ${dir}, name ASC`
}

/** How many names one bulk call may touch. */
const MAX_BULK = 200

export async function handleApi(req, res, path, url) {
  const ip = clientIp(req)
  const user = identify(req)
  const L = lang(req, url)

  /** Localised error response. `why` is a key or a [key, ...params] tuple. */
  const fail = (code, why) => {
    const [key, ...p] = Array.isArray(why) ? why : [why]
    return send(res, code, { error: t(L, key, ...p), code: key })
  }

  // ---------- auth ----------
  if (path === '/api/login' && req.method === 'POST') {
    if (loginThrottled(ip)) return fail(429, 'auth.loginThrottled')
    const body = await readJson(req)
    const u = verifyUser(body.username ?? 'admin', body.password)
    if (!u) return fail(401, 'auth.badCredentials')
    return send(res, 200, { token: openSession(u.id, !!body.remember), username: u.username, role: u.role })
  }
  if (path === '/api/captcha' && req.method === 'GET') {
    if (captchaThrottled(ip)) return fail(429, 'captcha.throttled')
    const c = issueCaptcha()
    return send(res, 200, c, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' })
  }

  if (path === '/api/register' && req.method === 'POST') {
    if (!conf('allow_register')) return fail(403, 'reg.closed')
    if (registerThrottled(ip)) return fail(429, 'reg.throttled')
    const blocked = ipBlockReason(ip)
    if (blocked) return fail(403, blocked)
    const b = await readJson(req)
    // Consume the captcha first: it is single-use, so a failure further down
    // still costs the caller a fresh challenge.
    if (conf('register_captcha') && !verifyCaptcha(b.captchaId, b.captcha))
      return fail(400, 'reg.captchaWrong')
    try {
      const u = createUser(b.username, b.password, 'uploader',
        confNum('register_daily_limit'), asVisibility(b.visibility) || conf('default_visibility'))
      noteRegistered(ip)
      emit('user.registered', { id: u.id, username: u.username, ip })
      return send(res, 200, { token: openSession(u.id), username: u.username, role: u.role })
    } catch (e) {
      return e instanceof AppError ? fail(400, [e.key, ...e.params]) : fail(400, 'c.internal')
    }
  }

  if (path === '/api/logout' && req.method === 'POST') {
    closeSession(tokenOf(req))
    return send(res, 200, { ok: true })
  }
  if (path === '/api/me' && req.method === 'GET') {
    if (!user) return fail(401, 'auth.unauthorized')
    const u = q.get('SELECT id, username, role, daily_limit, default_visibility, created FROM users WHERE id=?', user.id)
    return send(res, 200, u)
  }
  /** Self-service preferences. Only the uploader's own defaults, never role. */
  if (path === '/api/me' && req.method === 'PATCH') {
    if (!user) return fail(401, 'auth.unauthorized')
    const b = await readJson(req)
    const vis = asVisibility(b.default_visibility)
    if (!vis) return fail(400, 'c.badVisibility')
    q.run('UPDATE users SET default_visibility=? WHERE id=?', vis, user.id)
    return send(res, 200, { ok: true, default_visibility: vis })
  }
  if (path === '/api/me/password' && req.method === 'POST') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (user.via === 'key') return fail(403, 'key.sessionOnly')
    const body = await readJson(req)
    const u = verifyUser(user.username, body.old)
    if (!u) return fail(403, 'auth.oldPasswordWrong')
    try { assertPassword(body.password) }
    catch (e) { return fail(400, e instanceof AppError ? e.key : 'auth.passwordTooShort') }
    const { salt, hash } = hashPassword(body.password)
    q.run('UPDATE users SET pass_hash=?, salt=? WHERE id=?', hash, salt, user.id)
    q.run('DELETE FROM sessions WHERE user_id=?', user.id)
    return send(res, 200, { ok: true })
  }

  // ---------- public ----------
  if (path === '/api/health' && req.method === 'GET') {
    // Cheap liveness + a real DB round-trip, for docker/k8s probes.
    try { q.get('SELECT 1 x') } catch { return send(res, 503, { ok: false, db: false }) }
    return send(res, 200, { ok: true, db: true, uptime: Math.round(process.uptime()) })
  }

  if (path === '/api/config/public' && req.method === 'GET')
    return send(res, 200, publicConf())

  if (path === '/api/public/videos' && req.method === 'GET') {
    if (!conf('explore_public')) return fail(403, 'c.exploreClosed')
    const { size, off } = page(url, 24, 60)
    const kw = `%${(url.searchParams.get('q') || '').trim()}%`
    // Only listed items. `kind` is filterable so the gallery can show images too.
    const kinds = conf('explore_images') ? "kind IN ('video','image')" : "kind='video'"
    const conds = ["status='ok'", "visibility='public'", kinds]
    const args = []
    if (kw !== '%%') { conds.push('orig LIKE ?'); args.push(kw) }
    const where = conds.join(' AND ')
    const total = q.get(`SELECT COUNT(*) c FROM videos WHERE ${where}`, ...args).c
    const rows = q.all(`SELECT * FROM videos WHERE ${where} ORDER BY ${orderBy(url)} LIMIT ? OFFSET ?`, ...args, size, off)
    return send(res, 200, { total, items: rows.map(publicVideoOut) })
  }

  /**
   * Statistics are scoped to whoever is asking. Site totals are operational
   * data — storage, upload volume — so an uploader gets their own numbers and
   * an anonymous visitor gets nothing unless the owner opts in.
   */
  if (path === '/api/stats' && req.method === 'GET') {
    if (isAdmin(user)) return send(res, 200, { scope: 'site', ...buildStats() })
    if (user) return send(res, 200, { scope: 'own', ...buildStats({ userId: user.id }) })
    if (conf('stats_public')) return send(res, 200, { scope: 'site', ...buildStats() })
    return fail(403, 'c.statsLoginRequired')
  }

  // ---------- upload ----------
  if (path === '/api/videos' && req.method === 'POST') {
    if (conf('must_login') && !user) return fail(401, 'up.loginRequired')
    if (!hasScope(user, 'upload')) return fail(403, 'key.scopeMissing')
    if (!conf('must_login') && !conf('allow_guest') && !user) return fail(401, 'up.loginRequired')
    const blocked = ipBlockReason(ip)
    if (blocked) { logUpload({ ip, user, status: 'rejected', msg: blocked }); return fail(403, blocked) }
    const over = quotaReason(ip, user)
    if (over) { logUpload({ ip, user, status: 'rejected', msg: over }); return fail(429, over) }
    const full = storageReason() || diskReason()
    if (full) { logUpload({ ip, user, status: 'rejected', msg: full }); return fail(507, full) }
    const region = await locateIp(ip)
    const orig = url.searchParams.get('name') || 'video.mp4'
    const visibility = asVisibility(url.searchParams.get('visibility'))
    const r = await acceptUpload(req, { user, ip, region, orig, visibility })
    return r.error ? fail(r.status, r.error) : send(res, r.status, r.body)
  }

  // ---------- resumable uploads ----------
  if (path === '/api/uploads' || path.startsWith('/api/uploads/')) {
    if (conf('must_login') && !user) return fail(401, 'up.loginRequired')
    if (!conf('must_login') && !conf('allow_guest') && !user) return fail(401, 'up.loginRequired')
    if (!hasScope(user, 'upload')) return fail(403, 'key.scopeMissing')

    if (path === '/api/uploads' && req.method === 'POST') {
      const blocked = ipBlockReason(ip)
      if (blocked) return fail(403, blocked)
      const over = quotaReason(ip, user)
      if (over) return fail(429, over)
      const b = await readJson(req)
      const r = createUpload({ user, ip, orig: b.name, size: b.size, visibility: asVisibility(b.visibility) })
      return r.error ? fail(r.status, r.error) : send(res, r.status, r.body)
    }

    const um2 = path.match(/^\/api\/uploads\/([\w-]+)(\/finish)?$/)
    if (um2) {
      const [, id, finishing] = um2
      const u = getUpload(id, user)
      if (!u) return fail(404, 'c.notFound')

      if (req.method === 'GET' && !finishing)
        return send(res, 200, { id: u.id, offset: u.received, size: u.size, chunk_size: CHUNK_SIZE })

      if (req.method === 'PATCH' && !finishing) {
        const offset = Number(url.searchParams.get('offset') ?? u.received)
        const r = await appendChunk(req, u, offset)
        return send(res, r.status, r.body)
      }

      if (req.method === 'POST' && finishing) {
        const region = await locateIp(ip)
        const r = await finishUpload(u, { user, ip, region })
        return r.error ? fail(r.status, r.error) : send(res, r.status, r.body)
      }

      if (req.method === 'DELETE' && !finishing) { abortUpload(u); return send(res, 200, { ok: true }) }
    }
    return fail(404, 'c.notFound')
  }

  // ---------- my videos / management (owner or admin) ----------
  if (path === '/api/videos' && req.method === 'GET') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'read')) return fail(403, 'key.scopeMissing')
    const { size, off } = page(url)
    const kw = `%${(url.searchParams.get('q') || '').trim()}%`
    const showAll = isAdmin(user) && url.searchParams.get('all') === '1'
    const status = url.searchParams.get('status') || ''
    const vis = asVisibility(url.searchParams.get('visibility'))
    const tagId = Number(url.searchParams.get('tag')) || 0
    const conds = ["status != 'recycled'"], args = []
    if (!showAll) { conds.push('user_id = ?'); args.push(user.id) }
    if (kw !== '%%') { conds.push('orig LIKE ?'); args.push(kw) }
    if (status) { conds.push('status = ?'); args.push(status) }
    if (vis) { conds.push('visibility = ?'); args.push(vis) }
    // Filtering by a tag you do not own must not leak whose files carry it.
    if (tagId && q.get('SELECT COUNT(*) c FROM tags WHERE id = ? AND user_id = ?', tagId, user.id).c) {
      conds.push('name IN (SELECT video FROM video_tags WHERE tag_id = ?)')
      args.push(tagId)
    }
    const where = conds.join(' AND ')
    const total = q.get(`SELECT COUNT(*) c FROM videos WHERE ${where}`, ...args).c
    const rows = q.all(`SELECT * FROM videos WHERE ${where} ORDER BY ${orderBy(url)} LIMIT ? OFFSET ?`, ...args, size, off)
    return send(res, 200, { total, items: rows.map(videoOut) })
  }

  /**
   * One action over many files. Every name is authorised on its own and the
   * result reports per-name outcomes, so a selection that happens to include
   * someone else's file does the part it may and says what it skipped, rather
   * than failing the whole batch or quietly doing it anyway.
   */
  if (path === '/api/videos/bulk' && req.method === 'POST') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'manage')) return fail(403, 'key.scopeMissing')
    const b = await readJson(req)
    const names = Array.isArray(b.names) ? b.names.slice(0, MAX_BULK).map(String) : []
    const action = String(b.action || '')
    if (!names.length) return fail(400, 'bulk.noSelection')

    const vis = action === 'visibility' ? asVisibility(b.visibility) : null
    if (action === 'visibility' && !vis) return fail(400, 'c.badVisibility')

    let tag = null
    if (action === 'tag' || action === 'untag') {
      tag = action === 'tag'
        ? ensureTag(user.id, b.tag)
        : q.get('SELECT * FROM tags WHERE id = ? AND user_id = ?', Number(b.tag) || 0, user.id)
      if (!tag) return fail(400, 'tag.bad')
    }

    const done = [], skipped = []
    for (const name of names) {
      const v = q.get('SELECT * FROM videos WHERE name = ?', name)
      if (!v || (v.user_id !== user.id && !isAdmin(user))) { skipped.push(name); continue }
      switch (action) {
        case 'delete':
          q.run("UPDATE videos SET status='recycled' WHERE name=?", name); break
        case 'restore':
          q.run("UPDATE videos SET status='ok' WHERE name=?", name); break
        case 'force': {
          const f = findFile(v); if (f) try { unlinkSync(f) } catch {}
          try { unlinkSync(thumbPath(name)) } catch {}
          q.run('DELETE FROM videos WHERE name=?', name)
          dropSharesFor(name); dropTagsFor(name); dropCollectionRefs(name)
          emit('video.deleted', { name, orig: v.orig, size: v.size, username: v.username, by: user.username })
          break
        }
        case 'visibility':
          q.run('UPDATE videos SET visibility=? WHERE name=?', vis, name); break
        case 'tag':
          tagVideo(name, tag.id); break
        case 'untag':
          untagVideo(name, tag.id); break
        default:
          return fail(400, 'bulk.badAction')
      }
      done.push(name)
    }
    return send(res, 200, { ok: true, action, done: done.length, skipped: skipped.length, skippedNames: skipped })
  }

  const vm = path.match(/^\/api\/videos\/([\w.-]+)(\/(restore|force|ban|unban|shares|tags))?$/)
  if (vm) {
    const [, name, , action] = vm
    const v = q.get('SELECT * FROM videos WHERE name = ?', name)
    if (!user) return fail(401, 'auth.unauthorized')
    if (!v) return fail(404, 'c.notFound')
    const own = v.user_id === user.id
    const mayManage = own || isAdmin(user)
    const canWrite = mayManage && hasScope(user, 'manage')

    if (req.method === 'GET' && !action) {
      if (!mayManage) return fail(403, 'auth.forbidden')
      if (!hasScope(user, 'read')) return fail(403, 'key.scopeMissing')
      return send(res, 200, videoOut(v))
    }
    if (req.method === 'PATCH' && !action) {            // visibility toggle
      if (!canWrite) return fail(403, mayManage ? 'key.scopeMissing' : 'auth.forbidden')
      const b = await readJson(req)
      const vis = asVisibility(b.visibility)
      if (!vis) return fail(400, 'c.badVisibility')
      q.run('UPDATE videos SET visibility=? WHERE name=?', vis, name)
      return send(res, 200, { ok: true, visibility: vis })
    }
    if (req.method === 'DELETE' && !action) {           // soft delete → recycle bin
      if (!canWrite) return fail(403, mayManage ? 'key.scopeMissing' : 'auth.forbidden')
      q.run("UPDATE videos SET status='recycled' WHERE name=?", name)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && action === 'restore') {
      if (!canWrite) return fail(403, mayManage ? 'key.scopeMissing' : 'auth.forbidden')
      q.run("UPDATE videos SET status='ok' WHERE name=?", name)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'DELETE' && action === 'force') { // permanent
      if (!canWrite) return fail(403, mayManage ? 'key.scopeMissing' : 'auth.forbidden')
      const f = findFile(v); if (f) try { unlinkSync(f) } catch {}
      try { unlinkSync(thumbPath(name)) } catch {}
      q.run('DELETE FROM videos WHERE name=?', name)
      dropSharesFor(name); dropTagsFor(name); dropCollectionRefs(name)
      emit('video.deleted', { name, orig: v.orig, size: v.size, username: v.username, by: user.username })
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && (action === 'ban' || action === 'unban')) {
      if (!isAdminSession(user)) return fail(403, 'auth.forbidden')
      q.run('UPDATE videos SET status=? WHERE name=?', action === 'ban' ? 'banned' : 'ok', name)
      return send(res, 200, { ok: true })
    }

    // ---------- tags on one file ----------
    if (action === 'tags' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (!canWrite) return fail(403, mayManage ? 'key.scopeMissing' : 'auth.forbidden')
      const b = await readJson(req)
      if (req.method === 'POST') {
        const tg = ensureTag(user.id, b.name)
        if (!tg) return fail(400, 'tag.bad')
        if (!tagVideo(name, tg.id)) return fail(400, 'tag.bad')
      } else {
        untagVideo(name, Number(b.id) || 0)
      }
      return send(res, 200, { ok: true, tags: tagsOf(name) })
    }

    // ---------- share links ----------
    if (action === 'shares' && req.method === 'GET') {
      if (!mayManage) return fail(403, 'auth.forbidden')
      if (!hasScope(user, 'read')) return fail(403, 'key.scopeMissing')
      return send(res, 200, { items: sharesFor(name).map(shareOut) })
    }
    if (action === 'shares' && req.method === 'POST') {
      if (!canWrite) return fail(403, mayManage ? 'key.scopeMissing' : 'auth.forbidden')
      // A link onto a public or unlisted file would be theatre: the direct URL
      // works regardless, so the expiry and password would guard nothing.
      if (v.visibility !== 'protected') return fail(400, 'share.needsProtected')
      if (sharesFor(name).length >= MAX_SHARES_PER_VIDEO) return fail(429, 'share.tooMany')
      const b = await readJson(req)
      // Refused rather than clamped: a negative expiry silently becoming "never"
      // hands out more access than was asked for, which is the wrong way to be
      // forgiving about a typo.
      const hours = b.expires_in_hours === undefined ? 0 : Number(b.expires_in_hours)
      const views = b.max_views === undefined ? 0 : Number(b.max_views)
      if (!(hours >= 0) || !(views >= 0)) return fail(400, 'share.badLimits')
      const s = createShare({
        name,
        userId: user.id,
        password: b.password,
        expiresInHours: hours,
        maxViews: views,
        note: b.note,
      })
      return send(res, 200, shareOut(s))
    }
  }

  // ---------- tags ----------
  if (path === '/api/tags' && req.method === 'GET') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'read')) return fail(403, 'key.scopeMissing')
    return send(res, 200, { items: listTags(user.id) })
  }
  if (path === '/api/tags' && req.method === 'POST') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'manage')) return fail(403, 'key.scopeMissing')
    const b = await readJson(req)
    const tg = ensureTag(user.id, b.name)
    return tg ? send(res, 200, tg) : fail(400, 'tag.bad')
  }
  const tm = path.match(/^\/api\/tags\/(\d+)$/)
  if (tm) {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'manage')) return fail(403, 'key.scopeMissing')
    const id = Number(tm[1])
    if (req.method === 'PATCH') {
      const tg = renameTag(user.id, id, (await readJson(req)).name)
      return tg ? send(res, 200, tg) : fail(400, 'tag.bad')
    }
    if (req.method === 'DELETE')
      return deleteTag(user.id, id) ? send(res, 200, { ok: true }) : fail(404, 'tag.notFound')
  }

  // ---------- collections ----------
  if (path === '/api/collections' && req.method === 'GET') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'read')) return fail(403, 'key.scopeMissing')
    return send(res, 200, { items: collectionsOf(user.id).map(c => collectionOut(c)) })
  }
  if (path === '/api/collections' && req.method === 'POST') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'manage')) return fail(403, 'key.scopeMissing')
    const b = await readJson(req)
    if (!String(b.title || '').trim()) return fail(400, 'coll.needTitle')
    const c = createCollection({
      userId: user.id, username: user.username,
      title: b.title, descr: b.descr, visibility: b.visibility,
    })
    return send(res, 200, collectionOut(c, 0))
  }
  const cm = path.match(/^\/api\/collections\/(\d+)(\/(items|order))?$/)
  if (cm) {
    if (!user) return fail(401, 'auth.unauthorized')
    const c = getCollection(cm[1])
    if (!c) return fail(404, 'coll.notFound')
    if (c.user_id !== user.id && !isAdmin(user)) return fail(403, 'auth.forbidden')
    const sub = cm[3]
    const mayWrite = hasScope(user, 'manage')

    if (req.method === 'GET' && !sub) {
      if (!hasScope(user, 'read')) return fail(403, 'key.scopeMissing')
      const items = collectionItems(c.id)
      return send(res, 200, { ...collectionOut(c, items.length), items: items.map(videoOut) })
    }
    if (req.method === 'PATCH' && !sub) {
      if (!mayWrite) return fail(403, 'key.scopeMissing')
      return send(res, 200, collectionOut(updateCollection(c.id, await readJson(req))))
    }
    if (req.method === 'DELETE' && !sub) {
      if (!mayWrite) return fail(403, 'key.scopeMissing')
      return send(res, 200, { ok: deleteCollection(c.id) })
    }
    if (sub === 'items' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (!mayWrite) return fail(403, 'key.scopeMissing')
      const b = await readJson(req)
      const names = Array.isArray(b.names) ? b.names.slice(0, MAX_BULK).map(String) : []
      let n = 0
      for (const name of names) {
        // Only your own files, so a collection cannot be used to re-publish
        // someone else's private upload under your name.
        const v = q.get('SELECT user_id FROM videos WHERE name = ?', name)
        if (!v || (v.user_id !== user.id && !isAdmin(user))) continue
        if (req.method === 'POST') addToCollection(c.id, name)
        else removeFromCollection(c.id, name)
        n++
      }
      return send(res, 200, { ok: true, changed: n })
    }
    if (sub === 'order' && req.method === 'POST') {
      if (!mayWrite) return fail(403, 'key.scopeMissing')
      const b = await readJson(req)
      reorderCollection(c.id, Array.isArray(b.names) ? b.names.slice(0, MAX_BULK).map(String) : [])
      return send(res, 200, { ok: true })
    }
  }

  /** Revoking is immediate — the whole point of a link you can take back. */
  const sm = path.match(/^\/api\/shares\/([a-f0-9]{32})$/)
  if (sm && req.method === 'DELETE') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'manage')) return fail(403, 'key.scopeMissing')
    const s = getShare(sm[1])
    if (!s) return fail(404, 'share.notFound')
    const v = q.get('SELECT user_id FROM videos WHERE name = ?', s.name)
    if (v?.user_id !== user.id && !isAdmin(user)) return fail(403, 'auth.forbidden')
    return send(res, 200, { ok: revokeShare(s.token) })
  }

  /**
   * Recycle bin. Scoped to the caller by default and widened only with an
   * explicit `all=1` from an admin — the same contract as /api/videos. It used
   * to hand admins the whole site unasked, which the "My files" page then
   * displayed under a heading promising the opposite.
   */
  if (path === '/api/recycle' && req.method === 'GET') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'read')) return fail(403, 'key.scopeMissing')
    const { size, off } = page(url)
    const showAll = isAdmin(user) && url.searchParams.get('all') === '1'
    const conds = ["status = 'recycled'"], args = []
    if (!showAll) { conds.push('user_id = ?'); args.push(user.id) }
    const where = conds.join(' AND ')
    const total = q.get(`SELECT COUNT(*) c FROM videos WHERE ${where}`, ...args).c
    const rows = q.all(`SELECT * FROM videos WHERE ${where} ORDER BY ${orderBy(url)} LIMIT ? OFFSET ?`, ...args, size, off)
    return send(res, 200, { total, scope: showAll ? 'site' : 'own', items: rows.map(videoOut) })
  }

  /** Purge the bin — own by default, whole site for an admin passing all=1. */
  if (path === '/api/recycle' && req.method === 'DELETE') {
    if (!user) return fail(401, 'auth.unauthorized')
    if (!hasScope(user, 'manage')) return fail(403, 'key.scopeMissing')
    const showAll = isAdmin(user) && url.searchParams.get('all') === '1'
    const rows = showAll
      ? q.all("SELECT name, stored FROM videos WHERE status = 'recycled'")
      : q.all("SELECT name, stored FROM videos WHERE status = 'recycled' AND user_id = ?", user.id)
    let purged = 0, freed = 0
    for (const v of rows) {
      const f = findFile(v)
      if (f) { try { freed += statSync(f).size } catch {} try { unlinkSync(f) } catch {} }
      try { unlinkSync(thumbPath(v.name)) } catch {}
      q.run('DELETE FROM videos WHERE name=?', v.name)
      dropSharesFor(v.name); dropTagsFor(v.name); dropCollectionRefs(v.name)
      purged++
    }
    return send(res, 200, { ok: true, purged, freed })
  }

  // ---------- API keys ----------
  // Managing keys is session-only: a leaked key must not be able to mint more
  // keys, widen its own scopes, or extend its own expiry.
  if (path.startsWith('/api/me/keys')) {
    if (!user) return fail(401, 'auth.unauthorized')
    if (user.via === 'key') return fail(403, 'key.sessionOnly')
  }
  if (path === '/api/me/keys' && req.method === 'GET') {
    const now = Date.now()
    return send(res, 200, q.all(
      'SELECT key, name, status, scopes, expires, last_used, created FROM api_keys WHERE user_id=? ORDER BY created DESC',
      user.id).map(k => ({ ...k, expired: k.expires > 0 && k.expires <= now })))
  }
  if (path === '/api/me/keys' && req.method === 'POST') {
    const body = await readJson(req)
    const scopes = [...parseScopes(Array.isArray(body.scopes) ? body.scopes.join(',') : body.scopes)]
    if (!scopes.length) return fail(400, 'key.noScopes')
    const days = Math.max(0, Math.min(3650, Number(body.expires_days) || 0))
    const expires = days > 0 ? Date.now() + days * 86400_000 : 0
    const key = 'vh_' + newToken()
    q.run('INSERT INTO api_keys(key, user_id, name, scopes, expires, created) VALUES(?,?,?,?,?,?)',
      key, user.id, String(body.name || ''), scopes.join(','), expires, nowIso())
    return send(res, 200, { key, scopes, expires })
  }
  const km = path.match(/^\/api\/me\/keys\/([\w-]+)$/)
  if (km && req.method === 'PATCH') {          // revoke / re-enable without deleting
    const b = await readJson(req)
    if (!['active', 'disabled'].includes(b.status)) return fail(400, 'key.badStatus')
    q.run('UPDATE api_keys SET status=? WHERE key=? AND user_id=?', b.status, km[1], user.id)
    return send(res, 200, { ok: true, status: b.status })
  }
  if (km && req.method === 'DELETE') {
    q.run('DELETE FROM api_keys WHERE key=? AND user_id=?', km[1], user.id)
    return send(res, 200, { ok: true })
  }

  // ---------- admin ----------
  if (path.startsWith('/api/admin/')) {
    // An API key never reaches the admin surface, whatever its owner's role.
    if (!isAdminSession(user)) return fail(user ? 403 : 401, 'auth.forbidden')

    if (path === '/api/admin/check') return send(res, 200, { ok: true, ffmpeg: await hasFfmpeg() })

    if (path === '/api/admin/settings' && req.method === 'GET') return send(res, 200, confAll())
    if (path === '/api/admin/settings' && req.method === 'PUT') {
      setConf(await readJson(req, 4_000_000))
      return send(res, 200, { ok: true })
    }

    if (path === '/api/admin/stats' && req.method === 'GET') return send(res, 200, buildStats({ admin: true }))

    if (path === '/api/admin/users' && req.method === 'GET')
      return send(res, 200, q.all(`
        SELECT u.id, u.username, u.role, u.status, u.daily_limit, u.created,
               (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id AND v.status != 'recycled') videos,
               (SELECT COALESCE(SUM(size),0) FROM videos v WHERE v.user_id = u.id AND v.status != 'recycled') used
        FROM users u ORDER BY u.id`))
    if (path === '/api/admin/users' && req.method === 'POST') {
      const b = await readJson(req)
      try {
        const u = createUser(b.username, b.password, b.role === 'admin' ? 'admin' : 'uploader',
          Number(b.daily_limit) || 0, asVisibility(b.default_visibility) || conf('default_visibility'))
        return send(res, 200, u)
      } catch (e) {
        return e instanceof AppError ? fail(400, [e.key, ...e.params]) : fail(400, 'c.internal')
      }
    }
    const um = path.match(/^\/api\/admin\/users\/(\d+)$/)
    if (um && req.method === 'PATCH') {
      const b = await readJson(req)
      const id = Number(um[1])
      const target = q.get('SELECT id, role, status FROM users WHERE id=?', id)
      if (!target) return fail(404, 'user.notFound')

      // Demoting or disabling the last remaining admin would brick the panel
      // for good — ensureAdmin() only bootstraps when the table is empty.
      const losesAdmin = target.role === 'admin' && target.status === 'active' &&
        ((b.role && b.role !== 'admin') || b.status === 'disabled')
      if (losesAdmin && activeAdmins() <= 1)
        return fail(400, 'user.lastAdminLocked')

      if (b.password) {
        try {
          const { salt, hash } = hashPassword(assertPassword(b.password))
          q.run('UPDATE users SET pass_hash=?, salt=? WHERE id=?', hash, salt, id)
          q.run('DELETE FROM sessions WHERE user_id=?', id)
        } catch (e) {
          return e instanceof AppError ? fail(400, [e.key, ...e.params]) : fail(400, 'c.internal')
        }
      }
      if (b.role && ['admin', 'uploader'].includes(b.role)) q.run('UPDATE users SET role=? WHERE id=?', b.role, id)
      if (b.status && ['active', 'disabled'].includes(b.status)) {
        q.run('UPDATE users SET status=? WHERE id=?', b.status, id)
        if (b.status === 'disabled') q.run('DELETE FROM sessions WHERE user_id=?', id)
      }
      if (b.daily_limit !== undefined) q.run('UPDATE users SET daily_limit=? WHERE id=?', Number(b.daily_limit) || 0, id)
      return send(res, 200, { ok: true })
    }
    if (um && req.method === 'DELETE') {
      const id = Number(um[1])
      if (id === user.id) return fail(400, 'user.cannotDeleteSelf')
      const target = q.get('SELECT role, status FROM users WHERE id=?', id)
      if (!target) return fail(404, 'user.notFound')
      if (target.role === 'admin' && target.status === 'active' && activeAdmins() <= 1)
        return fail(400, 'user.lastAdminDelete')
      q.run('DELETE FROM users WHERE id=?', id)
      return send(res, 200, { ok: true })
    }

    if (path === '/api/admin/logs' && req.method === 'GET') {
      const { size, off } = page(url, 30, 200)
      const ipq = `%${(url.searchParams.get('ip') || '').trim()}%`
      const where = ipq === '%%' ? '1=1' : 'ip LIKE ?'
      const args = ipq === '%%' ? [] : [ipq]
      const total = q.get(`SELECT COUNT(*) c FROM upload_logs WHERE ${where}`, ...args).c
      const rows = q.all(`SELECT * FROM upload_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, size, off)
      return send(res, 200, { total, items: rows })
    }

    if (path === '/api/admin/iprules' && req.method === 'GET')
      return send(res, 200, q.all('SELECT * FROM ip_rules ORDER BY id DESC'))
    if (path === '/api/admin/iprules' && req.method === 'POST') {
      const b = await readJson(req)
      if (!String(b.ip || '').trim()) return fail(400, 'c.ipRequired')
      q.run('INSERT INTO ip_rules(ip, note) VALUES(?,?)', String(b.ip).trim(), String(b.note || ''))
      return send(res, 200, { ok: true })
    }
    const irm = path.match(/^\/api\/admin\/iprules\/(\d+)$/)
    if (irm && req.method === 'DELETE') {
      q.run('DELETE FROM ip_rules WHERE id=?', Number(irm[1]))
      return send(res, 200, { ok: true })
    }

    if (path === '/api/admin/hashblack' && req.method === 'GET')
      return send(res, 200, q.all('SELECT * FROM hash_black'))
    if (path === '/api/admin/hashblack' && req.method === 'POST') {
      const b = await readJson(req)
      if (!/^[a-f0-9]{64}$/i.test(String(b.sha256 || ''))) return fail(400, 'c.badHash')
      q.run('INSERT OR IGNORE INTO hash_black(sha256, note) VALUES(?,?)', b.sha256.toLowerCase(), String(b.note || ''))
      return send(res, 200, { ok: true })
    }
    const hbm = path.match(/^\/api\/admin\/hashblack\/([a-f0-9]{64})$/i)
    if (hbm && req.method === 'DELETE') {
      q.run('DELETE FROM hash_black WHERE sha256=?', hbm[1].toLowerCase())
      return send(res, 200, { ok: true })
    }

    // ---------- webhooks ----------
    if (path === '/api/admin/webhooks' && req.method === 'GET')
      return send(res, 200, {
        events: EVENTS,
        items: q.all('SELECT * FROM webhooks ORDER BY id DESC'),
      })

    if (path === '/api/admin/webhooks' && req.method === 'POST') {
      const b = await readJson(req)
      const bad = await checkTarget(String(b.url || ''))
      if (bad) return fail(400, bad)
      const events = String(b.events || '').split(',').map(s => s.trim()).filter(Boolean)
      if (events.some(e => !EVENTS.includes(e))) return fail(400, 'hook.badEvents')
      const secret = String(b.secret || '') || 'whsec_' + newToken().slice(0, 32)
      const r = q.run(
        'INSERT INTO webhooks(url, secret, events, note, created) VALUES(?,?,?,?,?)',
        String(b.url), secret, events.join(','), String(b.note || ''), nowIso())
      return send(res, 200, q.get('SELECT * FROM webhooks WHERE id=?', Number(r.lastInsertRowid)))
    }

    const hm = path.match(/^\/api\/admin\/webhooks\/(\d+)(\/test)?$/)
    if (hm) {
      const hook = q.get('SELECT * FROM webhooks WHERE id=?', Number(hm[1]))
      if (!hook) return fail(404, 'hook.notFound')

      if (req.method === 'POST' && hm[2]) {
        const r = await deliverTest(hook)
        return send(res, 200, { ok: r.ok, code: r.code, msg: r.msg || '' })
      }
      if (req.method === 'PATCH') {
        const b = await readJson(req)
        if (b.url !== undefined) {
          const bad = await checkTarget(String(b.url))
          if (bad) return fail(400, bad)
          q.run('UPDATE webhooks SET url=? WHERE id=?', String(b.url), hook.id)
        }
        if (b.events !== undefined) {
          const events = String(b.events).split(',').map(s => s.trim()).filter(Boolean)
          if (events.some(e => !EVENTS.includes(e))) return fail(400, 'hook.badEvents')
          q.run('UPDATE webhooks SET events=? WHERE id=?', events.join(','), hook.id)
        }
        if (['active', 'disabled'].includes(b.status))
          // re-enabling clears the failure streak that disabled it
          q.run('UPDATE webhooks SET status=?, failures=0 WHERE id=?', b.status, hook.id)
        if (b.note !== undefined) q.run('UPDATE webhooks SET note=? WHERE id=?', String(b.note), hook.id)
        return send(res, 200, q.get('SELECT * FROM webhooks WHERE id=?', hook.id))
      }
      if (req.method === 'DELETE') {
        q.run('DELETE FROM webhooks WHERE id=?', hook.id)
        q.run('DELETE FROM webhook_log WHERE hook_id=?', hook.id)
        return send(res, 200, { ok: true })
      }
    }

    if (path === '/api/admin/webhooks/log' && req.method === 'GET') {
      const { size, off } = page(url, 30, 200)
      const total = q.get('SELECT COUNT(*) c FROM webhook_log').c
      return send(res, 200, {
        total,
        items: q.all('SELECT * FROM webhook_log ORDER BY id DESC LIMIT ? OFFSET ?', size, off),
      })
    }

    // ---------- backups ----------
    if (path === '/api/admin/backups' && req.method === 'GET')
      return send(res, 200, backupStatus())

    if (path === '/api/admin/backups' && req.method === 'POST') {
      try { return send(res, 200, { ok: true, ...runBackup() }) }
      catch (e) { return send(res, 500, { error: String(e.message || e), code: 'backup.failed' }) }
    }

    const bm = path.match(/^\/api\/admin\/backups\/([\w.-]+)$/)
    if (bm) {
      const file = bm[1]
      const p = backupPath(file)
      if (!p || !listBackups().some(b => b.file === file)) return fail(404, 'backup.notFound')
      if (req.method === 'DELETE') return send(res, 200, { ok: removeBackup(file) })
      if (req.method === 'GET') {
        // Streamed rather than buffered: the snapshot is as large as the database.
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': statSync(p).size,
          'Content-Disposition': `attachment; filename="${file}"`,
          'Cache-Control': 'no-store',
        })
        return createReadStream(p).pipe(res)
      }
    }

    if (path === '/api/admin/jobs' && req.method === 'GET')
      return send(res, 200, q.all('SELECT * FROM jobs ORDER BY created DESC LIMIT 50'))
  }

  return fail(404, 'c.notFound')
}

// ---------- stats ----------

/** `userId` narrows every figure to one uploader; `admin` adds the site-wide extras. */
function buildStats({ admin = false, userId = null } = {}) {
  const items = userId
    ? q.all("SELECT size, uploaded, views FROM videos WHERE status != 'recycled' AND user_id = ?", userId)
    : q.all("SELECT size, uploaded, views FROM videos WHERE status != 'recycled'")
  const byDay = {}
  let totalSize = 0, views = 0
  for (const m of items) {
    const day = (m.uploaded || '').slice(0, 10)
    if (day) {
      byDay[day] = byDay[day] || { date: day, count: 0, size: 0 }
      byDay[day].count++
      byDay[day].size += m.size || 0
    }
    totalSize += m.size || 0
    views += m.views || 0
  }
  const out = {
    total: items.length,
    totalSize,
    views,
    byDay: Object.values(byDay).sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
  if (admin) {
    out.users = q.get('SELECT COUNT(*) c FROM users').c
    out.banned = q.get("SELECT COUNT(*) c FROM videos WHERE status='banned'").c
    out.recycled = q.get("SELECT COUNT(*) c FROM videos WHERE status='recycled'").c
    out.todayUploads = q.get('SELECT COUNT(*) c FROM upload_logs WHERE time LIKE ?', today() + '%').c
    out.disk = diskInfo()
    out.topIps = q.all("SELECT ip, region, COUNT(*) c FROM upload_logs WHERE time LIKE ? GROUP BY ip ORDER BY c DESC LIMIT 10", today() + '%')
  }
  return out
}
