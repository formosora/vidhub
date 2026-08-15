/**
 * Moderation (鉴黄):
 *  - mode 1: local skin-pixel heuristic over sampled frames (zero-dependency,
 *    frames come from ffmpeg as raw RGB). Classic rule-based skin detection.
 *  - mode 2: external audit webhook (阿里云/腾讯云内容安全或自建) — POSTs the
 *    stream URL and expects {score:0..1} or {label}.
 * A score ≥ threshold (check_img_value %) triggers ban / delete per config.
 */
import { conf } from './config.js'
import { extractFrames, imageToPixels } from './media.js'

/** Ratio of skin-tone pixels in an RGB24 buffer. */
export function skinRatio({ w, h, pixels }) {
  let skin = 0, total = 0
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
    total++
    // composite rule: RGB-range + normalized comparison
    if (r > 95 && g > 40 && b > 20 &&
        r > g && r > b &&
        Math.max(r, g, b) - Math.min(r, g, b) > 15 &&
        Math.abs(r - g) > 15) {
      // exclude very dark & near-white regions to cut false positives
      if (!(r > 220 && g > 210 && b > 170)) skin++
    }
  }
  return total ? skin / total : 0
}

/** Local check: max frame skin ratio across samples. Returns 0..1. */
export async function localCheck(file, kind) {
  if (kind === 'image') {
    const frame = await imageToPixels(file).catch(() => null)
    return frame ? skinRatio(frame) : 0
  }
  const frames = await extractFrames(file, 4).catch(() => [])
  if (!frames.length) return 0
  return Math.max(...frames.map(skinRatio))
}

/** External audit API — returns 0..1 or null on failure. */
export async function externalCheck(name, url) {
  const api = conf('check_api_url')
  if (!api) return null
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 15_000)
    const res = await fetch(api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(conf('check_api_key') ? { Authorization: `Bearer ${conf('check_api_key')}` } : {}),
      },
      body: JSON.stringify({ name, url, type: 'video' }),
      signal: ctl.signal,
    })
    clearTimeout(t)
    const j = await res.json()
    if (typeof j.score === 'number') return j.score
    if (j.label) return /porn|sexy|adult|nsfw/i.test(j.label) ? 0.95 : 0.02
  } catch { /* audit service unreachable → don't block the upload */ }
  return null
}

/**
 * Run moderation. Returns { score, flagged } — score 0..1, -1 when unchecked.
 */
export async function moderate(file, name, kind, publicUrl) {
  const mode = conf('check_img')
  if (!mode) return { score: -1, flagged: false }
  const threshold = (conf('check_img_value') || 60) / 100
  let score = -1
  if (mode === 1) score = await localCheck(file, kind).catch(() => -1)
  else if (mode === 2) score = (await externalCheck(name, publicUrl)) ?? -1
  return { score, flagged: score >= 0 && score >= threshold }
}
