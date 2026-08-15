/// <reference types="vite/client" />

// Without this shim `tsc --noEmit` cannot resolve single-file components.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
