/**
 * Media pipeline — ffmpeg/ffprobe wrapper.
 * Probe metadata, thumbnails, transcode/compress/resize, text & image watermarks,
 * still-image processing, and raw frame extraction for moderation.
 * Everything degrades gracefully when ffmpeg is not installed.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { conf } from './config.js'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')

function bin(cmd, args, { timeout = 120_000, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] })
    let out = Buffer.alloc(0), err = ''
    if (capture) p.stdout.on('data', c => { out = Buffer.concat([out, c]) })
    p.stderr.on('data', c => { err += c })
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')) }, timeout)
    p.on('error', e => { clearTimeout(t); reject(e) })
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve({ out, err }) : reject(new Error(err.slice(-400) || `exit ${code}`)) })
  })
}

let _hasFfmpeg = null
export async function hasFfmpeg() {
  if (_hasFfmpeg !== null) return _hasFfmpeg
  try { await bin(FFMPEG, ['-version'], { timeout: 5000 }); _hasFfmpeg = true }
  catch { _hasFfmpeg = false }
  if (!_hasFfmpeg) console.log('[vidhub] ffmpeg not found — transcoding/moderation disabled, storing originals')
  return _hasFfmpeg
}

// ---------- faststart ----------

/** Containers where the moov/mdat order decides whether playback can start early. */
const FASTSTART_EXTS = new Set(['mp4', 'm4v', 'mov'])
export const canFaststart = ext => FASTSTART_EXTS.has(String(ext || '').toLowerCase())

/**
 * True when the index sits *after* the media data.
 *
 * A browser cannot render a frame until it has the moov atom, so a file laid
 * out mdat-then-moov has to be downloaded in full before anything appears —
 * a 500MB clip means a 500MB wait no matter how fast the connection is.
 * Most encoders (ffmpeg included) write this layout by default.
 *
 * Only box headers are read, never the payload, so this costs a few reads.
 */
export async function needsFaststart(file) {
  let fh
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    const head = Buffer.alloc(16)
    let pos = 0, sawMdat = false
    while (pos + 8 <= size) {
      const { bytesRead } = await fh.read(head, 0, 16, pos)
      if (bytesRead < 8) break
      let boxSize = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (!/^[\x20-\x7e]{4}$/.test(type)) return false      // not a box tree we understand
      let headerLen = 8
      if (boxSize === 1) {                                   // 64-bit size
        if (bytesRead < 16) break
        boxSize = Number(head.readBigUInt64BE(8))
        headerLen = 16
      } else if (boxSize === 0) {
        boxSize = size - pos                                 // runs to end of file
      }
      if (boxSize < headerLen) return false
      if (type === 'moov') return sawMdat
      if (type === 'mdat') sawMdat = true
      pos += boxSize
    }
    return false
  } catch { return false } finally { await fh?.close() }
}

/**
 * Move the index to the front. This is a remux — streams are copied, not
 * re-encoded — so it is fast and lossless.
 */
export async function remuxFaststart(file) {
  const out = `${file}.fs${extname(file)}`
  await bin(FFMPEG, ['-y', '-i', file, '-c', 'copy', '-map', '0',
    '-movflags', '+faststart', out], { timeout: 20 * 60_000 })
  return out
}

// ---------- probe ----------

export async function probe(file) {
  const { out } = await bin(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { capture: true, timeout: 30_000 })
  const j = JSON.parse(out.toString())
  const v = (j.streams || []).find(s => s.codec_type === 'video')
  const a = (j.streams || []).find(s => s.codec_type === 'audio')
  return {
    width: v?.width || 0,
    height: v?.height || 0,
    duration: parseFloat(j.format?.duration || v?.duration || 0) || 0,
    hasAudio: !!a,
    videoCodec: v?.codec_name || '',
  }
}

// ---------- watermark geometry (1..9 grid, EasyImages-compatible) ----------

function waterXY(pos, w, h) {
  const col = (pos - 1) % 3, row = Math.floor((pos - 1) / 3)   // 0..2
  const xs = ['10', `(main_w-${w})/2`, `main_w-${w}-10`]
  const ys = ['10', `(main_h-${h})/2`, `main_h-${h}-10`]
  return { x: xs[col], y: ys[row] }
}

function watermarkFilters(pos) {
  const mode = conf('watermark')
  if (!mode) return []
  if (mode === 1) {
    const size = Math.round((conf('water_size') || 24) * 1.6)
    const { x, y } = waterXY(pos, 'text_w', 'text_h')
    return [`drawtext=text='${String(conf('water_text')).replace(/['\\:]/g, '')}':fontsize=${size}:fontcolor=${conf('water_color') || 'white@0.6'}:x=${x}:y=${y}:shadowcolor=black@0.4:shadowx=1:shadowy=1`]
  }
  // basename-only: the path comes from admin settings, keep it inside DATA_DIR
  const img = join(DATA_DIR, basename(conf('water_img') || 'watermark.png'))
  if (mode === 2 && existsSync(img)) return [{ image: img }]
  return []
}

// ---------- thumbnails ----------

export async function makeThumb(file, out, w = 320) {
  const seekAt = '00:00:01'
  await bin(FFMPEG, ['-y', '-ss', seekAt, '-i', file, '-frames:v', '1',
    '-vf', `scale='min(${w},iw)':-2`, '-q:v', '4', out], { timeout: 60_000 })
}

export async function makeImageThumb(file, out, w = 320) {
  await bin(FFMPEG, ['-y', '-i', file, '-frames:v', '1',
    '-vf', `scale='min(${w},iw)':-2`, '-q:v', '4', out], { timeout: 60_000 })
}

// ---------- transcode ----------

