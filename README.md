# KuneLab Web Games

A party quiz you host on a television while everyone answers from their phone.
Blind tests, questions, progressive image reveals and memory panels, assembled
into playlists and played in a room together.

Successor to `web-games-back` and `web-games-front`, which were two repositories
sharing one set of types by hand. They are now one workspace sharing a real
package, which is the whole reason this is a monorepo.

## Layout

```
apps/
  back/            Fastify 5 + Drizzle + SQLite. REST API, socket.io, game engine.
  front/           React 19 + Vite. Library, playlists, host screen, player screen.
packages/
  game-core/       Media kinds, answer matching, scoring, the realtime protocol.
```

`game-core` is imported by both apps. That is deliberate: the rules of the game,
the shape of every socket message and the definition of every media kind exist in
exactly one place, so the client cannot drift from the server. The previous split
kept a hand-maintained copy of the server's types in the frontend, with nothing
enforcing that they matched.

## Getting started

```bash
pnpm install                       # also builds game-core, which both apps import
cp apps/back/.env.example apps/back/.env    # SECRET is required, 32+ characters
cp apps/front/.env.example apps/front/.env  # optional, the defaults are usually right
pnpm dev
```

The API comes up on port 3000, Vite on 5173. The database file is created on
first boot and its tables with it, so there is no migration step for a fresh
checkout. An existing database from the old stack is migrated into the new media
model automatically and non-destructively on first boot.

Node 22 or later, pnpm 10 or later.

## Commands

Run from the repository root. Each one fans out across the workspace.

| Command          | What it does                                                  |
| ---------------- | ------------------------------------------------------------- |
| `pnpm dev`       | Vite, the API with `tsx watch`, and `game-core` in watch mode |
| `pnpm build`     | Builds `game-core`, then both apps                            |
| `pnpm typecheck` | Types only, every package                                     |
| `pnpm lint`      | ESLint, type-aware, every package                             |
| `pnpm test`      | `game-core` unit tests, then the API's end-to-end smoke run   |
| `pnpm smoke`     | Just the smoke run                                            |
| `pnpm format`    | Prettier across the workspace                                 |

`pnpm install` runs `prepare`, which builds `game-core`. Without that step both
apps fail to resolve it on a fresh clone, because the package's entry point is
its compiled output and `dist/` is not committed.

To work on one package, filter: `pnpm --filter back dev`, `pnpm --filter front build`.

## Testing

`game-core` has unit tests under `src/**/*.test.ts`, run with node's built-in
runner. They cover the parts where being wrong is invisible until a game night:
answer matching, the scorer, the clock.

The API has an end-to-end run in [apps/back/src/smoke.ts](apps/back/src/smoke.ts)
that exercises every route and the game engine through `app.inject()`, including
what a player is and is not allowed to see, cross-user isolation, and lag
compensation. It writes real rows, so it is launched through `smoke-run.ts`,
which hands it a throwaway database in the system temp directory and removes it
afterwards. `DEBUG=true pnpm smoke` turns the request log back on.

## Adding a media kind

One file in [packages/game-core/src/media/kinds/](packages/game-core/src/media/kinds/)
and one line in [registry.ts](packages/game-core/src/media/registry.ts). Nothing
else changes: payloads are stored as JSON validated by the kind's own Zod schema,
so there is no migration; the editor form is generated from the kind's
`formFields`; and scoring works off answer fields rather than off the kind.

The one part to write carefully is `playerPresentation`. It decides exactly what
a player's phone receives for a live round, so it is the security boundary of the
whole game: anything not built there cannot leak, and an answer value or a raw
filename built into it will.

## How a game works

The server owns the game. It holds the state, decides every phase change, and
projects a different view per recipient, so the answers to the current round are
never sent to a player at all. State is written to SQLite on each phase change,
which is what makes a restart mid-party survivable rather than fatal.

Timing is measured, not assumed. Each client estimates its offset from the server
clock and reports the moment the player actually pressed, bounded by their
measured round trip, so an answer is judged on when it was given rather than on
when its packet happened to arrive.

Images reach players through an opaque per-round token rather than by URL. In a
guessing game the filename is frequently the answer, which is also why the bytes
are proxied rather than redirected to.

## Deployment

Build with `pnpm build`, then run `apps/back` with `FRONT_DIR=front` and
`FRONT_DIR_BUILD=dist` and it serves the built frontend itself, with an
`index.html` fallback for client-side routes and JSON 404s under `/api`.

Set `REGISTRATION_OPEN=false` once your accounts exist. Existing logins keep
working and nobody new can create one.

Per-app configuration is documented in [apps/back/README.md](apps/back/README.md)
and [apps/front/README.md](apps/front/README.md). The origin and cookie rules in
the backend README are worth reading before deploying to anything reachable by
more than one hostname.

### Docker

The [Dockerfile](Dockerfile) builds one image containing the API and the built
frontend; [docker-compose.yml](docker-compose.yml) runs it with the database on a
named volume, so an image upgrade keeps every account, playlist and game result.

```bash
echo "SECRET=$(openssl rand -hex 32)" > .env   # signs the session cookies
docker compose up -d --build
```

The frontend's API origin is baked at build time by Vite; the compose defaults
suit browsing the box directly on `:3000`. Behind a reverse proxy on 80/443,
clear `VITE_API_PORT` in the build args and set `FRONT_PROTOCOL=https`.

### Backups

[scripts/backup-db.sh](scripts/backup-db.sh) snapshots the live database with
SQLite's own backup API — safe under load, where a plain `cp` of a WAL database
is not — gzips it, and keeps the last 30. Point a nightly cron at it; the header
of the script has examples for both the bare install and the container.

### Accounts and roles

Registration is open by default and closable with `REGISTRATION_OPEN=false`.
Roles (`member` / `admin` / `super-admin`) are managed from the shell, never over
HTTP:

```bash
pnpm --filter back admin list
pnpm --filter back admin role maxime admin
```
