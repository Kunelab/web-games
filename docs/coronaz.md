# CoronaZ — règles et conception

Réimplémentation du jeu de plateau maison de 2020 (`d:\workspace\web\CoronaZ`,
branche `origin/develop` — **pas** `master`, qui est un squelette vide). L'original
n'a jamais eu de règles écrites ; ce document est la spécification, rétro-conçue
depuis le PHP puis étendue. Le design est repris, l'implémentation non : l'original
gardait l'état du jeu dans le DOM du navigateur hôte et synchronisait par polling
SQL. Ici le serveur fait autorité, comme pour les quiz.

## Le jeu

Survival coopératif type _Zombicide_ : 1 à 4 survivants dans une grille de salles
générée procéduralement, envahie de zombies. La télé montre le plateau ; chaque
joueur agit depuis son téléphone. Deux camps adverses possibles :

- **vs IA** — le serveur joue les zombies.
- **vs Maître du jeu** — un humain (sur son téléphone) déplace les zombies, choisit
  les renforts avec un budget, et voit tout le plateau sans brouillard.

## Boucle et rythme

L'original était au tour par tour strict et traînait. Ici les phases sont
**simultanées et chronométrées** :

1. **Phase des héros** (15/30/45 s ou sans chrono, selon la difficulté) : tous les
   joueurs dépensent leurs PA en même temps. Un joueur qui a fini appuie sur
   « Prêt » ; la phase se termine au chrono ou quand tout le monde est prêt.
2. **Phase ennemie** : l'IA résout (ou le MJ joue, avec son propre chrono), les
   zombies regagnent leurs PA, avancent, attaquent, puis les salles d'apparition
   tirent leurs renforts.
3. Retour en 1, tour suivant.

Tout ce qui n'est pas une action de jeu est **gratuit et instantané** : équiper,
ranger, jeter, donner un objet à un héros de la même salle. Fouiller reste 1 PA
mais le butin s'équipe en un geste depuis le toast de résultat.

## Règles portées de l'original

- **Plateau** : grille de salles, connexité garantie. Les objectifs se placent
  selon le degré des salles : sortie et départ dans des culs-de-sac, apparitions
  de zombies dans les salles peu connectées, clés dans les salles de passage. (Le
  plateau lui-même a changé de forme en v3, voir plus bas.)
