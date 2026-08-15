<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fmtSize } from '../api'
import { t } from '../i18n'

interface DayStat { date: string; count: number; size: number }
interface Stats { total: number; totalSize: number; views: number; byDay: DayStat[] }

const data = ref<Stats | null>(null)
const errKey = ref('')
const err = computed(() => (errKey.value ? t(errKey.value) : ''))

const days = computed(() => (data.value?.byDay ?? []).slice(-14))
const maxCount = computed(() => Math.max(1, ...days.value.map(d => d.count)))
const todayCount = computed(() => {
  const t = new Date().toISOString().slice(0, 10)
  return days.value.find(d => d.date === t)?.count ?? 0
})

onMounted(async () => {
  try {
    const res = await fetch('/api/stats')
    if (!res.ok) { errKey.value = 'st.closed'; return }
    data.value = await res.json()
  } catch { errKey.value = 'st.loadFailed' }
})
</script>

<template>
  <div class="fade-up">
    <h1 style="margin:.5rem 0 1.4rem">{{ t('st.title') }}</h1>
    <p v-if="err" class="muted">{{ err }}</p>
    <template v-else>
      <div class="stat-grid">
        <div class="glass-card stat-card"><b>{{ data?.total ?? '—' }}</b><span>{{ t('st.totalVideos') }}</span></div>
        <div class="glass-card stat-card"><b>{{ data ? fmtSize(data.totalSize) : '—' }}</b><span>{{ t('st.storage') }}</span></div>
        <div class="glass-card stat-card"><b>{{ data?.views ?? '—' }}</b><span>{{ t('st.totalViews') }}</span></div>
        <div class="glass-card stat-card"><b>{{ todayCount }}</b><span>{{ t('st.today') }}</span></div>
      </div>

      <div class="glass-card chart-card">
        <h3 style="margin:0 0 .5rem;font-size:1rem">{{ t('st.last14') }}</h3>
        <div class="chart">
          <div v-for="d in days" :key="d.date" class="bar" :title="`${d.date}: ${d.count} 个, ${fmtSize(d.size)}`">
            <i :style="{ height: (d.count / maxCount) * 100 + '%' }" />
            <small>{{ d.date.slice(5) }}</small>
          </div>
          <p v-if="days.length === 0" class="muted" style="margin:auto">{{ t('st.noData') }}</p>
        </div>
      </div>
    </template>
  </div>
</template>
