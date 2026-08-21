/**
 * Server-side messages in zh / en.
 *
 * The locale comes from `?lang=` first (explicit beats inference), then the
 * Accept-Language header. Anything that is not clearly Chinese falls back to
 * English, so an unlabelled client gets a language it can probably read.
 */

export const LOCALES = ['zh', 'en']
export const DEFAULT_LOCALE = 'zh'

const M = {
  // ---- auth ----
  'auth.badCredentials':   ['用户名或密码错误', 'Incorrect username or password'],
  'auth.unauthorized':     ['未登录', 'Not signed in'],
  'auth.forbidden':        ['无权访问', 'Forbidden'],
  'auth.loginThrottled':   ['尝试过于频繁，请稍后再试', 'Too many attempts — please try again later'],
  'auth.oldPasswordWrong': ['原密码错误', 'Current password is incorrect'],
  'auth.passwordTooShort': ['密码至少 6 位', 'Password must be at least 6 characters'],
  'auth.passwordTooLong':  ['密码过长', 'Password is too long'],
  'auth.badUsername':      ['用户名需为 2-32 位字母数字或汉字', 'Username must be 2-32 letters, digits or Chinese characters'],
  'auth.usernameTaken':    ['用户名已存在', 'That username is already taken'],

  // ---- registration ----
  'reg.closed':            ['本站未开放注册', 'Registration is closed on this site'],
  'reg.throttled':         ['注册过于频繁，请稍后再试', 'Too many sign-ups — please try again later'],
  'reg.captchaWrong':      ['验证码错误或已过期', 'The verification answer is wrong or expired'],
  'captcha.throttled':     ['请求过于频繁，请稍后再试', 'Too many requests — please try again later'],

  // ---- api keys ----
  'key.sessionOnly':       ['该操作需登录后进行，API Key 不可用', 'This action needs a signed-in session; an API key cannot do it'],
  'key.scopeMissing':      ['该 API Key 没有此操作的权限', 'This API key does not carry the scope for that'],
  'key.noScopes':          ['至少选择一项权限', 'Pick at least one scope'],
  'key.badStatus':         ['状态取值无效', 'Invalid status'],

  // ---- webhooks ----
  'hook.badUrl':           ['需为 http(s) 地址', 'Must be an http(s) URL'],
  'hook.privateTarget':    ['目标指向内网或回环地址；确需如此请在设置中开启「允许内网目标」',
                            'That target resolves to a private or loopback address. Turn on "allow private targets" in settings if you really mean it.'],
  'hook.unresolvable':     ['域名无法解析', 'That hostname does not resolve'],
  'hook.notFound':         ['Webhook 不存在', 'No such webhook'],
  'hook.badEvents':        ['事件名无效', 'Unknown event name'],

  // ---- backups ----
  'backup.notFound':       ['备份文件不存在', 'No such backup file'],
  'backup.failed':         ['备份失败', 'Backup failed'],

  // ---- users (admin) ----
  'user.notFound':         ['用户不存在', 'No such user'],
  'user.lastAdminLocked':  ['这是最后一个管理员，不能降权或禁用', 'This is the last administrator — cannot demote or disable'],
  'user.lastAdminDelete':  ['这是最后一个管理员，不能删除', 'This is the last administrator — cannot delete'],
  'user.cannotDeleteSelf': ['不能删除自己', 'You cannot delete your own account'],

  // ---- upload ----
  'up.loginRequired':      ['请先登录后上传', 'Please sign in before uploading'],
  'up.badType':            ['不支持的格式', 'Unsupported file type'],
  'up.tooLarge':           ['超过大小限制 ({0}MB)', 'Exceeds the size limit ({0}MB)'],
  'up.aborted':            ['上传中断', 'Upload interrupted'],
  'up.hashBlocked':        ['该文件被禁止上传', 'This file is not allowed'],
  'up.banned':             ['该文件已被隔离，禁止上传', 'This file is quarantined and cannot be uploaded'],
  'up.tooSmall':           ['分辨率 {0}x{1} 低于最低限制 {2}x{3}', 'Resolution {0}x{1} is below the {2}x{3} minimum'],
  'up.quotaUser':          ['超过每日上传上限 ({0}/天)', 'Daily upload limit reached ({0}/day)'],
  'up.quotaIp':            ['该 IP 超过每日上传上限 ({0}/天)', 'This IP has hit its daily upload limit ({0}/day)'],
  'up.diskFull':           ['服务器磁盘空间不足，暂时无法上传', 'The server is out of disk space; uploads are paused'],
  'up.tooManySessions':    ['未完成的上传会话过多，请先完成或取消', 'Too many unfinished upload sessions — finish or cancel some first'],
  'up.storageFull':        ['站点存储已达上限 ({0}GB)，请联系管理员清理', 'Site storage is full ({0}GB) — contact the administrator'],
  'up.dedup':              ['秒传(内容去重)', 'Instant upload (deduplicated)'],

  // ---- moderation ----
  'mod.deleted':           ['审核命中-已删除', 'Flagged by moderation — deleted'],
  'mod.quarantined':       ['审核命中-已隔离', 'Flagged by moderation — quarantined'],

  // ---- security ----
  'sec.ipBlacklisted':     ['IP 在黑名单中', 'Your IP is blocklisted'],
  'sec.ipNotWhitelisted':  ['IP 不在白名单中', 'Your IP is not on the allowlist'],
  'sec.hotlink':           ['禁止盗链', 'Hotlinking is not allowed'],

  // ---- share links ----
  'share.notFound':        ['分享链接不存在或已被撤销', 'That share link does not exist or was revoked'],
  'share.expired':         ['分享链接已过期', 'This share link has expired'],
  'share.exhausted':       ['分享链接的播放次数已用完', 'This share link has run out of views'],
  'share.wrongPassword':   ['口令错误', 'Wrong password'],
  'share.throttled':       ['口令尝试过于频繁，请稍后再试', 'Too many password attempts — please try again later'],
  'share.needsProtected':  ['该文件的可见性不是「仅限分享链接」，直链本来就能访问，无需分享链接',
                            'This file is not set to link-only, so its direct URL already works — a share link adds nothing'],
  'share.tooMany':         ['该文件的分享链接过多，请先撤销一些', 'Too many share links on this file — revoke some first'],
  'share.badLimits':       ['有效期与播放次数不能为负数', 'Expiry and view limit cannot be negative'],

  // ---- player page (server-rendered) ----
  'p.views':               ['{0} 次观看', '{0} views'],
  'p.locked':              ['需要口令', 'Password required'],
  'p.lockedHint':          ['这条分享链接受口令保护', 'This share link is password-protected'],
  'p.passwordPlaceholder': ['请输入口令', 'Enter the password'],
  'p.unlock':              ['打开', 'Unlock'],
  'p.askOwner':            ['请向分享者索取新的链接。', 'Ask whoever shared it for a new link.'],
  'p.expiresOn':           ['{0} 过期', 'expires {0}'],
  'p.viewsLeft':           ['还可播放 {0} 次', '{0} views left'],
  'p.needsShareLink':      ['该内容仅可通过分享链接访问', 'This content is only reachable through a share link'],
  'p.poweredBy':           ['由 {0} 提供 — 自托管视频床', 'Powered by {0} — self-hosted video hosting'],
  'p.htmlLang':            ['zh-CN', 'en'],

  // ---- content ----
  'c.notFound':            ['未找到', 'Not found'],
  'c.underReview':         ['内容审核中', 'Content under review'],
  'c.exploreClosed':       ['广场未开放', 'The gallery is not public'],
  'c.statsClosed':         ['统计未开放', 'Statistics are not public'],
  'c.statsLoginRequired':  ['请登录后查看统计', 'Sign in to view statistics'],
  'c.badVisibility':       ['可见性取值无效', 'Invalid visibility value'],
  'c.badHash':             ['需为 sha256 哈希', 'Must be a sha256 hash'],
  'c.ipRequired':          ['IP 不能为空', 'IP cannot be empty'],
  'c.internal':            ['服务器内部错误', 'Internal server error'],
}

/** Pick a locale for this request. */
export function lang(req, url = null) {
  const q = url?.searchParams?.get('lang')
  if (q && LOCALES.includes(q)) return q
  const al = String(req?.headers?.['accept-language'] || '')
  if (/\bzh\b|zh-/i.test(al)) return 'zh'
  if (al.trim()) return 'en'
  return DEFAULT_LOCALE
}

/** Translate `key` for the request, substituting {0}, {1}, … */
export function t(reqOrLocale, key, ...params) {
  const locale = typeof reqOrLocale === 'string' ? reqOrLocale : lang(reqOrLocale)
  const row = M[key]
  if (!row) return key                       // surfacing the key beats an empty string
  const s = row[locale === 'en' ? 1 : 0] ?? row[0]
  return s.replace(/\{(\d+)\}/g, (m, i) => (params[i] ?? m))
}

/** Error codes carried by thrown Errors so callers can localise them. */
export class AppError extends Error {
  constructor(key, ...params) {
    super(key)
    this.key = key
    this.params = params
  }
}
