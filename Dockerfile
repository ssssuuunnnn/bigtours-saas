# 正式環境映像檔：API、前端與資料庫遷移共用同一個映像檔，由 docker-compose.prod.yml 決定各自的啟動指令。
# 在 GitHub Actions 建置後推到 GHCR，主機只負責下載與啟動，不在主機上編譯（Lightsail 小方案記憶體不夠）。
FROM node:22-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .

# next.config.ts 的轉址與 /api 轉發在建置時就固定下來，所以平台網域要在建置時給
ARG PLATFORM_DOMAIN
ENV PLATFORM_DOMAIN=${PLATFORM_DOMAIN}
ENV API_URL=http://api:4000
ENV NODE_ENV=production
RUN test -n "$PLATFORM_DOMAIN" && pnpm --filter @bigtours/web build

# 上傳檔案的位置（具名 volume 第一次掛載時會沿用這個目錄的擁有者）
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
