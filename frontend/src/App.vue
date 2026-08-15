<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { toastOk, toastText, toastVisible } from './toast'
import { ensureSite, state, setToken } from './api'
import { LOCALES, locale, setLocale, t } from './i18n'
import { useRouter } from 'vue-router'

const router = useRouter()
const title = computed(() => state.conf?.title || 'vidhub')
const brand = computed(() => title.value.split('·')[0].trim() || 'vidhub')

watch(title, t => { document.title = t }, { immediate: true })

/** Inject admin-provided custom code into the SPA (styles/meta to head, scripts to body). */
watch(() => state.conf, c => {
  if (!c || (window as any).__vhInjected) return
  ;(window as any).__vhInjected = true
  for (const [html, target] of [[c.custom_head, document.head], [c.footer_code, document.body]] as const) {
    if (!html) continue
    const frag = document.createRange().createContextualFragment(html)
    target.appendChild(frag)
  }
})

async function logout() {
  await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('vidhub_token')}` } })
  setToken('')
  state.me = null
  router.push('/')
}

onMounted(ensureSite)
</script>

<template>
  <div class="site">
    <div class="bg-fx" aria-hidden="true">
      <div class="orb orb-1" />
      <div class="orb orb-2" />
      <div class="orb orb-3" />
    </div>

    <header class="topbar glass-bar">
      <div class="wrap topbar-inner">
        <RouterLink to="/" class="brand">🎬 {{ brand }}</RouterLink>
        <nav class="nav">
          <RouterLink to="/">{{ t('nav.home') }}</RouterLink>
          <RouterLink v-if="state.conf?.explore_public" to="/explore">{{ t('nav.explore') }}</RouterLink>
          <RouterLink v-if="state.conf?.stats_public || state.me" to="/stats">{{ t('nav.stats') }}</RouterLink>
          <template v-if="state.me">
            <RouterLink to="/my">{{ t('nav.mine') }}</RouterLink>
            <RouterLink v-if="state.me.role === 'admin'" to="/admin">{{ t('nav.admin') }}</RouterLink>
            <a href="javascript:;" @click="logout">{{ t('nav.logout') }}</a>
          </template>
          <RouterLink v-else to="/login">{{ t('nav.login') }}</RouterLink>
          <span class="lang-switch">
            <button
              v-for="l in LOCALES" :key="l.id"
              class="lang-opt" :class="{ on: locale === l.id }"
              :aria-pressed="locale === l.id"
              @click="setLocale(l.id)"
            >{{ l.label }}</button>
          </span>
        </nav>
      </div>
    </header>

    <main class="wrap main">
      <div v-if="state.conf?.notice_status && state.conf?.notice" class="notice-banner" v-html="state.conf.notice" />
      <div v-if="state.conf?.ad_top" class="ad-slot" v-html="state.conf.ad_top_info" />
      <RouterView />
      <div v-if="state.conf?.ad_bot" class="ad-slot" v-html="state.conf.ad_bot_info" />
    </main>

    <footer class="foot">
      <div class="wrap">{{ title }} — {{ t('foot.tagline') }}</div>
    </footer>

    <div class="toast" :class="{ show: toastVisible, ok: toastOk, bad: !toastOk }">{{ toastText }}</div>
  </div>
</template>

<style scoped>
.lang-switch {
  display: inline-flex;
  gap: 2px;
  margin-left: .4rem;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, .22);
}
.lang-opt {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: .78rem;
  padding: .15rem .45rem;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.lang-opt.on { background: var(--glass-bg-strong); color: var(--text); }
.lang-opt:hover:not(.on) { color: var(--text); }
</style>
