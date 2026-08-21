/**
 * Server-rendered shareable player page — themed, with ad slots,
 * notice, custom head/footer code, and SEO meta from site settings.
 *
 * The same page backs both `/p/<name>` (ordinary videos) and `/s/<token>`
 * (share links). A share passes a signed `grant`, which is appended to the
 * media and poster URLs so /v/ and /t/ will serve a `protected` video; without
 * one the markup is byte-for-byte what it always was.
 */
import { conf } from './config.js'
import { esc } from './util.js'
import { t } from './i18n.js'

const CSS = `
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:radial-gradient(1200px 600px at 70% -10%,#1c2540 0%,#0b0e17 55%,#07090f 100%);
    color:#e8ecf4;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
  .wrap{width:min(1080px,100%)}
  h1{font-size:1.05rem;font-weight:600;margin:0 0 14px;opacity:.9;word-break:break-all}
  .stage{display:flex;justify-content:center;background:#0006;border-radius:14px;padding:12px;backdrop-filter:blur(8px)}
  .meta{display:flex;gap:14px;margin-top:12px;font-size:.8rem;color:#8b93a7;flex-wrap:wrap}
  .ad{margin:16px auto;text-align:center;max-width:100%}
  .ad img{max-width:100%;height:auto}
  .ad-player{margin:10px auto 0}
  .notice{margin:14px 0;padding:12px 16px;border:1px solid #f5c54244;border-radius:10px;background:#f5c54211;font-size:.85rem}
  footer{margin-top:22px;font-size:.75rem;color:#5a6378;text-align:center}
  a{color:#7ea2ff;text-decoration:none}`

/** The unlock form, and the page shown when a link is expired or used up. */
const GATE_CSS = `
  .gate{width:min(380px,100%);margin:0 auto;background:#111726cc;border:1px solid #ffffff14;
    border-radius:16px;padding:28px 26px;text-align:center;backdrop-filter:blur(10px)}
  .gate .lock{font-size:2rem;line-height:1}
  .gate h2{font-size:1rem;font-weight:600;margin:12px 0 6px}
  .gate p{margin:0 0 18px;font-size:.83rem;color:#8b93a7}
  .gate input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid #ffffff1f;
    background:#0b0e17;color:#e8ecf4;font-size:.95rem;outline:none}
  .gate input:focus{border-color:#7ea2ff88}
  .gate button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:10px;cursor:pointer;
    background:linear-gradient(135deg,#4f7cff,#7ea2ff);color:#fff;font-size:.95rem;font-weight:600}
  .gate .err{margin:12px 0 0;color:#ff8b8b;font-size:.82rem}`

const shell = (title, head, bodyInner, extraCss = '') => `<!doctype html>
<html lang="${head.lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${head.meta || ''}
<style>${CSS}${extraCss}</style>
${conf('custom_head')}
</head><body>
${bodyInner}
${conf('footer_code')}
</body></html>`

export function playerPage(v, locale = 'zh', { grant = '', share = null } = {}) {
  const L = locale
  const title = v.orig || v.name
  const k = grant ? `?k=${encodeURIComponent(grant)}` : ''
  const src = `/v/${v.name}${k}`
  const poster = `/t/${v.name}${k}`
  const isImage = v.kind === 'image'
  const adTop = conf('ad_top') ? `<div class="ad">${conf('ad_top_info')}</div>` : ''
  const adBot = conf('ad_bot') ? `<div class="ad">${conf('ad_bot_info')}</div>` : ''
  const adPlayer = conf('player_ad') ? `<div class="ad ad-player">${conf('player_ad_info')}</div>` : ''
  const notice = conf('notice_status') ? `<div class="notice">${conf('notice')}</div>` : ''
  const media = isImage
    ? `<img src="${src}" alt="${esc(title)}" style="max-width:100%;max-height:82vh;border-radius:12px">`
    : `<video src="${src}" poster="${poster}" controls autoplay playsinline
        style="max-width:100%;max-height:82vh;outline:none;border-radius:12px;box-shadow:0 20px 60px #000a"></video>`

  // What the recipient of a share link is subject to, stated plainly rather
  // than discovered when the link stops working.
  const limits = []
  if (share?.expires > 0) limits.push(`⏳ ${t(L, 'p.expiresOn', new Date(share.expires).toISOString().slice(0, 16).replace('T', ' '))}`)
  if (share?.max_views > 0) limits.push(`🎟 ${t(L, 'p.viewsLeft', Math.max(0, share.max_views - share.views))}`)

  const meta = `<meta name="description" content="${esc(conf('description'))}">
<meta name="keywords" content="${esc(conf('keywords'))}">
<meta property="og:title" content="${esc(title)}">
${isImage
    ? `<meta property="og:image" content="${esc(src)}">`
    : `<meta property="og:video" content="${esc(src)}"><meta property="og:image" content="${esc(poster)}">`}`

  return shell(`${esc(title)} · ${esc(conf('title'))}`, { lang: t(L, 'p.htmlLang'), meta }, `<div class="wrap">
  <h1>🎬 ${esc(title)}</h1>
  ${adTop}
  <div class="stage">${media}</div>
  ${adPlayer}
  <div class="meta">
    <span>👁 ${t(L, 'p.views', v.views)}</span><span>📦 ${(v.size / 1048576).toFixed(1)} MB</span>
    ${v.width ? `<span>📐 ${v.width}×${v.height}</span>` : ''}
    <span>🕐 ${esc((v.uploaded || '').slice(0, 10))}</span>
    ${limits.map(s => `<span>${s}</span>`).join('')}
  </div>
  ${notice}
  ${adBot}
  <footer>${t(L, 'p.poweredBy', `<a href="/">${esc(conf('title'))}</a>`)}</footer>
</div>`)
}

