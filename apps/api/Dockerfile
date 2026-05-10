# ── Stage 1: Install dependencies ────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/runtime/package.json packages/runtime/package.json

RUN npm ci --workspace=apps/api --workspace=packages/runtime --include-workspace-root

# ── Stage 2: Production image ─────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache dumb-init wget

RUN addgroup -g 1001 -S nodejs && adduser -S codex -u 1001

WORKDIR /app

# npm workspaces hoists everything to root node_modules
COPY --from=deps --chown=codex:nodejs /app/node_modules ./node_modules

COPY --chown=codex:nodejs apps/api/ ./apps/api/
COPY --chown=codex:nodejs packages/runtime/ ./packages/runtime/
COPY --chown=codex:nodejs package.json ./

ENV NODE_ENV=production
ENV USE_POSTGRES=true
ENV PORT=3000

USER codex

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/src/server.mjs"]
