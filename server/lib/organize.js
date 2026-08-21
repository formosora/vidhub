/**
 * Tags and collections — the two organising axes beyond search.
 *
 * Both are scoped to one owner. Tags are private labels for filtering your own
 * library; two accounts can each have "raw footage" and neither sees the
 * other's. Collections are ordered sets with their own shareable page, so they
 * carry a visibility of their own on top of the videos they contain.
 *
 * Membership is intentionally not enforced with a foreign key onto `videos`:
 * that table is keyed by a content hash, and a row can be replaced by the
 * pipeline (mkv → mp4) or purged from the recycle bin without warning. Instead
 * every read joins against `videos` and simply skips rows that are gone, and
 * deletions sweep the link tables — the same shape the rest of the codebase
 * uses for anything hanging off a video name.
 */
import { q } from './db.js'
import { nowIso } from './util.js'

/** Loose enough for CJK and spaces, tight enough to stay a label. */
export const cleanTagName = s => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 32)

const MAX_TAGS_PER_USER = 200
const MAX_TAGS_PER_VIDEO = 20

// ---------- tags ----------

/** Every tag the caller owns, with how many of their videos carry it. */
export function listTags(userId) {
  return q.all(`
    SELECT t.id, t.name, COUNT(vt.video) n
      FROM tags t
      LEFT JOIN video_tags vt ON vt.tag_id = t.id
      LEFT JOIN videos v ON v.name = vt.video AND v.status != 'recycled'
     WHERE t.user_id = ? AND (vt.video IS NULL OR v.name IS NOT NULL)
     GROUP BY t.id
     ORDER BY t.name`, userId)
}

/** Find or create. Returns null when the name is empty or the ceiling is hit. */
export function ensureTag(userId, rawName) {
  const name = cleanTagName(rawName)
  if (!name) return null
  const found = q.get('SELECT * FROM tags WHERE user_id = ? AND name = ?', userId, name)
  if (found) return found
  if (q.get('SELECT COUNT(*) c FROM tags WHERE user_id = ?', userId).c >= MAX_TAGS_PER_USER) return null
  q.run('INSERT INTO tags(user_id, name, created) VALUES(?,?,?)', userId, name, nowIso())
  return q.get('SELECT * FROM tags WHERE user_id = ? AND name = ?', userId, name)
}

export const tagsOf = video =>
  q.all('SELECT t.id, t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video = ? ORDER BY t.name', video)

/** Attach one tag. Silently a no-op if it is already there. */
export function tagVideo(video, tagId) {
  if (q.get('SELECT COUNT(*) c FROM video_tags WHERE video = ?', video).c >= MAX_TAGS_PER_VIDEO) return false
  q.run('INSERT OR IGNORE INTO video_tags(video, tag_id) VALUES(?,?)', video, tagId)
  return true
}

export const untagVideo = (video, tagId) =>
  q.run('DELETE FROM video_tags WHERE video = ? AND tag_id = ?', video, tagId).changes > 0

/** Deleting a tag unlinks it everywhere; the videos themselves are untouched. */
export function deleteTag(userId, tagId) {
  const t = q.get('SELECT * FROM tags WHERE id = ? AND user_id = ?', tagId, userId)
  if (!t) return false
  q.run('DELETE FROM video_tags WHERE tag_id = ?', tagId)
  q.run('DELETE FROM tags WHERE id = ?', tagId)
  return true
}

export function renameTag(userId, tagId, rawName) {
  const name = cleanTagName(rawName)
  if (!name) return null
  const t = q.get('SELECT * FROM tags WHERE id = ? AND user_id = ?', tagId, userId)
  if (!t) return null
  // Renaming onto an existing tag merges into it rather than failing on the
  // unique index — which is what someone fixing a typo actually means.
  const clash = q.get('SELECT * FROM tags WHERE user_id = ? AND name = ? AND id != ?', userId, name, tagId)
  if (clash) {
    q.run('UPDATE OR IGNORE video_tags SET tag_id = ? WHERE tag_id = ?', clash.id, tagId)
    q.run('DELETE FROM video_tags WHERE tag_id = ?', tagId)
    q.run('DELETE FROM tags WHERE id = ?', tagId)
    return clash
  }
  q.run('UPDATE tags SET name = ? WHERE id = ?', name, tagId)
  return q.get('SELECT * FROM tags WHERE id = ?', tagId)
}

