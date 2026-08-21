<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  api, absUrl, ensureSite, fmtDur, fmtSize, siteBase, state,
  type Collection, type Tag, type VideoItem, type Visibility,
} from '../api'
import { locale, t } from '../i18n'
import { linkFor } from '../links'
import ShareBox from '../components/ShareBox.vue'
import ShareLinks from '../components/ShareLinks.vue'
import { toast } from '../toast'

const router = useRouter()
const tab = ref<'videos' | 'recycle' | 'colls' | 'keys' | 'account'>('videos')

// videos
const videos = ref<VideoItem[]>([])
const total = ref(0)
const pageNum = ref(1)
const q = ref('')
const size = 12

const sort = ref('uploaded')
const order = ref<'asc' | 'desc'>('desc')
const tagFilter = ref(0)

async function load() {
  const isRecycle = tab.value === 'recycle'
  const sortQ = `&sort=${sort.value}&order=${order.value}`
  const path = isRecycle
    ? `/api/recycle?page=${pageNum.value}&size=${size}${sortQ}`
    : `/api/videos?page=${pageNum.value}&size=${size}&q=${encodeURIComponent(q.value)}${sortQ}`
      + (tagFilter.value ? `&tag=${tagFilter.value}` : '')
  const res = await api(path)
  if (res.status === 401) { router.push('/login'); return }
  const j = await res.json()
  videos.value = j.items || []
  total.value = j.total || 0
  // Anything no longer on screen cannot be acted on, so drop it from the selection.
  const here = new Set(videos.value.map(v => v.name))
  selected.value = selected.value.filter(n => here.has(n))
}
watch([tab, pageNum], load)
watch([sort, order, tagFilter], () => { pageNum.value = 1; load() })
let debounce: number | undefined
watch(q, () => { clearTimeout(debounce); debounce = window.setTimeout(() => { pageNum.value = 1; load() }, 350) })

const statusPill = (s: string) =>
  s === 'ok' ? t('s.ok') : s === 'processing' ? t('s.processing') : s === 'banned' ? t('s.banned') : t('s.recycled')

async function del(v: VideoItem) {
  if (!confirm(t('my.confirmDelete', v.orig || v.name))) return
  const res = await api(`/api/videos/${v.name}`, { method: 'DELETE' })
  if (res.ok) { toast(t('my.movedToBin')); load() } else toast(t('c.failed'), false)
}
async function restore(v: VideoItem) {
  const res = await api(`/api/videos/${v.name}/restore`, { method: 'POST' })
  if (res.ok) { toast(t('my.restored')); load() } else toast(t('c.failed'), false)
}
async function forceDel(v: VideoItem) {
  if (!confirm(t('my.confirmForce', v.orig || v.name))) return
  const res = await api(`/api/videos/${v.name}/force`, { method: 'DELETE' })
  if (res.ok) { toast(t('my.forceDeleted')); load() } else toast(t('c.failed'), false)
}
const copy = async (text: string) => { await navigator.clipboard.writeText(text); toast(t('c.copied')) }

/** Which row has its share panel open (only one at a time). */
const openShare = ref('')
const toggleShare = (name: string) => { openShare.value = openShare.value === name ? '' : name }

const purging = ref(false)
async function emptyBin() {
  if (!total.value || !confirm(t('bin.confirmOwn', total.value))) return
  purging.value = true
  const res = await api('/api/recycle', { method: 'DELETE' })
  purging.value = false
  if (!res.ok) return toast(t('c.failed'), false)
  const j = await res.json()
  toast(t('bin.purged', j.purged, fmtSize(j.freed)))
  load()
}

/** Cycles public → unlisted → link-only → public. */
const VIS_CYCLE: Visibility[] = ['public', 'private', 'protected']
const VIS_LABEL: Record<string, string> = { public: '🌐 vis.public', private: '🔒 vis.private', protected: '🔗 vis.protected' }
const visLabel = (vis: string) => {
  const [icon, key] = (VIS_LABEL[vis] || VIS_LABEL.public).split(' ')
  return `${icon} ${t(key)}`
}

async function toggleVisibility(v: VideoItem) {
  const next = VIS_CYCLE[(VIS_CYCLE.indexOf(v.visibility as Visibility) + 1) % VIS_CYCLE.length]
  const res = await api(`/api/videos/${v.name}`, {
    method: 'PATCH',
    body: JSON.stringify({ visibility: next }),
  })
  if (res.ok) { v.visibility = next; toast(t('vis.changed')) } else toast(t('c.failed'), false)
}

