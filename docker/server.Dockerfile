# Montr Server — Multi-stage Docker build
# Usage: docker build -f docker/server.Dockerfile -t montr-server .

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# Install build dependencies for native addons (better-sqlite3, sharp)
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy package files first for better layer caching
COPY server/package.json server/package-lock.json* ./

# Install all dependencies (including dev for tsc)
RUN npm ci --legacy-peer-deps

# Copy source
COPY server/src ./src
COPY server/tsconfig.json ./

# Build
RUN npx tsc && \
    mkdir -p dist/database && \
    cp src/database/schema.sql dist/database/ && \
    cp -r src/web dist/web

# Prune to production dependencies
RUN npm ci --omit=dev --legacy-peer-deps

# ── Stage 2: Runtime ────────────────────────────────────────
FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/montr-server

# Copy built application
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# Create directories for runtime data
RUN mkdir -p data storage logs

# Default environment
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_TYPE=sqlite \
    DB_PATH=./data/montr.db \
    STORAGE_PATH=./storage \
    LOG_LEVEL=info \
    PUBLIC_URL=https://montr.budgetvegas.com

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
