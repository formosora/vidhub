<script setup lang="ts">
import { computed, ref } from 'vue'
import { toast } from '../toast'

const TOKEN_KEY = 'vidhub_token'

const uploading = ref(false)
const progress = ref(0)
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement>()

interface Uploaded {
  name: string
  url: string
  player: string
  embed: string
}
const result = ref<Uploaded | null>(null)
const activeTab = ref<'direct' | 'markdown' | 'html' | 'iframe'>('direct')

const tabs = [
  { key: 'direct', label: '直链' },
  { key: 'markdown', label: 'MarkDown' },
  { key: 'html', label: 'HTML' },
  { key: 'iframe', label: 'iframe 嵌入' },
] as const

const currentLink = computed(() => {
  if (!result.value) return ''
  const origin = location.origin
  const u = result.value
  switch (activeTab.value) {
    case 'direct': return origin + u.url
    case 'markdown': return `[video](${origin}${u.player})`
    case 'html': return `<video src="${origin}${u.url}" controls style="max-width:100%"></video>`
    case 'iframe': return `<iframe src="${origin}${u.player}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`
  }
})

function upload(file: File) {
  const token = localStorage.getItem(TOKEN_KEY)
  if (!token) {
    toast('请先登录（管理页）', false)
    return
  }
  uploading.value = true
  progress.value = 0
  result.value = null

  const xhr = new XMLHttpRequest()
  xhr.open('POST', `/api/videos?name=${encodeURIComponent(file.name)}`)
  xhr.setRequestHeader('Authorization', `Bearer ${token}`)
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) progress.value = Math.round((e.loaded / e.total) * 100)
  }
  xhr.onload = () => {
    uploading.value = false
    if (xhr.status === 200) {
      result.value = JSON.parse(xhr.responseText)
      toast('上传完成 ✓')
    } else {
      try { toast(`上传失败：${JSON.parse(xhr.responseText).error}`, false) }
      catch { toast('上传失败', false) }
    }
  }
  xhr.onerror = () => { uploading.value = false; toast('网络错误', false) }
  xhr.send(file)
}

const onDrop = (e: DragEvent) => {
  dragOver.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) upload(f)
}

const copyResult = async () => {
  await navigator.clipboard.writeText(currentLink.value)
  toast('已复制 ✓')
}
</script>

<template>
  <div class="fade-up">
    <section class="hero">
      <h1>上传视频，即刻分享</h1>
      <p>自托管视频床 — 流式秒播、直链 / Markdown / HTML / iframe 全格式输出</p>
    </section>

    <div
      class="dropzone"
      :class="{ over: dragOver }"
      @click="fileInput?.click()"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <b>点击选择</b> 或拖拽视频到这里
      <div class="muted" style="margin-top:.5rem;color:var(--muted)">mp4 / webm / mov / mkv · 最大 500MB</div>
      <div v-if="uploading" class="progress"><i :style="{ width: progress + '%' }" /></div>
      <div v-if="uploading" style="margin-top:.4rem;color:var(--muted)">{{ progress }}%</div>
      <input ref="fileInput" type="file" accept="video/*" hidden @change="e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) upload(f) }" />
    </div>

    <div v-if="result" class="glass-card result-card fade-up">
      <h3>✅ 上传成功 — {{ result.name }}</h3>
      <div class="link-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="link-tab"
          :class="{ on: activeTab === t.key }"
          @click="activeTab = t.key"
        >{{ t.label }}</button>
      </div>
      <div class="link-out">{{ currentLink }}</div>
      <div style="margin-top:.8rem;display:flex;gap:.5rem">
        <button class="btn sm" @click="copyResult">复制</button>
        <a class="btn ghost sm" :href="result.player" target="_blank">打开播放页</a>
      </div>
    </div>
  </div>
</template>
