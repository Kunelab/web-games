# Game art

One folder per game, one folder per *kind* of thing inside it. Everything here is
served verbatim by Vite at `/games/…`, so a file dropped in is live on the next
reload with no build step and no import.

Nothing in the app should spell one of these paths out. `src/app/assets.ts` builds
every URL in this tree; that is the only file that knows the layout, which is what
made moving the whole tree here a one-file change rather than a hunt.

```
games/
  coronaz/
    logo.svg            the game's wordmark, for menus and the guide header
    heroes/<heroId>.jpg  survivor portraits — the id from coronaz-core's roster
    enemies/<file>       creature portraits, mapped by czAssets.ts
    items/<file>         weapon and gear sprites
    tiles/<file>         isometric wall pieces
    terrain/<file>       board overlays: the exit, a key, creep, a spawn
    iso/                 painted board slots, listed in iso/manifest.json
    skins/<skinId>.png   cosmetic outfits sold in the shop
  mafia/
    logo.svg
    roles/<roleId>.jpg   role portraits — the id from mafia-core's ROLES
    skins/<skinId>.png   avatar skins sold in the shop
    town/<file>.png      houses and props on the hill: house-village-day,
                         house-village-boarded, prop-fountain, prop-gallows,
                         prop-tombstone
    folk/<file>.png      the people on it: model-villager-base, -accused, -dead
    sfx/<name>.flac      the eight cues in mafiaSound.ts
  quiz/
    logo.svg
    covers/<file>        artwork for published quizzes
```

## Conventions

- **Photographs are `.jpg`, flat art and anything with transparency is `.png`,
  wordmarks and icons are `.svg`.** A portrait with a transparent background is a
  cutout, so it is a `.png`.
- **Ids, not labels, name the files.** `charles.jpg`, never `Charles Leclerc.jpg`:
  the label is content and gets rewritten, the id is in the engine and does not.
  Lowercase, no spaces, no accents.
- **Every art path is allowed to 404.** Each screen falls back to an emoji or a
  painted placeholder, so a missing file is a cosmetic downgrade and never a
  broken page. That is what lets art be commissioned one piece at a time.
- **Portraits are square**, at least 512×512, framed head-and-shoulders. See
  `docs/coronaz-art.md` for the CoronaZ commission brief.
- **Nothing on the Mafia hill may identify a role.** The town is public: every
  player and every spectator sees every house and every villager on it, so a
  sprite that looks like a doctor or a mafioso hands out the one thing the whole
  game is about. `folk/` holds the plain villager, the accused and the dead, and
  nothing else — role art belongs on a role card, which only its owner reads.

## Rendered art arrives with a backdrop

Anything generated (ComfyUI and friends) comes out as flat RGB on a studio grey,
512×512, with a render counter in the filename. None of that can go on a board:
a cutout needs alpha, its own edges, and a name.

```
node apps/front/scripts/art-cutout.mjs <in-dir> <out-dir> [--max=384]
```

It keys the backdrop out by flooding from the borders (so shadows the same value
as the backdrop survive), feathers the edge, crops to the subject and strips the
counter: `house-village-day_00001_.png` becomes `house-village-day.png` at about
a third of the size. Re-runnable; drop new renders in the source folder and run
it again.

Site chrome — the favicon, the KuneLab mark, the webfonts — stays at the root of
`public/`. It belongs to the site rather than to any game.