/** Password prompt for a protected share link. */
export function unlockPage(token, locale = 'zh', { error = '' } = {}) {
  const L = locale
  return shell(`${t(L, 'p.locked')} · ${esc(conf('title'))}`,
    { lang: t(L, 'p.htmlLang'), meta: '<meta name="robots" content="noindex">' },
    `<div class="wrap"><form class="gate" method="post" action="/s/${esc(token)}">
  <div class="lock">🔒</div>
  <h2>${t(L, 'p.locked')}</h2>
  <p>${t(L, 'p.lockedHint')}</p>
  <input type="password" name="password" autofocus autocomplete="off"
         placeholder="${t(L, 'p.passwordPlaceholder')}" maxlength="200">
  <button type="submit">${t(L, 'p.unlock')}</button>
  ${error ? `<p class="err">${t(L, error)}</p>` : ''}
</form></div>`, GATE_CSS)
}

/**
 * A collection: the first playable item up top, the rest as a clickable strip
 * beneath it. Rendered server-side like the player page so it can be embedded
 * and shared without the SPA.
 */
export function collectionPage(c, items, locale = 'zh', active = 0) {
  const L = locale
  const cur = items[active] || items[0]
  const notice = conf('notice_status') ? `<div class="notice">${conf('notice')}</div>` : ''
  const media = !cur
    ? `<p class="cempty">${t(L, 'coll.empty')}</p>`
    : cur.kind === 'image'
      ? `<img src="/v/${cur.name}" alt="${esc(cur.orig || cur.name)}" style="max-width:100%;max-height:70vh;border-radius:12px">`
      : `<video src="/v/${cur.name}" poster="/t/${cur.name}" controls playsinline
          style="max-width:100%;max-height:70vh;outline:none;border-radius:12px;box-shadow:0 20px 60px #000a"></video>`

  // A thumbnail can legitimately be absent (pipeline still running, or ffmpeg
  // unavailable). Hide the broken image rather than showing a torn tile — the
  // filename underneath still identifies the entry.
  const strip = items.map((v, i) => `<a class="citem${i === active ? ' on' : ''}" href="/c/${c.id}?i=${i}">
    <img src="/t/${v.name}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <span>${esc(v.orig || v.name)}</span>
  </a>`).join('')

  const meta = `<meta name="description" content="${esc(c.descr || conf('description'))}">
<meta property="og:title" content="${esc(c.title)}">
${cur ? `<meta property="og:image" content="/t/${cur.name}">` : ''}
${c.visibility === 'public' ? '' : '<meta name="robots" content="noindex">'}`

  return shell(`${esc(c.title)} · ${esc(conf('title'))}`, { lang: t(L, 'p.htmlLang'), meta }, `<div class="wrap">
  <h1>📚 ${esc(c.title)}</h1>
  ${c.descr ? `<p class="cdesc">${esc(c.descr)}</p>` : ''}
  <div class="stage">${media}</div>
  ${cur ? `<div class="meta"><span>${esc(cur.orig || cur.name)}</span><span>${t(L, 'p.views', cur.views)}</span></div>` : ''}
  <div class="cstrip">${strip}</div>
  ${notice}
  <footer>${t(L, 'p.poweredBy', `<a href="/">${esc(conf('title'))}</a>`)}</footer>
</div>`, COLL_CSS)
}

const COLL_CSS = `
  body{justify-content:flex-start;padding-top:34px}
  .cdesc{margin:-6px 0 14px;font-size:.84rem;color:#8b93a7;white-space:pre-wrap}
  .cempty{margin:38px 0;color:#8b93a7;font-size:.9rem}
  .cstrip{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:16px}
  .citem{display:block;border-radius:10px;overflow:hidden;background:#0006;border:1px solid #ffffff12;
    text-decoration:none;transition:border-color .15s}
  .citem:hover{border-color:#7ea2ff66}
  .citem.on{border-color:#7ea2ff}
  .citem img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#0b0e17}
  .citem span{display:block;padding:7px 9px;font-size:.74rem;color:#c9d2e4;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`

/** Expired, used up, or revoked — a dead end that says which. */
export function gonePage(reasonKey, locale = 'zh') {
  const L = locale
  return shell(`${t(L, reasonKey)} · ${esc(conf('title'))}`,
    { lang: t(L, 'p.htmlLang'), meta: '<meta name="robots" content="noindex">' },
    `<div class="wrap"><div class="gate">
  <div class="lock">🔗</div>
  <h2>${t(L, reasonKey)}</h2>
  <p>${t(L, 'p.askOwner')}</p>
</div></div>`, GATE_CSS)
}