- **PA** : 3 par héros et par tour (l'aptitude peut moduler).
- **Actions à 1 PA** : se déplacer d'une salle par une porte ouverte, attaquer,
  fouiller, ramasser une clé, sortir (salle de sortie, toutes clés ramassées).
- **Combat aux dés** (pur Zombicide) : ligne de vue en ligne droite par les portes
  ouvertes ; l'arme donne portée, dés, dégâts, précision (d6 ≥ seuil), mêlée,
  akimbo (dés doublés si la même arme dans les deux mains), bruit. Les touches en
  excès débordent sur un autre zombie de la salle.
- **Butin** : tirage pondéré (40/30/15/10/5 %) sur le _palier_ de l'objet. 12 armes
  - équipements (lampe : une fouille gratuite par tour ; gilet : absorbe une
    attaque ; essence : requise par lance-flammes et tronçonneuse ; munitions :
    relance d'attaque).
- **Zombies** (PV/PA/dégâts) : zombie 1/1/1, coureur 1/2/1, horreur 2/2/1,
  gras 4/1/1, mutant 3/2/2, boss 10/1/2.
- **Brouillard** : visible, exploré (déjà vu, entités masquées), inexploré (noir).
  Partagé par l'équipe. Trois sources de visibilité : les lignes droites (la règle
  Zombicide, celle que suit aussi une arme), **l'espace ouvert où l'on se tient**
  (une arche veut dire qu'il n'y a pas de mur : éclairer quatre rayons au milieu
  d'une rue et laisser le reste noir se lit comme un bug, pas comme la nuit), et les
  salles voisines pour qui porte une bonne lampe.

## Ajouté par cette version

- **Bruit** : chaque attaque bruyante marque la salle ; l'IA cible le héros le plus
  proche, départagé par le bruit. Se déplacer discrètement compte.
- **Aptitudes de héros** : Charles (tireur : relance un dé raté à distance),
  Johanna (assassin : +1 dé en mêlée), Chuck (fouilleur : première fouille du tour
  gratuite), Yuri (marine : la première blessure de chaque phase ennemie est
  réduite de 1).
- **Scénarios** : _Évasion_ (clés puis sortie), _Purge_ (éliminer N zombies),
  _Survie_ (tenir N tours puis extraction). Victoire si au moins un héros remplit
  l'objectif ; défaite si tous meurent.
- **Difficulté** : préréglages (facile → cauchemar) sur des paramètres exposés :
  taille de carte, clés, salles d'apparition, meute initiale, intensité des
  renforts, chrono de phase, PV des héros, chance de butin.
- **Points** : les parties écrivent dans `GameResults` comme les quiz, donc
  l'historique, le palmarès et les succès s'appliquent. Score par joueur : victimes
  pondérées par type, clés, fouilles, objectif rempli, bonus de survie ;
  distinctions propres (boucher, serrurier, pillard, increvable).

## Architecture

```
packages/coronaz-core/   règles pures, RNG seedé, applyAction, IA, protocole typé
apps/back/src/zombie/    sessions en mémoire + SQLite, socket.io, résolution IA rythmée
apps/front/src/pages/zombie/  mise en place, télé, téléphone héros, écran MJ
apps/front/src/pages/zombie/iso/  la projection, la peinture, le mobilier
```

Une partie sauvegardée par une version antérieure au modèle de salles n'est pas
reprise : le plateau n'a plus la même forme et il n'y a rien à migrer, donc la
session est supprimée au démarrage plutôt que restaurée à moitié.

Mêmes principes que les quiz : état sérialisable écrit en base à chaque phase
(redémarrage survivable), projections par destinataire (le brouillard pour les
joueurs, tout pour le MJ et la télé), horloge serveur pour les chronos. Le RNG est
seedé pour que la résolution soit rejouable et testable.

## v2 : escalade, objectifs, économie du MJ, simulateur

- **Boss** : Hurleuse (invoque un zombie à chaque activation), Brute, Colosse,
  Abomination. Marqués `boss`, comptés par les objectifs.
- **Objectifs secondaires** (0 à 2, tirés à la génération) : abattre un boss,
  quota de victimes, quota de fouilles. En Évasion ils verrouillent la sortie ;
  en Survie ils retardent l'extraction ; partout ils paient des points.
- **Sans fin** : personne ne sort, la menace ne plafonne jamais, le score est
  la distance parcourue avant la nuit.
- **Courbes** : la menace est quadratique (`tour × (1 + tour/12) × escalade`) et
  nourrit la table des renforts, leurs bonus d'élite (PV puis dégâts) et le
  revenu du MJ. Côté héros, la fatigue de fouille (-1 rareté par 4 fouilles)
  fait plafonner l'équipement en milieu de partie : le croisement est garanti.
- **Économie du MJ** : revenu par tour (base + intensité + menace/2,5), report
  du budget non dépensé, améliorations permanentes (Carapace +1 PV ×3,
  Griffes +1 dégât ×2), ordre Ruée (+1 PA à toute la horde). Consommables côté
  héros : kit de soin, adrénaline.
- **Simulateur** (`pnpm --filter coronaz-core sim`) : parties sans interface,
  bots joueurs (rusher/fighter/looter/balanced) et bots MJ
  (aggressor/economist), des centaines de parties par minute. Cibles mesurées
  sur 500 parties par case, joueurs `balanced` :
  facile 100 %, normal 97 %, difficile 71 %, contre MJ agressif 45 %
  (cauchemar ~27 %, assumé mortel). Rééquilibrer = changer un préréglage,
  relancer le banc.

## v3 : le bâtiment, la caméra, la rareté

### Plateau : des cases, puis des salles

La grille se mesure désormais en **cases** ; une **salle** en possède une à quatre
(simple, 1×2, 2×1, 2×2, L). La salle reste l'atome de toutes les règles — un
déplacement, une fouille, une ligne de vue — mais elle n'est plus un carré.

Entre deux cases voisines il y a quatre états au lieu de deux :

| État         | Sens                                                        | Passage | Vue |
| ------------ | ----------------------------------------------------------- | ------- | --- |
| `open` (`.`) | même salle, aucun mur                                       | oui     | oui |
| `wall` (`#`) | mur fermé                                                   | non     | non |
| `door` (`D`) | porte, une case de large                                    | oui     | oui |
| `arch` (`A`) | **tout** le mur commun retiré : deux salles, un seul espace | oui     | oui |

L'arche est la réponse au « totalement ouvert » qui manquait : deux pièces
mitoyennes dont la cloison entière a disparu se lisent comme un plateau ouvert
tout en restant deux salles pour les règles. La génération la préfère justement là
où le mur commun fait deux cases de long.

Trois passes, chacune ne faisant que son travail : **découper** (balayage
ligne par ligne, empreintes tirées au sort), **relier** (arbre couvrant aléatoire
sur le graphe des salles, puis boucles supplémentaires — un labyrinthe à chemin
unique se joue mal), **habiller** (teinte de zone, sol, thème, qui se propagent le
long des liaisons, l'arche transmettant presque toujours).

La ligne de vue parcourt maintenant les **cases** et non les salles, en comptant
les salles traversées : un pistolet porte toujours « à une salle », que cette salle
fasse une case ou quatre.

Deux conséquences réglées :

- **Fog** : une salle non explorée révèle son empreinte (la forme du bâtiment n'a
  jamais été le secret) mais rien de ce qu'elle contient. Une cloison n'est cachée
  que si ses **deux** côtés sont inexplorés, sinon on ne pourrait plus entrer dans
  le noir — c'est exactement ce que donnait l'ancien bit `doorRight`.
- **Pression** : les préréglages décrivent une pression sur une équipe, pas un
  nombre de zombies, et la carte est un réglage libre de 24 à 768 cases. Les
  renforts sont donc multipliés par la taille du bâtiment rapportée aux 32 salles
  de calibrage. Sans cela, agrandir la carte était devenu un réglage de difficulté
  déguisé : le premier banc sur le nouveau générateur donnait cauchemar à 48 %.

### Rendu : isométrique 2,5D et caméra

Le plateau est peint en isométrique 2:1 sur un canvas (case de 64 × 32, murs de 30) : sols à motifs, murs avec papier peint, portes encadrées, et du mobilier —
32 meubles, du bureau à la cuvette, placés par règles (le lit veut un coin, le
bureau veut un mur, le tapis veut le milieu) à partir d'**un seul nombre** tiré par
le serveur et transmis par salle. La décoration ne coûte donc rien au protocole et
tous les écrans meublent la même pièce de la même façon.

Le bâtiment est coupé vers la caméra : seuls les murs nord et ouest montent, les
autres sont des plinthes, donc on voit toujours _dans_ les pièces. La scène est
dessinée une fois dans un canvas hors écran et recomposée sous la caméra, ce qui
rend le déplacement fluide sur 768 cases.

La caméra a trois conducteurs : le PC (glisser, molette, flèches, `0` pour tout
voir), le téléphone (un doigt glisse, deux pincent) et la télévision, qui se
conduit seule — elle suit les survivants pendant leur phase, **recadre tout le
plateau dès que la horde joue**, et rend la main à quiconque la touche pendant six
secondes. Tout est décrit dans
[useCzCamera.ts](../apps/front/src/pages/zombie/useCzCamera.ts).

Les créatures restent en DOM au-dessus du canvas : elles ont besoin de zones
tactiles, de barres de vie et d'une transition CSS qui transforme une mise à jour
d'état en déplacement. Elles sont **posées** sur leur case (le bas de l'élément est
le point au sol) et portent une ellipse d'ombre : sans ça, une créature flotte et
rien ne dit sur quelle case elle est.

**Cliquer se résout sur l'image, pas sur la projection.** Inverser la projection
répond à « quelle case est sous ce point _au sol_ », ce qui n'est pas la question
qu'un clic pose : tout est dessiné _debout_ sur sa case, donc viser une pièce
par-dessus une armoire envoyait une case trop loin. La scène est donc peinte une
seconde fois, dans les mêmes ordres de passage, en couleurs d'identifiant : un
`getImageData` d'un pixel donne la case qu'on voit vraiment. Mesuré, les meubles
hauts désignent leur propre case dans 97,5 % des cas contre 1 % pour l'inversion
géométrique. Les murs, eux, ne revendiquent pas leurs pixels : les cloisons
intérieures étant translucides, la case qu'on voit à travers est celle qu'un clic
doit donner.

Les fichiers graphiques sont facultatifs et remplaçables un par un : voir
[coronaz-art.md](coronaz-art.md).

### Ce qu'un essai a corrigé ensuite

Quatre choses signalées en jouant, toutes réelles :

- **Impossible de frapper une créature.** La caméra capturait le pointeur au
  `pointerdown` pour gérer le glissé ; une pression sur un jeton remontait jusqu'à
  elle, la capture détournait le `pointerup`, et le bouton ne recevait jamais son
  clic. La caméra laisse désormais passer tout geste qui commence sur un jeton. Et
  taper une créature sans PA ne faisait _rien du tout_, sans un mot : ça se dit.
- **« Je ne sais pas sur quelle case ils sont. »** Les jetons étaient centrés sur
  leur point d'ancrage, donc ils flottaient. Ils sont maintenant **posés** dessus
  (le bas de l'élément est le point au sol) et portent une ellipse d'ombre.
- **« Je clique à côté, une case lointaine compte comme adjacente. »** Ce n'était
  pas un bug de clic mais le modèle de salles rendu invisible : une salle possède
  jusqu'à quatre cases, donc la case d'à côté peut appartenir à une autre salle
  pendant qu'une case à trois pas est à un seul déplacement. Les jointures d'arche
  étaient un murmure sur le sol ; elles sont maintenant un seuil visible, les salles
  jouables sont **cerclées comme des salles** (et non case par case), et la salle où
  l'on se tient est cerclée aussi.
- **« Tout ressemble à un hangar. »** Quatre causes : des murs à 22 px (passés à
  26), la moitié des programmes ouverts les uns sur les autres (`OPEN_PLAN` réduit à
  séjour/grande salle/bar/hall, probabilité 0,65 → 0,45), une seule teinte par
  bâtiment (chaque salle dérive de quelques degrés) et une palette murale par défaut
  identique pour presque tout (dix-huit programmes ont maintenant la leur).

### Rareté : par exemplaire

La rareté était une propriété de l'arme (un minigun était légendaire pour
toujours). Elle se dédouble :

- le **palier** (`tier`) de l'objet décide _quand_ il apparaît — c'est la table de
  2020, inchangée, et donc le rythme de la partie ;
- la **rareté** de l'exemplaire trouvé est tirée à ±1 palier, et modifie ses
  statistiques.

Le levier est la **précision**, seul chiffre qui veuille dire à peu près la même
chose pour toutes les armes : un rang déplace le seuil de touche de 1, soit un
tiers de dégâts en plus pour un pistolet et un cinquième pour un minigun, là où un
bonus plat doublerait le minigun et disparaîtrait sur le lance-flammes. Quand la
précision est au bout de sa course, le rang se paie en dégâts. L'écart total est
donc borné : au mieux un tiers de mieux que l'arme imprimée, au pire un quart de
moins. Les soins et l'adrénaline suivent la même logique ; le gilet, qui n'a pas de
curseur, ne gagne que la couleur.

L'akimbo tire à la qualité de la **moins bonne** des deux armes.

**Les équipements aussi doivent répondre.** « Quelle différence entre une lampe rare
et une lampe épique ? » n'avait pas de réponse : les effets binaires (gilet, lampe)
ne gagnaient que la couleur, ce qui fait de la rareté une décoration. Chacun a
maintenant son curseur :

| Équipement  | Ce que la rareté change                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| Gilet       | encaisse `1 + (rareté − palier)` impacts avant de céder — un épique tient deux fois |
| Lampe       | au-delà du palier, **éclaire les salles voisines** en plus de la fouille gratuite   |
| Kit de soin | ±10 PV rendus                                                                       |
| Adrénaline  | ±1 PA                                                                               |

Le gilet a donc besoin d'une mémoire : `ItemInstance.spent` compte les impacts pris.

Visuellement, l'effet monte avec la rareté : halo, lavage de teinte sur l'image de
l'arme elle-même, puis reflet mobile pour épique et légendaire. Un commun n'a
aucun effet — c'est le principe, sinon l'effet ne signifie rien.

### Équilibrage refait

Mesuré après la rareté et la nouvelle carte, à 400 parties par case (contre 500
pour les chiffres de v2), joueurs experts, mindset `balanced` :

| Préréglage         | v2    | v3     |
| ------------------ | ----- | ------ |
| facile             | 100 % | 100 %  |
| normal             | 97 %  | 93,5 % |
| difficile          | 71 %  | 68 %   |
| cauchemar          | ~27 % | 41,5 % |
| apocalypse         | —     | 18,5 % |
| contre MJ agressif | 45 %  | 45 %   |

La courbe est plus régulière qu'avant, où l'on passait de 71 % à 27 % d'un
préréglage au suivant. Cauchemar est plus clément qu'en v2 et l'assume :
apocalypse est désormais le plancher.

## v4 : le monde lisible

La v3 avait livré l'isométrique, mais trois défauts tenaient à une seule cause —
**le générateur découpait uniformément toute la grille en petites salles** :
claustrophobie, illisibilité, et un décor absurde (trois frigos par immeuble, cinq
tables sans chaise) parce que les thèmes étaient tirés _par salle_. Et tout était
en intérieur.

### Le générateur : parcelles, puis programmes

Quatre passes au lieu de trois. Un **layout** dit où passent les rues et où sont
les bâtiments ; le reste du moteur ne connaît pas les layouts.

| Layout          | Forme                                                    | Résultat mesuré (60 graines)                      |
| --------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `quartier`      | rues qui se croisent, immeubles et commerces entre elles | 63 salles, 45 % dehors, 6 bâtiments               |
| `residence`     | une route, pavillons détachés, jardins                   | 60 salles, 62 % dehors, 4 bâtiments               |
| `complexe`      | un seul bâtiment (labo, bunker) + un quai                | 59 salles, 16 % dehors, 1 bâtiment                |
| `etablissement` | rue, grande salle, sanitaires, arrière                   | 59 salles, 38 % dehors, volume ouvert de 74 cases |

- **Dehors** est découpé en salles dont _toutes_ les cloisons sont des **arches** :
  aucun mur, une rue est un espace continu qu'on voit et qu'on tire de bout en bout.
- **Un bâtiment** est partitionné en BSP : un espace par pièce de son
  **programme**, et un espace plus grand que le plafond de salle devient plusieurs
  salles jointes par des arches.
- **Le plafond de salle reste quatre cases** parce qu'un déplacement coûte 1 PA
  quelle que soit la taille de la salle. L'espace vient des **grappes d'arches** :
  visuellement un seul volume, mécaniquement plusieurs pas. Aucune règle ne change.
- **Les programmes** (maison, immeuble, bureaux, boîte de nuit, complexe, commerce,
  atelier) donnent des listes de pièces avec des comptes, attribuées par forme :
  le séjour prend le plus grand espace, la salle d'eau un cul-de-sac, le couloir le
  carrefour. C'est ce qui règle les trois frigos : un logement a _une_ cuisine.
- **Les objectifs** comprennent le dedans et le dehors : on arrive par la rue et on
  ressort par une autre, les clés sont à l'intérieur et réparties entre bâtiments,
  la horde sort des recoins.

Un piège qui a coûté une session de débogage est documenté dans le code : une
empreinte remplie par diffusion peut être en L, et le coin de sa boîte englobante
appartient alors à la salle _voisine_. Nommer une salle d'après ce coin produisait
des identifiants en collision, donc un plateau qui se déclarait non connexe. L'id
vient de la première case _possédée_ ; un test l'exige.

### Lisibilité

- **Angle** : la tuile passe de 64×32 (26°) à **64×44 (34,5°)** et les murs de 30 à
  **22** — on voit du sol plutôt que du mur.
- **Cloisons translucides** : la coque d'un bâtiment reste opaque (c'est elle qui
  dit où le bâtiment s'arrête), tout ce qui divise l'intérieur est dessiné à 50 %
  avec une plinthe opaque. Un plan se lit d'un coup d'œil.
- **Les seuils de porte** sont peints en permanence sur le sol : une ouverture vue
  de dessus, ce n'était presque rien.
- **Le cadrage d'ouverture** est la salle de départ à distance de lecture, plus
  « tout voir » à un bouton ; la caméra de suivi ne descend plus sous 0,9.
- **Minicarte** sur les écrans qu'on tient en main : la scène étant déjà un canvas
  de tout le bâtiment, c'est un `drawImage`, un rectangle de caméra et des points.

### Décor : des quotas

`maxPerRoom` par accessoire, `maxPerZone` par bâtiment, des **accompagnements**
(une table amène 2 à 4 chaises, un lit une table de chevet), et un budget de
_familles_ distinctes par salle — une petite salle d'eau a des WC, un lavabo et une
poubelle, pas un exemplaire de tout. Le meublage se fait **par bâtiment** parce que
« un frigo par immeuble » n'est pas une question qu'une salle peut trancher.

48 familles d'accessoires, dont l'extérieur (voiture, benne, lampadaire, grillage,
barricade, banc, jardinière, borne, bouche d'incendie, panneau). Mesuré sur 6 000
salles : 3,3 accessoires par salle, aucun quota dépassé, aucun accessoire hors
sujet, et 85 % des tables ont une chaise à côté.

### Biomes

Un **biome** est l'arsenal, la faune et le look ; un layout est la forme du plan.
Les deux sont orthogonaux, donc un bunker moderne et un lotissement cyberpunk sont
également légaux. Le remplacement est **complet** : un biome fournit ses seize
objets et ses neuf créatures, et rien de ce qu'il contient ne vient d'ailleurs.

Ça n'est possible que grâce à une indirection, parce que vingt survivants
désignaient leur arme fétiche par identifiant et dix classes de MJ désignaient des
zombies. Désormais :

- un **rôle** (`club`, `blade`, `sidearm`, `marksman`, `chaingun`, `medkit`…) est le
  métier d'un objet. **Il possède son palier et son budget de puissance** ;
- un **archétype** (`walker`, `runner`, `screamer`, `colossus`…) est le métier d'une
  créature. **Il possède ses statistiques**, identiques dans tous les biomes, parce
  que la courbe de menace est la colonne vertébrale de l'équilibre ;
- `heroDef.favoriteWeapon` est un rôle : Charles est tireur d'élite dans un monde
  qui n'a jamais fabriqué de sniper.

Un test interdit la dérive : pour chaque biome et chaque rôle, les dégâts attendus
(`dés × chance de toucher × dégâts`) doivent tenir à ±15 % du budget du rôle. Un
railgun peut donc être _différent_ d'un sniper sans être _meilleur_.

**Ajouter un biome** — un fichier plus une ligne, comme les types de médias des
quiz :

```
packages/coronaz-core/src/content/roles.ts        rôles, archétypes, budgets
packages/coronaz-core/src/content/biome.ts        le contrat
packages/coronaz-core/src/content/biomes/modern.ts   le biome de référence
packages/coronaz-core/src/content/registry.ts     une ligne par biome
```

Un seul biome est écrit pour l'instant (`moderne`, qui _est_ la table de 2020), donc
cette passe n'ajoute aucun contenu visible : elle rend le suivant mécanique.

### Rééquilibrage, encore

Le monde par défaut passe à 16 × 10 cases (~60 salles). Deux corrections se
compensaient mal et il a fallu les séparer :

- **l'espace** : agrandir la carte diluait la horde. La mise à l'échelle existait
  déjà, mais linéaire en nombre de salles — ce qu'une équipe subit n'est pas la
  _densité_ de la horde mais son _taux de contact_, qui dépend d'une distance, donc
  de la **racine** d'une aire. `boardPressure` est désormais `√(salles / 32)`.
- **le temps** : un monde plus grand se traverse en 12 tours au lieu de 10, et la
  courbe de menace avait son genou calé sur 10. Elle est donc étirée à la taille du
  monde (`threat` lit `tour / boardPressure`), sinon un grand monde était puni deux
  fois : pour être long, et pour avoir atteint le tour 12 en le parcourant.
- et la taille des paquets de renforts **n'est plus** multipliée : un monde plus
  grand reçoit déjà plus de vagues, et multiplier en plus faisait croître le total
  livré comme l'aire quand la capacité de l'équipe croît comme l'horloge. C'est ce
  qui avait fait tomber `normal` de 93 % à 65 % au premier banc.

**La table** est le troisième facteur, et il manquait complètement. La meute de
départ se mettait à l'échelle du groupe depuis toujours ; les renforts, jamais. Un
survivant seul avec trois PA recevait donc les mêmes vagues que cinq survivants
avec quinze, ce qu'un banc qui ne jouait qu'à trois héros ne pouvait pas voir.
Mesuré par taille de groupe, `difficile` en solo se gagnait 2,8 % du temps et à
cinq 94 % : deux jeux différents sous un seul nom de préréglage.

Deux corrections, aux deux endroits où le groupe compte :

- **le volume** — la fréquence de tir d'une salle d'apparition est multipliée par
  `partyPressure` (têtes / 3). Ce qu'une équipe peut encaisser, ce sont ses points
  d'action ; ce qui arrive doit donc suivre le nombre de têtes.
- **le rythme** — un solo met plus longtemps à faire le travail (14 tours contre
  11,6 à trois), et la menace est quadratique en progression : ces tours
  supplémentaires arrivaient comme un tiers de monde en plus par-dessus le tiers de
  corps en moins. `partyPace` étire l'arc pour les petites tables et le comprime
  pour les grandes.

Une troisième correction a été essayée et **retirée** : mettre l'objectif à
l'échelle aussi (une clé par survivant, les clés en trop retirées du plateau). Elle
faisait passer deux joueurs (78 % en `difficile`) devant trois (72 %), parce qu'une
équipe va chercher les clés en parallèle — une petite table avait alors un travail
plus court _et_ une horde plus petite. Une courbe de difficulté qui creuse au milieu
est pire qu'une courbe simplement raide. Le travail reste le travail.

250 parties par case, joueurs experts, mindset `balanced` :

| Préréglage | 1      | 2      | 3      | 4      | 5      |
| ---------- | ------ | ------ | ------ | ------ | ------ |
| facile     | 72,4 % | 98,8 % | 100 %  | 100 %  | 100 %  |
| normal     | 52,8 % | 90,8 % | 96,0 % | 97,6 % | 98,4 % |
| difficile  | 28,4 % | 62,8 % | 74,0 % | 86,4 % | 95,6 % |
| cauchemar  | 6,4 %  | 28,4 % | 48,8 % | 60,0 % | 71,6 % |
| apocalypse | 2,8 %  | 7,6 %  | 14,8 % | 21,2 % | 32,0 % |

Le solo reste le plus dur, et le reste par construction : une seule mort met fin au
raid, alors qu'un trio a trois chances de sortir quelqu'un. C'est aussi pour ça que
le lobby propose des bots — « en solo, prenez deux ou trois bots » est la réponse
prévue, pas un pis-aller.

`cauchemar` a gagné une quinzaine de points en corrigeant le brouillard, et lui
seul : `facile` se joue sans brouillard et `normal` avec le plan connu, donc seuls
les préréglages qui jouent dans le noir profitent de voir la rue où l'on se tient.
C'est la conséquence d'une correction, pas un réglage ; l'échelle reste monotone et
espacée, et aucun préréglage n'a été resserré pour retomber sur un chiffre d'avant.

400 parties par case, à trois joueurs experts, mindset `balanced` :

| Préréglage         | v3     | v4     |
| ------------------ | ------ | ------ |
| facile             | 100 %  | 99,5 % |
| normal             | 93,5 % | 96,8 % |
| difficile          | 68 %   | 72,3 % |
| cauchemar          | 41,5 % | ~30 %  |
| contre MJ agressif | 45 %   | 35 %   |

Le MJ agressif a perdu dix points sans qu'on touche à son économie : ses parties
durent un tour de plus et son revenu suit la menace. À surveiller si quelqu'un
trouve la horde trop dure à jouer contre.

## v5 : les primes, les mutations, le compte

Cette passe ne touche ni la carte ni la caméra : elle répond à « qu'est-ce qu'on
joue, pour qui, et pourquoi ce chiffre ».

### Objectifs : sept sortes, dont quatre facultatives

Les objectifs étaient trois (boss, victimes, fournitures) et tous obligatoires : en
Évasion ils verrouillent la sortie. Quatre s'ajoutent, et elles sont **facultatives**
par nature.

| Sorte      | Ce qu'elle demande             | Verrouille la sortie |
| ---------- | ------------------------------ | -------------------- |
| `boss`     | abattre un boss                | oui                  |
| `kills`    | un quota de victimes           | oui (ou prime)       |
| `searches` | un quota de fournitures        | oui                  |
| `explore`  | voir 45 % des salles           | non                  |
| `treasure` | trouver une pièce épique       | non                  |
| `intact`   | sortir sans perdre personne    | non                  |
| `speed`    | sortir avant un tour donné     | non                  |

Une prime **ne bloque rien et paie le double** (6 points contre 3) : personne n'était
obligé de la prendre. C'est ce qui la rend jouable comme une prime et non comme une
corvée : on l'abandonne sans rien perdre. Deux dials dans la mise en place
(`secondaryObjectives`, `optionalObjectives`) et une liste d'autorisation
(`objectiveKinds`) qui couvre les sept : un hôte qui déteste courir après un boss le
raye, plutôt que de tout couper.

Les clés comptent enfin comme un objectif à l'écran. Elles verrouillaient la sortie
depuis toujours mais n'apparaissaient nulle part dans la liste : le joueur lisait
« abattre un boss » et ignorait qu'il manquait deux clés. `czGoals()` unifie les deux
familles, trie l'obligatoire avant la prime et préfixe les primes d'une étoile.

### Le handicap volontaire, des deux côtés

Deux façons de rendre le raid plus dur en échange de points, choisies par les
joueurs et non par l'hôte :

- **Aucun atout.** Un survivant qui ne prend rien marque **+12** à la fin, l'équivalent
  d'un boss. Un handicap que personne ne remarque est un handicap que personne ne
  prend ; celui-ci se voit sur le tableau final (🙌).
- **Les mutations de la horde.** Cinq cases à cocher dans le salon d'attente, chacune
  renforce les zombies et **multiplie le score de tout le monde**.

| Mutation      | Effet sur la horde        | Récompense |
| ------------- | ------------------------- | ---------- |
| Peau épaisse  | +10 PV                    | +15 %      |
| Griffes       | +10 dégâts                | +20 %      |
| Vive          | +1 PA                     | +30 %      |
| Féconde       | renforts ×1,5             | +25 %      |
| Titans        | +40 PV aux boss           | +15 %      |

Le multiplicateur s'affiche dans le salon d'attente avant qu'on coche quoi que ce
soit, et sur l'écran de fin à côté des scores : la table sait ce qu'elle achète.

### Le butin tombe aussi des cadavres

Vider une salle ne payait qu'en points. Un cadavre lâche maintenant une pièce avec
une probabilité qui suit sa rareté (10 % + 5 % par rang, **toujours** pour un boss),
si le sac a de la place. Ça change le calcul d'une salle pleine : elle valait qu'on
la contourne, elle vaut maintenant qu'on la vide.

### Le score va au compte Kune

Les carrières étaient indexées sur le pseudo tapé sur le téléphone, ce qui marche
dans un salon et pas ailleurs : « Max » perdait tout en devenant « MaxAubry ». Quand
la connexion socket porte le cookie de session (un navigateur connecté), la carrière
s'indexe sur le **compte**, préfixé `@` pour ne jamais collider avec un pseudo ; sinon
elle reste sur le pseudo, que le téléphone garde déjà dans son `localStorage`. Le
salon d'attente le dit en une ligne (🔗 compte, ou 📱 ce pseudo) : on sait où va la
soirée avant de la jouer.

L'identité est vérifiée **côté serveur** (signature du cookie `kune.sid` puis lecture
de la session en base). Faire confiance à un login envoyé par le client laisserait
n'importe qui créditer le compte de n'importe qui.

### Toutes les armes touchent

L'accuracy est morte : chaque arme porte `accuracy: 1`, donc chaque dé touche. Le
budget de puissance des rôles a été refait autour de ce fait, et une attaque n'a plus
qu'une question : combien de dés as-tu apportés. Les dés sont **encore tirés** du flux
aléatoire, volontairement : une graine doit rejouer à l'identique, et sauter des
tirages ferait dériver toutes les parties sauvegardées.

Conséquence à connaître, mesurée plus bas : sans jet à rater, le seul stat qui compte
contre les cinq archétypes à 10 PV est le **nombre de dés**, parce que tout ce qui
frappe pour 10 ou plus les tue d'un coup. Une batte vaut un sniper contre un
traînard. C'est le sujet de la proposition « dégâts et armure ».

### Ce que le banc dit de cette passe

120 parties par case, trois héros experts, mindset `balanced`, évasion. Le banc
expose deux dials neufs, `--luck lucky|unlucky` et `--noperks`, parce que les deux
questions posées à cette passe ne se lisent pas dans une moyenne.

| Préréglage         | v4     | v5     | Cible    |
| ------------------ | ------ | ------ | -------- |
| facile             | 99,5 % | 100 %  | ≥ 99 %   |
| normal             | 96,8 % | 95,8 % | 94-95 %  |
| difficile          | 72,3 % | 74,2 % | ~70 %    |
| cauchemar          | ~30 %  | 44,2 % | ~41 %    |
| apocalypse         | -      | 16,7 % | ~20 %    |
| contre MJ agressif | 35 %   | 39,2 % | 40-50 %  |

La courbe est revenue à sa place sans qu'on y touche : le 100 % de précision et le
butin sur cadavre rendent surtout service **là où l'équipe était marginale**, donc
`cauchemar` remonte de quatorze points et `facile` ne bouge pas, puisqu'il était déjà
au plafond. Rien à resserrer sur les préréglages.

Par taille de table :

| Préréglage | 1      | 2      | 3      | 4      | 5      |
| ---------- | ------ | ------ | ------ | ------ | ------ |
| normal     | 62,5 % | 94,2 % | 95,8 % | 97,5 % | 96,7 % |
| difficile  | 44,2 % | 73,3 % | 74,2 % | 86,7 % | 87,5 % |

Le solo était le vrai blessé de la v4 (52,8 % en `normal`, 28,4 % en `difficile`) et
c'est lui qui profite le plus des deux changements : un survivant seul rate moins et
ramasse sur chaque cadavre. Duo et trio sont désormais à égalité sur `difficile`
(73,3 contre 74,2), ce qui est plat mais pas creux.

**Le vrai problème est la variance, pas la moyenne.** Avec les six premiers tirages
forcés :

| Préréglage | butin ingrat | normal | butin généreux |
| ---------- | ------------ | ------ | -------------- |
| normal     | 76,7 %       | 95,8 % | 98,3 %         |
| difficile  | 26,7 %       | 74,2 % | 83,3 %         |

Cinquante-sept points d'écart en `difficile`, pour la même équipe, le même
préréglage et la même carte. Et l'écart est **asymétrique** : la chance ne rapporte
que neuf points (le plafond est proche), la malchance en coûte quarante-sept. Ce
n'est donc pas « le butin décide » mais « le bas de la table de butin tue » : six
armes à 1 dé × 10 dégâts ne peuvent pas nettoyer une salle, quoi que fasse le
joueur, parce que sans jet à rater la seule façon de tuer deux choses est d'avoir
deux dés.

Enfin, le handicap volontaire est bon marché :

| Préréglage | avec atouts | sans atout | score moyen |
| ---------- | ----------- | ---------- | ----------- |
| normal     | 95,8 %      | 92,5 %     | 171 → 193   |
| difficile  | 74,2 %      | 70,0 %     | 199 → 216   |

Trois à quatre points de victoire pour douze points de score : le prix est
défendable, mais il dit aussi que les atouts pèsent peu. À surveiller le jour où on
retouchera les atouts eux-mêmes.

## v6 : l'armure, la grille de dix, et la porte de sortie

### La grille de dix a sauté

Chaque valeur du jeu était un multiple de dix. C'était sans conséquence tant que les
armes pouvaient rater ; c'est devenu le problème central quand elles ont arrêté. Un
traînard avait exactement 10 PV, donc **toutes** les armes du jeu en tuaient un par
coup, et un sniper jetait 88 % de ses dégâts pour faire ce qu'une batte faisait
aussi bien. Les dés étaient devenus le seul stat qui comptait contre les deux
créatures les plus courantes du plateau.

L'échelle ×10 reste (un « +10 PV » se lit, un « +1 PV » ressemble à une erreur
d'arrondi), la **grille** disparaît : 9, 11, 19, 27, 29, 42, 68, 98, 148 PV. Les PV
des héros et les bonus plats des atouts restent ronds volontairement, parce que ce
sont les chiffres qu'un joueur lit sur sa propre carte à chaque tour et que rien
chez eux n'était cassé.

### L'armure

Une réduction plate sur **chaque coup**, avec un minimum de 1 qui passe toujours :
l'armure rend une arme mauvaise, jamais inutile.

| | Traînard | Coureur | Horreur | Mutant | Masse | Brute | Colosse | Abomination |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PV | 9 | 11 | 19 | 29 | 42 | 68 | 98 | 148 |
| Armure | 0 | 0 | 0 | 1 | 2 | 3 | 4 | 6 |

C'est le stat qui redonne son métier à une arme lourde. Contre un colosse, il faut
10 attaques à la batte, 5 à la pioche (qui perce), 3 à la tronçonneuse et 2 au
sniper ; contre une salle de traînards, le minigun en tue six d'un coup et le sniper
un seul. Les armes de foule répondent à la foule, les armes lourdes à l'armure, et
une main gauche et une main droite ont enfin une question à trancher.

**Perforante** (pioche, tronçonneuse, Desert Eagle, sniper) ignore la moitié de
l'armure. Ce n'est pas un bonus par-dessus le budget, c'est *dedans* : c'est
l'essentiel de ce qu'un gros calibre est censé être.

Côté héros, le gilet n'est plus un booléen. Il l'était : un gilet rare et un gilet
légendaire encaissaient exactement une attaque, une fois. Il donne maintenant **-1
dégât par rang, du commun au légendaire**, sur chaque blessure. Deux gilets ne
s'additionnent pas (le meilleur porté compte) sinon deux plaques légendaires
rendaient la moitié du bestiaire inoffensive. Le « la plaque tient, entièrement »
reste, comme capacité d'Omar, là où il a sa place.

### Le haut de l'arsenal est redescendu

Le sommet valait douze fois le bas (lance-flammes 120 contre batte 10), ce qui
faisait de la soirée une loterie sur l'apparition d'un tier 5 : le banc mesurait
57 points d'écart de victoire entre une table forcée à bien ouvrir et une table
forcée à mal ouvrir, sur le même préréglage. Les paliers sont resserrés à
**14-24 / 33-36 / 45-48 / 56-58 / 70-72**, soit cinq fois le bas au lieu de douze.

La rareté a suivi, par nécessité. Un rang valait dix dégâts plats, ce qui sur une
arme à six dés fait +83 % de sa production totale : la rareté aurait rendu par une
porte ce que la compression venait de retirer par l'autre. Un rang vaut maintenant
**+18 % des dégâts de l'arme**, ce qui règle du même coup le vieux déséquilibre (dix
dégâts, c'était +100 % sur une batte et +12,5 % sur un sniper : le même « rang »
voulait dire deux choses différentes selon ce qu'on tenait).

### Le plancher de pitié et la caisse offerte

Deux corrections de l'ouverture, qui est là où un raid se décide :

- **Le plancher de pitié** : si les deux premières trouvailles d'un héros n'ont rien
  donné de mieux que du tier 1, la troisième est plancher au tier 2. Ça ne touche
  que le cas catastrophe et ça ne déplace pas le plafond, qui n'a jamais été le
  problème.
- **La caisse offerte** : une fouille gratuite par raid, pour tout le monde, quoi
  qu'on porte. Dépensée après la fouille gratuite renouvelable (lampe, Chuck), parce
  que c'est ce qu'un joueur ferait si le jeu lui posait la question.

### Abandonner, et annuler

Trois portes qui n'existaient pas :

- **Un survivant peut abandonner** en cours de raid, gratuitement et en deux taps.
  Il sort du plateau comme un mort, mais ce n'est pas une mort : la carrière compte
  l'abandon à part, il ne touche ni la victoire ni son bonus (sinon abandonner
  serait la façon la moins chère de farmer une victoire), et il garde le score qu'il
  avait gagné jusqu'à la porte.
- **Le maître du jeu peut concéder**, dans n'importe quelle phase, ce qui est la
  seule action de la horde jouable hors de son tour : un MJ qui veut arrêter ne
  devrait pas attendre que son tour revienne pour le dire.
- **L'hôte peut annuler un raid** depuis la liste de la mise en place. Les parties en
  cours y restaient indéfiniment, sans autre moyen de les vider que de les jouer
  jusqu'au bout ou de redémarrer le serveur.

## v7 : une ville plutôt qu'un hangar

Le diagnostic tenait en une phrase : vu d'en haut, le biome moderne ressemblait à un
seul immense hangar. Trois causes, chacune corrigée à sa racine plutôt qu'en aval.

### 1. Dehors n'avait pas de sortes

Tout ce qui n'était pas un mur était une « rue ». Un parking, un jardin et un
boulevard étaient donc le même sol gris avec les mêmes poubelles dessus, et l'oeil
n'avait rien pour comprendre où il se trouvait. Il y a maintenant neuf extérieurs,
dont trois neufs et décisifs :

| Programme  | Sol      | Ce que c'est                               |
| ---------- | -------- | ------------------------------------------ |
| `street`   | bitume   | la chaussée, deux cases de large           |
| `sidewalk` | dallage  | le trottoir, une case, réverbères et bancs |
| `square`   | pavés    | la place : fontaine, kiosque, bancs        |
| `park`     | herbe    | arbres et haies                            |

Un trottoir n'est pas une chaussée et une place n'est pas un parking : c'est la
première chose que l'oeil lit, avant même la forme des bâtiments.

### 2. Tout était meublé à la même densité

Un chiffre unique, 1,9 accessoire par case, partout, dedans comme dehors. Quatre
cases de bitume recevaient donc huit objets. Une chaussée ne porte pas huit objets ;
elle porte une voiture garée, et tout le reste est au bord du trottoir.

La densité est désormais une propriété du **type de lieu**, et c'est ce qui lui donne
une identité vue d'en haut. Mesuré sur les cinq layouts :

| Lieu        | accessoires/case |
| ----------- | ---------------- |
| chaussée    | 0,11             |
| trottoir    | 0,49             |
| place       | 0,58             |
| parc        | 0,75             |
| couloir     | 0,74             |
| séjour      | 1,19             |
| salle d'eau | 1,80             |

Onze fois plus dense dans un séjour que sur la chaussée. Deux règles ont dû changer
avec : la pièce maîtresse d'une salle n'est plus posée d'office (chaque bout de bitume
recevait une voiture, quoi que dise la densité), et la passe de détritus suit la même
échelle (elle rajoutait deux poubelles et une flaque de sang sur une route vide, ce
qui défaisait discrètement le travail de la passe précédente).

