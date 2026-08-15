<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, fmtSize, state } from '../api'
import { locale, t } from '../i18n'

interface DayStat { date: string; count: number; size: number }
interface Stats {
  scope: 'site' | 'own'
  total: number; totalSize: number; views: number; byDay: DayStat[]
}

const data = ref<Stats | null>(null)
const errKey = ref('')
const err = computed(() => (errKey.value ? t(errKey.value) : ''))

const days = computed(() => (data.value?.byDay ?? []).slice(-14))
const maxCount = computed(() => Math.max(1, ...days.value.map(d => d.count)))
const todayCount = computed(() => {
  const iso = new Date().toISOString().slice(0, 10)
  return days.value.find(d => d.date === iso)?.count ?? 0
})

/** Site-wide totals vs. just this account's — the labels have to say which. */
const isOwn = computed(() => data.value?.scope === 'own')

async function load() {
  errKey.value = ''
  try {
    const res = await api('/api/stats')
    if (res.status === 401 || res.status === 403) {
      errKey.value = state.me ? 'st.closed' : 'st.loginRequired'
      data.value = null
      return
    }
    data.value = await res.json()
  } catch { errKey.value = 'st.loadFailed' }
}

watch(locale, load)
onMounted(load)
</script>

<template>
  <div class="fade-up">
    <div class="row" style="margin:.5rem 0 1.4rem">
      <h1 style="margin:0">{{ isOwn ? t('st.titleOwn') : t('st.title') }}</h1>
      <span v-if="data" class="pill" :class="isOwn ? 'role-uploader' : 'role-admin'">
        {{ isOwn ? t('st.scopeOwn') : t('st.scopeSite') }}
      </span>
    </div>

    <template v-if="err">
      <p class="muted">{{ err }}</p>
      <RouterLink v-if="!state.me" class="btn sm" to="/login">{{ t('nav.login') }}</RouterLink>
    </template>

    <template v-else>
      <div class="stat-grid">
        <div class="glass-card stat-card"><b>{{ data?.total ?? '—' }}</b><span>{{ isOwn ? t('st.myVideos') : t('st.totalVideos') }}</span></div>
        <div class="glass-card stat-card"><b>{{ data ? fmtSize(data.totalSize) : '—' }}</b><span>{{ t('st.storage') }}</span></div>
        <div class="glass-card stat-card"><b>{{ data?.views ?? '—' }}</b><span>{{ t('st.totalViews') }}</span></div>
        <div class="glass-card stat-card"><b>{{ todayCount }}</b><span>{{ t('st.today') }}</span></div>
      </div>

      <div class="glass-card chart-card">
        <h3 style="margin:0 0 .5rem;font-size:1rem">{{ t('st.last14') }}</h3>
        <div class="chart">
          <div v-for="d in days" :key="d.date" class="bar" :title="t('st.barTip', d.date, d.count, fmtSize(d.size))">
            <span class="track"><i :style="{ height: Math.max(2, (d.count / maxCount) * 100) + '%' }" /></span>
            <small>{{ d.date.slice(5) }}</small>
          </div>
          <p v-if="days.length === 0" class="muted" style="margin:auto">{{ t('st.noData') }}</p>
        </div>
      </div>
    </template>
  </div>
</template>
