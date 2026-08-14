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
- **Brouillard** : visible (ligne de vue d'un héros), exploré (déjà vu, entités
  masquées), inexploré (noir). Partagé par l'équipe.

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
d'état en déplacement.

Les fichiers graphiques sont facultatifs et remplaçables un par un : voir
[coronaz-art.md](coronaz-art.md).

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

400 parties par case, joueurs experts, mindset `balanced` :

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