Quatre accessoires neufs, parce qu'une place ne peut pas être faite d'objets
d'intérieur : **arbre, haie, fontaine, kiosque**. Un arbre ne peut pas être dedans,
une fontaine ne peut pas être dans une ruelle : ce sont eux qui disent « place » de
l'autre bout de la carte.

### 3. Les bâtiments n'avaient pas de noms

Un immeuble et des bureaux se ressemblent depuis la rue, donc la carte était un champ
de boîtes grises. Une ville a des repères. Le layout **`ville`** en plante toujours
deux : un **commissariat** et un **hôpital** (mesuré : commissariat sur 100 % des
cartes, hôpital sur 88 %). Ce sont aussi les deux bâtiments que la table de butin
paie le mieux, donc la silhouette et la raison d'aller vers elle sont la même chose.

Neuf salles neuves les remplissent : accueil, chambres, bloc opératoire, pharmacie,
morgue, cellule, salle des scellés, armurerie. Elles n'étaient meublées par rien du
tout au départ (un hôpital sortait en boîtes vides) ; elles le sont maintenant depuis
le catalogue existant, parce qu'une chambre d'hôpital *est* un lit et un chariot.

### `ville` : une avenue, ses trottoirs, une place

Une seule chaussée droite qui traverse la carte, ses deux trottoirs, puis des lots de
part et d'autre : un lot par côté devient une place ou un parc, les autres reçoivent
un bâtiment en retrait. Droite et unique volontairement : les rues qui tournent
produisaient des salles extérieures en L, qui se lisent comme un défaut, et une
grille de rues était le labyrinthe qui faisait de l'ancienne ville un dédale plutôt
qu'un lieu.

