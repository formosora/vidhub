<script setup lang="ts">
/**
 * Terms of service. The body is admin-authored HTML from site settings — the
 * same trusted-injection contract as the notice and ad slots.
 */
import { computed, onMounted } from 'vue'
import { ensureSite, state } from '../api'
import { t } from '../i18n'

const body = computed(() => String(state.conf?.terms || '').trim())

onMounted(ensureSite)
</script>

<template>
  <div class="fade-up">
    <h1 style="margin:.5rem 0 1.4rem">{{ t('terms.title') }}</h1>
    <div v-if="body" class="glass-card terms-body" v-html="body" />
    <p v-else class="muted">{{ t('terms.empty') }}</p>
  </div>
</template>

<style scoped>
.terms-body {
  padding: 1.4rem 1.6rem;
  line-height: 1.75;
  font-size: .92rem;
}
.terms-body :deep(h2),
.terms-body :deep(h3) { margin: 1.2rem 0 .5rem; font-size: 1rem; }
.terms-body :deep(p) { margin: .6rem 0; }
.terms-body :deep(ul),
.terms-body :deep(ol) { margin: .6rem 0; padding-left: 1.4rem; }
.terms-body :deep(li) { margin: .25rem 0; }
.terms-body :deep(a) { color: var(--accent, #7c5cff); }
</style>
