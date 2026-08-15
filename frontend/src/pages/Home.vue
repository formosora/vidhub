<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from '../toast'
import { getToken, state, fmtSize, type Visibility } from '../api'
import { langHeader, t } from '../i18n'
import { LINK_FORMATS, linkFor, type LinkFormat } from '../links'

interface Uploaded {
  name: string; orig: string; size: number; kind?: string; status: string
  url: string; player: string; embed: string; thumb: string
}
interface UpTask { file: File; progress: number; done: boolean; err: string }

const dragOver = ref(false)
const fileInput = ref<HTMLInputElement>()
const tasks = ref<UpTask[]>([])
const results = ref<Uploaded[]>([])
const activeTab = ref<LinkFormat>('player')

/** Per-batch visibility; defaults to the signed-in user's own preference. */
const visibility = ref<Visibility>('public')
watch(() => state.me, me => { if (me) visibility.value = me.default_visibility || 'public' }, { immediate: true })

const accept = computed(() => {
  const c = state.conf
  if (!c) return 'video/*'
  const parts = [ ...(c.extensions || 'mp4').split(',').map(e => '.' + e.trim()) ]
  if (c.allow_images) parts.push(...(c.image_extensions || 'jpg,png').split(',').map(e => '.' + e.trim()))
  if (c.allow_other) return '*'
  return parts.join(',')
})

const tabs = LINK_FORMATS