Le retrait ne s'applique **pas** au bord du plateau. Un retrait uniforme entourait
toute la carte d'un anneau de cour d'une case, ce qui d'en haut se lisait comme une
douve : la ville avait l'air d'une maquette sur un plateau au lieu d'un morceau
découpé dans quelque chose de plus grand.

### Les salles extérieures sont des rectangles

Dehors était découpé par la même fonction que l'intérieur : une graine qui pousse en
tache, donc des L, des tétrominos et des cases orphelines. Deux choses n'allaient
pas. Ça se voyait (un trottoir en L est un défaut) et ça se **jouait** mal : un
déplacement coûte un point d'action par salle quelle que soit sa taille, donc un
boulevard découpé en quinze petits L coûtait quinze points à descendre. Traverser la
carte, c'était patauger.

Dehors est maintenant **pavé** : 2x2 partout où il en tient un, puis des dominos,
puis des cases seules. Les terrains ouverts (place, parc, cour) passent d'abord en
3x3, parce qu'une place doit faire deux ou trois enjambées de large. Le plafond de
salle passe donc de 4 à **9 cases dehors** et reste à 4 dedans : un rez-de-chaussée
d'un seul tenant se traverserait pour un point, et toute la tension d'une fouille
sous pression vient de ce qu'on paie pour se déplacer dedans. Résultat mesuré : 0 %
de salles extérieures non rectangulaires, 3,05 cases par salle extérieure sur `ville`
contre 2,08 avant.

