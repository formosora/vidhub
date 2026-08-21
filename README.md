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
- Per-file public / unlisted / link-only visibility, with a per-account default
- Share links with an optional password, expiry and view limit — revocable one by one
- Full English/Chinese localisation of the UI *and* the API
- API keys (`Authorization: Bearer vh_xxx`) for third-party upload tools
- Recycle bin (soft delete, restore, permanent delete)
- Scheduled database backups with retention, downloadable from the admin panel

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

**Public**

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness probe (used by the Docker healthcheck) |
| `GET /api/config/public` | Site settings safe to expose (title, limits, toggles) |
| `POST /api/login` · `POST /api/logout` | Sign in (rate limited) / sign out |
| `GET /api/captcha` | Fetch a challenge → `{id, svg, ttl}` (rate limited, single use) |
| `POST /api/register` | Self-registration — must be enabled in admin; rate limited + CAPTCHA |
| `GET /api/public/videos` | Gallery. Can be closed; never includes uploader IP or username |
| `GET /v/<name>` · `/t/<name>` · `/p/<name>` · `/d/<name>` | Stream (Range/206) / thumbnail / player page / download |
| `GET/POST /s/<token>` | Share link — player page, or the password prompt when one is set |

**Signed in**

| Endpoint | Purpose |
| --- | --- |
| `POST /api/videos?name=…&visibility=…` | Upload (binary body). Guests too, if guest uploads are enabled |
| `GET /api/videos?page=&q=&status=&visibility=` | Own videos; admins add `all=1` for the whole site |
| `GET /api/videos/<name>` | One item (owner or admin) |
| `PATCH /api/videos/<name>` | Change visibility, `{visibility:"public"\|"private"}` |
| `DELETE /api/videos/<name>` | Move to the recycle bin |
| `GET/POST /api/videos/<name>/shares` | List / issue share links (link-only files) |
| `DELETE /api/shares/<token>` | Revoke one share link, immediately |
| `POST /api/videos/<name>/restore` · `DELETE …/force` | Restore / delete permanently |
| `GET /api/recycle` | Recycle bin; admins add `all=1` for the whole site |
| `DELETE /api/recycle` | Purge the bin — own, or site-wide for an admin with `all=1` |
| `GET/PATCH /api/me` | Read or update personal preferences (default visibility) |
| `POST /api/me/password` | Change own password (invalidates every session) |
| `GET/POST /api/me/keys` · `PATCH/DELETE /api/me/keys/<key>` | API key management (session only) |
| `POST /api/uploads` | Start a resumable upload → `{id, offset, chunk_size}` |
| `GET /api/uploads/<id>` | How many bytes the server holds, for resuming |
| `PATCH /api/uploads/<id>?offset=N` | Append one chunk at a known offset |
| `POST /api/uploads/<id>/finish` · `DELETE /api/uploads/<id>` | Finalise / abandon |
| `GET /api/stats` | Site-wide for admins, own figures for uploaders, anonymous only if `stats_public` |

**Admin**

| Endpoint | Purpose |
| --- | --- |
| `POST /api/videos/<name>/ban` · `/unban` | Quarantine / release |
| `GET/PUT /api/admin/settings` | All site settings |
| `GET /api/admin/check` | Environment probe → `{ok, ffmpeg}` |
| `GET /api/admin/stats` | Site figures plus users, quarantined, bin size, top IPs |
| `GET /api/admin/jobs` | The 50 most recent pipeline jobs |
| `GET/POST /api/admin/backups` | List backups / take one now |
| `GET/DELETE /api/admin/backups/<file>` | Download / delete a snapshot |
| `GET/POST /api/admin/users` · `PATCH/DELETE /api/admin/users/<id>` | User management |
| `GET /api/admin/logs?ip=` | Upload log with IP geolocation |
| `GET/POST /api/admin/iprules` · `DELETE …/<id>` | IP allow/block rules |
| `GET/POST /api/admin/hashblack` · `DELETE …/<sha256>` | File-hash blocklist |
| `GET/POST /api/admin/webhooks` · `PATCH/DELETE …/<id>` | Webhook endpoints |
| `POST /api/admin/webhooks/<id>/test` · `GET …/webhooks/log` | Send a test ping / delivery log |

## 📁 Layout