async function uploadOne(task: UpTask) {
  const token = getToken()
  return new Promise<void>(resolve => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/videos?name=${encodeURIComponent(task.file.name)}&visibility=${visibility.value}`)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    for (const [k, v] of Object.entries(langHeader())) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = e => { if (e.lengthComputable) task.progress = Math.round((e.loaded / e.total) * 100) }
    xhr.onload = () => {
      task.done = true
      try {
        const j = JSON.parse(xhr.responseText)
        if (xhr.status === 200) { results.value.unshift(j); if (j.status === 'processing') pollUntilDone(j) }
        else task.err = j.error || t('home.uploadFailed')
      } catch { task.err = t('home.uploadFailed') }
      resolve()
    }
    xhr.onerror = () => { task.done = true; task.err = t('home.netError'); resolve() }
    xhr.send(task.file)
  })
}

async function pollUntilDone(u: Uploaded) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const r = await fetch(`/api/videos/${u.name}`, {
        headers: { Authorization: `Bearer ${getToken()}`, ...langHeader() },
      })
      if (!r.ok) return
      const j = await r.json()
      if (j.status !== 'processing') {
        const idx = results.value.findIndex(x => x.name === u.name)
        if (idx >= 0) results.value[idx] = { ...results.value[idx], ...j }
        if (j.status === 'banned') toast(t('home.rejected', u.orig), false)
        return
      }
    } catch { return }
  }
}

async function pick(files: FileList | null | undefined) {
  if (!files?.length) return
  const c = state.conf
  const needLogin = c ? (c.must_login || !c.allow_guest) : true
  if (needLogin && !getToken()) { toast(t('home.loginFirst'), false); return }
  const max = c?.max_upload_files || 5
  const list = [...files].slice(0, max)
  if (files.length > max) toast(t('home.maxFiles', max), false)
  for (const f of list) {
    const task: UpTask = { file: f, progress: 0, done: false, err: '' }
    tasks.value.push(task)
    await uploadOne(task)
  }
  if (results.value.length) toast(t('home.allDone'))
}

const onDrop = (e: DragEvent) => { dragOver.value = false; pick(e.dataTransfer?.files) }

const copy = async (u: Uploaded) => {
  await navigator.clipboard.writeText(linkFor(u, activeTab.value))
  toast(t('c.copied'))
}
const copyAll = async () => {
  await navigator.clipboard.writeText(results.value.map(u => linkFor(u, activeTab.value)).join('\n'))
  toast(t('c.copied'))
}
</script>

<template>
  <div class="fade-up">
    <section class="hero">
      <h1>{{ t('home.title') }}</h1>
      <p>{{ state.conf?.description || t('home.fallbackDesc') }}</p>
      <p class="muted" style="font-size:.82rem" v-if="state.conf?.tips" v-html="state.conf.tips" />
    </section>

    <div
      class="dropzone"
      :class="{ over: dragOver }"
      @click="fileInput?.click()"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <b>{{ t('home.drop') }}</b> {{ t('home.dropRest') }}
      <div class="muted" style="margin-top:.5rem;color:var(--muted)">
        {{ t('home.limits', state.conf?.max_size_mb ?? 500, state.conf?.max_upload_files ?? 5) }}
        <template v-if="state.conf?.must_login"> · {{ t('home.needLogin') }}</template>
      </div>
      <input ref="fileInput" type="file" :accept="accept" multiple hidden @change="e => pick((e.target as HTMLInputElement).files)" />
    </div>

    <div v-if="state.me" class="glass-card vis-picker">
      <span class="vis-label">{{ t('home.uploadAs') }}</span>
      <label class="vis-opt" :class="{ on: visibility === 'public' }">
        <input type="radio" value="public" v-model="visibility" />
        <b>{{ t('vis.public') }}</b><small>{{ t('vis.publicHint') }}</small>
      </label>
      <label class="vis-opt" :class="{ on: visibility === 'private' }">
        <input type="radio" value="private" v-model="visibility" />
        <b>{{ t('vis.private') }}</b><small>{{ t('vis.privateHint') }}</small>
      </label>
    </div>

    <div v-if="tasks.length" class="glass-card" style="padding:.8rem 1.2rem;margin-top:1rem">
      <div v-for="t in tasks" :key="t.file.name + t.file.size" class="up-item">
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ t.file.name }}</span>
        <span class="muted2">{{ fmtSize(t.file.size) }}</span>
        <div class="bar"><i :style="{ width: t.progress + '%' }" /></div>
        <b v-if="t.err" style="color:var(--red)">{{ t.err }}</b>
        <b v-else-if="t.done" style="color:var(--green)">✓</b>
        <b v-else>{{ t.progress }}%</b>
      </div>
    </div>

    <div v-if="results.length" class="glass-card result-card fade-up" style="margin-top:1rem">
      <div class="row" style="margin-bottom:.7rem">
        <h3 style="margin:0">✅ {{ t('home.uploaded', results.length) }}</h3>
        <span class="grow"></span>
        <button class="btn ghost sm" @click="copyAll">{{ t('c.copyAll') }}</button>
        <button class="btn ghost sm" @click="results = []; tasks = []">{{ t('c.clear') }}</button>
      </div>
      <div class="link-tabs">
        <button v-for="tab in tabs" :key="tab.key" class="link-tab" :class="{ on: activeTab === tab.key }" @click="activeTab = tab.key">{{ t(tab.label) }}</button>
      </div>
      <div v-for="u in results" :key="u.name" class="row" style="padding:.5rem 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <div class="link-out grow" style="margin:0">{{ linkFor(u, activeTab) }}
          <span v-if="u.status === 'processing'" class="pill processing">{{ t('home.processing') }}</span>
        </div>
        <button class="btn sm" @click="copy(u)">{{ t('c.copy') }}</button>
        <a class="btn ghost sm" :href="u.player" target="_blank">{{ t('c.open') }}</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vis-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: .6rem;
  padding: .8rem 1rem;
  margin-top: 1rem;
}
.vis-label { align-self: center; font-size: .85rem; color: var(--muted); }
.vis-opt {
  flex: 1 1 220px;
  display: flex;
  flex-direction: column;
  gap: .15rem;
  padding: .55rem .8rem;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color .18s, background .18s;
}
.vis-opt.on { border-color: var(--accent, #7c5cff); background: rgba(124, 92, 255, .1); }
.vis-opt input { display: none; }
.vis-opt b { font-size: .9rem; }
.vis-opt small { color: var(--muted); font-size: .74rem; line-height: 1.35; }
</style>
