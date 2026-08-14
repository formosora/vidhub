<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from '../toast'

interface VideoItem {
  name: string
  orig?: string
  size: number
  uploaded: string
}

const TOKEN_KEY = 'vidhub_token'
const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
const authed = ref(false)

const pwd = ref('')
const loginErr = ref('')
const videos = ref<VideoItem[]>([])
const uploading = ref(false)
const progress = ref(0)
const fileInput = ref<HTMLInputElement>()

const authHeaders = () => ({ Authorization: `Bearer ${token.value}` })

async function login() {
  loginErr.value = ''
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd.value }),
  })
  if (res.ok) {
    token.value = (await res.json()).token
    localStorage.setItem(TOKEN_KEY, token.value)
    authed.value = true
    loadList()
  } else loginErr.value = '密码错误 / Wrong password'
}

function logout() {
  localStorage.removeItem(TOKEN_KEY)
  token.value = ''
  authed.value = false
}

async function loadList() {
  const res = await fetch('/api/videos', { headers: authHeaders() })
  if (res.status === 401) return logout()
  const list = (await res.json()) as VideoItem[]
  videos.value = list.sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1))
}

function upload(file: File) {
  uploading.value = true
  progress.value = 0
  const xhr = new XMLHttpRequest()
  xhr.open('POST', `/api/videos?name=${encodeURIComponent(file.name)}`)
  xhr.setRequestHeader('Authorization', `Bearer ${token.value}`)
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) progress.value = Math.round((e.loaded / e.total) * 100)
  }
  xhr.onload = () => {
    uploading.value = false
    if (xhr.status === 200) { toast('上传完成 ✓'); loadList() }
    else {
      try { toast(`上传失败：${JSON.parse(xhr.responseText).error}`, false) }
      catch { toast('上传失败', false) }
    }
  }
  xhr.onerror = () => { uploading.value = false; toast('网络错误', false) }
  xhr.send(file)
}

const fmtSize = (n: number) =>
  n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : (n / (1 << 20)).toFixed(1) + ' MB'

const copy = async (text: string, label: string) => {
  await navigator.clipboard.writeText(text)
  toast(`${label}已复制 ✓`)
}

const embedCode = (v: VideoItem) =>
  `<iframe src="${location.origin}/p/${v.name}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`

const remove = async (v: VideoItem) => {
  if (!confirm(`删除 ${v.orig || v.name}？`)) return
  const res = await fetch(`/api/videos/${v.name}`, { method: 'DELETE', headers: authHeaders() })
  if (res.ok) { toast('已删除'); loadList() } else toast('删除失败', false)
}

onMounted(async () => {
  if (!token.value) return
  const res = await fetch('/api/admin/check', { headers: authHeaders() })
  if (res.ok) { authed.value = true; loadList() } else logout()
})
</script>

<template>
  <div class="fade-up">
    <div v-if="!authed" class="login-wrap">
      <form class="glass-card login-card" @submit.prevent="login">
        <h1>🎬 vidhub 管理</h1>
        <input v-model="pwd" type="password" placeholder="管理密码" autocomplete="current-password" />
        <div class="err">{{ loginErr }}</div>
        <button class="btn" style="width:100%" type="submit">登录</button>
      </form>
    </div>

    <template v-else>
      <div class="admin-toolbar" style="display:flex;align-items:center;gap:.6rem;margin-bottom:1.1rem">
        <h2 style="margin:0;font-size:1.15rem">视频管理</h2>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="fileInput?.click()">＋ 上传</button>
        <button class="btn ghost sm" @click="logout">退出</button>
        <input ref="fileInput" type="file" accept="video/*" hidden @change="e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) upload(f) }" />
      </div>

      <div v-if="uploading" class="progress"><i :style="{ width: progress + '%' }" /></div>

      <div class="glass-card" style="padding:.5rem 1.2rem">
        <div v-if="videos.length === 0" class="muted" style="text-align:center;padding:2rem 0">还没有视频。</div>
        <div v-for="v in videos" :key="v.name" class="vrow">
          <div class="thumb"><video :src="`/v/${v.name}`" preload="metadata" muted /></div>
          <div class="info">
            <b>{{ v.orig || v.name }}</b>
            <small>{{ fmtSize(v.size) }} · {{ v.uploaded.slice(0, 10) }}</small>
          </div>
          <div class="ops">
            <button class="btn ghost sm" @click="copy(`${location.origin}/p/${v.name}`, '链接')">链接</button>
            <button class="btn ghost sm" @click="copy(embedCode(v), '嵌入码')">嵌入</button>
            <button class="btn danger sm" @click="remove(v)">删除</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