// ---------------- selection + bulk actions ----------------
const selected = ref<string[]>([])
const isSel = (n: string) => selected.value.includes(n)
function toggleSel(n: string) {
  selected.value = isSel(n) ? selected.value.filter(x => x !== n) : [...selected.value, n]
}
const allOnPage = computed(() => videos.value.length > 0 && videos.value.every(v => isSel(v.name)))
function toggleAll() {
  selected.value = allOnPage.value ? [] : videos.value.map(v => v.name)
}

const bulkBusy = ref(false)
async function bulk(action: string, extra: Record<string, unknown> = {}) {
  if (!selected.value.length || bulkBusy.value) return
  bulkBusy.value = true
  const res = await api('/api/videos/bulk', {
    method: 'POST',
    body: JSON.stringify({ action, names: selected.value, ...extra }),
  })
  bulkBusy.value = false
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return toast(j.error || t('c.failed'), false)
  toast(j.skipped ? t('blk.someSkipped', j.done, j.skipped) : t('blk.done', j.done))
  selected.value = []
  load()
  loadTags()
}

const bulkDelete = () =>
  confirm(t('blk.confirmDelete', selected.value.length)) && bulk('delete')
const bulkForce = () =>
  confirm(t('blk.confirmForce', selected.value.length)) && bulk('force')
function bulkTag() {
  const name = prompt(t('blk.tagPrompt'))
  if (name && name.trim()) bulk('tag', { tag: name.trim() })
}

