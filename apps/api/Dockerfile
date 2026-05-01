FROM node:20-alpine
WORKDIR /app

# Copy all package manifests so npm can resolve the full workspace graph
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/runtime/package.json packages/runtime/package.json

RUN npm install

# Copy source (root .dockerignore excludes node_modules, .env, storage, etc.)
COPY . .

EXPOSE 3000
ENV NODE_ENV=production
ENV USE_POSTGRES=true

CMD ["node", "apps/api/src/server.mjs"]
