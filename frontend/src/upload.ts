/**
 * Upload transport.
 *
 * Small files go up in one POST — simplest path, no extra round-trips. Anything
 * large uses the resumable protocol, because a single POST that dies at 90%
 * has to start over, which on a shaky connection can mean never finishing.
 *
 * The session id is remembered per file so a reload or a fresh tab resumes
 * rather than re-sending gigabytes the server already has.
 */
import { getToken } from './api'
import { langHeader } from './i18n'

/** Below this a plain POST is cheaper than the session round-trips. */
export const RESUMABLE_FROM = 16 * 1024 * 1024
const STORE_KEY = 'vidhub_uploads'
const MAX_RETRIES = 5

export interface UploadHandle {
  onProgress?: (sent: number, total: number) => void
  onResume?: (from: number, total: number) => void
  signal?: AbortSignal
}

const authHeaders = () => {
  const h: Record<string, string> = { ...langHeader() }
  const t = getToken()
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

/** Identity of a file good enough to match a stored session against. */
const fingerprint = (f: File) => `${f.name}|${f.size}|${f.lastModified}`

type Store = Record<string, string>
const readStore = (): Store => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
}
const writeStore = (s: Store) => localStorage.setItem(STORE_KEY, JSON.stringify(s))
const remember = (f: File, id: string) => { const s = readStore(); s[fingerprint(f)] = id; writeStore(s) }
const forget = (f: File) => { const s = readStore(); delete s[fingerprint(f)]; writeStore(s) }
const recall = (f: File) => readStore()[fingerprint(f)]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** One-shot upload with progress, for small files. */
function postWhole(file: File, visibility: string, h: UploadHandle): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/videos?name=${encodeURIComponent(file.name)}&visibility=${visibility}`)
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = e => { if (e.lengthComputable) h.onProgress?.(e.loaded, e.total) }
    xhr.onload = () => {
      let j: any = {}
      try { j = JSON.parse(xhr.responseText) } catch {}
      xhr.status === 200 ? resolve(j) : reject(new Error(j.error || 'upload failed'))
    }
    xhr.onerror = () => reject(new Error('network'))
    h.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(file)
  })
}

/** Send one slice, reporting progress relative to the whole file. */
function patchChunk(id: string, blob: Blob, offset: number, total: number, h: UploadHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PATCH', `/api/uploads/${id}?offset=${offset}`)
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = e => { if (e.lengthComputable) h.onProgress?.(offset + e.loaded, total) }
    xhr.onload = () => {
      let j: any = {}
      try { j = JSON.parse(xhr.responseText) } catch {}
      // 409 carries the server's real offset, so a confused client resynchronises
      if (xhr.status === 200 || xhr.status === 409) return resolve(Number(j.offset ?? offset))
      reject(new Error(j.error || `chunk failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('network'))
    h.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(blob)
  })
}

async function resumable(file: File, visibility: string, h: UploadHandle): Promise<any> {
  let id = recall(file)
  let offset = 0
  let chunkSize = 8 * 1024 * 1024

  // Try to pick up where a previous attempt stopped.
  if (id) {
    const r = await fetch(`/api/uploads/${id}`, { headers: authHeaders() })
    if (r.ok) {
      const j = await r.json()
      offset = j.offset || 0
      chunkSize = j.chunk_size || chunkSize
      if (offset > 0) h.onResume?.(offset, file.size)
    } else { forget(file); id = '' }
  }

  if (!id) {
    const r = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name: file.name, size: file.size, visibility }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || 'could not start the upload')
    id = j.id
    offset = j.offset || 0
    chunkSize = j.chunk_size || chunkSize
    remember(file, id)
  }

  let attempt = 0
  while (offset < file.size) {
    if (h.signal?.aborted) throw new Error('aborted')
    const end = Math.min(offset + chunkSize, file.size)
    try {
      const next = await patchChunk(id, file.slice(offset, end), offset, file.size, h)
      if (next <= offset && next !== file.size) {
        // no forward progress: trust the server's offset and try again
        if (++attempt > MAX_RETRIES) throw new Error('stalled')
        await sleep(500 * attempt)
      } else attempt = 0
      offset = next
      h.onProgress?.(offset, file.size)
    } catch (e) {
      // A dropped connection is expected on big files — back off and resume
      // from whatever the server actually holds rather than starting over.
      if (h.signal?.aborted || ++attempt > MAX_RETRIES) throw e
      await sleep(500 * attempt)
      const r = await fetch(`/api/uploads/${id}`, { headers: authHeaders() }).catch(() => null)
      if (r?.ok) offset = (await r.json()).offset || offset
    }
  }

  const fin = await fetch(`/api/uploads/${id}/finish`, { method: 'POST', headers: authHeaders() })
  const j = await fin.json().catch(() => ({}))
  if (!fin.ok) {
    if (fin.status !== 409) forget(file)      // 409 = incomplete, worth resuming
    throw new Error(j.error || 'could not finish the upload')
  }
  forget(file)
  return j
}

export async function uploadFile(file: File, visibility: string, h: UploadHandle = {}): Promise<any> {
  return file.size >= RESUMABLE_FROM ? resumable(file, visibility, h) : postWhole(file, visibility, h)
}

/** Abandon a half-finished session on the server and locally. */
export async function discardUpload(file: File) {
  const id = recall(file)
  if (!id) return
  await fetch(`/api/uploads/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {})
  forget(file)
}
