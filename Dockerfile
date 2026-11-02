# syntax=docker/dockerfile:1
#
# The party platform for internet hosting (see docs/deployment.md and compose.yaml).
# Base images are pinned by digest: a rebuild never picks up a different image unnoticed.
ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# --- Build the web client ------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY challenges challenges
RUN npm run build

# --- Runtime: the game server only, as an unprivileged user ----------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    ADMIN_PORT=3000
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# Only what the server needs at runtime (no build tools, no test runner, no web libraries).
RUN npm ci --omit=dev --no-audit --no-fund -w @challenge/server -w @challenge/engine -w @challenge/contract \
 && npm cache clean --force
COPY packages/contract packages/contract
COPY packages/engine packages/engine
COPY packages/server packages/server
COPY challenges challenges
COPY --from=build /app/packages/web/dist packages/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080 3000
# The server runs its TypeScript through tsx (in this process: no extra child process).
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]
