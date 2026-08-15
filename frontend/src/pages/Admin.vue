<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api, absUrl, ensureSite, fmtDur, fmtSize, state, type VideoItem, type Visibility } from '../api'
import { locale, t, tLog } from '../i18n'
import { linkFor } from '../links'
import ShareBox from '../components/ShareBox.vue'
import { toast } from '../toast'

const router = useRouter()
const tab = ref<'dash' | 'videos' | 'users' | 'security' | 'settings'>('dash')

// ================= dashboard =================
interface AdminStats {
  total: number; totalSize: number; views: number; users: number; banned: number
  recycled: number; todayUploads: number
  byDay: { date: string; count: number; size: number }[]
  topIps: { ip: string; region: string; c: number }[]
}
const stats = ref<AdminStats | null>(null)
interface Job { id: string; name: string; type: string; status: string; msg: string; created: string }
const jobs = ref<Job[]>([])
const ffmpegOk = ref<boolean | null>(null)

async function loadDash() {
  const [s, j, c] = await Promise.all([
    api('/api/admin/stats'), api('/api/admin/jobs'), api('/api/admin/check'),
  ])
  if (s.status === 401 || s.status === 403) { router.push('/login'); return }
  stats.value = await s.json()
  jobs.value = await j.json()
  ffmpegOk.value = (await c.json()).ffmpeg
}

// ================= videos =================
const videos = ref<VideoItem[]>([])
const vTotal = ref(0)
const vPage = ref(1)
const vQ = ref('')
const vStatus = ref('')
const vSize = 15

async function loadVideos() {
  const res = await api(`/api/videos?all=1&page=${vPage.value}&size=${vSize}&q=${encodeURIComponent(vQ.value)}&status=${vStatus.value}`)
  if (!res.ok) return
  const j = await res.json()
  videos.value = j.items || []
  vTotal.value = j.total || 0
}
watch([tab, vPage, vStatus], () => { if (tab.value === 'videos') loadVideos() })
let vDeb: number | undefined
watch(vQ, () => { clearTimeout(vDeb); vDeb = window.setTimeout(() => { vPage.value = 1; loadVideos() }, 350) })

const statusPill = (s: string) =>
  s === 'ok' ? t('s.ok') : s === 'processing' ? t('s.processing') : s === 'banned' ? t('s.banned') : t('s.recycled')

async function videoAction(v: VideoItem, action: string, confirmText?: string) {
  if (confirmText && !confirm(confirmText)) return
  const method = action === 'delete' || action === 'force' ? 'DELETE' : 'POST'
  const suffix = action === 'delete' ? '' : `/${action}`
  const res = await api(`/api/videos/${v.name}${suffix}`, { method })
  if (res.ok) { toast(t('c.ok')); loadVideos() } else toast(t('c.failed'), false)
}
const copy = async (text: string) => { await navigator.clipboard.writeText(text); toast(t('c.copied')) }

const openShare = ref('')
const toggleShare = (name: string) => { openShare.value = openShare.value === name ? '' : name }

// ================= users =================
interface User { id: number; username: string; role: string; status: string; daily_limit: number; created: string; videos: number; used: number }
const users = ref<User[]>([])
const nu = ref({ username: '', password: '', role: 'uploader', daily_limit: 0 })

async function loadUsers() { users.value = await (await api('/api/admin/users')).json() }
async function createUser() {
  const res = await api('/api/admin/users', { method: 'POST', body: JSON.stringify(nu.value) })
  const j = await res.json().catch(() => ({}))
  if (res.ok) { toast(t('ad.userCreated')); nu.value = { username: '', password: '', role: 'uploader', daily_limit: 0 }; loadUsers() }
  else toast(j.error || t('ad.createFailed'), false)
}
async function patchUser(u: User, patch: Record<string, unknown>, msg: string) {
  const res = await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  if (res.ok) { toast(msg + ' ✓'); loadUsers() } else toast(t('c.failed'), false)
}
async function resetPwd(u: User) {
  const p = prompt(t('ad.resetPwPrompt', u.username))
  if (p) patchUser(u, { password: p }, t('ad.pwReset'))
}
async function delUser(u: User) {
  if (!confirm(t('ad.confirmDelUser', u.username))) return
  const res = await api(`/api/admin/users/${u.id}`, { method: 'DELETE' })
  if (res.ok) { toast(t('ad.deleted')); loadUsers() } else toast((await res.json()).error || t('ad.delFailed'), false)
}

