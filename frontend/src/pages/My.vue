<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api, absUrl, ensureSite, fmtDur, fmtSize, state, type VideoItem, type Visibility } from '../api'
import { locale, t } from '../i18n'
import { linkFor } from '../links'
import ShareBox from '../components/ShareBox.vue'
import { toast } from '../toast'

const router = useRouter()
const tab = ref<'videos' | 'recycle' | 'keys' | 'account'>('videos')

// videos
const videos = ref<VideoItem[]>([])
const total = ref(0)
const pageNum = ref(1)
const q = ref('')
const size = 12

async function load() {
  const isRecycle = tab.value === 'recycle'
  const path = isRecycle
    ? `/api/recycle?page=${pageNum.value}&size=${size}`
    : `/api/videos?page=${pageNum.value}&size=${size}&q=${encodeURIComponent(q.value)}`
  const res = await api(path)
  if (res.status === 401) { router.push('/login'); return }
  const j = await res.json()
  videos.value = j.items || []
  total.value = j.total || 0
}
watch([tab, pageNum], load)
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

async function toggleVisibility(v: VideoItem) {
  const next: Visibility = v.visibility === 'public' ? 'private' : 'public'
  const res = await api(`/api/videos/${v.name}`, {
    method: 'PATCH',
    body: JSON.stringify({ visibility: next }),
  })
  if (res.ok) { v.visibility = next; toast(t('vis.changed')) } else toast(t('c.failed'), false)
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
interface ApiKey { key: string; name: string; status: string; created: string }
const keys = ref<ApiKey[]>([])
const keyName = ref('')
async function loadKeys() { keys.value = await (await api('/api/me/keys')).json() }
async function addKey() {
  const res = await api('/api/me/keys', { method: 'POST', body: JSON.stringify({ name: keyName.value }) })
  if (res.ok) { keyName.value = ''; loadKeys(); toast(t('my.keyCreated')) }
}
async function delKey(k: ApiKey) {
  if (!confirm(t('my.keyConfirmDelete', k.name || k.key.slice(0, 12) + '…'))) return
  await api(`/api/me/keys/${k.key}`, { method: 'DELETE' })
  loadKeys()
}

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
      <button class="tab" :class="{ on: tab === 'keys' }" @click="tab = 'keys'">{{ t('my.tabKeys') }}</button>
      <button class="tab" :class="{ on: tab === 'account' }" @click="tab = 'account'">{{ t('my.tabAccount') }}</button>
    </div>

    <template v-if="tab === 'videos' || tab === 'recycle'">
      <div class="row" style="margin-bottom:.9rem" v-if="tab === 'videos'">
        <input v-model="q" :placeholder="t('my.searchMine')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none" />
      </div>
      <div class="glass-card" style="padding:.4rem 1.2rem">
        <div v-if="videos.length === 0" class="muted" style="text-align:center;padding:2rem 0">{{ t('c.empty') }}</div>
        <template v-for="v in videos" :key="v.name">
        <div class="vrow">
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
          </div>
          <span class="pill" :class="v.status">{{ statusPill(v.status) }}</span>
          <button
            v-if="tab === 'videos'"
            class="pill vis-pill" :class="v.visibility"
            :title="v.visibility === 'public' ? t('vis.makePrivate') : t('vis.makePublic')"
            @click="toggleVisibility(v)"
          >{{ v.visibility === 'public' ? '🌐 ' + t('vis.public') : '🔒 ' + t('vis.private') }}</button>
          <div class="ops">
            <template v-if="tab === 'videos'">
              <button class="btn ghost sm" @click="copy(linkFor(v, 'direct'))">{{ t('tab.direct') }}</button>
              <button class="btn ghost sm" :class="{ on: openShare === v.name }" @click="toggleShare(v.name)">
                {{ t('c.share') }} {{ openShare === v.name ? '▾' : '▸' }}
              </button>
              <button class="btn danger sm" @click="del(v)">{{ t('c.delete') }}</button>
            </template>
            <template v-else>
              <button class="btn ghost sm" @click="restore(v)">{{ t('c.restore') }}</button>
              <button class="btn danger sm" @click="forceDel(v)">{{ t('my.forceDelete') }}</button>
            </template>
          </div>
        </div>
        <ShareBox v-if="tab === 'videos' && openShare === v.name" :item="v" />
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
        <div class="row" style="margin-bottom:1rem">
          <input v-model="keyName" :placeholder="t('my.keyName')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none;flex:1" />
          <button class="btn sm" @click="addKey">{{ t('c.create') }}</button>
        </div>
        <div v-for="k in keys" :key="k.key" class="row" style="padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,.05)">
          <div class="grow">
            <div>{{ k.name || t('my.unnamed') }} <span class="muted2">{{ k.created.slice(0, 10) }}</span></div>
            <div class="mono muted2">{{ k.key }}</div>
          </div>
          <button class="btn ghost sm" @click="copy(k.key)">{{ t('c.copy') }}</button>
          <button class="btn danger sm" @click="delKey(k)">{{ t('c.delete') }}</button>
        </div>
        <p v-if="keys.length === 0" class="muted">{{ t('my.noKeys') }}</p>
      </div>
    </template>

    <template v-if="tab === 'account'">
      <div class="glass-card" style="padding:1.2rem;max-width:560px;margin-bottom:1rem">
        <h3 style="margin-top:0">{{ t('my.preferences') }}</h3>
        <div class="field">
          <label>{{ t('vis.default') }} <span class="muted2">— {{ t('vis.defaultHint') }}</span></label>
          <div class="vis-choice">
            <button
              class="vis-btn" :class="{ on: state.me?.default_visibility !== 'private' }"
              :disabled="savingPref" @click="setDefaultVisibility('public')"
            ><b>🌐 {{ t('vis.public') }}</b><small>{{ t('vis.publicHint') }}</small></button>
            <button
              class="vis-btn" :class="{ on: state.me?.default_visibility === 'private' }"
              :disabled="savingPref" @click="setDefaultVisibility('private')"
            ><b>🔒 {{ t('vis.private') }}</b><small>{{ t('vis.privateHint') }}</small></button>
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
</style>
