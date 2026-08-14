import { ref } from 'vue'

export const toastText = ref('')
export const toastOk = ref(true)
export const toastVisible = ref(false)
let timer: number | undefined

export function toast(text: string, ok = true): void {
  toastText.value = text
  toastOk.value = ok
  toastVisible.value = true
  clearTimeout(timer)
  timer = window.setTimeout(() => (toastVisible.value = false), 2200)
}
