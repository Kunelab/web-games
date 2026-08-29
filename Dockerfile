# Single-image deployment: the API serves the built frontend itself
# (FRONT_DIR/FRONT_DIR_BUILD), so one container is the whole product.
#
# The frontend's API origin is baked at build time by Vite. The defaults below
# leave the host empty (the page's own hostname is used) and the port at 3000,
# which is right for browsing the container directly on its published port. Behind
# a reverse proxy that serves the app on 80/443, rebuild with
# `--build-arg VITE_API_PORT=` so the frontend talks to the page's own origin.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build

# better-sqlite3 compiles native code when no prebuilt binary matches its target.
# @node-rs/argon2 never does: its binaries are per-platform optional dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Dependency layer, cached until a manifest changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Every workspace manifest, so `pnpm install` provisions node_modules for all of
# them. Listing only some of them installed nothing for the rest: `COPY packages`
# below then dropped in sources with no dependencies beside them, and the build
# died on `Cannot find type definition file for 'node'`. A new package under
# `packages/` has to be added here too.
COPY apps/back/package.json apps/back/
COPY apps/front/package.json apps/front/
COPY packages/chat-core/package.json packages/chat-core/
COPY packages/coronaz-core/package.json packages/coronaz-core/
COPY packages/game-core/package.json packages/game-core/
COPY packages/i18n/package.json packages/i18n/
COPY packages/lobby-core/package.json packages/lobby-core/
COPY packages/mafia-core/package.json packages/mafia-core/
COPY packages/presence-core/package.json packages/presence-core/

# `prepare` wants game-core sources; the ignore-scripts install defers it.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages ./packages
COPY apps ./apps

# The native modules skipped by --ignore-scripts build now, then everything else.
RUN pnpm rebuild -r

ARG VITE_API_PROTOCOL=http
ARG VITE_API_URL=
ARG VITE_API_PORT=3000
ENV VITE_API_PROTOCOL=${VITE_API_PROTOCOL} \
    VITE_API_URL=${VITE_API_URL} \
    VITE_API_PORT=${VITE_API_PORT}

RUN pnpm build

# Production dependencies only, for the runtime image. `--legacy` keeps the
# pre-v10 deploy behaviour, which copies workspace packages (game-core) in as
# regular dependencies instead of requiring injected workspaces.
RUN pnpm --filter back deploy --legacy --prod /deploy/back

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# sqlite3 is only here for scripts/backup-db.sh, which snapshots the live
# database with SQLite's own backup API.
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_FILE=/data/kune.db \
    FRONT_DIR=/app/front \
    FRONT_DIR_BUILD=.

WORKDIR /app

COPY --from=build /deploy/back ./back
COPY --from=build /app/apps/front/dist ./front
COPY scripts ./scripts

# The database lives on a volume so an image upgrade keeps every account,
# playlist and game result. Owned by the runtime user, or the first boot cannot
# create the file.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

EXPOSE 3000

USER node

CMD ["node", "back/dist/server.js"]
