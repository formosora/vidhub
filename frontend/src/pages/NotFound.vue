<script setup lang="ts">
import { t } from '../i18n'
</script>

<template>
  <div class="fade-up" style="text-align:center;padding:3rem 0">
    <h1 style="margin:0 0 .6rem;font-size:2.4rem">404</h1>
    <p class="muted" style="margin:0 0 1.4rem">{{ t('nf.body') }}</p>
    <RouterLink class="btn sm" to="/">{{ t('nav.home') }}</RouterLink>
  </div>
</template>
