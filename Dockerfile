# RED Justice — Production Dockerfile
# Multi-stage build: install deps → build → minimal production image

# ── Stage 1: Dependencies ──
FROM node:20-slim AS deps
WORKDIR /app
RUN npm install -g bun
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ── Stage 2: Build ──
FROM node:20-slim AS builder
WORKDIR /app
RUN npm install -g bun
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run db:generate
RUN bun run build
# copy-static.js runs as part of "bun run build" now

# ── Stage 3: Production ──
FROM node:20-slim AS runner
WORKDIR /app

# Install curl for healthchecks + sqlite3 for DB
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd --system --gid 1001 redjustice \
    && useradd --system --uid 1001 --gid redjustice --shell /bin/bash --create-home redjustice

# Copy built standalone app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Create data directory for SQLite
RUN mkdir -p /app/db && chown -R redjustice:redjustice /app

# Environment
ENV NODE_ENV=production
ENV PORT=8008
ENV DATABASE_URL="file:/app/db/red-justice.db"
ENV LOCAL_AI_BASE_URL="http://host.docker.internal:11434/v1"
ENV LOCAL_AI_MODEL="llama3.2"
ENV HOSTNAME="0.0.0.0"

USER redjustice

EXPOSE 8008

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8008/api/system/status || exit 1

CMD ["node", "server.js"]
