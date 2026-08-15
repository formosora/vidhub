/**
 * Zero-dependency arithmetic CAPTCHA.
 *
 * Glyphs are drawn as line segments, never as <text> — an SVG that spells the
 * challenge out in markup is solved by reading the response body, which defeats
 * the point. A bot has to rasterize and recognise the strokes instead.
 *
 * The answer lives server-side only, keyed by a one-shot id.
 */
import { newToken } from './util.js'

const TTL = 5 * 60_000      // a challenge is valid for 5 minutes
const MAX = 5_000           // hard cap on outstanding challenges

const store = new Map()     // id -> { answer, exp }

function sweep() {
  const now = Date.now()
  for (const [k, v] of store) if (v.exp < now) store.delete(k)
  // still oversized (flood) → drop oldest first; Map preserves insertion order
  while (store.size > MAX) store.delete(store.keys().next().value)
}

// ---------- stroke font (7-segment digits + operators) in a 10x16 box ----------

const SEG = {
  a: [[1, 1], [9, 1]], b: [[9, 1], [9, 8]], c: [[9, 8], [9, 15]],
  d: [[1, 15], [9, 15]], e: [[1, 8], [1, 15]], f: [[1, 1], [1, 8]],
  g: [[1, 8], [9, 8]],
}
const DIGIT_SEGS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
}
const OP_SEGS = {
  '+': [[[2, 8], [8, 8]], [[5, 5], [5, 11]]],
  '-': [[[2, 8], [8, 8]]],
  '=': [[[2, 6], [8, 6]], [[2, 10], [8, 10]]],
}

const glyphSegments = ch =>
  ch in OP_SEGS ? OP_SEGS[ch] : [...(DIGIT_SEGS[ch] || '')].map(s => SEG[s])

// ---------- rendering ----------

const rnd = (a, b) => a + Math.random() * (b - a)
const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const INK = ['#1f2937', '#3730a3', '#831843', '#065f46', '#7c2d12']

/** One segment as a slightly bowed path, so glyphs are never pixel-identical. */
function segPath([[x1, y1], [x2, y2]]) {
  const mx = (x1 + x2) / 2 + rnd(-0.7, 0.7)
  const my = (y1 + y2) / 2 + rnd(-0.7, 0.7)
  return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
}

function render(text) {
  const cell = 26
  const W = 24 + text.length * cell
  const H = 56
  const parts = []

  parts.push(`<rect width="${W}" height="${H}" rx="10" fill="#eef1f6"/>`)

  // background noise: a few wandering curves
  for (let i = 0; i < 4; i++) {
    parts.push(
      `<path d="M${rnd(0, W).toFixed(1)},${rnd(0, H).toFixed(1)} ` +
      `Q${rnd(0, W).toFixed(1)},${rnd(0, H).toFixed(1)} ${rnd(0, W).toFixed(1)},${rnd(0, H).toFixed(1)}" ` +
      `fill="none" stroke="${pick(INK)}" stroke-opacity="0.22" stroke-width="${rnd(1, 2.2).toFixed(1)}"/>`)
  }

  // glyphs
  text.split('').forEach((ch, i) => {
    const segs = glyphSegments(ch)
    if (!segs.length) return
    const scale = rnd(1.9, 2.3)
    const tx = 12 + i * cell + rnd(-2, 2)
    const ty = 8 + rnd(-3, 3)
    const rot = rnd(-14, 14)
    const ink = pick(INK)
    const d = segs.map(segPath).join(' ')
    parts.push(
      `<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) rotate(${rot.toFixed(1)},10,16) scale(${(scale / 2).toFixed(2)})">` +
      `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${rnd(2, 3).toFixed(1)}" ` +
      `stroke-linecap="round" stroke-linejoin="round"/></g>`)
  })

  // foreground speckle
  for (let i = 0; i < 26; i++) {
    parts.push(`<circle cx="${rnd(0, W).toFixed(1)}" cy="${rnd(0, H).toFixed(1)}" ` +
      `r="${rnd(0.6, 1.6).toFixed(1)}" fill="${pick(INK)}" fill-opacity="0.3"/>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" role="img" aria-label="算术验证码">${parts.join('')}</svg>`
}

// ---------- public API ----------

/** Issue a challenge. Returns { id, svg, ttl } — the answer never leaves here. */
export function issueCaptcha() {
  sweep()
  const a = 1 + Math.floor(Math.random() * 9)
  const b = 1 + Math.floor(Math.random() * 9)
  const plus = Math.random() < 0.5
  // subtraction is ordered so the answer is never negative
  const [x, y] = plus ? [a, b] : (a >= b ? [a, b] : [b, a])
  const answer = plus ? x + y : x - y

  const id = newToken()
  store.set(id, { answer: String(answer), exp: Date.now() + TTL })
  return { id, svg: render(`${x}${plus ? '+' : '-'}${y}=`), ttl: TTL / 1000 }
}

/**
 * Check and *consume* a challenge — one attempt per image, right or wrong, so a
 * single issued captcha can't be brute-forced with ten guesses.
 */
export function verifyCaptcha(id, input) {
  const key = String(id || '')
  const rec = store.get(key)
  store.delete(key)
  if (!rec || rec.exp < Date.now()) return false
  return String(input ?? '').trim() === rec.answer
}

export const pendingCaptchas = () => store.size