function scaleFilter(meta) {
  const parts = []
  if (conf('resize_enabled') && conf('resize_w') > 0) {
    const w = conf('resize_w'), h = conf('resize_h') > 0 ? conf('resize_h') : -2
    parts.push(`scale=${w}:${h}`)
  } else {
    const mw = conf('max_width'), mh = conf('max_height')
    if (mw > 0 || mh > 0) {
      // The expressions MUST be quoted: an unquoted comma inside min(w,iw) is
      // read as a filterchain separator and ffmpeg rejects the whole graph.
      const w = mw > 0 ? `'min(${mw},iw)'` : 'iw'
      const h = mh > 0 ? `'min(${mh},ih)'` : 'ih'
      parts.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`)
    }
  }
  return parts
}

/**
 * Decide + run the video pipeline. Returns { out, done } where out is the
 * final file (same as `file` when untouched) or null if nothing needed doing.
 */
/** Image-watermark overlay chain, honouring water_opacity. */
function overlayChain(vParts, xy) {
  const alpha = Math.min(1, Math.max(0, Number(conf('water_opacity')) || 0))
  // colorchannelmixer scales the overlay's alpha channel before compositing
  const prep = alpha < 1 ? `[1:v]format=rgba,colorchannelmixer=aa=${alpha}[wm];` : ''
  const wmLabel = alpha < 1 ? '[wm]' : '[1:v]'
  const base = vParts.length ? `[0:v]${vParts.join(',')}[v0];[v0]` : '[0:v]'
  return `${prep}${base}${wmLabel}overlay=${xy.x}:${xy.y}`
}

export async function processVideo(file, ext, meta) {
  if (!conf('process_enabled')) return null
  const jobs = []
  const wm = watermarkFilters(conf('water_position'))
  const filters = [...scaleFilter(meta)]
  const wmImage = wm.find(f => f.image)
  const wmText = wm.filter(f => typeof f === 'string')

  const convertTo = conf('convert_to')
  const needConvert = convertTo && convertTo !== ext
  const needCompress = !!conf('compress')
  const needWm = wm.length > 0
  if (!needConvert && !needCompress && !needWm && filters.length === 0) return null

  const targetExt = convertTo || ext
  const out = file + '.transcoding.' + targetExt
  const args = ['-y', '-i', file]
  if (wmImage) args.push('-i', wmImage.image)

  const vParts = [...filters, ...wmText]
  if (wmImage) {
    const xy = waterXY(conf('water_position'), 'overlay_w', 'overlay_h')
    args.push('-filter_complex',
      `${overlayChain(vParts, xy)}:format=auto,format=yuv420p[v]`, '-map', '[v]', '-map', '0:a?')
  } else {
    if (vParts.length === 0) vParts.push('format=yuv420p')
    args.push('-vf', vParts.join(','))
  }

  const crf = Math.min(35, Math.max(18, conf('crf') || 28))
  if (targetExt === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', String(crf + 4), '-b:v', '0', '-c:a', 'libopus')
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-c:a', 'aac', '-movflags', '+faststart')

  args.push(out)
  await bin(FFMPEG, args, { timeout: 30 * 60_000 })
  jobs.push(out)
  return { out, ext: targetExt, jobs }
}

// ---------- image processing (compress / watermark / resize) ----------

export async function processImage(file, ext) {
  if (!conf('process_enabled')) return null
  const wm = watermarkFilters(conf('water_position'))
  const need = conf('image_compress') || wm.length || (conf('max_width') > 0 || conf('max_height') > 0)
  if (!need) return null

  const quality = Math.min(100, Math.max(10, conf('image_quality') || 80))
  const qv = Math.max(2, Math.round(31 * (1 - quality / 100)))   // mjpeg qscale 2..31
  const filters = [...scaleFilter({})]
  const wmImage = wm.find(f => f.image)
  const wmText = wm.filter(f => typeof f === 'string')
  const out = file + '.proc.jpg'

  const args = ['-y', '-i', file]
  if (wmImage) args.push('-i', wmImage.image)
  const vParts = [...filters, ...wmText]
  if (wmImage) {
    const xy = waterXY(conf('water_position'), 'overlay_w', 'overlay_h')
    args.push('-filter_complex', `${overlayChain(vParts, xy)}[v]`, '-map', '[v]')
  } else if (vParts.length) args.push('-vf', vParts.join(','))
  args.push('-frames:v', '1', '-q:v', String(qv), out)
  await bin(FFMPEG, args, { timeout: 120_000 })
  return { out, ext: 'jpg' }
}

// ---------- frame extraction for moderation (raw RGB) ----------

/** Extract `n` small frames as raw RGB24 buffers: [{w,h,pixels}]. */
export async function extractFrames(file, n = 4, size = 96) {
  const frames = []
  const meta = await probe(file).catch(() => null)
  const dur = meta?.duration || 0
  for (let i = 1; i <= n; i++) {
    const at = dur > 2 ? (dur * i) / (n + 1) : i - 1
    try {
      const { out } = await bin(FFMPEG, [
        '-ss', at.toFixed(1), '-i', file, '-frames:v', '1',
        '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { capture: true, timeout: 30_000 })
      if (out.length === size * size * 3) frames.push({ w: size, h: size, pixels: out })
    } catch { /* skip unreadable frame */ }
  }
  return frames
}

/** Same for a still image. */
export async function imageToPixels(file, size = 128) {
  const { out } = await bin(FFMPEG, [
    '-i', file, '-frames:v', '1',
    '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { capture: true, timeout: 30_000 })
  return out.length === size * size * 3 ? { w: size, h: size, pixels: out } : null
}
