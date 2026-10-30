# Bizhub Payment Gateway: one container, data on a volume at /data.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# The database, slip images and backups live here; mount a volume so they survive upgrades.
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
