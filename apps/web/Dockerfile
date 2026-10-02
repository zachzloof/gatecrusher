# syntax=docker/dockerfile:1
# Build context is the repo root (see docker-compose.yml).

FROM node:24-alpine AS base
RUN npm install --global pnpm@12.5.1
WORKDIR /app

# --- deps: install from the lockfile, cached until a manifest changes ----------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/gates/package.json packages/gates/
RUN pnpm install --frozen-lockfile

# --- dev: hot reload against a bind-mounted repo (docker-compose.dev.yml) ------------
FROM deps AS dev
# yt-dlp: metadata fallback for playlist ingest when SoundCloud's api-v2 fails.
RUN apk add --no-cache yt-dlp
ENV NODE_ENV=development NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "exec", "next", "dev", "--hostname", "0.0.0.0", "--port", "3000"]

# --- build: standalone production bundle --------------------------------------------
FROM deps AS build
COPY . .
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @gatecrusher/web build

# --- runner: only the traced server output, as a non-root user -----------------------
FROM node:24-alpine AS runner
# yt-dlp: metadata fallback for playlist ingest when SoundCloud's api-v2 fails.
RUN apk add --no-cache yt-dlp
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
