# syntax=docker/dockerfile:1.7
#
# One image for the API, the worker and the CLI:
#   API:     node dist/index.js   (default)
#   worker:  node dist/worker.js
#   CLI:     node dist/cli.js <command>
# The working directory is /app/server, so "node dist/cli.js migrate" works as written in the deploy guide.
# The server is bundled by esbuild with --packages=external, so its production dependencies live in /app/node_modules.
# The shared/ folder is bundled into the output; the built web app is served by the API from /app/web/dist.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

# ---------------------------------------------------------------- production dependencies only
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w server --include-workspace-root=false \
 && npm cache clean --force

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    STORAGE_DIR=/data/files
RUN apk add --no-cache tini \
 && mkdir -p /data/files \
 && chown -R node:node /data
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY package.json ./
COPY server/package.json server/
COPY --from=build --chown=root:root /app/server/dist server/dist
COPY --from=build --chown=root:root /app/server/migrations server/migrations
COPY --from=build --chown=root:root /app/web/dist web/dist
WORKDIR /app/server
# Nothing in the image is writable by the application. Uploaded files go to /data/files (a volume) or to S3.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