// ================= security =================
interface IpRule { id: number; ip: string; note: string }
const ipRules = ref<IpRule[]>([])
const newRule = ref({ ip: '', note: '' })
interface HashBlack { sha256: string; note: string }
const hashBlack = ref<HashBlack[]>([])
const newHash = ref({ sha256: '', note: '' })
interface Log { id: number; time: string; ip: string; region: string; username: string; orig: string; size: number; status: string; msg: string }
const logs = ref<Log[]>([])
const logTotal = ref(0)
const logPage = ref(1)
const logIp = ref('')

async function loadSecurity() {
  ipRules.value = await (await api('/api/admin/iprules')).json()
  hashBlack.value = await (await api('/api/admin/hashblack')).json()
  loadLogs()
}
async function loadLogs() {
  const res = await api(`/api/admin/logs?page=${logPage.value}&size=30&ip=${encodeURIComponent(logIp.value)}`)
  const j = await res.json()
  logs.value = j.items || []
  logTotal.value = j.total || 0
}
watch(logPage, () => { if (tab.value === 'security') loadLogs() })
async function addRule() {
  await api('/api/admin/iprules', { method: 'POST', body: JSON.stringify(newRule.value) })
  newRule.value = { ip: '', note: '' }; loadSecurity(); toast(t('ad.added'))
}
async function delRule(r: IpRule) { await api(`/api/admin/iprules/${r.id}`, { method: 'DELETE' }); loadSecurity() }
async function addHash() {
  const res = await api('/api/admin/hashblack', { method: 'POST', body: JSON.stringify(newHash.value) })
  if (res.ok) { newHash.value = { sha256: '', note: '' }; loadSecurity(); toast(t('ad.added')) }
  else toast((await res.json()).error || t('ad.badFormat'), false)
}
async function delHash(h: HashBlack) { await api(`/api/admin/hashblack/${h.sha256}`, { method: 'DELETE' }); loadSecurity() }

// ================= settings =================
const settings = ref<Record<string, any>>({})
const saving = ref(false)
async function loadSettings() { settings.value = await (await api('/api/admin/settings')).json() }
async function saveSettings() {
  saving.value = true
  const res = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings.value) })
  saving.value = false
  if (res.ok) toast(t('ad.saved'))
  else toast(t('ad.saveFailed'), false)
}

function reload(which = tab.value) {
  if (which === 'dash') loadDash()
  if (which === 'videos') loadVideos()
  if (which === 'users') loadUsers()
  if (which === 'security') loadSecurity()
  if (which === 'settings') loadSettings()
}
watch(tab, reload)
watch(locale, () => reload())        // pull server-rendered strings in the new language

async function setVideoVisibility(v: VideoItem, vis: Visibility) {
  const res = await api(`/api/videos/${v.name}`, { method: 'PATCH', body: JSON.stringify({ visibility: vis }) })
  if (res.ok) { v.visibility = vis; toast(t('vis.changed')) } else toast(t('c.failed'), false)
}

onMounted(async () => {
  await ensureSite()                       // no race: resolves once /api/me has answered
  if (state.me?.role !== 'admin') { router.push('/login'); return }
  loadDash()
})
</script>

