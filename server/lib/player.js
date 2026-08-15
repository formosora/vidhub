/**
 * Server-rendered shareable player page — themed, with ad slots,
 * notice, custom head/footer code, and SEO meta from site settings.
 */
import { conf } from './config.js'
import { esc } from './util.js'
import { t } from './i18n.js'

export function playerPage(v, locale = 'zh') {
  const L = locale
  const title = v.orig || v.name
  const poster = `/t/${v.name}`
  const isImage = v.kind === 'image'
  const adTop = conf('ad_top') ? `<div class="ad">${conf('ad_top_info')}</div>` : ''
  const adBot = conf('ad_bot') ? `<div class="ad">${conf('ad_bot_info')}</div>` : ''
  const adPlayer = conf('player_ad') ? `<div class="ad ad-player">${conf('player_ad_info')}</div>` : ''
  const notice = conf('notice_status') ? `<div class="notice">${conf('notice')}</div>` : ''
  const media = isImage
    ? `<img src="/v/${v.name}" alt="${esc(title)}" style="max-width:100%;max-height:82vh;border-radius:12px">`
    : `<video src="/v/${v.name}" poster="${poster}" controls autoplay playsinline
        style="max-width:100%;max-height:82vh;outline:none;border-radius:12px;box-shadow:0 20px 60px #000a"></video>`

  return `<!doctype html>
<html lang="${t(L, 'p.htmlLang')}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(conf('title'))}</title>
<meta name="description" content="${esc(conf('description'))}">
<meta name="keywords" content="${esc(conf('keywords'))}">
<meta property="og:title" content="${esc(title)}">
${isImage ? `<meta property="og:image" content="${esc(`/v/${v.name}`)}">` : `<meta property="og:video" content="${esc(`/v/${v.name}`)}"><meta property="og:image" content="${esc(poster)}">`}
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:radial-gradient(1200px 600px at 70% -10%,#1c2540 0%,#0b0e17 55%,#07090f 100%);
    color:#e8ecf4;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
  .wrap{width:min(1080px,100%)}
  h1{font-size:1.05rem;font-weight:600;margin:0 0 14px;opacity:.9;word-break:break-all}
  .stage{display:flex;justify-content:center;background:#0006;border-radius:14px;padding:12px;backdrop-filter:blur(8px)}
  .meta{display:flex;gap:14px;margin-top:12px;font-size:.8rem;color:#8b93a7}
  .ad{margin:16px auto;text-align:center;max-width:100%}
  .ad img{max-width:100%;height:auto}
  .ad-player{margin:10px auto 0}
  .notice{margin:14px 0;padding:12px 16px;border:1px solid #f5c54244;border-radius:10px;background:#f5c54211;font-size:.85rem}
  footer{margin-top:22px;font-size:.75rem;color:#5a6378;text-align:center}
  a{color:#7ea2ff;text-decoration:none}
</style>
${conf('custom_head')}
</head><body>
<div class="wrap">
  <h1>🎬 ${esc(title)}</h1>
  ${adTop}
  <div class="stage">${media}</div>
  ${adPlayer}
  <div class="meta">
    <span>👁 ${t(L, 'p.views', v.views)}</span><span>📦 ${(v.size / 1048576).toFixed(1)} MB</span>
    ${v.width ? `<span>📐 ${v.width}×${v.height}</span>` : ''}
    <span>🕐 ${esc((v.uploaded || '').slice(0, 10))}</span>
  </div>
  ${notice}
  ${adBot}
  <footer>${t(L, 'p.poweredBy', `<a href="/">${esc(conf('title'))}</a>`)}</footer>
</div>
${conf('footer_code')}
</body></html>`
}

export function imagePage(v) { return playerPage(v) }
