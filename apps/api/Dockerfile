# ── Stage 1: Install dependencies ──────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy root package files
COPY package.json ./
COPY package-lock.json* ./

# Copy workspace package file
COPY apps/api/package.json ./apps/api/

# Create minimal web package.json for workspace
RUN mkdir -p apps/web && echo '{"name":"web","version":"1.0.0"}' > apps/web/package.json

# Install dependencies
RUN npm ci --workspace=apps/api --ignore-scripts || \
    npm install --workspace=apps/api --ignore-scripts

# ── Stage 2: Production image ───────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache dumb-init wget

RUN addgroup -g 1001 -S nodejs && \
    adduser -S codex -u 1001

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps --chown=codex:nodejs /app/node_modules ./node_modules

# Copy application source
COPY --chown=codex:nodejs package.json ./
COPY --chown=codex:nodejs apps/api/ ./apps/api/
COPY --chown=codex:nodejs apps/web/ ./apps/web/

ENV NODE_ENV=production
ENV USE_POSTGRES=true
ENV PORT=3000

USER codex
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/src/server.mjs"]