```
├── frontend/       # Vue 3 + TS + Vite portal and admin panel
├── server/
│   ├── server.js   # entry point: API / media streaming / player pages / static
│   └── lib/        # db · config · auth · security · upload · media · moderate · player
│                   # shares · backup · webhooks · resumable · i18n · captcha
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

`test/smoke.sh` — 230 assertions, no ffmpeg required. Covers registration and the
CAPTCHA, visibility and gallery filtering, share-link formats, the bilingual API,
uploads that must not be executable, the last administrator that must not be
lockable, public endpoints that must not leak IPs, settings clamping, quarantined
content that must not be re-uploadable, quotas and hotlink protection,
authorization boundaries, and Range/path-traversal handling.

```bash
DATA_DIR=/tmp/vh-pipe PORT=8097 ADMIN_PASSWORD=TestPass123 node server/server.js &
BASE=http://localhost:8097 DATA_DIR=/tmp/vh-pipe bash test/pipeline.sh
```

`test/pipeline.sh` — 33 assertions, needs ffmpeg. Generates its own footage, then
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
- `private` is unlisted, not locked — see [Visibility](#-visibility). `protected`
  is the level with real access control: every direct URL is refused and a signed,
  short-lived, per-file grant minted by a share page is required to stream.
- Share passwords are scrypt-hashed with a per-link salt and are never returned
  by the API. Revoking a link takes effect immediately; grants it already handed
  out lapse within hours rather than being individually recallable.
- Backup snapshots contain **everything** — password hashes, API keys, the share
  signing key. Treat a downloaded snapshot exactly as you would the live database.
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

## 📊 Statistics

Figures are scoped to whoever is asking, because storage and upload volume are
operational numbers rather than public showcase material:

| Caller | Sees |
| --- | --- |
| Administrator | The whole site |
| Signed-in uploader | Only their own uploads |
| Anonymous | Nothing, unless `stats_public` is turned on |

`stats_public` is **off** by default. Turning it on exposes site-wide totals to
everyone, which is a deliberate choice for a public showcase.

## 👁 Visibility

Every file sits at one of three levels:

| | Listed in the gallery | Direct link / player / embed | Share link |
| --- | --- | --- | --- |
| Public | ✅ | ✅ | — |
| Unlisted (`private`) | ❌ | ✅ | — |
| Link-only (`protected`) | ❌ | ❌ | ✅ |

> ⚠️ **"Unlisted" means unlisted, not locked.** Filenames are the first 16 hex
> characters of the content's SHA-256 and cannot be enumerated, but anyone who
> has the URL keeps it forever. That is fine for most uploads. For anything that
> genuinely needs controlling, use **link-only** — it is the level with real
> access control behind it.

Users set their default under *My files → Account* and can override it per upload.
Administrators set the default for new accounts under *Settings → Registration*,
and can change the visibility of any file from the video list.

## 🔗 Share links

A `protected` file refuses every direct URL — `/v/`, `/d/`, `/t/` and `/p/` all
answer 403. It is reachable only through a share link its owner issues, and each
link can carry:

| | |
| --- | --- |
| Password | Prompted for on the share page; scrypt-hashed, never returned by the API |
| Expiry | 1 hour to 30 days, or never |
| View limit | One viewer counts once per hour, so a reload does not burn a view |
| Revocation | Immediate, per link — the others keep working |

Wrong password guesses are budgeted **per link** rather than per IP: rotating
addresses buys an attacker no fresh attempts, and one person fumbling a link
cannot lock their colleagues out of every other one. Only failures count.


```bash
curl -X POST http://localhost:8081/api/videos/<name>/shares \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"password":"letmein","expires_in_hours":24,"max_views":5,"note":"for review"}'
```

**This does not break embedding**, which is the whole reason authenticated access
was rejected as the answer here. The token lives in the URL, so
`<iframe src="/s/<token>">` behaves exactly like the ordinary player page.

Streaming is authorised by a short-lived signed grant rather than a cookie or a
session: the share page mints `?k=<exp>.<sig>` into its own media URLs and `/v/`
verifies the HMAC. That keeps the no-cookie design intact (so still no CSRF
surface), leaves Range requests untouched, and means a media URL copied out of
the page stops working within hours instead of never. A grant is also clamped to
its own link's expiry, so a ten-minute link cannot hand out six hours of video.

## 💾 Backups

Two things here cannot be regenerated: the SQLite database and the media
directory. Media are plain files that rsync or a volume snapshot already handles.
The database is the part that needs care — copying `vidhub.db` while the server
is writing to it can catch a half-written page or miss the WAL, giving you a file
that looks fine right up until you try to restore it.

vidhub uses SQLite's own `VACUUM INTO`, which writes a fresh, internally
consistent, already-compacted database from inside a read transaction. No
downtime, no write lock held for the duration, and no `-wal`/`-shm` sidecars to
keep alongside the copy.

Turn it on under *Settings → Database backups* (off by default — snapshots cost
disk, so that should be a deliberate choice), or press **Back up now** under
*Security*. Snapshots land in `DATA_DIR/backups/` and the oldest are pruned past
the retention count.

Restoring is a plain file operation:

```bash
docker stop vidhub
# put the snapshot in place as the live database
cp vidhub-20260818-030000.db /var/lib/docker/volumes/vidhub-data/_data/vidhub.db
# IMPORTANT: a stale WAL beside a restored database can corrupt it
rm -f /var/lib/docker/volumes/vidhub-data/_data/vidhub.db-wal \
      /var/lib/docker/volumes/vidhub-data/_data/vidhub.db-shm
