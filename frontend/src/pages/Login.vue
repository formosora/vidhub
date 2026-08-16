<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ensureSite, loadSite, setToken, state } from '../api'
import { langHeader, t } from '../i18n'

const router = useRouter()
const mode = ref<'login' | 'register'>('login')
const username = ref('admin')
const password = ref('')
const password2 = ref('')
const err = ref('')
const busy = ref(false)
const remember = ref(false)

// ---- captcha ----
const capSvg = ref('')
const capId = ref('')
const capInput = ref('')
const capLoading = ref(false)

async function newCaptcha() {
  capLoading.value = true
  capInput.value = ''
  try {
    const j = await (await fetch('/api/captcha', { headers: langHeader() })).json()
    capId.value = j.id
    capSvg.value = j.svg
  } catch { capSvg.value = '' } finally { capLoading.value = false }
}

// entering the register tab for the first time pulls a challenge
watch(mode, m => {
  err.value = ''
  if (m === 'register') {
    if (username.value === 'admin') username.value = ''
    if (!capSvg.value) newCaptcha()
  }
})

async function submit() {
  if (mode.value === 'register') return register()
  return login()
}

async function login() {
  err.value = ''
  busy.value = true
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...langHeader() },
      body: JSON.stringify({ username: username.value, password: password.value, remember: remember.value }),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok) {
      setToken(j.token)
      await loadSite()
      router.push(j.role === 'admin' ? '/admin' : '/my')
    } else err.value = j.error || t('lg.failed')
  } finally { busy.value = false }
}

async function register() {
  err.value = ''
  if (password.value !== password2.value) { err.value = t('lg.mismatch'); return }
  busy.value = true
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...langHeader() },
      body: JSON.stringify({
        username: username.value,
        password: password.value,
        captchaId: capId.value,
        captcha: capInput.value,
      }),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok) {
      setToken(j.token)
      await loadSite()
      router.push('/my')
    } else {
      err.value = j.error || t('lg.regFailed')
      newCaptcha()      // every challenge is single-use, so always re-issue
    }
  } finally { busy.value = false }
}

onMounted(ensureSite)
</script>

<template>
  <div class="login-wrap fade-up">
    <form class="glass-card login-card" @submit.prevent="submit">
      <h1>🎬 {{ state.conf?.title || 'vidhub' }}</h1>

      <div v-if="state.conf?.allow_register" class="auth-tabs">
        <button type="button" class="auth-tab" :class="{ on: mode === 'login' }" @click="mode = 'login'">{{ t('lg.signIn') }}</button>
        <button type="button" class="auth-tab" :class="{ on: mode === 'register' }" @click="mode = 'register'">{{ t('lg.signUp') }}</button>
      </div>
      <p v-else class="muted" style="margin:.2rem 0 1rem;font-size:.85rem">{{ t('lg.subtitle') }}</p>

      <div class="field">
        <label>{{ t('lg.username') }}</label>
        <input v-model="username" autocomplete="username" :placeholder="mode === 'register' ? t('lg.usernameHint') : ''" />
      </div>
      <div class="field">
        <label>{{ t('lg.password') }}</label>
        <input v-model="password" type="password"
               :autocomplete="mode === 'register' ? 'new-password' : 'current-password'"
               :placeholder="mode === 'register' ? t('lg.passwordHint') : ''"
               @keyup.enter="submit" />
      </div>

      <template v-if="mode === 'register'">
        <div class="field">
          <label>{{ t('lg.confirm') }}</label>
          <input v-model="password2" type="password" autocomplete="new-password" @keyup.enter="submit" />
        </div>
        <div class="field">
          <label>{{ t('lg.captcha') }} <span class="muted2">— {{ t('lg.captchaHint') }}</span></label>
          <div class="cap-row">
            <button type="button" class="cap-img" :disabled="capLoading" :title="t('lg.captchaRefresh')" @click="newCaptcha">
              <span v-if="capSvg" v-html="capSvg" />
              <span v-else class="muted2" style="font-size:.8rem">{{ t('c.loading') }}</span>
            </button>
            <input v-model="capInput" inputmode="numeric" autocomplete="off" :placeholder="t('lg.captchaAnswer')" style="width:110px" @keyup.enter="submit" />
          </div>
        </div>
      </template>

      <label v-if="mode === 'login'" class="switch" style="margin:.2rem 0 .7rem">
        <input type="checkbox" v-model="remember" /><span class="knob" />
        <span class="sw-label">{{ t('lg.remember') }}</span>
      </label>

      <div class="err" style="color:var(--red);font-size:.83rem;min-height:1.2em">{{ err }}</div>
      <button class="btn" style="width:100%" type="submit" :disabled="busy">
        {{ busy ? (mode === 'register' ? t('lg.signingUp') : t('lg.signingIn')) : (mode === 'register' ? t('lg.signUp') : t('lg.signIn')) }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.auth-tabs {
  display: flex;
  gap: .3rem;
  margin: .6rem 0 1.1rem;
  padding: .25rem;
  border-radius: 12px;
  background: rgba(0, 0, 0, .28);
  border: 1px solid var(--glass-border);
}
.auth-tab {
  flex: 1;
  padding: .45rem .6rem;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: .9rem;
  cursor: pointer;
  transition: background .18s, color .18s;
}
.auth-tab.on { background: var(--glass-bg-strong); color: var(--text); font-weight: 600; }
.auth-tab:hover:not(.on) { color: var(--text); }

.cap-row { display: flex; gap: .6rem; align-items: center; }
.cap-img {
  padding: 0;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  background: transparent;
  line-height: 0;
  cursor: pointer;
  overflow: hidden;
  min-width: 128px;
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cap-img:hover { border-color: var(--accent, #7c5cff); }
.cap-img :deep(svg) { display: block; }
</style>
