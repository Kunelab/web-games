# CoronaZ — cahier des charges graphique

Ce qu’il faut dessiner, à quelle taille, et où le déposer. Rien de tout cela n’est
obligatoire : chaque emplacement se peint tout seul en attendant (voir
[iso/art.ts](../apps/front/src/pages/zombie/iso/art.ts)), donc le jeu est jouable
sans un seul fichier. Un fichier déposé et déclaré remplace le dessin procédural
au rechargement suivant, sans toucher au code.

## La projection

Isométrique haute. Une case du plateau est un losange de **64 × 44 px** (environ
34,5° d’élévation), les murs montent de **22 px**. Ce sont les valeurs de `TILE_W`,
`TILE_H` et `WALL_H` dans
[iso/geometry.ts](../apps/front/src/pages/zombie/iso/geometry.ts) ; tout est dessiné
à cette échelle puis mis à l’échelle par la caméra, donc livrer en ×2 (128 × 88)
donne une image nette sur écran haute densité.

C’était 64 × 32 avec des murs de 30 jusqu’à ce qu’un essai dise l’évidence : à cet
angle on voit plus de mur que de sol. Une illustration livrée pour l’ancien ratio
paraîtra écrasée.

Le bâtiment est **coupé vers la caméra** : seuls les murs nord et ouest de chaque
case sont dessinés en pleine hauteur, les murs sud et est ne sont qu’une plinthe.
Un décor ne doit donc jamais contenir son propre mur.

Attention au sens des axes, qui n’est pas celui de l’écran : `+x` descend vers la
droite et `+y` vers la gauche, donc la cloison « nord » (celle partagée avec la case
`y - 1`) est l’arête **en haut à droite** du losange. `wallEdge` dans
[iso/art.ts](../apps/front/src/pages/zombie/iso/art.ts) est la référence, et un test
vérifie que les quatre cloisons tombent sur l’arête qu’elles partagent.

## Où déposer, et comment déclarer

Les fichiers vont dans `apps/front/public/coronaz/iso/`, et sont déclarés dans
[manifest.json](../apps/front/public/coronaz/iso/manifest.json) du même dossier :

```json
{
  "props": { "desk": "props/desk.png", "bin": "props/bin.png" },
  "floors": { "parquet": "floors/parquet.png" },
  "walls": { "stripes": "walls/stripes.png" }
}
```

Un emplacement absent du manifeste est peint par le code. Un emplacement déclaré
mais introuvable retombe aussi sur le code, en silence : une faute de frappe
dégrade l’image, elle ne casse pas l’écran.

## `props` — le mobilier

PNG à fond transparent, **ancrés en bas au centre** : le point (largeur / 2,
hauteur) du fichier est posé au sol, un peu en avant du centre de la case. Largeur
recommandée 64 px (128 en ×2) ; la hauteur est libre, une armoire a le droit
d’être haute.

Les 48 emplacements, tels que les nomme
[iso/props.ts](../apps/front/src/pages/zombie/iso/props.ts) — qui porte aussi, pour
chacun, la pièce où il apparaît, son plafond par salle et par bâtiment, et ce qui
l'accompagne :

| Meuble                                                                                             | Emplacements          | Pièces où il apparaît                       |
| -------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------- |
| `desk` `printer` `whiteboard` `filecabinet` `rack`                                                 | contre un mur         | bureau, archives, labo, serveurs            |
| `shelf` `bookcase` `locker` `vending` `radiator` `pipes`                                           | contre un mur         | archives, réserve, couloir                  |
| `counter` `stove` `sink` `urinal` `bathtub` `cot` `sofa` `wardrobe` `decks`                        | contre un mur         | cuisine, salle d’eau, chambre, grande salle |
| `workbench`                                                                                        | contre un mur         | atelier, labo                               |
| `bed` `fridge` `toilet` `safe` `boxpile`                                                           | dans un coin          | chambre, cuisine, salle d’eau, réserve      |
| `table` `rug`                                                                                      | au centre d’une pièce | cuisine, cantine, séjour                    |
| `chair` `nightstand` `bin` `crate` `barrel` `pallet` `plant` `trolley`                             | n’importe où          | partout                                     |
| `papers` `blood`                                                                                   | n’importe où          | partout, c’est la fin du monde              |
| `car` `dumpster` `lamppost` `bench` `planter` `fence` `barricade` `bollard` `hydrant` `streetsign` | dehors                | rue, carrefour, ruelle, cour, parking, quai |