### Le butin dépend de la salle

Une salle était un conteneur interchangeable, donc explorer était une corvée facturée
en points d'action et la réponse était toujours « fouiller la chose la plus proche ».
Chaque programme porte maintenant un bonus de butin, dépensé comme une **chance d'un
rang** de la table (les rangs sont ce dont la table est faite ; une fraction de rang
devrait s'arrondir, et la moitié des valeurs ne feraient alors rien du tout).

| Bande          | Part des salles | Exemples                                |
| -------------- | --------------- | --------------------------------------- |
| -20 % à -15 %  | 28 %            | chaussée, carrefour, trottoir           |
| -15 % à 0 %    | 44 %            | cour, parc, couloir, sanitaires, séjour |
| 0 %            | 10 %            | chambre, bureau, dortoir                |
| +1 % à +29 %   | 9 %             | bar, atelier, quai, morgue              |
| +30 % à +59 %  | 6,5 %           | réserve, archives, serveurs, labo, bloc |
| +60 % à +100 % | 1,9 %           | scellés, pharmacie, armurerie           |

La salle de départ ajoute +15 % par-dessus son programme : la première fouille du
raid s'y fait, au tour un, avec trois points d'action et une batte, et elle donne le
ton de la soirée.

**Et ça se voit.** Les salles au-dessus de +40 % scintillent : un halo chaud sur le
sol et quelques éclats, peints sur le sol et non en contour (un contour voudrait dire
« sélectionnée », ce que la carte utilise déjà). Le téléphone affiche en plus le nom
de la salle où l'on se tient et « bon butin » ou « rien à fouiller ici ». Un joueur
doit pouvoir *vouloir* une pièce sans avoir lu de tableau. Mesuré : 3,8 salles
brillantes par carte, soit 2,5 % des salles.

Un piège trouvé en chemin : une salle plus grande que le plafond devient plusieurs
salles, et chacune héritait du programme. Pour une chambre d'hôpital c'est juste (une
grande chambre *est* plusieurs chambres) ; pour une armurerie c'était un doublon de
jackpot avec un air sérieux, mesuré à 2,1 armureries par ville pour un seul
commissariat. Les six programmes qui portent le butin restent singuliers et le
débordement devient la salle ordinaire d'à côté, ce qui est aussi à quoi ressemble un
vrai bâtiment : une cage fermée, et les étagères autour.

## v8 : les fenêtres, les repères, et une clé derrière quelque chose

### La première cloison où voir et passer ne sont plus la même question

Toutes les cloisons du jeu répondaient la même chose à « puis-je voir » et « puis-je
passer » : un mur bloque les deux, une porte laisse les deux. Conséquence, le combat
devenait aveugle dès qu'on rentrait quelque part. Un `window` sépare enfin les deux
réponses.

| Cloison  | Passer | Voir et tirer |
| -------- | ------ | ------------- |
| `wall`   | non    | non           |
| `door`   | oui    | oui           |
| `arch`   | oui    | oui           |
| `window` | **non**| **oui**       |

Un survivant peut donc surveiller la rue depuis le magasin, tirer à couvert, et se
faire tirer dessus à travers la vitre. Une salle peut être dangereuse sans être
accessible. Tout ça avec un seul état de cloison et **aucune** règle de déplacement
modifiée : `connectionsOf` n'accepte toujours que `door` et `arch`, donc une fenêtre
ne peut pas casser la connexité ni laisser passer la horde. Un test l'affirme dans les
deux sens, parce que se tromper sur la seconde moitié serait bien pire que de ne pas
avoir de fenêtres du tout.

Le vitrage suit l'appétit de la salle : rien dans une salle d'eau, des sanitaires ou
une cellule (le principe de la pièce est qu'on n'y voit pas), 72 % des murs éligibles
d'un séjour ou d'une chambre, 15 % d'une réserve ou d'une armurerie, 48 % ailleurs.
Mesuré : 17 fenêtres sur une ville, 55 sur un quartier, 36 sur un lotissement, 6 dans
un bunker (qui n'a presque pas de mur extérieur, ce qui est correct).

Le taux a dû monter d'un tiers à une moitié en cours de route, parce que l'offre de
mur éligible est bien plus petite qu'elle n'y paraît : les côtés d'un bâtiment posés
sur le bord du plateau n'ont rien à voir derrière eux, et dans une ville la plupart
des bâtiments d'un pâté sont enclavés par les autres. Un tiers donnait douze fenêtres
sur une ville entière.

Une **fenêtre n'est pas un appui pour les meubles**, et c'est un compromis assumé :
compter les fenêtres comme mur solide côté ameublement faisait tomber la part des
grands accessoires cliquables de 99 % à 68 %. Un meuble collé à une façade au sud ou à
l'est se fait recouvrir le haut de son empreinte par la tuile devant lui dans la carte
de sélection, donc le clic qui devrait viser l'armoire vise la rue. La faiblesse est
dans l'ordre d'empilement, pas dans les fenêtres ; en attendant, la réponse pas chère
est de ne rien poser là. Personne ne s'est jamais plaint d'un rebord de fenêtre vide.

### Les repères sont tirés d'une réserve, et il en manque toujours

Une ville plantait systématiquement un commissariat et un hôpital, donc la troisième
ville ressemblait à la première. Il y a maintenant six repères possibles, dont quatre
neufs (**caserne de pompiers, école, supermarché, église**), et une ville en tire deux
ou trois.

Il en manque donc la plupart, à chaque partie, et c'est le but plutôt qu'une limite :
en 22 × 22 on ne peut pas tout faire tenir de toute façon. Un raid où la pharmacie
n'est nulle part est un raid qui parle d'autre chose, et une table qui sait qu'une
caserne *pourrait* être là a une raison de regarder.

Chaque repère porte une salle que la table de butin paie, donc tirer dans la réserve
déplace le bon butin et pas seulement la toiture. Mesuré sur 60 villes :

| Salle-repère        | Présente sur |
| ------------------- | ------------ |
| pharmacie           | 73 %         |
| morgue              | 58 %         |
| laboratoire         | 30 %         |
| salle des scellés   | 27 %         |
| armurerie           | 25 %         |
| bloc opératoire     | 15 %         |

2,3 sortes de salles-repères par ville sur six possibles.

### Une clé derrière quelque chose

Les clés atterrissaient dans la salle la plus passante, ce qui en faisait une corvée
facturée en points d'action : entrer, ramasser, sortir. Pendant ce temps les salles que
la table de butin paie double étaient entièrement optionnelles, donc une table qui les
ignorait ne perdait que des points.

La moitié des clés (arrondie au plancher, au moins une) va maintenant dans une salle
brillante quand il en existe une. Les deux décisions deviennent la même décision, et
c'est la façon la moins chère de rendre les bonnes salles porteuses au lieu de
décoratives. Mesuré : 32 % des clés d'une ville et 35 % de celles d'un bunker sont
derrière du bon butin.

Volontairement **pas toutes** : mettre les trois clés derrière les trois meilleures
salles serait un autre jeu. Et une ville qui n'a tiré aucun repère n'a aucune salle de
ce genre (100 % des lotissements, par construction), ce qui ne doit surtout pas
produire un raid impossible : le repli sur les salles ordinaires est la voie normale,
pas un cas d'erreur.

## Reste à faire

- **Les autres biomes.** Le système existe et n'a qu'une entrée. Cyberpunk et
  steampunk étaient demandés : seize objets et neuf créatures chacun, plus une
  palette et une table d'accessoires. Le test d'enveloppe dira si l'arsenal dérive.
- **Les images**. Le plateau et les vingt portraits se dessinent tout seuls ; le
  cahier des charges pour les remplacer est dans [coronaz-art.md](coronaz-art.md).
  Vérifier la licence de la police « 28 Days Later » avant de l'embarquer.
- **Comportements par archétype** : aujourd'hui un archétype impose ses
  statistiques, donc une créature d'un autre biome est un habillage. Des _traits_
  (comme l'invocation de la hurleuse) donneraient une identité mécanique sans
  toucher à la courbe de menace. C'est la suite naturelle des biomes.
- Munitions/essence/relances côté UI (les données existent, la règle les ignore
  sauf lampe et gilet).
- Échanges pendant la phase ennemie, XP/niveaux, classes CIVIL/MILITAIRE.
- Portes _fermables_ : le modèle de cloison en a la place (`door` est un état, plus
  un booléen), mais aucune règle ne s'en sert.
- Niveaux Z : hors périmètre, décidé. Les immeubles sont de plain-pied.
