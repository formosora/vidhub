<script setup lang="ts">
/**
 * Issue and revoke share links for one `protected` file.
 *
 * Shown in place of the ordinary copy-a-URL box, because for a link-only file
 * those URLs do not work — a share link is the only way in.
 */
import { onMounted, ref } from 'vue'
import { api, siteBase, type Share } from '../api'
import { t } from '../i18n'
import { toast } from '../toast'

const props = defineProps<{ name: string }>()

const links = ref<Share[]>([])
const busy = ref(false)
const password = ref('')
const expires = ref(0)          // hours; 0 = never
const maxViews = ref(0)         // 0 = unlimited
const note = ref('')

const EXPIRY_CHOICES = [
  { v: 0, label: () => t('sl.never') },
  { v: 1, label: () => t('sl.hours', 1) },
  { v: 24, label: () => t('sl.days', 1) },
  { v: 24 * 7, label: () => t('sl.days', 7) },
  { v: 24 * 30, label: () => t('sl.days', 30) },
]

async function load() {
  const res = await api(`/api/videos/${props.name}/shares`)
  if (res.ok) links.value = (await res.json()).items
}
onMounted(load)

async function create() {
  if (busy.value) return
  busy.value = true
  const res = await api(`/api/videos/${props.name}/shares`, {
    method: 'POST',
    body: JSON.stringify({
      password: password.value,
      expires_in_hours: expires.value,
      max_views: maxViews.value,
      note: note.value,
    }),
  })
  busy.value = false
  if (!res.ok) return toast((await res.json()).error || t('c.failed'), false)
  password.value = ''; note.value = ''
  toast(t('sl.created'))
  load()
}

async function revoke(s: Share) {
  if (!confirm(t('sl.revokeConfirm'))) return
  const res = await api(`/api/shares/${s.token}`, { method: 'DELETE' })
  if (!res.ok) return toast(t('c.failed'), false)
  toast(t('sl.revoked'))
  load()
}

const fullUrl = (s: Share) => siteBase() + s.url

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast(t('c.copied')) }
  catch { toast(t('c.copyFailed'), false) }
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
</script>

<template>
  <div class="sl">
    <p class="sl-intro">{{ t('sl.intro') }}</p>

    <div class="sl-form">
      <input v-model="password" type="text" :placeholder="t('sl.password')" maxlength="200">
      <select v-model.number="expires">
        <option v-for="c in EXPIRY_CHOICES" :key="c.v" :value="c.v">{{ c.label() }}</option>
      </select>
      <input v-model.number="maxViews" type="number" min="0" :placeholder="t('sl.maxViews')" :title="t('sl.maxViews')">
      <input v-model="note" type="text" :placeholder="t('sl.note')" maxlength="200">
      <button class="btn sm" :disabled="busy" @click="create">{{ t('sl.create') }}</button>
    </div>
    <p class="sl-hint">{{ t('sl.countHint') }}</p>

    <p v-if="!links.length" class="sl-empty">{{ t('sl.empty') }}</p>

    <div v-for="s in links" :key="s.token" class="sl-row" :class="{ dead: s.state !== 'ok' }">
      <code class="sl-url">{{ fullUrl(s) }}</code>
      <span class="sl-tags">
        <span v-if="s.note" class="sl-tag note">{{ s.note }}</span>
        <span v-if="s.has_password" class="sl-tag">{{ t('sl.hasPassword') }}</span>
        <span v-if="s.max_views" class="sl-tag">{{ t('sl.viewsUsed', s.views, s.max_views) }}</span>
        <span v-else class="sl-tag">{{ t('sl.viewsCount', s.views) }}</span>
        <span v-if="s.expires" class="sl-tag">{{ t('sl.expiresOn', fmtDate(s.expires)) }}</span>
        <span v-if="s.state === 'expired'" class="sl-tag bad">{{ t('sl.stateExpired') }}</span>
        <span v-if="s.state === 'exhausted'" class="sl-tag bad">{{ t('sl.stateExhausted') }}</span>
      </span>
      <button class="btn ghost sm" @click.stop="copy(fullUrl(s))">{{ t('c.copy') }}</button>
      <button class="btn ghost sm" @click.stop="copy(s.embed)">{{ t('tab.iframe') }}</button>
      <button class="btn danger sm" @click.stop="revoke(s)">{{ t('sl.revoke') }}</button>
    </div>
  </div>
</template>

<style scoped>
.sl {
  margin: .5rem 0 .7rem;
  padding: .7rem .8rem;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  background: rgba(0, 0, 0, .26);
}
.sl-intro { margin: 0 0 .6rem; font-size: .76rem; color: var(--muted); }
.sl-hint { margin: .35rem 0 .6rem; font-size: .7rem; color: var(--muted); opacity: .8; }
.sl-empty { margin: .5rem 0 0; font-size: .78rem; color: var(--muted); }
.sl-form { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
.sl-form input, .sl-form select {
  padding: .32rem .5rem;
  border: 1px solid var(--glass-border);
  border-radius: 7px;
  background: rgba(0, 0, 0, .3);
  color: var(--text);
  font-size: .76rem;
}
.sl-form input[type="text"] { flex: 1 1 9rem; min-width: 7rem; }
.sl-form input[type="number"] { width: 6.5rem; }
.sl-row {
  display: flex;
  align-items: center;
  gap: .45rem;
  margin-top: .45rem;
  padding-top: .45rem;
  border-top: 1px solid var(--glass-border);
}
.sl-row.dead { opacity: .5; }
.sl-row .btn { flex: 0 0 auto; white-space: nowrap; }
.sl-url {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .73rem;
  opacity: .85;
}
.sl-tags { display: flex; flex-wrap: wrap; gap: .25rem; flex: 0 0 auto; }
.sl-tag {
  font-size: .66rem;
  padding: .1rem .4rem;
  border-radius: 5px;
  background: rgba(255, 255, 255, .07);
  color: var(--muted);
  white-space: nowrap;
}
.sl-tag.note { color: var(--text); opacity: .8; }
.sl-tag.bad { background: rgba(255, 110, 110, .16); color: #ff9b9b; }
@media (max-width: 720px) {
  .sl-row { flex-wrap: wrap; }
  .sl-url { flex-basis: 100%; }
  .sl-tags { flex-basis: 100%; }
}
</style>
