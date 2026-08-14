# 🎬 vidhub

A self-hosted **video bed** — upload a video, get a streamable link and an
embed code. Vue 3 admin + zero-dependency Node server, one Docker container.

![Vue](https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Node](https://img.shields.io/badge/Node.js_24-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)

## ✨ Features

- ⬆️ **Streaming uploads** — files flow to disk with a rolling SHA-256; the
  server never buffers the whole video in memory (500 MB default cap)
- 📺 **True streaming playback** — HTTP `Range` / 206 partial responses, so
  `<video>` seeking works instantly
- 🔗 **Shareable player page** (`/p/<hash>`) + ready-made iframe embed code
- 🗂️ **Content-addressed storage** — identical bytes get the identical name
- 🔐 Token login for the admin UI (drag-drop upload, copy link/embed, delete)

## 📁 Structure

```
├── frontend/    # Vue 3 + TS + Vite admin SPA
├── server/      # zero-dep Node server: upload / stream / player / admin API
├── Dockerfile   # multi-stage, single container
└── docker-compose.yml
```

## 🚀 Run

```bash
docker build -t vidhub .
docker run -d --name vidhub -p 8081:8080 \
  -v vidhub-data:/app/data \
  -e ADMIN_PASSWORD="choose-a-strong-one" \
  vidhub
# admin UI → http://localhost:8081/
```

## 🔌 API

| Endpoint | Auth | Purpose |
| -------- | ---- | ------- |
| `POST /api/videos?name=…` | ✓ | upload (binary body) |
| `GET /api/videos` | ✓ | list |
| `DELETE /api/videos/<name>` | ✓ | delete |
| `GET /v/<name>` | public | stream (Range/206) |
| `GET /p/<name>` | public | minimal player page |
