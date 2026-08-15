/** Shared API client + global state (site config, current user). */
import { reactive } from 'vue'
import { langHeader } from './i18n'

export const TOKEN_KEY = 'vidhub_token'
export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const setToken = (t: string) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)

export interface PublicConf {
  title: string; keywords: string; description: string; tips: string
  notice: string; notice_status: number; custom_head: string; footer_code: string; terms: string
  domain: string
  must_login: number; allow_guest: number; max_size_mb: number; max_upload_files: number
  extensions: string; allow_images: number; image_extensions: string; allow_other: number
  explore_public: number; stats_public: number; allow_register: number
  ad_top: number; ad_top_info: string; ad_bot: number; ad_bot_info: string
  [k: string]: unknown
}

export type Visibility = 'public' | 'private'

export interface Me {
  id: number; username: string; role: 'admin' | 'uploader'
  daily_limit: number; default_visibility: Visibility; created: string
}

export const state = reactive({
  conf: null as PublicConf | null,
  me: null as Me | null,
  checked: false,
})

export async function api(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...langHeader(),                       // API errors come back already translated
    ...(opts.headers as Record<string, string> || {}),
  }
  const t = getToken()
  if (t) headers.Authorization = `Bearer ${t}`
  if (opts.body && typeof opts.body === 'string' && !headers['Content-Type'])
    headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers })
  if (res.status === 401 && !path.includes('/login')) {
    // stale token
    if (state.me) { state.me = null; setToken('') }
  }
  return res
}

export async function loadSite() {
  try {
    state.conf = await (await fetch('/api/config/public', { headers: langHeader() })).json()
  } catch { /* offline */ }
  if (getToken()) {
    try {
      const r = await api('/api/me')
      if (r.ok) state.me = await r.json()
    } catch { /* ignore */ }
  }
  state.checked = true
}

/**
 * Memoized site bootstrap. Child `onMounted` hooks run before the parent's, so a
 * route guard cannot assume App.vue has loaded the session yet — awaiting this
 * is what replaces the old fixed 300ms sleep.
 */
let sitePromise: Promise<void> | null = null
export function ensureSite(): Promise<void> {
  if (!sitePromise) sitePromise = loadSite()
  return sitePromise
}

/** Origin used in copied links — honours the admin's 外链域名 setting. */
export const siteBase = (): string => {
  const d = String(state.conf?.domain || '').trim().replace(/\/+$/, '')
  return d || location.origin
}

export const absUrl = (path: string): string => siteBase() + path

export const fmtSize = (n: number) =>
  // the Math.max floor keeps a 300-byte file from reading "0 KB"; a genuine
  // zero must still say zero
  !n ? '0 KB'
    : n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB'
      : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB'
        : Math.max(1, Math.round(n / 1024)) + ' KB'

export const fmtDur = (s: number) => {
  if (!s) return ''
  const m = Math.floor(s / 60), sec = Math.round(s % 60)
  const h = Math.floor(m / 60)
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export interface VideoItem {
  name: string; orig: string; size: number; kind: string; ext: string
  width: number; height: number; duration: number; status: string
  visibility: Visibility
  mod_score: number; username: string; ip: string; ip_region: string
  views: number; uploaded: string; url: string; player: string; thumb: string; embed: string
}
