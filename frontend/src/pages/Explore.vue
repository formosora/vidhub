<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { fmtDur, fmtSize, type VideoItem } from '../api'
import { langHeader, locale, t } from '../i18n'

const videos = ref<VideoItem[]>([])
const loading = ref(true)
const errKey = ref('')
const q = ref('')
const pageNum = ref(1)
const total = ref(0)
const size = 24
/** Newest first by default; "most viewed" is the other one visitors reach for. */
const sort = ref('uploaded')

async function load() {
  loading.value = true
  errKey.value = ''
  try {
    const res = await fetch(`/api/public/videos?page=${pageNum.value}&size=${size}&q=${encodeURIComponent(q.value)}&sort=${sort.value}&order=desc`,
      { headers: langHeader() })
    // Without this the 403 body fell through to `j.items || []` and the page
    // claimed "nothing here yet" when the gallery was simply switched off.
    if (!res.ok) { errKey.value = 'exp.closed'; videos.value = []; total.value = 0; return }
    const j = await res.json()
    videos.value = j.items || []
    total.value = j.total || 0
  } catch { errKey.value = 'st.loadFailed' } finally { loading.value = false }
}

let debounce: number | undefined
watch(q, () => { clearTimeout(debounce); debounce = window.setTimeout(() => { pageNum.value = 1; load() }, 350) })
watch(sort, () => { pageNum.value = 1; load() })
watch(pageNum, load)
watch(locale, load)          // server-side messages depend on the language
onMounted(load)

const pages = () => Math.max(1, Math.ceil(total.value / size))
</script>

<template>
  <div class="fade-up">
    <div class="row" style="margin:.5rem 0 1.4rem">
      <h1 style="margin:0">{{ t('exp.title') }}</h1>
      <span class="grow"></span>
      <input v-model="q" :placeholder="t('exp.searchPlaceholder')" style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .8rem;outline:none" />
      <select v-model="sort" :title="t('sort.label')"
              style="background:rgba(0,0,0,.28);border:1px solid var(--glass-border);color:var(--text);border-radius:10px;padding:.5rem .6rem;outline:none;font-size:.84rem">
        <option value="uploaded">{{ t('sort.uploaded') }}</option>
        <option value="views">{{ t('sort.views') }}</option>
        <option value="size">{{ t('sort.size') }}</option>
        <option value="duration">{{ t('sort.duration') }}</option>
      </select>
    </div>

    <p v-if="loading" class="muted">{{ t('c.loading') }}</p>
    <p v-else-if="errKey" class="muted">{{ t(errKey) }}</p>
    <p v-else-if="videos.length === 0" class="muted">{{ t('exp.empty') }}</p>

    <div class="gallery">
      <a v-for="v in videos" :key="v.name" class="glass-card vcard" :href="v.player" target="_blank">
        <div class="thumb">
          <img v-if="v.thumb" :src="v.thumb" loading="lazy" style="width:100%;height:100%;object-fit:cover" @error="($event.target as HTMLImageElement).style.display = 'none'" />
          <div class="play-badge">▶</div>
          <span v-if="v.duration" style="position:absolute;right:6px;bottom:6px;background:#000a;padding:1px 6px;border-radius:6px;font-size:.7rem">{{ fmtDur(v.duration) }}</span>
        </div>
        <div class="vinfo">
          <b>{{ v.orig || v.name }}</b>
          <small>{{ fmtSize(v.size) }} · {{ t('c.views', v.views) }} · {{ v.uploaded.slice(0, 10) }}</small>
        </div>
      </a>
    </div>

    <div v-if="pages() > 1" class="pager">
      <button class="btn ghost sm" :disabled="pageNum <= 1" @click="pageNum--">{{ t('c.prev') }}</button>
      <span>{{ pageNum }} / {{ pages() }}</span>
      <button class="btn ghost sm" :disabled="pageNum >= pages()" @click="pageNum++">{{ t('c.next') }}</button>
    </div>
  </div>
</template>
