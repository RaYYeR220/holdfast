# syntax=docker/dockerfile:1

# The Holdfast web application: the API, the pages and the tick endpoint.
# Build from the repository root:
#
#   docker build -t holdfast-web .
#
# The base image is Debian, not Alpine. The Zcash scanner
# (@ledgerhq/zcash-utils) is a native module that ships prebuilt for glibc on
# x64 and arm64 and for nothing else on Linux.

FROM node:24-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@9.15.0
WORKDIR /repo

# The manifests alone, so that the installed packages are rebuilt only when a
# manifest or the lockfile changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/attest/package.json packages/attest/
COPY packages/books/package.json packages/books/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/hyperliquid/package.json packages/hyperliquid/
COPY packages/intents/package.json packages/intents/
COPY packages/solana/package.json packages/solana/
COPY packages/tempo/package.json packages/tempo/
COPY packages/zcash/package.json packages/zcash/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @holdfast/web build

# The whole workspace is kept. The packages are used from their TypeScript
# sources, the native scanner is loaded from node_modules when a route first
# runs, and the migration step runs packages/db/scripts/migrate.ts with tsx.
FROM base AS run
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
