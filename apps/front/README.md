# KuneLab Web Games, frontend

React 19 + Vite + TypeScript. The library and playlist editors, the host screen
that goes on the television, and the player screen that goes on a phone.

Part of a workspace. Run it from the repository root with `pnpm dev`, or on its
own with `pnpm --filter front dev` once `game-core` has been built.

## Scripts

| Script              | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `pnpm dev`          | Vite dev server with HMR, bound to all interfaces |
| `pnpm build`        | Typecheck (`tsc -b`) then bundle to `dist/`       |
| `pnpm typecheck`    | Types only, no output                             |
| `pnpm lint`         | ESLint, type-aware                                |
| `pnpm format`       | Prettier                                          |
| `pnpm preview`      | Serve the built `dist/` locally                   |

`pnpm build` fails on a type error, so a broken build cannot ship.

## Environment

| Variable             | Default          | Purpose                                     |
| -------------------- | ---------------- | ------------------------------------------- |
| `VITE_API_PROTOCOL`  | `http`           | API scheme                                  |
| `VITE_API_URL`       | current hostname | API host. Best left unset, see below        |
| `VITE_API_PORT`      | none             | API port, with or without a leading colon   |
| `VITE_BUZZER_ORIGIN` | current origin   | Origin the join QR code points players at   |

These are assembled once in [src/tools/api-url.ts](src/tools/api-url.ts). The API
origin is also what socket.io connects to.

Leaving `VITE_API_URL` unset is the recommended setup, and not only for
convenience. The API's session cookie is `SameSite=Lax`, so the page and the API
have to share a registrable domain for it to be sent. Pinning the API to
`localhost` while browsing the app at `www.kune.local` produces a request that
clears CORS and then 401s on every authenticated call, because the cookie was
never attached. Unset, the API host is read from the page's own hostname and the
two cannot drift apart.

The dev server binds all interfaces, and `server.allowedHosts` in
[vite.config.ts](vite.config.ts) accepts `.kune.local` (the leading dot covers
subdomains, so `www.kune.local` works) plus `localhost`. Any other hostname you
reach the dev server by has to be added there, or Vite rejects the request as a
DNS-rebinding guard.

## Layout

```
src/
  api/client.ts      Typed fetch client, one function per endpoint
  app/
    router.tsx       Route table, every page lazily imported
    shells.tsx       The two shells, atelier and jeu
    kinds.ts         Colour and short label per media kind
  hooks/             useAuth, useAsync, useGameSocket, useYoutube
  forms/             Answer editor and the generated payload fields
  ui/                Primitives: button, field, dialog, select, switch
  pages/             One file per route
  styles/            Design tokens and the base sheet
  tools/api-url.ts   API origin, asset URLs, join URLs
```

## Two shells

The app does two unrelated jobs and has a shell for each.

The **atelier** is the librarian's app: navigation, dense lists, editors, a page
title. The **jeu** shell is what a room looks at or what a thumb operates: no
navigation at all, one thing to do at a time, everything sized to be read across a
room or pressed without looking.

The shell class is also what selects the palette, so the same `ui/` primitives
render either way without knowing which they are in. That is also why floating
content (dialogs, selects) is portalled into the shell element rather than to
`document.body`: the colour variables are declared on the shell, and anything
outside it resolves every one of them to nothing.

## Routing

Every screen is a route, including the ones that would naturally be component
state: editing a media item, launching a playlist, running a game. That is the
whole reason the back button, a refresh and a shared link all work. Filters live
in the query string for the same reason.

`/partie/:code` is the host screen and requires an account. `/rejoindre/:code` is
the player screen and deliberately does not: players are guests with a nickname
and a token in `localStorage`, which is what lets a phone that locked mid-round
reclaim its seat and its score.

## Adding a media kind

Nothing here needs changing for a new kind that only adds form fields: the editor
builds its form from the kind's `formFields`, served by the API from the same
definition the server validates against.

A kind that needs its own presentation does need code here, in two places: the
`Presentation` component in [src/pages/Player.tsx](src/pages/Player.tsx) for what
the phone shows, and `HostMedia` in [src/pages/Host.tsx](src/pages/Host.tsx) for
what the room sees. Those are separate on purpose. The host is trusted with the
real payload; the player gets only what the kind's `playerPresentation` built.
