# KuneLab Web Games, backend

Fastify 5 + Drizzle ORM + SQLite, in TypeScript. Serves the REST API, the
socket.io game protocol, the authoritative game engine, and optionally the built
frontend.

Part of a workspace. Run it from the repository root with `pnpm dev`, or on its
own with `pnpm --filter back dev`.

## Setup

```bash
pnpm install           # from the repository root
cp .env.example .env   # SECRET is required and must be 32+ chars
pnpm --filter back dev
```

The database file is created on first boot and the tables are created if missing,
so there is no migration step for a fresh checkout.

## Scripts

| Script             | What it does                                |
| ------------------ | ------------------------------------------- |
| `pnpm dev`         | `tsx watch` on `src/server.ts`              |
| `pnpm build`       | Compile to `dist/`                          |
| `pnpm start`       | Run the compiled server                     |
| `pnpm typecheck`   | Types only                                  |
| `pnpm lint`        | ESLint, type-aware                          |
| `pnpm test`        | End-to-end run against a throwaway database |
| `pnpm smoke`       | The same thing, under its older name        |
| `pnpm db:generate` | Generate a migration from schema changes    |
| `pnpm db:migrate`  | Apply pending migrations                    |
| `pnpm db:studio`   | Drizzle Studio                              |

The test writes real rows, which is why it goes through `smoke-run.ts`: that
entry point points `DATABASE_FILE` at a temporary directory and removes it
afterwards, so it can never touch your development database. It also quietens the
request log; `DEBUG=true pnpm test` turns it back on.

## Environment

See [.env.example](.env.example). `src/env.ts` validates everything at startup
with Zod and exits with a readable message rather than failing later on an
undefined value.

A relative `DATABASE_FILE` is resolved against this package, not against the
working directory, so it names the same file whether the server is started from
here or from the repository root.

`REGISTRATION_OPEN=false` closes signups without affecting existing accounts.
Login is rate limited to ten attempts a minute per address and registration to
five an hour; nothing else is limited, because the busiest route by a wide margin
is the asset proxy and throttling that breaks the game it is serving.

Leave `FRONT_DIR` / `FRONT_DIR_BUILD` unset in development so Vite serves the
frontend. Set them to `front` and `dist` in production and this process serves the
built SPA, with a fallback to `index.html` for client-side routes and JSON 404s
under `/api`.

### Origins and cookies

CORS runs off an allow-list, logged at startup. It contains the origin built from
`FRONT_PROTOCOL`/`FRONT_URL`/`FRONT_PORT`, the `www.` variant of that host, every
entry in `FRONT_ORIGINS`, and, outside production, `localhost` and `127.0.0.1`.
The browser treats `kune.local:5173`, `www.kune.local:5173` and
`192.168.1.18:5173` as three different origins, so each address you actually use
has to be covered.

Getting past CORS is not sufficient to stay logged in. The session cookie is
`SameSite=Lax`, which means the page and the API must share a registrable domain:
a page on `www.kune.local` calling an API on `localhost` is a cross-site request,
the cookie is not sent, and every authenticated call 401s even though the
preflight succeeded. The frontend avoids this by deriving the API host from the
page when `VITE_API_URL` is unset, so leave it unset unless the API really does
live elsewhere.

`secure` on the cookie follows `FRONT_PROTOCOL`, not `NODE_ENV`, because a secure
cookie over plain http is never sent at all and would lock out the LAN box.

## Layout

```
src/
  server.ts       Entry point: signals, shutdown
  app.ts          Fastify instance, plugins, route registration, error handler
  env.ts          Zod-validated configuration, package root, database path
  db/
    schema.ts     Drizzle tables
    bootstrap.ts  Idempotent DDL for a fresh database
    migrate-to-media.ts  One-time copy of legacy Videos/Images into Media
    session-store.ts     SQLite-backed session store
  routes/         One plugin per resource
  services/       Query layer, takes a SessionUser rather than a request
  game/
    session.ts    The engine: state, transitions, scoring, player projections
    manager.ts    Owns every live game, persistence, phase timers
    assets.ts     Opaque per-round image tokens and the byte cache
  realtime/       socket.io: join, host actions, answers, clock sync
  smoke.ts        End-to-end check, launched by smoke-run.ts
```

## The game engine

`game/session.ts` is pure and serialisable, which is what lets the manager write
the whole session to SQLite on each phase change and restore it after a restart.
The old implementation kept sessions in a plain object in `server.js`, so a deploy
ended the game and lost every score.

Nothing a player receives is built anywhere but in `toRoundView` and the kind's
own `playerPresentation`. Answer values, explanations and raw asset paths are
absent from both by construction, so they cannot leak through a new field added
elsewhere.

Scoring happens once, when answering closes, rather than per answer. That is what
allows position to be resolved per field: the finishing order for a field is not
known until the phase ends, and on a blind test one player can take the position
bonus on the title while another takes it on the year.

## Schema notes

The tables were originally created by Sequelize's `sync()`, so they carry its
pluralised PascalCase names (`Users`, `ContentPlaylists`, ...) and both its
`createdAt`/`updatedAt` columns and the hand-declared `created_at`/`last_modified`
ones. Every identifier in `schema.ts` is spelled out explicitly to keep an
existing production database working. Do not tidy those names without a migration.

`Media` and `PlaylistItems` are the current model: one table for everything a game
can present, with `kind` naming the variant and `payload` holding whatever that
variant needs as JSON. The legacy `Videos`, `Images` and the polymorphic
`ContentPlaylists` are still there, copied across on first boot by
`migrate-to-media.ts` and then left alone, so a bad mapping can be re-read from
the originals.

## Validation and auth

Every route validates its params and body with Zod. Media bodies go through
game-core's `validateMedia`, which checks the envelope, then the payload against
its kind's own schema, so the server and the editor cannot disagree about what a
kind is.

Bodies are parsed with unknown keys stripped, which is what stops a client from
setting `user_id` or `id` by including them. Routes that need a session add
`app.requireAuth` as a `preHandler`; it returns 401 and copies the session user to
`request.currentUser`.
