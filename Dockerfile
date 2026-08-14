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
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data
COPY server/ ./
COPY --from=fe /fe/dist ./wwwroot
VOLUME /app/data
EXPOSE 8080
CMD ["node", "server.js"]
