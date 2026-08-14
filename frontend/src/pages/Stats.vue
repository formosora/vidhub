<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface DayStat { date: string; count: number; size: number }
interface Stats { total: number; totalSize: number; byDay: DayStat[] }

const data = ref<Stats | null>(null)

const fmtSize = (n: number) =>
  n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : (n / (1 << 20)).toFixed(1) + ' MB'

const days = computed(() => (data.value?.byDay ?? []).slice(-14))
const maxCount = computed(() => Math.max(1, ...days.value.map(d => d.count)))

onMounted(async () => {
  const res = await fetch('/api/stats')
  data.value = await res.json()
})
</script>

<template>
  <div class="fade-up">
    <h1 style="margin:.5rem 0 1.4rem">统计</h1>

    <div class="stat-grid">
      <div class="glass-card stat-card">
        <b>{{ data?.total ?? '—' }}</b>
        <span>视频总数</span>
      </div>
      <div class="glass-card stat-card">
        <b>{{ data ? fmtSize(data.totalSize) : '—' }}</b>
        <span>总存储占用</span>
      </div>
      <div class="glass-card stat-card">
        <b>{{ days.length ? days[days.length - 1].count : '—' }}</b>
        <span>今日上传</span>
      </div>
      <div class="glass-card stat-card">
        <b>{{ days.length ? Math.max(...days.map(d => d.count)) : '—' }}</b>
        <span>单日最高</span>
      </div>
    </div>

    <div class="glass-card chart-card">
      <h3 style="margin:0 0 .5rem;font-size:1rem">近 14 天上传</h3>
      <div class="chart">
        <div v-for="d in days" :key="d.date" class="bar" :title="`${d.date}: ${d.count} 个, ${fmtSize(d.size)}`">
          <i :style="{ height: (d.count / maxCount) * 100 + '%' }" />
          <small>{{ d.date.slice(5) }}</small>
        </div>
        <p v-if="days.length === 0" class="muted" style="margin:auto">暂无数据</p>
      </div>
    </div>
  </div>
</template>
