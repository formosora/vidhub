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
- 每个文件可设公开 / 私有（私有 = 不在广场列出），账号可设默认值
- 界面与 API 全量中英双语，语言跟随浏览器并可手动切换
- API Key（`Authorization: Bearer vh_xxx`）供第三方工具上传
- 回收站（软删除/恢复/彻底删除）

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

**登录后**

| Endpoint | 说明 |
| --- | --- |
| `POST /api/videos?name=…&visibility=…` | 上传（binary body）。后台开启后游客也可用 |
| `GET /api/videos?page=&q=&status=&visibility=` | 我的视频；管理员加 `all=1` 看全站 |
| `GET /api/videos/<name>` | 单个详情（所有者或管理员） |
| `PATCH /api/videos/<name>` | 改可见性 `{visibility:"public"\|"private"}` |
| `DELETE /api/videos/<name>` | 移入回收站 |
| `POST /api/videos/<name>/restore` · `DELETE …/force` | 恢复 / 彻底删除 |
| `GET /api/recycle` | 回收站；管理员加 `all=1` 看全站 |
| `DELETE /api/recycle` | 清空回收站 —— 自己的，管理员加 `all=1` 清全站 |
| `GET/PATCH /api/me` | 读取 / 修改个人偏好（默认可见性） |
| `POST /api/me/password` | 修改自己的密码（会踢掉全部会话） |
| `GET/POST /api/me/keys` · `DELETE /api/me/keys/<key>` | API Key 管理 |
| `GET /api/stats` | 管理员看全站，上传员看自己，匿名需开启 `stats_public` |

**管理员**

| Endpoint | 说明 |
| --- | --- |
| `POST /api/videos/<name>/ban` · `/unban` | 隔离 / 解除 |
| `GET/PUT /api/admin/settings` | 全部站点设置 |
| `GET /api/admin/check` | 环境探测 → `{ok, ffmpeg}` |
| `GET /api/admin/stats` | 全站数据，另含用户数、隔离数、回收站、今日 IP 排行 |
| `GET /api/admin/jobs` | 最近 50 条管线任务 |
| `GET/POST /api/admin/users` · `PATCH/DELETE /api/admin/users/<id>` | 用户管理 |
| `GET /api/admin/logs?ip=` | 上传日志（含 IP 归属地） |
| `GET/POST /api/admin/iprules` · `DELETE …/<id>` | IP 黑白名单 |
| `GET/POST /api/admin/hashblack` · `DELETE …/<sha256>` | 文件哈希黑名单 |

## 📁 结构

```
├── frontend/       # Vue 3 + TS + Vite 门户与管理后台
├── server/
│   ├── server.js   # 路由入口：API / 视频流 / 播放页 / 静态
│   └── lib/        # db · config · auth · security · upload · media · moderate · player · i18n · captcha
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

`test/smoke.sh`（112 条断言，不需要 ffmpeg）——注册开关与验证码、可见性与广场过滤、
分享链接格式、双语 API、上传内容不可执行、最后一个管理员不可锁死、公开接口不泄露
IP、设置项越界钳制、隔离内容不可重传、配额与防盗链、越权边界、Range/路径穿越。

```bash
DATA_DIR=/tmp/vh-pipe PORT=8097 ADMIN_PASSWORD=TestPass123 node server/server.js &
BASE=http://localhost:8097 DATA_DIR=/tmp/vh-pipe bash test/pipeline.sh
```

`test/pipeline.sh`（28 条断言，需要 ffmpeg）——自己用 ffmpeg 造素材，验证真实
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

每个文件有 `public` / `private` 两种可见性：

| | 广场列出 | 直链 / 播放页 / 嵌入 |
| --- | --- | --- |
| 公开 | ✅ | ✅ |
| 私有 | ❌ | ✅ |

> ⚠️ **「私有」是「不列出」，不是「加锁」。** 视频床的链接必须能分享和嵌入，
> 做成鉴权访问会直接废掉 embed。文件名是 sha256 前 16 位、不可枚举，实际隐私性
> 足够日常使用，但**不要用来存敏感内容**。需要真正的访问控制请另开需求。

账号可在「我的 → 账号」设默认值，上传时也能临时改；管理员可在「设置 → 注册」
设定新账号的默认值，并在视频列表里改任意文件的可见性。
