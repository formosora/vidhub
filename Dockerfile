# ---------- frontend build ----------
FROM node:24-alpine AS fe
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ .
ENV BUILD_BASE=/
RUN npm run build

# ---------- runtime ----------
FROM node:24-alpine
# ffmpeg + ffprobe power transcode / thumbnails / watermark / moderation
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    TRUST_PROXY=1
COPY server/ ./
COPY --from=fe /fe/dist ./wwwroot
VOLUME /app/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# --no-warnings keeps the experimental node:sqlite notice out of the logs
CMD ["node", "--no-warnings", "server.js"]
