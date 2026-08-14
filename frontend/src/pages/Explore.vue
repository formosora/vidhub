<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface VideoItem {
  name: string
  orig?: string
  size: number
  uploaded: string
}

const videos = ref<VideoItem[]>([])
const loading = ref(true)

const fmtSize = (n: number) =>
  n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : (n / (1 << 20)).toFixed(1) + ' MB'

onMounted(async () => {
  try {
    const res = await fetch('/api/public/videos')
    const list = (await res.json()) as VideoItem[]
    videos.value = list.sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="fade-up">
    <h1 style="margin:.5rem 0 1.4rem">广场</h1>

    <p v-if="loading" class="muted">加载中…</p>
    <p v-else-if="videos.length === 0" class="muted">还没有视频。</p>

    <div class="gallery">
      <a v-for="v in videos" :key="v.name" class="glass-card vcard" :href="`/p/${v.name}`" target="_blank">
        <div class="thumb">
          <video :src="`/v/${v.name}`" preload="metadata" muted />
          <div class="play-badge">▶</div>
        </div>
        <div class="vinfo">
          <b>{{ v.orig || v.name }}</b>
          <small>{{ fmtSize(v.size) }} · {{ v.uploaded.slice(0, 10) }}</small>
        </div>
      </a>
    </div>
  </div>
</template>