## `floors` — les sols

Onze sols. Intérieur : `parquet`, `carpet`, `tile`, `lino`, `concrete`, `grate`.
Extérieur : `asphalt`, `pavement`, `gravel`, `grass`, `cobble`. Une tuile carrée de
**64 × 44 px**, dessinée à cheval sur la case puis découpée au losange — donc une
texture simple et sans bordure suffit, le détourage est fait pour vous. La teinte de
la pièce n’est pas appliquée par-dessus une texture fournie : si vous en livrez une,
elle est la couleur du sol.

Les sols d’extérieur ignorent la teinte du bâtiment et partagent une teinte de nuit
froide : c’est ce qui fait lire les bâtiments comme des lieux séparés posés dedans.

## `walls` — les papiers peints

Cinq motifs : `plain`, `stripes`, `panel`, `tiles`, `grime`. Une tuile de
**64 × 44 px** environ, dessinée dans le quadrilatère du mur puis découpée. Le motif
doit être **frontal**, pas incliné : c’est le découpage qui lui donne sa perspective,
et une texture déjà en perspective se retrouve inclinée deux fois.

Les cloisons _intérieures_ sont dessinées à 50 % d’opacité (avec une plinthe opaque)
pour qu’un plan se lise de dessus ; seule la coque d’un bâtiment est pleine. Un
papier peint très contrasté perdra donc la moitié de sa force à l’intérieur, ce qui
est voulu.

Une **fenêtre** est peinte par le même code de mur, avec un carreau percé dans la
moitié haute : le mur descend entier jusqu'au sol (on ne passe pas), et la vitre est
sombre avec un reflet froid en haut et un meneau au milieu. La différence avec une
porte doit rester lisible d'un coup d'œil, parce que les deux cloisons répondent des
choses opposées : une porte est une absence jusqu'au sol, une fenêtre est un mur qu'on
voit à travers. Un papier peint n'a pas à prévoir la découpe, elle est faite par-dessus.

## `heroes` — les portraits

Hors du dossier `iso`, et hors manifeste : ceux-là sont chargés par nom.

`apps/front/public/coronaz/heroes/<id>.jpg`, un par survivant, **carré**, 256 × 256
minimum, cadré sur le visage — la grille de sélection les affiche en 4,5 à 6 rem de
côté et le dossier en 5 rem, donc ce qui compte est lisible en petit. Les vingt
identifiants sont dans
[data.ts](../packages/coronaz-core/src/data.ts) : `charles`, `johanna`, `chuck`,
`yuri`, `sacha`, `nadia`, `marco`, `ines`, `bernard`, `awa`, `viktor`, `lea`,
`omar`, `fatou`, `diego`, `suzanne`, `karim`, `margot`, `ethan`, `rosa`.

Sans fichier, la grille affiche l’emoji du personnage sur un médaillon dont la
teinte est stable par personnage : un roster complet et cohérent, en attendant.

## Ce qui existe déjà

Repris du dépôt de 2020 et toujours utilisé : les sprites d’objets
(`items/`), les créatures (`zombies/`), et `terrain/key.png`, `terrain/spawn.png`,
`terrain/creep.png`, posés à plat sur le sol de la salle concernée.

`tiles/T_Wall_*.png` en revanche n’est plus utilisé : c’étaient les murs vus de
dessus de l’ancien plateau. Ils peuvent servir de texture de mur (`walls`) si
quelqu’un les redécoupe de face.
