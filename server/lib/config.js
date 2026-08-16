/**
 * Site settings — EasyImages2.0-style config model, stored in SQLite.
 * Everything is a plain JSON value keyed by name; cached in memory.
 */
import { q } from './db.js'

export const DEFAULTS = {
  // ---- site ----
  title: 'vidhub · 视频床',
  keywords: '视频床,视频上传,视频分享,自托管',
  description: '自托管商业级视频床：流式上传、秒播、鉴黄审核、水印转码。',
  notice_status: 0,
  notice: '',
  tips: '单文件 ≤ 500MB，支持常见视频格式',
  domain: '',                       // public origin used in copied links; empty = request origin
  custom_head: '',                  // 自定义代码 (<head> injection, player + portal)
  footer_code: '',                  // 统计脚本等, injected before </body>
  terms: '',

  // ---- registration ----
  allow_register: 0,                // 开放自助注册
  register_captcha: 1,              // 注册需通过人机验证
  register_daily_limit: 0,          // 注册用户的每日上传上限, 0 = 跟随全局
  register_rate_limit: 5,           // 每 IP 每小时注册尝试

  // ---- upload ----
  must_login: 1,                    // 仅登录后上传
  allow_guest: 0,                   // 匿名上传 (must_login=0 时生效)
  max_size_mb: 500,
  max_upload_files: 5,              // 单次批量
  extensions: 'mp4,webm,mov,m4v,mkv,avi,ts,flv,wmv,3gp',
  allow_images: 1,                  // 同时接受图片 (走同一管线)
  image_extensions: 'jpg,jpeg,png,gif,webp,bmp',
  allow_other: 0,                   // 任意文件 (直链下载, 不处理)
  storage_quota_gb: 0,              // 0 = 不限
  daily_limit_ip: 0,                // 每 IP 每日上传次数, 0 = 不限
  daily_limit_user: 0,              // 每用户每日, 0 = 不限

  // ---- media pipeline (ffmpeg) ----
  process_enabled: 1,               // 总开关; 无 ffmpeg 时自动无效
  convert_to: '',                   // '' = 保持原始, 'mp4' | 'webm' 统一转码
  compress: 0,                      // 压缩开关 (CRF 转码)
  crf: 28,                          // 18..35, 越大越小
  max_width: 0,                     // 超宽自动等比缩小, 0 = 不处理
  max_height: 0,
  min_width: 0,                     // 低于此拒绝上传, 0 = 不限制
  min_height: 0,
  resize_enabled: 0,                // 强制输出指定宽高 (等比缩放)
  resize_w: 0,
  resize_h: 0,
  thumbnail: 1,
  thumbnail_w: 320,
  image_compress: 0,                // 图片压缩 (质量%)
  image_quality: 80,

  // ---- watermark ----
  watermark: 0,                     // 0 关 / 1 文字 / 2 图片
  water_text: 'vidhub',
  water_position: 9,                // 1..9 九宫格
  water_color: 'white@0.6',
  water_size: 24,                   // 相对高度百分比 2..20 → font size factor
  water_img: '',                    // data/watermark.png 相对路径
  water_opacity: 0.6,

  // ---- moderation 鉴黄 ----
  check_img: 0,                     // 0 关 / 1 本地抽帧肤色检测 / 2 外部审核 API
  check_img_value: 60,              // 判定阈值: 肤色像素占比 %
  check_action: 'ban',              // ban = 标记隔离, delete = 直接删除
  check_api_url: '',                // 外部审核 webhook: POST {url, name} → {score:0..1} 或 {label:'porn'|'ok'}
  check_api_key: '',

  // ---- security ----
  check_ip: 0,                      // 0 关 / 1 黑名单 / 2 白名单
  upload_logs: 1,
  ip_locate: 1,                     // 上传日志 IP 归属地 (在线查询, 失败自动降级)
  hash_black: 1,                    // sha256 黑名单开关
  anti_leech: 0,                    // 防盗链: 校验 Referer 白名单
  leech_hosts: '',                  // 允许的域名, 逗号分隔, 空 = 仅本站
  leech_allow_empty: 1,             // 无 Referer 时放行 (直接打开/下载工具); 0 = 一并拦截
  login_rate_limit: 10,             // 每 IP 每小时登录尝试

  // ---- sessions ----
  session_hours: 12,                // 普通会话时长; 活跃时自动滑动续期
  session_remember_days: 30,        // 勾选「记住我」后的会话时长
  session_max_days: 90,             // 从首次登录起的硬上限, 0 = 不限

  // ---- visibility ----
  default_visibility: 'public',     // 新账号/游客上传的默认可见性: public | private

  // ---- portal ----
  explore_public: 1,                // 广场公开
  explore_images: 0,                // 广场同时展示图片
  // 统计默认仅登录可见 —— 存储量/上传量属于经营数据, 不该对匿名访客敞开。
  // 登录用户看自己的, 管理员看全站; 打开此项则匿名访客也能看全站汇总。
  stats_public: 0,                  // 匿名访客也能看全站统计
  ad_top: 0,
  ad_top_info: '',
  ad_bot: 0,
  ad_bot_info: '',
  player_ad: 0,                     // 播放页暂停/贴片广告 HTML
  player_ad_info: '',
}

