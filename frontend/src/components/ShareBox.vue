<script setup lang="ts">
/** All share formats for one item, each with its own copy button. */
import { t } from '../i18n'
import { toast } from '../toast'
import { LINK_FORMATS, linkFor, type Linkable } from '../links'

const props = defineProps<{ item: Linkable }>()

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('c.copied'))
  } catch {
    toast(t('c.copyFailed'), false)
  }
}
</script>

<template>
  <div class="share-box">
    <div v-for="f in LINK_FORMATS" :key="f.key" class="share-row">
      <span class="share-tag">{{ t(f.label) }}</span>
      <code class="share-val">{{ linkFor(props.item, f.key) }}</code>
      <button class="btn ghost sm" @click.stop="copy(linkFor(props.item, f.key))">{{ t('c.copy') }}</button>
    </div>
  </div>
</template>

<style scoped>
.share-box {
  display: flex;
  flex-direction: column;
  gap: .35rem;
  margin: .5rem 0 .7rem;
  padding: .7rem .8rem;
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  background: rgba(0, 0, 0, .26);
}
.share-row {
  display: flex;
  align-items: center;
  gap: .6rem;
}
/* the long HTML/iframe snippets must not squeeze the button onto two lines */
.share-row .btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
.share-tag {
  flex: 0 0 auto;
  min-width: 5.2rem;
  font-size: .74rem;
  color: var(--muted);
}
.share-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .74rem;
  color: var(--text);
  opacity: .85;
}
@media (max-width: 640px) {
  .share-row { flex-wrap: wrap; }
  .share-val { flex-basis: 100%; order: 3; }
}
</style>
