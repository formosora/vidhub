<script setup lang="ts">
import { toastOk, toastText, toastVisible } from './toast'
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
        <RouterLink to="/" class="brand">🎬 vid<span>hub</span></RouterLink>
        <nav class="nav">
          <RouterLink to="/">首页</RouterLink>
          <RouterLink to="/explore">广场</RouterLink>
          <RouterLink to="/stats">统计</RouterLink>
          <RouterLink to="/admin">管理</RouterLink>
        </nav>
      </div>
    </header>

    <main class="wrap main">
      <RouterView />
    </main>

    <footer class="foot">
      <div class="wrap">vidhub — self-hosted video bed · Vue 3 + Node · single Docker container</div>
    </footer>

    <div class="toast" :class="{ show: toastVisible, ok: toastOk, bad: !toastOk }">{{ toastText }}</div>
  </div>
</template>
