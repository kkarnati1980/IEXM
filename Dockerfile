FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/runtime/package.json packages/runtime/package.json

RUN npm install

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/ready').then((r) => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "apps/api/src/server.mjs"]