// ---------------- tags ----------------
const tags = ref<Tag[]>([])
async function loadTags() {
  const res = await api('/api/tags')
  if (res.ok) tags.value = (await res.json()).items
}
async function renameTag(tg: Tag) {
  const name = prompt(t('tg.renamePrompt'), tg.name)
  if (!name || name.trim() === tg.name) return
  const res = await api(`/api/tags/${tg.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) })
  if (res.ok) { loadTags(); load(); toast(t('c.ok')) } else toast(t('c.failed'), false)
}
async function delTag(tg: Tag) {
  if (!confirm(t('tg.confirmDelete', tg.name))) return
  const res = await api(`/api/tags/${tg.id}`, { method: 'DELETE' })
  if (!res.ok) return toast(t('c.failed'), false)
  if (tagFilter.value === tg.id) tagFilter.value = 0
  loadTags(); load(); toast(t('c.ok'))
}
async function untag(v: VideoItem, tg: Tag) {
  const res = await api(`/api/videos/${v.name}/tags`, { method: 'DELETE', body: JSON.stringify({ id: tg.id }) })
  if (res.ok) { v.tags = (await res.json()).tags; loadTags() } else toast(t('c.failed'), false)
}

// ---------------- collections ----------------
const colls = ref<Collection[]>([])
const newColl = ref({ title: '', descr: '', visibility: 'private' as 'public' | 'private' })
const openColl = ref<Collection | null>(null)
const collItems = ref<VideoItem[]>([])

async function loadColls() {
  const res = await api('/api/collections')
  if (res.ok) colls.value = (await res.json()).items
}
async function addColl() {
  if (!newColl.value.title.trim()) return
  const res = await api('/api/collections', { method: 'POST', body: JSON.stringify(newColl.value) })
  if (!res.ok) return toast((await res.json().catch(() => ({}))).error || t('c.failed'), false)
  newColl.value = { title: '', descr: '', visibility: 'private' }
  toast(t('cl.created'))
  loadColls()
}
async function delColl(c: Collection) {
  if (!confirm(t('cl.confirmDelete', c.title))) return
  const res = await api(`/api/collections/${c.id}`, { method: 'DELETE' })
  if (!res.ok) return toast(t('c.failed'), false)
  if (openColl.value?.id === c.id) openColl.value = null
  toast(t('cl.deleted'))
  loadColls()
}
async function showColl(c: Collection) {
  if (openColl.value?.id === c.id) { openColl.value = null; return }
  const res = await api(`/api/collections/${c.id}`)
  if (!res.ok) return toast(t('c.failed'), false)
  const j = await res.json()
  openColl.value = c
  collItems.value = j.items || []
}
async function collRemove(name: string) {
  if (!openColl.value) return
  await api(`/api/collections/${openColl.value.id}/items`, { method: 'DELETE', body: JSON.stringify({ names: [name] }) })
  collItems.value = collItems.value.filter(v => v.name !== name)
  toast(t('cl.removed'))
  loadColls()
}
/** Order is persisted as the whole list, so one swap is a full rewrite. */
async function collMove(i: number, dir: -1 | 1) {
  const j = i + dir
  if (!openColl.value || j < 0 || j >= collItems.value.length) return
  const a = collItems.value.slice()
  ;[a[i], a[j]] = [a[j], a[i]]
  collItems.value = a
  await api(`/api/collections/${openColl.value.id}/order`, {
    method: 'POST', body: JSON.stringify({ names: a.map(v => v.name) }),
  })
}
async function bulkAddToColl(id: number) {
  if (!selected.value.length) return
  const res = await api(`/api/collections/${id}/items`, {
    method: 'POST', body: JSON.stringify({ names: selected.value }),
  })
  if (!res.ok) return toast(t('c.failed'), false)
  toast(t('cl.added', (await res.json()).changed))
  selected.value = []
  loadColls()
}

// account default
const savingPref = ref(false)
async function setDefaultVisibility(vis: Visibility) {
  savingPref.value = true
  const res = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ default_visibility: vis }) })
  savingPref.value = false
  if (res.ok && state.me) { state.me.default_visibility = vis; toast(t('vis.changed')) }
  else toast(t('c.failed'), false)
}

watch(locale, () => { if (tab.value === 'videos' || tab.value === 'recycle') load() })

// api keys
interface ApiKey {
  key: string; name: string; status: string; created: string
  scopes: string; expires: number; last_used: number; expired: boolean
}
const keys = ref<ApiKey[]>([])
const keyName = ref('')
const keyScopes = ref<string[]>(['read', 'upload'])
const keyDays = ref(0)

async function loadKeys() { keys.value = await (await api('/api/me/keys')).json() }
async function addKey() {
  if (!keyScopes.value.length) return toast(t('my.keyNeedScope'), false)
  const res = await api('/api/me/keys', {
    method: 'POST',
    body: JSON.stringify({ name: keyName.value, scopes: keyScopes.value, expires_days: keyDays.value }),
  })
  if (res.ok) { keyName.value = ''; loadKeys(); toast(t('my.keyCreated')) }
  else toast((await res.json().catch(() => ({}))).error || t('c.failed'), false)
}
async function delKey(k: ApiKey) {
  if (!confirm(t('my.keyConfirmDelete', k.name || k.key.slice(0, 12) + '…'))) return
  await api(`/api/me/keys/${k.key}`, { method: 'DELETE' })
  loadKeys()
}
async function toggleKey(k: ApiKey) {
  const status = k.status === 'active' ? 'disabled' : 'active'
  const res = await api(`/api/me/keys/${k.key}`, { method: 'PATCH', body: JSON.stringify({ status }) })
  if (res.ok) { loadKeys(); toast(t('c.ok')) } else toast(t('c.failed'), false)
}

const SCOPE_KEYS = ['read', 'upload', 'manage'] as const
const fmtDate = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : '')
const keyState = (k: ApiKey) =>
  k.status !== 'active' ? t('my.keyRevoked') : k.expired ? t('my.keyExpired') : t('ad.active')

// password
const oldPwd = ref(''), newPwd = ref(''), newPwd2 = ref('')
async function changePwd() {
  if (newPwd.value !== newPwd2.value) return toast(t('lg.mismatch'), false)
  const res = await api('/api/me/password', { method: 'POST', body: JSON.stringify({ old: oldPwd.value, password: newPwd.value }) })
  const j = await res.json().catch(() => ({}))
  if (res.ok) { toast(t('my.pwChanged')); localStorage.removeItem('vidhub_token'); state.me = null; router.push('/login') }
  else toast(j.error || t('my.pwFailed'), false)
}

onMounted(async () => {
  await ensureSite()                       // wait for the session check, don't assume it ran
  if (!state.me) { router.push('/login'); return }
  load()
  loadKeys()
  loadTags()
  loadColls()
})
</script>

<template>
  <div class="fade-up">
    <div class="row" style="margin:.5rem 0 1.2rem">
      <h1 style="margin:0;font-size:1.3rem">{{ t('my.title') }}</h1>
      <span class="pill" :class="state.me?.role === 'admin' ? 'role-admin' : 'role-uploader'">{{ state.me?.username }}</span>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'videos' }" @click="tab = 'videos'">{{ t('my.tabVideos') }}</button>
      <button class="tab" :class="{ on: tab === 'recycle' }" @click="tab = 'recycle'">{{ t('my.tabRecycle') }}</button>
      <button class="tab" :class="{ on: tab === 'colls' }" @click="tab = 'colls'">{{ t('cl.title') }}</button>
      <button class="tab" :class="{ on: tab === 'keys' }" @click="tab = 'keys'">{{ t('my.tabKeys') }}</button>
      <button class="tab" :class="{ on: tab === 'account' }" @click="tab = 'account'">{{ t('my.tabAccount') }}</button>
    </div>

    <template v-if="tab === 'videos' || tab === 'recycle'">
      <div class="row" style="margin-bottom:.9rem;flex-wrap:wrap;gap:.5rem" v-if="tab === 'videos'">
        <input v-model="q" :placeholder="t('my.searchMine')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none" />
        <select v-model="tagFilter" class="mini-sel" :title="t('tg.title')">
          <option :value="0">{{ t('tg.all') }}</option>
          <option v-for="tg in tags" :key="tg.id" :value="tg.id">{{ tg.name }} ({{ tg.n }})</option>
        </select>
        <span class="grow"></span>
        <select v-model="sort" class="mini-sel" :title="t('sort.label')">
          <option value="uploaded">{{ t('sort.uploaded') }}</option>
          <option value="size">{{ t('sort.size') }}</option>
          <option value="duration">{{ t('sort.duration') }}</option>
          <option value="views">{{ t('sort.views') }}</option>
          <option value="name">{{ t('sort.name') }}</option>
        </select>
        <button class="btn ghost sm" :title="order === 'desc' ? t('sort.desc') : t('sort.asc')"
                @click="order = order === 'desc' ? 'asc' : 'desc'">{{ order === 'desc' ? '↓' : '↑' }}</button>
      </div>

      <!-- appears only once something is picked, so the list stays uncluttered -->
      <div v-if="selected.length" class="bulkbar">
        <b>{{ t('blk.selected', selected.length) }}</b>
        <button class="btn ghost sm" @click="selected = []">{{ t('blk.clear') }}</button>
        <span class="grow"></span>
        <template v-if="tab === 'videos'">
          <select class="mini-sel" :disabled="bulkBusy"
                  @change="bulk('visibility', { visibility: ($event.target as HTMLSelectElement).value }); ($event.target as HTMLSelectElement).selectedIndex = 0">
            <option value="">{{ t('blk.visibility') }}</option>
            <option value="public">{{ t('vis.public') }}</option>
            <option value="private">{{ t('vis.private') }}</option>
            <option value="protected">{{ t('vis.protected') }}</option>
          </select>
          <button class="btn ghost sm" :disabled="bulkBusy" @click="bulkTag">{{ t('blk.tag') }}</button>
          <select v-if="colls.length" class="mini-sel" :disabled="bulkBusy"
                  @change="bulkAddToColl(Number(($event.target as HTMLSelectElement).value)); ($event.target as HTMLSelectElement).selectedIndex = 0">
            <option value="">{{ t('blk.addTo') }}</option>
            <option v-for="c in colls" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
          <button class="btn danger sm" :disabled="bulkBusy" @click="bulkDelete">{{ t('blk.delete') }}</button>
        </template>
        <template v-else>
          <button class="btn ghost sm" :disabled="bulkBusy" @click="bulk('restore')">{{ t('blk.restore') }}</button>
          <button class="btn danger sm" :disabled="bulkBusy" @click="bulkForce">{{ t('blk.force') }}</button>
        </template>
      </div>
      <div class="row" style="margin-bottom:.9rem" v-if="tab === 'recycle'">
        <span class="muted2" style="font-size:.78rem">{{ t('bin.note') }}</span>
        <span class="grow"></span>
        <button class="btn danger sm" :disabled="purging || !videos.length" @click="emptyBin">{{ t('bin.empty') }}</button>
      </div>
      <div class="glass-card" style="padding:.4rem 1.2rem">
        <div v-if="videos.length === 0" class="muted" style="text-align:center;padding:2rem 0">
          {{ tab === 'recycle' ? t('bin.emptyState') : t('c.empty') }}
        </div>
        <label v-else class="selall">
          <input type="checkbox" :checked="allOnPage" @change="toggleAll"> {{ t('blk.selectAll') }}
        </label>
        <template v-for="v in videos" :key="v.name">
        <div class="vrow" :class="{ picked: isSel(v.name) }">
          <input class="vcheck" type="checkbox" :checked="isSel(v.name)" @change="toggleSel(v.name)">
          <div class="thumb">
            <img v-if="v.thumb" :src="v.thumb" style="width:100%;height:100%;object-fit:cover" @error="($event.target as HTMLImageElement).style.display = 'none'" />
          </div>
          <div class="info">
            <b>{{ v.orig || v.name }}</b>
            <small>
              {{ fmtSize(v.size) }}<template v-if="v.duration"> · {{ fmtDur(v.duration) }}</template>
              <template v-if="v.width"> · {{ v.width }}×{{ v.height }}</template>
               · {{ v.uploaded.slice(0, 10) }} · {{ t('c.views', v.views) }}
            </small>
            <div v-if="tab === 'videos' && v.tags?.length" class="tagrow">
              <span v-for="tg in v.tags" :key="tg.id" class="tagchip">
                {{ tg.name }}<button :title="t('c.delete')" @click.stop="untag(v, tg)">×</button>
              </span>
            </div>
          </div>
          <span class="pill" :class="v.status">{{ statusPill(v.status) }}</span>
          <button
            v-if="tab === 'videos'"
            class="pill vis-pill" :class="v.visibility"
            :title="t('vis.next')"
            @click="toggleVisibility(v)"
          >{{ visLabel(v.visibility) }}</button>
          <div class="ops">
            <template v-if="tab === 'videos'">
              <!-- a link-only file has no working direct URL to copy -->
              <button v-if="v.visibility !== 'protected'" class="btn ghost sm" @click="copy(linkFor(v, 'direct'))">{{ t('tab.direct') }}</button>
              <button class="btn ghost sm" :class="{ on: openShare === v.name }" @click="toggleShare(v.name)">
                {{ v.visibility === 'protected' ? t('sl.title') : t('c.share') }} {{ openShare === v.name ? '▾' : '▸' }}
              </button>
              <button class="btn danger sm" @click="del(v)">{{ t('c.delete') }}</button>
            </template>
            <template v-else>
              <button class="btn ghost sm" @click="restore(v)">{{ t('c.restore') }}</button>
              <button class="btn danger sm" @click="forceDel(v)">{{ t('my.forceDelete') }}</button>
            </template>
          </div>
        </div>
        <template v-if="tab === 'videos' && openShare === v.name">
          <ShareLinks v-if="v.visibility === 'protected'" :name="v.name" />
          <ShareBox v-else :item="v" />
        </template>
        </template>
      </div>
      <p v-if="tab === 'videos' && videos.length" class="muted2" style="margin:.7rem 0 0;font-size:.75rem">
        {{ t('vis.warning') }}
      </p>
      <div v-if="Math.ceil(total / size) > 1" class="pager">
        <button class="btn ghost sm" :disabled="pageNum <= 1" @click="pageNum--">{{ t('c.prev') }}</button>
        <span>{{ pageNum }} / {{ Math.ceil(total / size) }}</span>
        <button class="btn ghost sm" :disabled="pageNum >= Math.ceil(total / size)" @click="pageNum++">{{ t('c.next') }}</button>
      </div>
    </template>

    <template v-if="tab === 'keys'">
      <div class="glass-card" style="padding:1.2rem">
        <h3 style="margin-top:0">{{ t('my.tabKeys') }} <span class="muted2">— {{ t('my.keysDesc') }}</span></h3>

        <div class="key-new">
          <div class="row" style="margin-bottom:.7rem">
            <input v-model="keyName" :placeholder="t('my.keyName')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none;flex:1" />
          </div>
          <div class="field">
            <label>{{ t('my.keyScopes') }}</label>
            <div class="scope-row">
              <label v-for="s in SCOPE_KEYS" :key="s" class="scope-opt" :class="{ on: keyScopes.includes(s) }">
                <input type="checkbox" :value="s" v-model="keyScopes" />
                <b>{{ t('scope.' + s) }}</b><small>{{ t('scope.' + s + 'Hint') }}</small>
              </label>
            </div>
          </div>
          <div class="row" style="align-items:flex-end">
            <div class="field" style="width:230px;margin:0">
              <label>{{ t('my.keyExpiry') }}</label>
              <select v-model.number="keyDays">
                <option :value="0">{{ t('my.keyNoExpiry') }}</option>
                <option :value="30">30 {{ t('my.days') }}</option>
                <option :value="90">90 {{ t('my.days') }}</option>
                <option :value="365">365 {{ t('my.days') }}</option>
              </select>
            </div>
            <button class="btn sm" @click="addKey">{{ t('c.create') }}</button>
          </div>
          <p class="hint">{{ t('my.keyAdminNote') }}</p>
        </div>

        <div v-for="k in keys" :key="k.key" class="key-row">
          <div class="grow" style="min-width:0">
            <div>
              {{ k.name || t('my.unnamed') }}
              <span class="pill" :class="k.status === 'active' && !k.expired ? 'ok' : 'banned'">{{ keyState(k) }}</span>
              <span v-for="s in k.scopes.split(',')" :key="s" class="pill scope-pill">{{ t('scope.' + s) }}</span>
            </div>
            <div class="mono muted2" style="overflow:hidden;text-overflow:ellipsis">{{ k.key }}</div>
            <div class="muted2" style="font-size:.72rem">
              {{ t('my.keyCreatedOn', k.created.slice(0, 10)) }}
              · {{ k.expires ? t('my.keyExpiresOn', fmtDate(k.expires)) : t('my.keyNoExpiry') }}
              · {{ k.last_used ? t('my.keyLastUsed', fmtDate(k.last_used)) : t('my.keyNeverUsed') }}
            </div>
          </div>
          <div class="ops">
            <button class="btn ghost sm" @click="copy(k.key)">{{ t('c.copy') }}</button>
            <button class="btn ghost sm" @click="toggleKey(k)">{{ k.status === 'active' ? t('my.keyRevoke') : t('ad.enable') }}</button>
            <button class="btn danger sm" @click="delKey(k)">{{ t('c.delete') }}</button>
          </div>
        </div>
        <p v-if="keys.length === 0" class="muted">{{ t('my.noKeys') }}</p>
      </div>
    </template>

    <template v-if="tab === 'colls'">
      <div class="glass-card" style="padding:1.2rem;margin-bottom:1rem;max-width:640px">
        <h3 style="margin-top:0">{{ t('cl.new') }}</h3>
        <div class="cl-form">
          <input v-model="newColl.title" :placeholder="t('cl.name')" maxlength="120">
          <input v-model="newColl.descr" :placeholder="t('cl.descr')" maxlength="500">
          <select v-model="newColl.visibility">
            <option value="private">{{ t('cl.private') }}</option>
            <option value="public">{{ t('cl.public') }}</option>
          </select>
          <button class="btn sm" :disabled="!newColl.title.trim()" @click="addColl">{{ t('cl.create') }}</button>
        </div>
      </div>

      <div class="glass-card" style="padding:.4rem 1.2rem;margin-bottom:1rem">
        <p v-if="!colls.length" class="muted" style="text-align:center;padding:2rem 0">{{ t('cl.empty') }}</p>
        <template v-for="c in colls" :key="c.id">
          <div class="vrow">
            <div class="info">
              <b>📚 {{ c.title }}</b>
              <small>
                {{ t('cl.items', c.count) }} ·
                {{ c.visibility === 'public' ? t('vis.public') : t('vis.private') }} ·
                {{ c.updated.slice(0, 10) }}
              </small>
              <small v-if="c.descr" class="muted2">{{ c.descr }}</small>
            </div>
            <div class="ops">
              <button class="btn ghost sm" :class="{ on: openColl?.id === c.id }" @click="showColl(c)">
                {{ t('c.edit') }} {{ openColl?.id === c.id ? '▾' : '▸' }}
              </button>
              <button class="btn ghost sm" @click="copy(siteBase() + c.url)">{{ t('c.copy') }}</button>
              <a class="btn ghost sm" :href="c.url" target="_blank" rel="noopener">{{ t('cl.open') }}</a>
              <button class="btn danger sm" @click="delColl(c)">{{ t('c.delete') }}</button>
            </div>
          </div>
          <div v-if="openColl?.id === c.id" class="cl-items">
            <p v-if="!collItems.length" class="muted2" style="font-size:.78rem;margin:.2rem 0">{{ t('coll.empty') }}</p>
            <div v-for="(v, i) in collItems" :key="v.name" class="cl-item">
              <span class="cl-pos">{{ i + 1 }}</span>
              <img v-if="v.thumb" :src="v.thumb" @error="($event.target as HTMLImageElement).style.visibility = 'hidden'">
              <span class="cl-name">{{ v.orig || v.name }}</span>
              <button class="btn ghost sm" :disabled="i === 0" :title="t('cl.up')" @click="collMove(i, -1)">↑</button>
              <button class="btn ghost sm" :disabled="i === collItems.length - 1" :title="t('cl.down')" @click="collMove(i, 1)">↓</button>
              <button class="btn danger sm" @click="collRemove(v.name)">{{ t('c.delete') }}</button>
            </div>
            <p class="muted2" style="font-size:.72rem;margin:.5rem 0 .2rem">{{ t('cl.protectedSkipped') }}</p>
          </div>
        </template>
      </div>

      <div class="glass-card" style="padding:1.2rem">
        <h3 style="margin-top:0">{{ t('tg.manage') }}</h3>
        <p v-if="!tags.length" class="muted2" style="font-size:.8rem;margin:0">{{ t('tg.empty') }}</p>
        <div v-else class="tagmgr">
          <div v-for="tg in tags" :key="tg.id" class="tagmgr-row">
            <b>{{ tg.name }}</b>
            <span class="muted2">{{ t('tg.count', tg.n) }}</span>
            <button class="btn ghost sm" @click="renameTag(tg)">{{ t('tg.rename') }}</button>
            <button class="btn danger sm" @click="delTag(tg)">{{ t('c.delete') }}</button>
          </div>
        </div>
      </div>
    </template>

    <template v-if="tab === 'account'">
      <div class="glass-card" style="padding:1.2rem;max-width:560px;margin-bottom:1rem">
        <h3 style="margin-top:0">{{ t('my.preferences') }}</h3>
        <div class="field">
          <label>{{ t('vis.default') }} <span class="muted2">— {{ t('vis.defaultHint') }}</span></label>
          <div class="vis-choice">
            <button
              class="vis-btn" :class="{ on: (state.me?.default_visibility || 'public') === 'public' }"
              :disabled="savingPref" @click="setDefaultVisibility('public')"
            ><b>🌐 {{ t('vis.public') }}</b><small>{{ t('vis.publicHint') }}</small></button>
            <button
              class="vis-btn" :class="{ on: state.me?.default_visibility === 'private' }"
              :disabled="savingPref" @click="setDefaultVisibility('private')"
            ><b>🔒 {{ t('vis.private') }}</b><small>{{ t('vis.privateHint') }}</small></button>
            <button
              class="vis-btn" :class="{ on: state.me?.default_visibility === 'protected' }"
              :disabled="savingPref" @click="setDefaultVisibility('protected')"
            ><b>🔗 {{ t('vis.protected') }}</b><small>{{ t('vis.protectedHint') }}</small></button>
          </div>
        </div>
        <p class="muted2" style="font-size:.75rem;margin:.4rem 0 0">{{ t('vis.warning') }}</p>
      </div>

      <div class="glass-card" style="padding:1.2rem;max-width:420px">
        <h3 style="margin-top:0">{{ t('my.changePassword') }}</h3>
        <div class="field"><label>{{ t('my.oldPassword') }}</label><input v-model="oldPwd" type="password" autocomplete="current-password" /></div>
        <div class="field"><label>{{ t('my.newPassword') }}</label><input v-model="newPwd" type="password" autocomplete="new-password" /></div>
        <div class="field"><label>{{ t('my.confirmNew') }}</label><input v-model="newPwd2" type="password" autocomplete="new-password" /></div>
        <button class="btn" @click="changePwd">{{ t('c.save') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.vis-pill {
  cursor: pointer;
  border: 1px solid transparent;
  font: inherit;
  font-size: .72rem;
  white-space: nowrap;
}
.vis-pill.public { background: rgba(52, 211, 153, .14); color: #6ee7b7; }
.vis-pill.private { background: rgba(148, 163, 184, .16); color: #cbd5e1; }
.vis-pill.protected { background: rgba(125, 162, 255, .18); color: #a8bcff; }

/* ---- selection + bulk ---- */
.selall {
  display: flex; align-items: center; gap: .45rem;
  padding: .5rem .1rem .3rem; font-size: .76rem; color: var(--muted); cursor: pointer;
}
.vcheck { flex: 0 0 auto; width: 1rem; height: 1rem; cursor: pointer; accent-color: #4f7cff; }
.vrow.picked { background: rgba(79, 124, 255, .08); }
.bulkbar {
  display: flex; align-items: center; gap: .45rem; flex-wrap: wrap;
  margin-bottom: .7rem; padding: .55rem .8rem;
  border: 1px solid rgba(125, 162, 255, .35);
  border-radius: 10px;
  background: rgba(79, 124, 255, .1);
  font-size: .8rem;
}

/* ---- tags ---- */
.tagrow { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .28rem; }
.tagchip {
  display: inline-flex; align-items: center; gap: .2rem;
  padding: .08rem .18rem .08rem .4rem;
  border-radius: 5px;
  background: rgba(255, 255, 255, .08);
  font-size: .68rem; color: var(--muted);
}
.tagchip button {
  border: 0; background: none; color: inherit; cursor: pointer;
  padding: 0 .18rem; font-size: .8rem; line-height: 1; opacity: .6;
}
.tagchip button:hover { opacity: 1; color: #ff9b9b; }
.tagmgr { display: flex; flex-direction: column; gap: .3rem; }
.tagmgr-row {
  display: flex; align-items: center; gap: .55rem;
  padding: .35rem 0;
  border-top: 1px solid var(--glass-border);
  font-size: .82rem;
}
.tagmgr-row .muted2 { flex: 1; font-size: .74rem; }

/* ---- collections ---- */
.cl-form { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; }
.cl-form input, .cl-form select {
  padding: .45rem .6rem;
  border: 1px solid var(--glass-border);
  border-radius: 9px;
  background: rgba(0, 0, 0, .28);
  color: var(--text);
  font-size: .84rem;
  outline: none;
}
.cl-form input { flex: 1 1 12rem; min-width: 8rem; }
.cl-items {
  margin: 0 0 .7rem;
  padding: .6rem .8rem;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  background: rgba(0, 0, 0, .26);
}
.cl-item {
  display: flex; align-items: center; gap: .5rem;
  padding: .3rem 0;
  border-top: 1px solid var(--glass-border);
}
.cl-item:first-child { border-top: 0; }
.cl-pos { flex: 0 0 1.3rem; font-size: .72rem; color: var(--muted); text-align: right; }
.cl-item img { flex: 0 0 auto; width: 58px; height: 33px; object-fit: cover; border-radius: 5px; background: #0b0e17; }
.cl-name {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: .8rem;
}
@media (max-width: 640px) {
  .cl-item img { display: none; }
}
.vis-pill:hover { border-color: currentColor; }

.vis-choice { display: flex; flex-wrap: wrap; gap: .6rem; }
.vis-btn {
  flex: 1 1 220px;
  display: flex;
  flex-direction: column;
  gap: .15rem;
  text-align: left;
  padding: .6rem .8rem;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  background: rgba(0, 0, 0, .22);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition: border-color .18s, background .18s;
}
.vis-btn.on { border-color: var(--accent, #7c5cff); background: rgba(124, 92, 255, .12); }
.vis-btn small { color: var(--muted); font-size: .74rem; line-height: 1.35; }
.vis-btn:disabled { opacity: .6; cursor: default; }

.key-new {
  padding: 1rem;
  margin-bottom: 1rem;
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  background: rgba(0, 0, 0, .18);
}
.scope-row { display: flex; flex-wrap: wrap; gap: .6rem; }
.scope-opt {
  flex: 1 1 180px;
  display: flex;
  flex-direction: column;
  gap: .1rem;
  padding: .5rem .7rem;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color .18s, background .18s;
}
.scope-opt.on { border-color: var(--accent, #7c5cff); background: rgba(124, 92, 255, .1); }
.scope-opt input { display: none; }
.scope-opt b { font-size: .85rem; }
.scope-opt small { color: var(--muted); font-size: .72rem; line-height: 1.35; }

.key-row {
  display: flex;
  align-items: center;
  gap: .6rem;
  padding: .6rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, .05);
}
.key-row .ops { display: flex; gap: .3rem; flex: 0 0 auto; }
.scope-pill { background: rgba(124, 92, 255, .16); color: #c4b5fd; font-size: .68rem; }
@media (max-width: 640px) {
  .key-row { flex-wrap: wrap; }
  .key-row .ops { width: 100%; }
}
</style>