docker start vidhub
```

> The database holds metadata, not video bytes. Restoring it alone rolls back
> accounts, settings and the file index — pair it with your media-directory
> backup, or the index will reference files that are no longer on disk.

## 🔑 API keys

Keys carry explicit scopes rather than the full weight of their owner's account:

| Scope | Grants |
| --- | --- |
| `read` | List and read own files |
| `upload` | Add files — cannot list or delete |
| `manage` | Visibility changes, deletion, emptying the bin |

An optional expiry date closes the window on a leaked key, `last_used` shows
whether a key is still live, and a key can be revoked without being deleted.

> An API key **can never** reach the admin panel, create other keys, or change
> the account password — even when its owner is an administrator. Those need a
> signed-in session, so a key that leaks cannot escalate itself.

## ⏱ Sessions

Sessions slide: once past halfway, activity pushes the expiry out again, so
someone working through the day is never signed out mid-task while an abandoned
session still dies on schedule. `session_max_days` is a hard ceiling measured
from first sign-in, so no session lives forever. "Keep me signed in" swaps the
`session_hours` window for `session_remember_days`.

## ⏸ Resumable uploads

Files at or above 16 MB use a resumable session instead of one long POST, since
a transfer that dies at 90% otherwise starts over. The client asks the server
how many bytes it holds and continues from there — across a dropped connection,
a page reload, or a new tab.

```
POST   /api/uploads              {name, size}          -> {id, offset, chunk_size}
GET    /api/uploads/<id>                               -> {offset, size}
PATCH  /api/uploads/<id>?offset=N  <binary chunk>      -> {offset}
POST   /api/uploads/<id>/finish                        -> the usual upload result
```

The offset is authoritative on the server. A chunk that does not begin exactly
at the current offset is refused with the real offset attached, so a confused
client resynchronises instead of corrupting the file. Sessions nobody returns to
are swept after 24 hours.

## 🔔 Webhooks

Configured under *Admin → Webhooks*. Events are queued and delivered out of
band, so a slow or dead endpoint never holds up an upload.

| Event | Fires when |
| --- | --- |
| `upload.completed` | A file finished processing and went live |
| `upload.rejected` | An upload was refused — type, size, quota, hash blocklist, resolution |
| `moderation.flagged` | Moderation quarantined or deleted something |
| `video.deleted` | A file was permanently removed |
| `user.registered` | Someone signed up |
| `backup.completed` | A database snapshot was written |
| `backup.failed` | A snapshot could not be written — the one worth alerting on |

Every delivery carries:

```
X-Vidhub-Event: upload.completed
X-Vidhub-Delivery: <uuid>
X-Vidhub-Timestamp: 1735689600000
X-Vidhub-Signature: sha256=<hex>
```

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. **Verify it
before trusting the payload** — the URL alone is not a secret. Including the
timestamp in the signed string is what stops a captured delivery from being
replayed later.

```js
const want = 'sha256=' + createHmac('sha256', SECRET)
  .update(`${req.headers['x-vidhub-timestamp']}.${rawBody}`).digest('hex')
// compare with timingSafeEqual, not ===
```

Failures retry with exponential backoff (`webhook_retries`, default 3). Twenty
consecutive failures disable the hook rather than hammering a dead endpoint
forever; re-enabling clears the streak. Every attempt lands in the delivery log,
so an integration that quietly stopped working is visible instead of being
noticed weeks later.

> Webhook targets are checked against loopback, link-local, RFC1918 and CGNAT
> ranges — including IPv4-mapped IPv6 forms such as `::ffff:127.0.0.1` — both
> when a hook is saved and again at delivery time, which closes the DNS-rebinding
> window between the two. A sub-millisecond 0-TTL rebind between the delivery
> re-check and the request itself remains theoretically possible; pin an egress
> allowlist at the network layer if that matters for your threat model.
>
> Targets that resolve to loopback, link-local or RFC1918 addresses are refused
> by default. The URL comes from an administrator, but a compromised admin
> account should not also become a probe into your private network — including
> `169.254.169.254`, the cloud metadata endpoint. Set `webhook_allow_private`
> if your receiver genuinely is internal.

## ▶ Instant start (faststart)

An MP4 carries its index — the `moov` atom — either before or after the media
data, and most encoders write it **after**. A browser cannot render a frame
until it has that index, so such a file has to be downloaded in full before
anything appears: a 500MB clip means a 500MB wait. This is a file-layout
problem, not a bandwidth one; a fast connection does not help.

vidhub checks every stored mp4/m4v/mov and, when the index is at the back,
remuxes it to the front. Streams are copied, never re-encoded, so it takes
seconds and the video is bit-for-bit identical — the test suite asserts the
video stream MD5 is unchanged. Turn it off with `faststart` if you have a
reason to keep files exactly as uploaded.

## 💾 Disk

`storage_quota_gb` is the policy you set. Underneath it sits the physical
limit, which vidhub now watches directly:

| Setting | Default | Effect |
| --- | --- | --- |
| `disk_reserve_gb` | 2 | Refuse new uploads once free space would drop below this |
| `disk_warn_gb` | 10 | Below this the admin dashboard turns red and `storage.low` fires (at most hourly) |

Without the reserve, a full disk shows up as half-written files and 500s from
SQLite — and the first sign of trouble is a user complaint. Refusing early with
a clear message keeps enough headroom for the database to keep writing. Free
and total space appear on the admin overview. Set either to 0 to disable.
