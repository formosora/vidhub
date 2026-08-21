# 🎬 vidhub · 商业级自托管视频床

上传视频，即刻获得可流式播放的链接与嵌入代码。
Vue 3 管理门户 + **零 npm 依赖** Node 服务端（内置 SQLite）+ ffmpeg 媒体管线，一个 Docker 容器搞定。

[English](README.md) · **简体中文**

![Vue](https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Node](https://img.shields.io/badge/Node.js_24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)

## ✨ 功能

**上传与存储**
- 流式上传（滚动 SHA-256，不占用内存；内容寻址存储，相同文件秒传去重）
- 多文件批量上传、大小/格式白名单、最低分辨率限制
- 支持视频 + 图片 + （可选）任意文件

**媒体管线（ffmpeg）**
- 统一转码 MP4(H.264)/WebM(VP9)，CRF 压缩画质可调
- 文字/图片水印（九宫格定位）、强制/等比缩放、宽高上下限
- 自动生成缩略图；HTTP Range/206 真流式播放，拖动秒响应

**内容安全**
- 🛡️ 鉴黄：本地抽帧肤色检测（零成本）或对接外部审核 API，命中自动隔离/删除
- IP 黑白名单（支持 `1.2.3.*` / CIDR）、文件哈希黑名单、防盗链
- 上传日志 + IP 归属地、每 IP/每用户每日上传限额、站点总存储配额、登录限速
- 上传内容以 `nosniff` + `sandbox` CSP 下发；非视频/图片类型强制附件下载，
  杜绝上传的 HTML/SVG 在本站域名下执行脚本

**多用户与 API**
- 管理员 / 上传员 双角色；仅上传用户、禁用、日限额、重置密码
- 可选的自助注册 + 算术人机验证（笔画绘制，SVG 内不含文字）
- 每个文件可设公开 / 私有 / 仅分享链接，账号可设默认值
- 分享链接可带口令、有效期、播放次数上限，且可单条撤销
- 界面与 API 全量中英双语，语言跟随浏览器并可手动切换
- API Key（`Authorization: Bearer vh_xxx`）供第三方工具上传
- 标签与有序合集，每个合集有自己的分享页面
- 批量勾选：一次删除、打标签、改可见性或归入合集
- 所有列表可按时间 / 大小 / 时长 / 播放量 / 文件名排序
- 回收站（软删除/恢复/彻底删除）
- 数据库定时备份 + 保留策略，后台可直接下载快照

**门户与商业化**
- 广场（缩略图画廊 + 搜索）、统计页、播放页 OG 分享
- 顶部/底部/播放页广告位、全站公告、自定义 head/页脚代码（站长统计）
- 外链域名可配置（CDN / 独立分发域名）

## 🚀 部署

```bash
docker build -t vidhub .
docker run -d --name vidhub -p 8081:8080 \
  -v vidhub-data:/app/data \
  -e ADMIN_PASSWORD="choose-a-strong-one" \
  vidhub
# 门户 → http://localhost:8081/   管理 → 登录 admin
```

或 `docker compose up -d`。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `change-me` | 首次启动创建 admin 的密码（**务必修改**） |
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `/app/data` | 数据目录（视频/缩略图/SQLite） |
| `TRUST_PROXY` | `1` | 反代后取真实 IP（X-Forwarded-For） |
| `FFMPEG_PATH` | `ffmpeg` | 自定义 ffmpeg 路径 |

> 无 ffmpeg 时自动降级为「原样存储」（转码/水印/鉴黄停用），其余功能不受影响。

## 🔌 API

**公开**

| Endpoint | 说明 |
| --- | --- |
| `GET /api/health` | 存活探针（Docker HEALTHCHECK 使用） |
| `GET /api/config/public` | 可对外暴露的站点设置（标题、限额、开关） |
| `POST /api/login` · `POST /api/logout` | 登录（限速）/ 登出 |
| `GET /api/captcha` | 取人机验证题 → `{id, svg, ttl}`（限速，一次性） |
| `POST /api/register` | 自助注册 —— 需后台开启；限速 + 验证码 |
| `GET /api/public/videos` | 广场。可关闭；不含上传者 IP/用户名 |
| `GET /v/<name>` · `/t/<name>` · `/p/<name>` · `/d/<name>` | 视频流（Range/206）/ 缩略图 / 播放页 / 下载 |
| `GET/POST /s/<token>` | 分享链接 —— 播放页，设了口令则先出验证表单 |
| `GET /c/<id>` | 合集页面 —— 有序列表，可播放、可嵌入 |

**登录后**

| Endpoint | 说明 |
| --- | --- |
| `POST /api/videos?name=…&visibility=…` | 上传（binary body）。后台开启后游客也可用 |
| `GET /api/videos?page=&q=&status=&visibility=` | 我的视频；管理员加 `all=1` 看全站 |
| `GET /api/videos/<name>` | 单个详情（所有者或管理员） |
| `PATCH /api/videos/<name>` | 改可见性 `{visibility:"public"\|"private"}` |
| `DELETE /api/videos/<name>` | 移入回收站 |
| `POST /api/videos/bulk` | 对多个文件执行同一操作，逐个鉴权 |
| `GET/POST /api/videos/<name>/shares` | 列出 / 签发分享链接（仅「仅分享链接」的文件） |
| `POST/DELETE /api/videos/<name>/tags` | 给单个文件加 / 去标签 |
| `GET/POST /api/tags` · `PATCH/DELETE /api/tags/<id>` | 我的标签 —— 改名即合并，删除只解绑 |
| `GET/POST /api/collections` · `PATCH/DELETE /api/collections/<id>` | 合集 |
| `POST/DELETE /api/collections/<id>/items` · `POST …/order` | 合集成员与排序 |
| `DELETE /api/shares/<token>` | 立即撤销某条分享链接 |
| `POST /api/videos/<name>/restore` · `DELETE …/force` | 恢复 / 彻底删除 |
| `GET /api/recycle` | 回收站；管理员加 `all=1` 看全站 |
| `DELETE /api/recycle` | 清空回收站 —— 自己的，管理员加 `all=1` 清全站 |
| `GET/PATCH /api/me` | 读取 / 修改个人偏好（默认可见性） |
| `POST /api/me/password` | 修改自己的密码（会踢掉全部会话） |
| `GET/POST /api/me/keys` · `PATCH/DELETE /api/me/keys/<key>` | API Key 管理（仅限会话） |
| `POST /api/uploads` | 开始断点续传 → `{id, offset, chunk_size}` |
| `GET /api/uploads/<id>` | 查询服务端已收到多少字节，用于续传 |
| `PATCH /api/uploads/<id>?offset=N` | 在指定偏移追加一个分片 |
| `POST /api/uploads/<id>/finish` · `DELETE /api/uploads/<id>` | 完成 / 放弃 |
| `GET /api/stats` | 管理员看全站，上传员看自己，匿名需开启 `stats_public` |

**管理员**

| Endpoint | 说明 |
| --- | --- |
| `POST /api/videos/<name>/ban` · `/unban` | 隔离 / 解除 |
| `GET/PUT /api/admin/settings` | 全部站点设置 |
| `GET /api/admin/check` | 环境探测 → `{ok, ffmpeg}` |
| `GET /api/admin/stats` | 全站数据，另含用户数、隔离数、回收站、今日 IP 排行 |
| `GET /api/admin/jobs` | 最近 50 条管线任务 |
| `GET/POST /api/admin/backups` | 列出备份 / 立即备份 |
| `GET/DELETE /api/admin/backups/<file>` | 下载 / 删除某个快照 |
| `GET/POST /api/admin/users` · `PATCH/DELETE /api/admin/users/<id>` | 用户管理 |
| `GET /api/admin/logs?ip=` | 上传日志（含 IP 归属地） |
| `GET/POST /api/admin/iprules` · `DELETE …/<id>` | IP 黑白名单 |
| `GET/POST /api/admin/hashblack` · `DELETE …/<sha256>` | 文件哈希黑名单 |
| `GET/POST /api/admin/webhooks` · `PATCH/DELETE …/<id>` | Webhook 端点 |
| `POST /api/admin/webhooks/<id>/test` · `GET …/webhooks/log` | 发送测试 / 投递日志 |

## 📁 结构

```
├── frontend/       # Vue 3 + TS + Vite 门户与管理后台
├── server/
│   ├── server.js   # 路由入口：API / 视频流 / 播放页 / 静态
│   └── lib/        # db · config · auth · security · upload · media · moderate · player
│                   # shares · organize · backup · webhooks · resumable · i18n · captcha
├── test/           # smoke.sh · pipeline.sh · captcha.test.mjs
├── Dockerfile      # 多阶段构建，单容器，内置 ffmpeg
└── docker-compose.yml
```

## 💻 本地开发（不用 Docker）

需要 Node 22+（`node:sqlite`）。ffmpeg 可选，缺失时自动降级为原样存储。

```bash
cd frontend && npm install && npm run build && cp -r dist ../server/wwwroot && cd ..
DATA_DIR=./data PORT=8080 ADMIN_PASSWORD=dev-password node --no-warnings server/server.js
```

前端热更新用 `npm run dev`（已配置 `/api` 代理到 8080）。

**Windows 装 ffmpeg**（无需管理员权限）：从 <https://www.gyan.dev/ffmpeg/builds/>
下载 `ffmpeg-release-essentials.zip`，核对同目录下的 `.sha256`，解压到
`%LOCALAPPDATA%\Programs\ffmpeg`，再把其中的 `bin` 加进用户 PATH。

## 🧪 测试

两个脚本都会真实上传、封禁、改设置，**务必指向一次性数据目录**：

```bash
DATA_DIR=/tmp/vh-test PORT=8098 ADMIN_PASSWORD=TestPass123 node server/server.js &
BASE=http://localhost:8098 ADMIN_PASSWORD=TestPass123 bash test/smoke.sh
```

`test/smoke.sh`（278 条断言，不需要 ffmpeg）——注册开关与验证码、可见性与广场过滤、
分享链接格式、双语 API、上传内容不可执行、最后一个管理员不可锁死、公开接口不泄露
IP、设置项越界钳制、隔离内容不可重传、配额与防盗链、越权边界、Range/路径穿越。

```bash
DATA_DIR=/tmp/vh-pipe PORT=8097 ADMIN_PASSWORD=TestPass123 node server/server.js &
BASE=http://localhost:8097 DATA_DIR=/tmp/vh-pipe bash test/pipeline.sh
```

`test/pipeline.sh`（33 条断言，需要 ffmpeg）——自己用 ffmpeg 造素材，验证真实
转码后公开链接不失效、水印像素级确实烧录、`max_width` 等比缩放、最低分辨率
拦截、图片管线、本地鉴黄命中隔离。

验证码模块另有单元测试（不需要起服务）：

```bash
node --test test/captcha.test.mjs
```

## 🔒 安全说明

- 会话 token 存于 `localStorage` 并通过 `Authorization` 头传递（无 Cookie ⇒ 无 CSRF 面）
- 上传文件与门户同源，但非视频/图片一律 `Content-Disposition: attachment` +
  `application/octet-stream`；`/v/` 响应带 `sandbox` CSP 与 `nosniff`
- 系统始终保留至少一个可用管理员（降权/禁用/删除最后一个会被拒绝）
- `private` 是「不列出」不是「加锁」，详见 [可见性](#-可见性)；`protected` 才是有真正访问
  控制的那一档：所有直链一律拒绝，取流必须持有分享页签发的短期单文件签名 grant
- 分享口令用 scrypt + 每条链接独立 salt 存储，API 永不回传；撤销立即生效，但已经
  发出去的 grant 是靠几小时内自然过期，而不是逐个召回
- 备份快照里**什么都有** —— 密码哈希、API Key、分享签名密钥。下载下来的快照请当作
  正式数据库同等对待
- 「自定义 head / 页脚 / 广告」是**管理员自持的原始 HTML 注入点**，按设计不转义 ——
  只应授予可信管理员
- 自助注册默认**关闭**，开启后新账号一律是「上传员」；限速拆成两层——尝试次数
  给宽松上限（防爆破），成功注册数按 `register_rate_limit` 严格计（防批量开号），
  所以真人填错验证码不会被锁一小时
- ⚠️ 内置验证码是**简单**方案：算术题用线段绘制，SVG 里不含文字，能挡住直接读
  响应体的脚本；但 7 段式数字对真正的 OCR 抵抗力有限。公网商业部署建议换成
  Cloudflare Turnstile / hCaptcha
- ⚠️ 本地肤色鉴黄是启发式方案，误报漏报都不低（浅色墙面、沙滩易误判）。
  商业场景请用「外部审核 API」模式对接专业内容安全服务

## 🌏 双语

界面语言首次访问跟随浏览器（`navigator.language`），之后记在 `localStorage`，
右上角可随时切换。API 错误按 `Accept-Language` 返回对应语言，也可用 `?lang=zh|en`
显式指定（显式优先）；服务端渲染的播放页同样如此。

错误响应同时带机器可读的 `code`（如 `auth.badCredentials`），便于第三方集成自行本地化：

```json
{ "error": "Incorrect username or password", "code": "auth.badCredentials" }
```

上传日志把消息按 `key|参数` 存库而不是存成品文案，所以切换语言时**历史日志**
也会跟着变成对应语言。

新增语言：在 `server/lib/i18n.js` 和 `frontend/src/i18n.ts` 的词表各加一列即可。

## 📊 统计

统计数字按调用者的身份收敛 —— 存储量和上传量属于经营数据，不是对外展示素材：

| 调用者 | 看到的范围 |
| --- | --- |
| 管理员 | 全站 |
| 已登录的上传员 | 仅自己上传的内容 |
| 匿名访客 | 什么都看不到，除非开启 `stats_public` |

`stats_public` 默认**关闭**。开启后全站汇总对所有人可见 —— 这是给「公开展示型」
站点的选项，需要自己权衡。

## 👁 可见性

每个文件有三档可见性：

| | 广场列出 | 直链 / 播放页 / 嵌入 | 分享链接 |
| --- | --- | --- | --- |
| 公开 | ✅ | ✅ | — |
| 私有（`private`） | ❌ | ✅ | — |
| 仅分享链接（`protected`） | ❌ | ❌ | ✅ |

> ⚠️ **「私有」是「不列出」，不是「加锁」。** 文件名是 sha256 前 16 位、不可枚举，
> 但拿到 URL 的人就永久拿到了。日常用够了；**真正需要控制访问的内容请设为
> 「仅分享链接」** —— 那一档背后才有真正的访问控制。

账号可在「我的 → 账号」设默认值，上传时也能临时改；管理员可在「设置 → 注册」
设定新账号的默认值，并在视频列表里改任意文件的可见性。

## 🔗 分享链接

设为 `protected` 的文件会拒绝一切直链 —— `/v/`、`/d/`、`/t/`、`/p/` 一律 403，
只能通过所有者签发的分享链接访问。每条链接可以带：

| | |
| --- | --- |
| 口令 | 在分享页输入；scrypt 哈希存储，API 永不回传 |
| 有效期 | 1 小时到 30 天，或永不过期 |
| 播放次数上限 | 同一访问者 1 小时内只计 1 次，刷新页面不会消耗次数 |
| 撤销 | 立即生效，且只影响这一条，其余链接照常 |

口令猜测次数是**按链接**而不是按 IP 计的：攻击者换 IP 拿不到新的额度，而某个人
把一条链接的口令敲错，也不会把同事挡在其它所有链接之外。只有失败才计数。


```bash
curl -X POST http://localhost:8081/api/videos/<name>/shares \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"password":"letmein","expires_in_hours":24,"max_views":5,"note":"给评审看"}'
```

**这不会破坏嵌入** —— 这正是当初否掉「鉴权访问」的理由。token 本身就在 URL 里，
`<iframe src="/s/<token>">` 和普通播放页表现完全一致。

取流的授权用的是短期签名 grant，而不是 Cookie 或会话：分享页把
`?k=<exp>.<sig>` 写进自己的媒体地址，`/v/` 校验这个 HMAC。这样既保住了无 Cookie
的设计（依然没有 CSRF 面），也不影响 Range 请求，而且从页面里复制出去的媒体地址
几小时后就失效，而不是永久有效。grant 还会被自身链接的有效期钳制 —— 十分钟的
链接不可能签发出六小时的播放权。

## 💾 备份

不可再生的东西只有两样：SQLite 数据库和媒体目录。媒体是普通文件，rsync 或卷快照
本来就能覆盖；需要小心的是数据库 —— 在服务端正在写入时直接拷贝 `vidhub.db`，
可能抓到写了一半的页或漏掉 WAL，拿到一个「看起来没问题、恢复时才发现坏了」的文件。

vidhub 用的是 SQLite 自带的 `VACUUM INTO`：它在一个读事务里写出一份全新、内部
一致、且已经过整理压缩的数据库。不停服、不长时间持写锁，输出也是单个自包含文件，
不需要连带保存 `-wal`/`-shm`。

在「设置 → 数据库备份」里开启（默认关闭 —— 备份要占盘，该由站长明确决定），或者
在「安全」页点「立即备份」。快照落在 `DATA_DIR/backups/`，超出保留份数的自动删除。

恢复就是普通的文件操作：

```bash
docker stop vidhub
# 把快照放回去当作正式库
cp vidhub-20260818-030000.db /var/lib/docker/volumes/vidhub-data/_data/vidhub.db
# 关键：残留的旧 WAL 会把刚恢复的库写坏
rm -f /var/lib/docker/volumes/vidhub-data/_data/vidhub.db-wal \
      /var/lib/docker/volumes/vidhub-data/_data/vidhub.db-shm
docker start vidhub
```

> 数据库里存的是元数据，不是视频本体。单独恢复它只会把账号、设置和文件索引回滚 ——
> 请和媒体目录的备份配套使用，否则索引会指向磁盘上已经不存在的文件。

## 🗂 组织

搜索之外的三件事，为文件多到一屏放不下的时候准备。

**排序。** 所有列表 —— 我的文件、管理端列表、回收站、公开广场 —— 都接受
`?sort=uploaded|size|duration|views|name` 和 `?order=asc|desc`。排序字段通过白名单
查表解析而不是拼接，因为 `ORDER BY` 恰好是参数绑定保护不到的地方。

**标签。** 按所有者隔离：两个账号可以各有一个「素材」标签，互相看不见。把标签
改成一个已存在的名字会**合并**过去，而不是撞上唯一索引报错 —— 那才是「改错别字」
的真实含义。删除标签只解除关联，文件本身不动。

**合集。** 有序的一组视频，有自己的页面 `/c/<id>`，和播放页一样可嵌入。只能放自己的
文件，所以合集不会变成「把别人的上传挂到自己名下重新发布」的通道；而「仅分享链接」
的成员不会出现在合集页上 —— 拒绝直链正是那一档存在的意义。

**批量操作。** 勾选若干行，一次删除、恢复、彻底删除、改可见性、打标签或归入合集。
每个文件单独鉴权，返回里会说明跳过了几个：选中的文件里混进了不属于你的，就做能做的
部分并如实告知，而不是整批失败、更不是闷声照做。

## 🔑 API Key

Key 携带显式的权限范围，而不是直接继承账号的全部能力：

| 范围 | 能做什么 |
| --- | --- |
| `read` | 列出、查看自己的文件 |
| `upload` | 新增文件 —— 不能读也不能删 |
| `manage` | 改可见性、删除、清空回收站 |

可选的过期时间限制泄露后的窗口，`last_used` 用于判断 Key 是否还在用，
吊销不必删除。

> API Key **永远无法**访问管理后台、创建其他 Key、或修改账号密码 ——
> 即使持有者是管理员。这些操作必须是登录会话，所以泄露的 Key 无法自我扩权。

## ⏱ 会话

会话会滑动续期：过半后只要有活动就把过期时间推后，白天连续工作的人不会
被中途踢出，而闲置的会话仍按时失效。`session_max_days` 是从首次登录起算的
硬上限，任何会话都不会永生。勾选「记住我」把 `session_hours` 换成
`session_remember_days`。

## ⏸ 断点续传

≥16MB 的文件走续传会话而不是一个长 POST —— 后者在 90% 处断掉就得从头再来。
客户端向服务端询问已收到多少字节，然后从那里继续：断线、刷新页面、换个标签页
都能接上。

```
POST   /api/uploads              {name, size}      -> {id, offset, chunk_size}
GET    /api/uploads/<id>                           -> {offset, size}
PATCH  /api/uploads/<id>?offset=N  <二进制分片>     -> {offset}
POST   /api/uploads/<id>/finish                    -> 与普通上传相同的返回
```

偏移量以服务端为准。分片起点若与当前偏移不符会被拒绝，并附上真实偏移，
让客户端重新对齐而不是写坏文件。无人续传的会话 24 小时后清理。

## 🔔 Webhook

在「管理 → Webhook」中配置。事件异步排队投递，接收端慢或挂掉都不会拖住上传。

| 事件 | 触发时机 |
| --- | --- |
| `upload.completed` | 文件处理完成、已可播放 |
| `upload.rejected` | 上传被拒 —— 格式、大小、配额、哈希黑名单、分辨率 |
| `moderation.flagged` | 内容审核隔离或删除了某个文件 |
| `video.deleted` | 文件被永久删除 |
| `user.registered` | 有人注册 |
| `backup.completed` | 数据库快照写入成功 |
| `backup.failed` | 快照写入失败 —— 最值得告警的一条 |

每次投递都带：

```
X-Vidhub-Event: upload.completed
X-Vidhub-Delivery: <uuid>
X-Vidhub-Timestamp: 1735689600000
X-Vidhub-Signature: sha256=<hex>
```

签名为 `HMAC-SHA256(secret, "<时间戳>.<原始请求体>")`。**请在信任内容前先校验** ——
URL 本身不是秘密。把时间戳纳入签名串，是为了让抓到的一次投递无法被重放。

```js
const want = 'sha256=' + createHmac('sha256', SECRET)
  .update(`${req.headers['x-vidhub-timestamp']}.${rawBody}`).digest('hex')
// 用 timingSafeEqual 比较，不要用 ===
```

失败按指数退避重试（`webhook_retries`，默认 3 次）。连续失败 20 次会自动停用该
Webhook，而不是无休止地敲一个已经死掉的地址；重新启用会清零计数。每次尝试都记入
投递日志，让"悄悄坏掉的集成"当场可见，而不是几周后才发现。

> Webhook 目标会对回环、链路本地、RFC1918、CGNAT 段做校验 —— 包括
> `::ffff:127.0.0.1` 这类 IPv4-mapped IPv6 写法 —— 在保存时和投递前各校验一次,
> 关闭两者之间的 DNS 重绑定窗口。投递前二次校验与真正发起请求之间仍有亚毫秒级
> 的 0-TTL 重绑定理论窗口;若你的威胁模型在意,请在网络层加出站白名单。
>
> 解析到回环、链路本地或 RFC1918 地址的目标默认被拒绝。URL 虽然来自管理员，但
> 管理员账号被攻陷时，不应该顺带把服务器变成内网探测器 —— 包括云元数据地址
> `169.254.169.254`。接收端确实在内网时可开启 `webhook_allow_private`。

## ▶ 秒开（faststart）

MP4 的索引（`moov` atom）可以放在媒体数据之前或之后，而**多数编码器写在之后**。
浏览器拿不到索引就渲染不出任何一帧，于是这种文件必须整个下载完才会出画面——
500MB 的片子就是先等 500MB。这是文件布局问题，不是带宽问题，**网络再快也没用**。

vidhub 会检查每个存储的 mp4/m4v/mov，索引在后就把它重排到前面。只复制流、不
重新编码，几秒完事且逐位一致——测试套件会断言视频流 MD5 未变。如果你有理由
保持文件与上传时完全一致，可以关掉 `faststart`。

## 💾 磁盘

`storage_quota_gb` 是你设定的运营策略，它下面还有个物理极限，现在会被直接监控：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `disk_reserve_gb` | 2 | 剩余空间将低于此值时拒绝新上传 |
| `disk_warn_gb` | 10 | 低于此值后台概览转红，并触发 `storage.low`（每小时最多一次） |

没有这道保险时，磁盘写满表现为半个文件和 SQLite 抛 500 —— 而站长第一次知道
是用户来报错的时候。提前用明确的提示拒绝，能给数据库留出继续写入的余量。
后台概览显示真实的剩余/总容量。任一项设为 0 即关闭。