export const dropTagsFor = video => q.run('DELETE FROM video_tags WHERE video = ?', video)

// ---------- collections ----------

export const collectionsOf = userId =>
  q.all(`SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.coll_id = c.id) n
           FROM collections c WHERE c.user_id = ? ORDER BY c.updated DESC`, userId)

export const getCollection = id =>
  q.get('SELECT * FROM collections WHERE id = ?', Number(id) || 0)

export function createCollection({ userId, username, title, descr = '', visibility = 'private' }) {
  const now = nowIso()
  const r = q.run(
    'INSERT INTO collections(user_id, username, title, descr, visibility, created, updated) VALUES(?,?,?,?,?,?,?)',
    userId, username || '', String(title || '').slice(0, 120), String(descr || '').slice(0, 500),
    visibility === 'public' ? 'public' : 'private', now, now)
  return getCollection(Number(r.lastInsertRowid))
}

export function updateCollection(id, patch) {
  const c = getCollection(id)
  if (!c) return null
  if (patch.title !== undefined) q.run('UPDATE collections SET title=? WHERE id=?', String(patch.title).slice(0, 120), id)
  if (patch.descr !== undefined) q.run('UPDATE collections SET descr=? WHERE id=?', String(patch.descr).slice(0, 500), id)
  if (patch.visibility === 'public' || patch.visibility === 'private')
    q.run('UPDATE collections SET visibility=? WHERE id=?', patch.visibility, id)
  touch(id)
  return getCollection(id)
}

const touch = id => q.run('UPDATE collections SET updated=? WHERE id=?', nowIso(), id)

export function deleteCollection(id) {
  q.run('DELETE FROM collection_items WHERE coll_id = ?', id)
  return q.run('DELETE FROM collections WHERE id = ?', id).changes > 0
}

/** Append to the end. Re-adding an existing member just keeps its position. */
export function addToCollection(id, video) {
  const next = (q.get('SELECT MAX(pos) m FROM collection_items WHERE coll_id = ?', id).m ?? -1) + 1
  q.run('INSERT OR IGNORE INTO collection_items(coll_id, video, pos) VALUES(?,?,?)', id, video, next)
  touch(id)
}

export function removeFromCollection(id, video) {
  const gone = q.run('DELETE FROM collection_items WHERE coll_id = ? AND video = ?', id, video).changes > 0
  if (gone) touch(id)
  return gone
}

/** Rewrite the order from a caller-supplied list; anything omitted keeps its place after. */
export function reorderCollection(id, names) {
  let pos = 0
  for (const n of names) {
    if (q.run('UPDATE collection_items SET pos = ? WHERE coll_id = ? AND video = ?', pos, id, n).changes) pos++
  }
  touch(id)
}

/**
 * Members in order, joined against `videos` so entries whose file has since been
 * recycled or purged simply drop out instead of rendering as broken tiles.
 */
export const collectionItems = id =>
  q.all(`SELECT v.* FROM collection_items ci
           JOIN videos v ON v.name = ci.video
          WHERE ci.coll_id = ? AND v.status = 'ok'
          ORDER BY ci.pos, v.uploaded DESC`, id)

export const dropCollectionRefs = video => q.run('DELETE FROM collection_items WHERE video = ?', video)

export const collectionOut = (c, n = null) => ({
  id: c.id,
  title: c.title,
  descr: c.descr,
  visibility: c.visibility,
  username: c.username,
  count: n ?? c.n ?? 0,
  url: `/c/${c.id}`,
  embed: `<iframe src="/c/${c.id}" width="640" height="420" frameborder="0" allowfullscreen></iframe>`,
  created: c.created,
  updated: c.updated,
})
