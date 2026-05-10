FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache dumb-init wget

# Copy package manifests so npm can resolve the full workspace graph.
# packages/runtime must be here because it is in package-lock.json's workspace
# list — omitting it makes npm ci fail with a lockfile mismatch.
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/runtime/package.json packages/runtime/package.json

RUN npm ci

# Copy all source after install to keep layer cache effective.
COPY . .

ENV NODE_ENV=production
ENV USE_POSTGRES=true
# PORT is injected by Railway at runtime; server.mjs reads process.env.PORT.

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/src/server.mjs"]
