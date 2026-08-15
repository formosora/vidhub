# 🎬 vidhub · self-hosted video hosting

Upload a video, get a streamable link and embed code back immediately.
A Vue 3 portal and admin panel, a **zero-npm-dependency** Node server (SQLite built
in), and an ffmpeg media pipeline — all in one Docker container.

**English** · [简体中文](README.zh-CN.md)

![Vue](https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Node](https://img.shields.io/badge/Node.js_24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)

## ✨ Features

**Upload & storage**
- Streaming upload with a rolling SHA-256 — nothing is buffered in memory, and
  content-addressed storage means an identical file is deduplicated instantly
- Batch uploads, size and extension allowlists, minimum-resolution rejection
- Video, images, and optionally any file type

**Media pipeline (ffmpeg)**
- Transcode everything to MP4 (H.264) or WebM (VP9), with an adjustable CRF
- Text and image watermarks on a 3×3 position grid, proportional or forced
  scaling, upper and lower size bounds
- Automatic thumbnails; real HTTP Range/206 streaming, so seeking is instant

**Content safety**
- 🛡️ NSFW moderation: a local skin-tone frame heuristic (free) or an external
  moderation API, quarantining or deleting on a hit
- IP allow/block lists (`1.2.3.*` and CIDR), file-hash blocklist, hotlink protection
- Upload log with IP geolocation, per-IP and per-user daily caps, a site-wide
  storage quota, and login rate limiting
- Uploads are served with `nosniff` and a `sandbox` CSP; anything that is not
  video or image is forced to download, so an uploaded HTML or SVG file can
  never run script on your origin

**Multi-user & API**
- Two roles — administrator and uploader — with per-user daily caps, account
  disabling, and password resets
- Optional self-service registration behind a stroke-drawn arithmetic CAPTCHA
- Per-file public/unlisted visibility, with a per-account default
- Full English/Chinese localisation of the UI *and* the API
- API keys (`Authorization: Bearer vh_xxx`) for third-party upload tools
- Recycle bin (soft delete, restore, permanent delete)

**Portal**
- Gallery with thumbnails and search, statistics page, player pages with OG tags
- Top/bottom/player ad slots, site-wide notice, custom head and footer code
- Configurable link domain, for serving through a CDN or a separate origin

## 🚀 Deployment

```bash
docker build -t vidhub .
docker run -d --name vidhub -p 8081:8080 \
  -v vidhub-data:/app/data \
  -e ADMIN_PASSWORD="choose-a-strong-one" \
  vidhub
# portal → http://localhost:8081/   admin → sign in as "admin"
```

Or `docker compose up -d`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `change-me` | Password for the admin account created on first boot (**change it**) |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/app/data` | Data directory (videos, thumbnails, SQLite) |
| `TRUST_PROXY` | `1` | Read the real client IP from `X-Forwarded-For` behind a reverse proxy |
| `FFMPEG_PATH` | `ffmpeg` | Path to a custom ffmpeg binary |

> Without ffmpeg the server falls back to storing originals as-is. Transcoding,
> watermarking and moderation switch off; everything else keeps working.

## 🔌 API

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /api/health` | public | Liveness probe (used by the Docker healthcheck) |
| `POST /api/login` | public | Sign in (rate limited) |
| `GET /api/captcha` | public | Fetch a challenge → `{id, svg, ttl}` (rate limited, single use) |
| `POST /api/register` | public\* | Self-registration (\*must be enabled in admin; rate limited + CAPTCHA) |
| `POST /api/videos?name=…` | user/guest\* | Upload (binary body; \*guest uploads must be enabled) |
| `GET /api/videos?page=&q=` | user | Own videos (admins add `all=1` for the whole site) |
| `DELETE /api/videos/<name>` | owner | Move to the recycle bin |
| `POST /api/videos/<name>/restore` · `DELETE …/force` | owner | Restore / delete permanently |
| `PATCH /api/videos/<name>` | owner | Change visibility, `{visibility:"public"\|"private"}` |
| `POST /api/videos/<name>/ban` · `/unban` | admin | Quarantine / release |
| `GET/PATCH /api/me` | user | Read or update personal preferences (default visibility) |
| `GET/PUT /api/admin/settings` | admin | All site settings |
| `GET/POST/PATCH/DELETE /api/admin/users…` | admin | User management |
| `GET /api/admin/logs` · `…/iprules` · `…/hashblack` | admin | Logs / IP rules / hash blocklist |
| `GET /api/public/videos` · `/api/stats` | public\* | Gallery / statistics (\*can be closed; never includes uploader IP or username) |
| `GET /v/<name>` | public | Media stream (Range/206) |
| `GET /t/<name>` · `/p/<name>` · `/d/<name>` | public | Thumbnail / player page / download |

## 📁 Layout

```
├── frontend/       # Vue 3 + TS + Vite portal and admin panel
├── server/
│   ├── server.js   # entry point: API / media streaming / player pages / static
│   └── lib/        # db · config · auth · security · upload · media · moderate · player · i18n · captcha
├── test/           # smoke.sh · pipeline.sh · captcha.test.mjs
├── Dockerfile      # multi-stage build, single container, ffmpeg included
└── docker-compose.yml
```

## 💻 Local development (no Docker)

Needs Node 22+ for `node:sqlite`. ffmpeg is optional.

```bash
cd frontend && npm install && npm run build && cp -r dist ../server/wwwroot && cd ..
DATA_DIR=./data PORT=8080 ADMIN_PASSWORD=dev-password node --no-warnings server/server.js
```

For frontend hot reload use `npm run dev` — `/api` is already proxied to 8080.

**Installing ffmpeg on Windows** (no administrator rights needed): download
`ffmpeg-release-essentials.zip` from <https://www.gyan.dev/ffmpeg/builds/>, check
it against the `.sha256` published alongside it, extract to
`%LOCALAPPDATA%\Programs\ffmpeg`, and add that folder's `bin` to your user PATH.

## 🧪 Tests

Both scripts really do upload, ban and rewrite settings, so **always point them at
a throwaway data directory**:

```bash
DATA_DIR=/tmp/vh-test PORT=8098 ADMIN_PASSWORD=TestPass123 node server/server.js &
BASE=http://localhost:8098 ADMIN_PASSWORD=TestPass123 bash test/smoke.sh
```

`test/smoke.sh` — 88 assertions, no ffmpeg required. Covers registration and the
CAPTCHA, visibility and gallery filtering, share-link formats, the bilingual API,
uploads that must not be executable, the last administrator that must not be
lockable, public endpoints that must not leak IPs, settings clamping, quarantined
content that must not be re-uploadable, quotas and hotlink protection,
authorization boundaries, and Range/path-traversal handling.

```bash
DATA_DIR=/tmp/vh-pipe PORT=8097 ADMIN_PASSWORD=TestPass123 node server/server.js &
BASE=http://localhost:8097 DATA_DIR=/tmp/vh-pipe bash test/pipeline.sh
```

`test/pipeline.sh` — 28 assertions, needs ffmpeg. Generates its own footage, then
checks that a public link survives a real transcode, that the watermark is
genuinely burned into the pixels, that `max_width` scaling works, and that the
minimum-resolution gate, image pipeline and local moderation all behave.

The CAPTCHA module has unit tests that need no running server:

```bash
node --test test/captcha.test.mjs
```

## 🔒 Security notes

- Session tokens live in `localStorage` and travel in the `Authorization` header.
  No cookies, so there is no CSRF surface.
- Uploads share the portal's origin, but anything that is not video or image is
  returned as `application/octet-stream` with `Content-Disposition: attachment`,
  and every `/v/` response carries a `sandbox` CSP and `nosniff`.
- The system always keeps at least one usable administrator — demoting,
  disabling or deleting the last one is refused.
- Custom head/footer/ad fields are **raw HTML injection points held by the
  administrator** and are deliberately not escaped. Only grant admin to people
  you trust with that.
- Self-registration is **off** by default. When enabled, new accounts are always
  uploaders. Rate limiting is split in two: attempts get a generous ceiling to
  stop brute-forcing, while *successful* sign-ups are capped strictly by
  `register_rate_limit` to stop bulk account creation — so a human who fumbles
  the CAPTCHA is not locked out for an hour.
- ⚠️ The built-in CAPTCHA is a **simple** measure. The arithmetic is drawn as
  line segments and the SVG contains no text, so a script cannot read the answer
  out of the response body — but seven-segment digits do not hold up to real OCR.
  For a public commercial deployment, swap in Cloudflare Turnstile or hCaptcha.
- ⚠️ Local skin-tone moderation is a heuristic with meaningful false-positive and
  false-negative rates (pale walls and beaches trip it easily). For commercial
  use, switch to the external moderation API mode and connect a real content
  safety service.

## 🌏 Bilingual

The UI language follows the browser (`navigator.language`) on a first visit,
is then remembered in `localStorage`, and can be switched at any time from the
header. API errors are returned in the language given by `Accept-Language`, and
`?lang=zh|en` overrides it explicitly. The server-rendered player page follows
the same rules.

Error responses also carry a machine-readable `code`, so an integration can do
its own localisation:

```json
{ "error": "Incorrect username or password", "code": "auth.badCredentials" }
```

Upload logs store `key|params` rather than a finished sentence, so switching
language re-renders **historical log rows** too.

To add a language, append a column to the tables in `server/lib/i18n.js` and
`frontend/src/i18n.ts`.

## 👁 Visibility

Every file is either `public` or `private`:

| | Listed in the gallery | Direct link / player / embed |
| --- | --- | --- |
| Public | ✅ | ✅ |
| Unlisted (`private`) | ❌ | ✅ |

> ⚠️ **"Unlisted" means unlisted, not locked.** A video host's links have to be
> shareable and embeddable; putting them behind authentication would break embeds
> outright. Filenames are the first 16 hex characters of the content's SHA-256 and
> cannot be enumerated, which is private enough for everyday use — but **do not
> use this for sensitive material**. Real access control is a separate feature.

Users set their default under *My files → Account* and can override it per upload.
Administrators set the default for new accounts under *Settings → Registration*,
and can change the visibility of any file from the video list.