<template>
  <div class="fade-up">
    <h1 style="margin:.5rem 0 1.2rem;font-size:1.3rem">{{ t('ad.title') }}</h1>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'dash' }" @click="tab = 'dash'">{{ t('ad.tabDash') }}</button>
      <button class="tab" :class="{ on: tab === 'videos' }" @click="tab = 'videos'">{{ t('ad.tabVideos') }}</button>
      <button class="tab" :class="{ on: tab === 'users' }" @click="tab = 'users'">{{ t('ad.tabUsers') }}</button>
      <button class="tab" :class="{ on: tab === 'security' }" @click="tab = 'security'">{{ t('ad.tabSecurity') }}</button>
      <button class="tab" :class="{ on: tab === 'settings' }" @click="tab = 'settings'">{{ t('ad.tabSettings') }}</button>
    </div>

    <!-- ============ 概览 ============ -->
    <template v-if="tab === 'dash'">
      <div v-if="ffmpegOk === false" class="notice-banner">
        {{ t('ad.noFfmpeg') }}
      </div>
      <div class="stat-grid">
        <div class="glass-card stat-card"><b>{{ stats?.total ?? '—' }}</b><span>{{ t('ad.statVideos') }}</span></div>
        <div class="glass-card stat-card"><b>{{ stats ? fmtSize(stats.totalSize) : '—' }}</b><span>{{ t('ad.statStorage') }}</span></div>
        <div class="glass-card stat-card"><b>{{ stats?.views ?? '—' }}</b><span>{{ t('ad.statPlays') }}</span></div>
        <div class="glass-card stat-card"><b>{{ stats?.todayUploads ?? '—' }}</b><span>{{ t('ad.statToday') }}</span></div>
        <div class="glass-card stat-card"><b>{{ stats?.users ?? '—' }}</b><span>{{ t('ad.statUsers') }}</span></div>
        <div class="glass-card stat-card"><b style="color:var(--red)">{{ stats?.banned ?? '—' }}</b><span>{{ t('ad.statBanned') }}</span></div>
      </div>

      <div class="glass-card" style="padding:1rem 1.2rem;margin-bottom:1rem">
        <h3 style="margin:0 0 .6rem;font-size:.95rem">{{ t('ad.topIps') }}</h3>
        <table class="tbl">
          <thead><tr><th>IP</th><th>{{ t('ad.region') }}</th><th>{{ t('ad.count') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in stats?.topIps || []" :key="r.ip"><td class="mono">{{ r.ip }}</td><td>{{ r.region || '—' }}</td><td>{{ r.c }}</td></tr>
            <tr v-if="!stats?.topIps?.length"><td colspan="3" class="muted">{{ t('ad.noUploadsToday') }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="glass-card" style="padding:1rem 1.2rem">
        <h3 style="margin:0 0 .6rem;font-size:.95rem">{{ t('ad.queue') }}</h3>
        <table class="tbl">
          <thead><tr><th>{{ t('ad.file') }}</th><th>{{ t('ad.type') }}</th><th>{{ t('ad.status') }}</th><th>{{ t('ad.info') }}</th><th>{{ t('ad.time') }}</th></tr></thead>
          <tbody>
            <tr v-for="j in jobs" :key="j.id">
              <td class="mono">{{ j.name }}</td><td>{{ j.type }}</td>
              <td><span class="pill" :class="j.status === 'done' ? 'ok' : j.status === 'failed' ? 'banned' : 'processing'">{{ j.status }}</span></td>
              <td class="muted2">{{ tLog(j.msg) }}</td><td class="muted2">{{ j.created.slice(5, 16) }}</td>
            </tr>
            <tr v-if="!jobs.length"><td colspan="5" class="muted">{{ t('ad.noJobs') }}</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 视频 ============ -->
    <template v-if="tab === 'videos'">
      <div class="row" style="margin-bottom:.9rem">
        <input v-model="vQ" :placeholder="t('exp.searchPlaceholder')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none" />
        <select v-model="vStatus" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none">
          <option value="">{{ t('ad.allStatus') }}</option><option value="ok">{{ t('s.ok') }}</option>
          <option value="processing">{{ t('s.processing') }}</option><option value="banned">{{ t('s.banned') }}</option>
        </select>
      </div>
      <div class="glass-card" style="padding:.6rem 1rem;overflow-x:auto">
        <table class="tbl">
          <thead><tr><th>{{ t('ad.preview') }}</th><th>{{ t('ad.name') }}</th><th class="hide-m">{{ t('ad.sizeDur') }}</th><th class="hide-m">{{ t('ad.uploader') }}</th><th class="hide-m">IP</th><th>{{ t('ad.status') }}</th><th>{{ t('ad.visibility') }}</th><th>{{ t('ad.play') }}</th><th>{{ t('ad.actions') }}</th></tr></thead>
          <tbody>
            <template v-for="v in videos" :key="v.name">
            <tr>
              <td><img class="thumb-mini" :src="v.thumb" @error="($event.target as HTMLImageElement).style.visibility = 'hidden'" /></td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                <a :href="v.player" target="_blank">{{ v.orig || v.name }}</a>
                <div class="muted2">{{ v.uploaded.slice(0, 10) }}</div>
              </td>
              <td class="hide-m">{{ fmtSize(v.size) }}<template v-if="v.duration"> · {{ fmtDur(v.duration) }}</template>
                <div v-if="v.width" class="muted2">{{ v.width }}×{{ v.height }}</div></td>
              <td class="hide-m">{{ v.username }}</td>
              <td class="hide-m"><span class="mono">{{ v.ip }}</span><div class="muted2">{{ v.ip_region }}</div></td>
              <td><span class="pill" :class="v.status">{{ statusPill(v.status) }}</span>
                <div v-if="v.mod_score >= 0" class="muted2">{{ t('ad.modScore', Math.round(v.mod_score * 100)) }}</div></td>
              <td>
                <button
                  class="pill vis-pill" :class="v.visibility"
                  :title="v.visibility === 'public' ? t('vis.makePrivate') : t('vis.makePublic')"
                  @click="setVideoVisibility(v, v.visibility === 'public' ? 'private' : 'public')"
                >{{ v.visibility === 'public' ? '🌐 ' + t('vis.public') : '🔒 ' + t('vis.private') }}</button>
              </td>
              <td>{{ v.views }}</td>
              <td style="white-space:nowrap">
                <button class="btn ghost sm" @click="copy(linkFor(v, 'direct'))">{{ t('tab.direct') }}</button>
                <button class="btn ghost sm" @click="toggleShare(v.name)">{{ t('c.share') }} {{ openShare === v.name ? '▾' : '▸' }}</button>
                <button v-if="v.status !== 'banned'" class="btn ghost sm" @click="videoAction(v, 'ban', t('ad.confirmBan', v.orig))">{{ t('ad.quarantine') }}</button>
                <button v-else class="btn ghost sm" @click="videoAction(v, 'unban')">{{ t('ad.unquarantine') }}</button>
                <button class="btn danger sm" @click="videoAction(v, 'delete', t('ad.confirmDelete', v.orig))">{{ t('c.delete') }}</button>
              </td>
            </tr>
            <tr v-if="openShare === v.name">
              <td colspan="9" style="padding:0 .4rem"><ShareBox :item="v" /></td>
            </tr>
            </template>
          </tbody>
        </table>
        <p v-if="!videos.length" class="muted" style="text-align:center;padding:1.4rem 0">{{ t('ad.noVideos') }}</p>
      </div>
      <div v-if="Math.ceil(vTotal / vSize) > 1" class="pager">
        <button class="btn ghost sm" :disabled="vPage <= 1" @click="vPage--">{{ t('c.prev') }}</button>
        <span>{{ vPage }} / {{ Math.ceil(vTotal / vSize) }}</span>
        <button class="btn ghost sm" :disabled="vPage >= Math.ceil(vTotal / vSize)" @click="vPage++">{{ t('c.next') }}</button>
      </div>
    </template>

    <!-- ============ 用户 ============ -->
    <template v-if="tab === 'users'">
      <div class="glass-card" style="padding:1.2rem;margin-bottom:1rem">
        <h3 style="margin-top:0">{{ t('ad.createUser') }} <span class="muted2">— {{ t('ad.createUserHint') }}</span></h3>
        <div class="form-grid">
          <div class="field"><label>{{ t('lg.username') }}</label><input v-model="nu.username" /></div>
          <div class="field"><label>{{ t('lg.password') }}</label><input v-model="nu.password" type="password" /></div>
          <div class="field"><label>{{ t('ad.role') }}</label>
            <select v-model="nu.role"><option value="uploader">{{ t('ad.roleUploader') }}</option><option value="admin">{{ t('ad.roleAdmin') }}</option></select></div>
          <div class="field"><label>{{ t('ad.dailyLimit') }}</label><input v-model.number="nu.daily_limit" type="number" min="0" /></div>
        </div>
        <button class="btn sm" @click="createUser">{{ t('c.create') }}</button>
      </div>
      <div class="glass-card" style="padding:.6rem 1rem;overflow-x:auto">
        <table class="tbl">
          <thead><tr><th>ID</th><th>{{ t('lg.username') }}</th><th>{{ t('ad.role') }}</th><th>{{ t('ad.status') }}</th><th class="hide-m">{{ t('ad.videos') }}</th><th class="hide-m">{{ t('ad.used') }}</th><th class="hide-m">{{ t('ad.limit') }}</th><th>{{ t('ad.actions') }}</th></tr></thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>{{ u.id }}</td><td><b>{{ u.username }}</b></td>
              <td><span class="pill" :class="'role-' + u.role">{{ u.role === 'admin' ? t('ad.roleAdmin') : t('ad.roleUploader') }}</span></td>
              <td><span class="pill" :class="u.status === 'active' ? 'ok' : 'banned'">{{ u.status === 'active' ? t('ad.active') : t('ad.inactive') }}</span></td>
              <td class="hide-m">{{ u.videos }}</td><td class="hide-m">{{ fmtSize(u.used) }}</td><td class="hide-m">{{ u.daily_limit || t('c.none') }}</td>
              <td style="white-space:nowrap">
                <button class="btn ghost sm" @click="patchUser(u, { status: u.status === 'active' ? 'disabled' : 'active' }, u.status === 'active' ? t('ad.disabled') : t('ad.enabled'))">
                  {{ u.status === 'active' ? t('ad.disable') : t('ad.enable') }}</button>
                <button class="btn ghost sm" @click="patchUser(u, { role: u.role === 'admin' ? 'uploader' : 'admin' }, t('ad.roleSwitched'))">
                  {{ u.role === 'admin' ? t('ad.demote') : t('ad.promote') }}</button>
                <button class="btn ghost sm" @click="resetPwd(u)">{{ t('ad.resetPw') }}</button>
                <button class="btn danger sm" @click="delUser(u)">{{ t('c.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 安全 ============ -->
    <template v-if="tab === 'security'">
      <div class="glass-card" style="padding:1.2rem;margin-bottom:1rem">
        <h3 style="margin-top:0">{{ t('ad.ipRules') }} <span class="muted2">— {{ t('ad.ipRulesHint') }}</span></h3>
        <div class="row" style="margin-bottom:.8rem">
          <input v-model="newRule.ip" :placeholder="t('ad.ipOrRange')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none" />
          <input v-model="newRule.note" :placeholder="t('ad.note')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none;flex:1" />
          <button class="btn sm" @click="addRule">{{ t('ad.add') }}</button>
        </div>
        <table class="tbl">
          <tbody>
            <tr v-for="r in ipRules" :key="r.id"><td class="mono">{{ r.ip }}</td><td>{{ r.note }}</td>
              <td style="text-align:right"><button class="btn danger sm" @click="delRule(r)">{{ t('c.delete') }}</button></td></tr>
            <tr v-if="!ipRules.length"><td class="muted">{{ t('ad.noRules') }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="glass-card" style="padding:1.2rem;margin-bottom:1rem">
        <h3 style="margin-top:0">{{ t('ad.hashBlack') }} <span class="muted2">— {{ t('ad.hashBlackHint') }}</span></h3>
        <div class="row" style="margin-bottom:.8rem">
          <input v-model="newHash.sha256" :placeholder="t('ad.hashPlaceholder')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none;flex:1" />
          <input v-model="newHash.note" :placeholder="t('ad.note')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none;width:180px" />
          <button class="btn sm" @click="addHash">{{ t('ad.add') }}</button>
        </div>
        <table class="tbl">
          <tbody>
            <tr v-for="h in hashBlack" :key="h.sha256"><td class="mono">{{ h.sha256.slice(0, 24) }}…</td><td>{{ h.note }}</td>
              <td style="text-align:right"><button class="btn danger sm" @click="delHash(h)">{{ t('c.delete') }}</button></td></tr>
            <tr v-if="!hashBlack.length"><td class="muted">{{ t('ad.noRecords') }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="glass-card" style="padding:1.2rem">
        <h3 style="margin-top:0">{{ t('ad.logs') }} <span class="muted2">— {{ t('ad.logsHint') }}</span></h3>
        <div class="row" style="margin-bottom:.8rem">
          <input v-model="logIp" :placeholder="t('ad.filterByIp')" @keyup.enter="logPage = 1; loadLogs()" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none" />
          <button class="btn ghost sm" @click="logPage = 1; loadLogs()">{{ t('ad.query') }}</button>
        </div>
        <div style="overflow-x:auto">
          <table class="tbl">
            <thead><tr><th>{{ t('ad.time') }}</th><th>IP</th><th>{{ t('ad.region') }}</th><th>{{ t('ad.user') }}</th><th>{{ t('ad.file') }}</th><th class="hide-m">{{ t('ad.size') }}</th><th>{{ t('ad.result') }}</th></tr></thead>
            <tbody>
              <tr v-for="l in logs" :key="l.id">
                <td class="muted2" style="white-space:nowrap">{{ l.time.slice(5, 19).replace('T', ' ') }}</td>
                <td class="mono">{{ l.ip }}</td><td>{{ l.region || '—' }}</td><td>{{ l.username || 'guest' }}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ l.orig || l.name }}
                  <div v-if="l.msg" class="muted2">{{ tLog(l.msg) }}</div></td>
                <td class="hide-m">{{ fmtSize(l.size) }}</td>
                <td><span class="pill" :class="l.status === 'ok' ? 'ok' : l.status === 'banned' ? 'banned' : 'processing'">{{ l.status }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="Math.ceil(logTotal / 30) > 1" class="pager">
          <button class="btn ghost sm" :disabled="logPage <= 1" @click="logPage--">{{ t('c.prev') }}</button>
          <span>{{ logPage }} / {{ Math.ceil(logTotal / 30) }}</span>
          <button class="btn ghost sm" :disabled="logPage >= Math.ceil(logTotal / 30)" @click="logPage++">{{ t('c.next') }}</button>
        </div>
      </div>
    </template>

    <!-- ============ 设置 ============ -->
    <template v-if="tab === 'settings'">
      <div class="glass-card" style="padding:1.2rem 1.4rem">

        <div class="set-section">
          <h3>{{ t('set.site') }}</h3>
          <div class="form-grid">
            <div class="field"><label>{{ t('set.siteTitle') }}</label><input v-model="settings.title" /></div>
            <div class="field"><label>{{ t('set.keywords') }}</label><input v-model="settings.keywords" /></div>
            <div class="field"><label>{{ t('set.tips') }}</label><input v-model="settings.tips" /></div>
            <div class="field"><label>{{ t('set.domain') }}</label><input v-model="settings.domain" placeholder="https://v.example.com" /></div>
          </div>
          <div class="field"><label>{{ t('set.description') }}</label><input v-model="settings.description" /></div>
          <label class="switch"><input type="checkbox" v-model="settings.notice_status" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.noticeOn') }}</span></label>
          <div class="field" v-if="settings.notice_status"><textarea v-model="settings.notice" placeholder="支持 HTML"></textarea></div>
        </div>

        <div class="set-section">
          <h3>{{ t('set.register') }}</h3>
          <div class="row" style="margin-bottom:.9rem;gap:1.4rem">
            <label class="switch"><input type="checkbox" v-model="settings.allow_register" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.allowRegister') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.register_captcha" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.registerCaptcha') }}</span></label>
          </div>
          <div class="form-grid" v-if="settings.allow_register">
            <div class="field"><label>{{ t('set.registerLimit') }}</label><input v-model.number="settings.register_daily_limit" type="number" min="0" /></div>
            <div class="field"><label>{{ t('set.registerRate') }}</label><input v-model.number="settings.register_rate_limit" type="number" min="1" /></div>
            <div class="field"><label>{{ t('set.defaultVisibility') }}</label><select v-model="settings.default_visibility"><option value="public">{{ t('vis.public') }}</option><option value="private">{{ t('vis.private') }}</option></select></div>
          </div>
          <p class="hint">{{ t('set.registerNote') }}</p>
          <p class="hint" v-if="settings.allow_register && !settings.register_captcha">
            {{ t('set.registerNoCaptcha') }}
          </p>
        </div>

        <div class="set-section">
          <h3>{{ t('set.upload') }}</h3>
          <div class="row" style="margin-bottom:.9rem;gap:1.4rem">
            <label class="switch"><input type="checkbox" v-model="settings.must_login" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.mustLogin') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.allow_guest" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.allowGuest') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.allow_images" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.allowImages') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.allow_other" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.allowOther') }}</span></label>
          </div>
          <div class="form-grid">
            <div class="field"><label>{{ t('set.maxSize') }}</label><input v-model.number="settings.max_size_mb" type="number" min="1" /></div>
            <div class="field"><label>{{ t('set.maxFiles') }}</label><input v-model.number="settings.max_upload_files" type="number" min="1" /></div>
            <div class="field"><label>{{ t('set.perIpDay') }}</label><input v-model.number="settings.daily_limit_ip" type="number" min="0" /></div>
            <div class="field"><label>{{ t('set.perUserDay') }}</label><input v-model.number="settings.daily_limit_user" type="number" min="0" /></div>
            <div class="field"><label>{{ t('set.storageQuota') }}</label><input v-model.number="settings.storage_quota_gb" type="number" min="0" step="0.1" /></div>
          </div>
          <p class="hint" v-if="settings.allow_other">
            {{ t('set.allowOtherWarn') }}
          </p>
          <div class="field"><label>{{ t('set.extensions') }}</label><input v-model="settings.extensions" /><span class="hint">{{ t('set.extensionsHint') }}</span></div>
        </div>

        <div class="set-section">
          <h3>{{ t('set.transcode') }} <span class="muted2">(ffmpeg)</span></h3>
          <div class="row" style="margin-bottom:.9rem;gap:1.4rem">
            <label class="switch"><input type="checkbox" v-model="settings.process_enabled" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.processEnabled') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.compress" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.compress') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.thumbnail" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.thumbnail') }}</span></label>
          </div>
          <div class="form-grid">
            <div class="field"><label>{{ t('set.convertTo') }}</label>
              <select v-model="settings.convert_to"><option value="">{{ t('set.keepFormat') }}</option><option value="mp4">MP4 (H.264)</option><option value="webm">WebM (VP9)</option></select></div>
            <div class="field"><label>{{ t('set.crf') }}</label><input v-model.number="settings.crf" type="number" min="18" max="35" /></div>
            <div class="field"><label>{{ t('set.maxWidth') }}</label><input v-model.number="settings.max_width" type="number" min="0" /></div>
            <div class="field"><label>{{ t('set.maxHeight') }}</label><input v-model.number="settings.max_height" type="number" min="0" /></div>
            <div class="field"><label>{{ t('set.minWidth') }}</label><input v-model.number="settings.min_width" type="number" min="0" /></div>
            <div class="field"><label>{{ t('set.minHeight') }}</label><input v-model.number="settings.min_height" type="number" min="0" /></div>
          </div>
          <div class="row" style="gap:1.4rem">
            <label class="switch"><input type="checkbox" v-model="settings.resize_enabled" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.forceSize') }}</span></label>
            <template v-if="settings.resize_enabled">
              <div class="field" style="width:120px"><label>{{ t('set.width') }}</label><input v-model.number="settings.resize_w" type="number" min="0" /></div>
              <div class="field" style="width:120px"><label>{{ t('set.heightAuto') }}</label><input v-model.number="settings.resize_h" type="number" min="0" /></div>
            </template>
          </div>
        </div>

        <div class="set-section">
          <h3>{{ t('set.watermark') }}</h3>
          <div class="row" style="gap:1.4rem;margin-bottom:.9rem">
            <div class="field" style="width:180px"><label>{{ t('set.wmMode') }}</label>
              <select v-model.number="settings.watermark"><option :value="0">{{ t('set.wmOff') }}</option><option :value="1">{{ t('set.wmText') }}</option><option :value="2">{{ t('set.wmImage') }}</option></select></div>
            <div class="field" v-if="settings.watermark === 1" style="flex:1"><label>{{ t('set.wmContent') }}</label><input v-model="settings.water_text" /></div>
            <div class="field" v-if="settings.watermark === 1" style="width:140px"><label>{{ t('set.wmSize') }}</label><input v-model.number="settings.water_size" type="number" min="8" max="80" /></div>
            <div class="field" v-if="settings.watermark" style="width:140px"><label>{{ t('set.wmPos') }}</label><input v-model.number="settings.water_position" type="number" min="1" max="9" /></div>
          </div>
          <div class="row" v-if="settings.watermark === 2" style="gap:1.4rem">
            <div class="field" style="width:200px"><label>{{ t('set.wmOpacity') }}</label>
              <input v-model.number="settings.water_opacity" type="number" min="0" max="1" step="0.05" /></div>
          </div>
          <p class="hint" v-if="settings.watermark === 2">{{ t('set.wmImageHint') }}</p>
        </div>

        <div class="set-section">
          <h3>{{ t('set.moderation') }}</h3>
          <div class="form-grid">
            <div class="field"><label>{{ t('set.modMode') }}</label>
              <select v-model.number="settings.check_img">
                <option :value="0">{{ t('set.wmOff') }}</option>
                <option :value="1">{{ t('set.modLocal') }}</option>
                <option :value="2">{{ t('set.modApi') }}</option>
              </select></div>
            <div class="field"><label>{{ t('set.modThreshold') }}</label><input v-model.number="settings.check_img_value" type="number" min="5" max="95" /></div>
            <div class="field"><label>{{ t('set.modAction') }}</label>
              <select v-model="settings.check_action"><option value="ban">{{ t('set.modBan') }}</option><option value="delete">{{ t('set.modDelete') }}</option></select></div>
          </div>
          <template v-if="settings.check_img === 2">
            <div class="field"><label>{{ t('set.modApiUrl') }}</label><input v-model="settings.check_api_url" placeholder="POST {name,url,type} → {score:0..1}" /></div>
            <div class="field"><label>{{ t('set.modApiKey') }}</label><input v-model="settings.check_api_key" type="password" /></div>
          </template>
        </div>

        <div class="set-section">
          <h3>{{ t('set.security') }}</h3>
          <div class="form-grid">
            <div class="field"><label>{{ t('set.ipMode') }}</label>
              <select v-model.number="settings.check_ip"><option :value="0">{{ t('set.wmOff') }}</option><option :value="1">{{ t('set.ipBlack') }}</option><option :value="2">{{ t('set.ipWhite') }}</option></select></div>
            <div class="field"><label>{{ t('set.loginRate') }}</label><input v-model.number="settings.login_rate_limit" type="number" min="1" /></div>
          </div>
          <div class="row" style="gap:1.4rem;margin-bottom:.9rem">
            <label class="switch"><input type="checkbox" v-model="settings.upload_logs" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.uploadLogs') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.ip_locate" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.ipLocate') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.hash_black" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.hashBlack') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.anti_leech" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.antiLeech') }}</span></label>
          </div>
          <template v-if="settings.anti_leech">
            <div class="field"><label>{{ t('set.leechHosts') }}</label><input v-model="settings.leech_hosts" placeholder="example.com,blog.example.com" /></div>
            <label class="switch"><input type="checkbox" v-model="settings.leech_allow_empty" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.leechAllowEmpty') }}</span></label>
            <p class="hint">{{ t('set.leechHint') }}</p>
          </template>
        </div>

        <div class="set-section">
          <h3>{{ t('set.portal') }}</h3>
          <div class="row" style="gap:1.4rem;margin-bottom:.9rem">
            <label class="switch"><input type="checkbox" v-model="settings.explore_public" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.explorePublic') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.explore_images" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.exploreImages') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.stats_public" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.statsPublic') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.ad_top" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.adTop') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.ad_bot" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.adBot') }}</span></label>
            <label class="switch"><input type="checkbox" v-model="settings.player_ad" :true-value="1" :false-value="0" /><span class="knob" /><span class="sw-label">{{ t('set.adPlayer') }}</span></label>
          </div>
          <div class="field" v-if="settings.ad_top"><label>{{ t('set.adTopHtml') }}</label><textarea v-model="settings.ad_top_info"></textarea></div>
          <div class="field" v-if="settings.ad_bot"><label>{{ t('set.adBotHtml') }}</label><textarea v-model="settings.ad_bot_info"></textarea></div>
          <div class="field" v-if="settings.player_ad"><label>{{ t('set.adPlayerHtml') }} <span class="muted2">{{ t('set.adPlayerHint') }}</span></label><textarea v-model="settings.player_ad_info"></textarea></div>
        </div>

        <div class="set-section">
          <h3>{{ t('set.customCode') }}</h3>
          <div class="field"><label>{{ t('set.customHead') }}</label><textarea v-model="settings.custom_head" placeholder="<style>…</style>"></textarea></div>
          <div class="field"><label>{{ t('set.footerCode') }}</label><textarea v-model="settings.footer_code" placeholder="<script>…"></textarea></div>
        </div>

        <div class="row" style="position:sticky;bottom:12px;background:var(--glass-bg-strong);padding:.8rem;border-radius:12px;border:1px solid var(--glass-border)">
          <button class="btn" :disabled="saving" @click="saveSettings">{{ saving ? t('ad.saving') : t('ad.saveAll') }}</button>
          <span class="muted2">{{ t('ad.savedHint') }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