/**
 * Range clamps for numeric settings. Anything numeric not listed here still gets
 * coerced to a finite number — a NaN slipping through used to disable the upload
 * size cap entirely (`size > NaN` is always false).
 */
const LIMITS = {
  max_size_mb: [1, 1024 * 100],
  max_upload_files: [1, 100],
  storage_quota_gb: [0, 1024 * 100],
  daily_limit_ip: [0, 100000],
  daily_limit_user: [0, 100000],
  crf: [18, 35],
  max_width: [0, 16384], max_height: [0, 16384],
  min_width: [0, 16384], min_height: [0, 16384],
  resize_w: [0, 16384], resize_h: [0, 16384],
  thumbnail_w: [16, 4096],
  image_quality: [10, 100],
  water_position: [1, 9],
  water_size: [2, 200],
  water_opacity: [0, 1],
  check_img: [0, 2], check_img_value: [1, 100], check_ip: [0, 2],
  watermark: [0, 2],
  login_rate_limit: [1, 10000],
  register_daily_limit: [0, 100000],
  register_rate_limit: [1, 1000],
  session_hours: [1, 24 * 365],
  session_remember_days: [1, 3650],
  session_max_days: [0, 3650],
}

/** Coerce an incoming setting to the shape its default declares. */
function coerce(key, value) {
  const def = DEFAULTS[key]
  if (typeof def === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return def
    const [lo, hi] = LIMITS[key] || [-Infinity, Infinity]
    return Math.min(hi, Math.max(lo, n))
  }
  if (typeof def === 'string') return String(value ?? '')
  return value
}

const cache = new Map()
let loaded = false

function ensureLoaded() {
  if (loaded) return
  for (const row of q.all('SELECT key, value FROM settings')) {
    try { cache.set(row.key, JSON.parse(row.value)) } catch { /* skip */ }
  }
  loaded = true
}

export function conf(key) {
  ensureLoaded()
  if (cache.has(key)) return cache.get(key)
  return DEFAULTS[key]
}

export function confAll() {
  ensureLoaded()
  const out = { ...DEFAULTS }
  for (const [k, v] of cache) out[k] = v
  return out
}

export function setConf(patch) {
  ensureLoaded()
  if (!patch || typeof patch !== 'object') return
  for (const [k, raw] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue            // reject unknown keys
    const v = coerce(k, raw)                  // …and reject unusable values
    cache.set(k, v)
    q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      k, JSON.stringify(v))
  }
}

/** Numeric read that survives a legacy row holding a bad value. */
export function confNum(key) {
  const n = Number(conf(key))
  return Number.isFinite(n) ? n : Number(DEFAULTS[key]) || 0
}

/** Keys safe to expose to anonymous visitors. */
export const PUBLIC_KEYS = [
  'title', 'keywords', 'description', 'notice', 'notice_status', 'tips',
  'custom_head', 'footer_code', 'terms', 'must_login', 'allow_guest', 'max_size_mb',
  'max_upload_files', 'extensions', 'allow_images', 'image_extensions', 'allow_other',
  'explore_public', 'stats_public', 'ad_top', 'ad_top_info', 'ad_bot', 'ad_bot_info',
  'thumbnail', 'domain', 'allow_register',
]

export function publicConf() {
  const all = confAll()
  return Object.fromEntries(PUBLIC_KEYS.map(k => [k, all[k]]))
}
