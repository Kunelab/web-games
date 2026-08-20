# Mafia (nom de code) — règles et conception

> **État (2026-08)** : v2 — **les 63 rôles du wiki sont implémentés** (Ville 20,
> Mafia 15, Triade 12 en famille rivale complète, Neutres 16, Secte par
> conversion), plus murmures (MP), testaments, tribunal du Juge, révélation du
> Prévôt, et le système de setups (templates proposés façon wiki + 10 modèles
> perso par compte + chaos + census). Benchmark : `pnpm --filter mafia-core sim`
> — 50% setup demandé / 50% census (compositions aléatoires, Triade présente
> une fois sur deux à taille égale à la Mafia). v1 initiale : `packages/chat-core` (chat
> générique à canaux/règles de visibilité), `packages/mafia-core` (moteur :
> cycle jour/nuit, accusations, procès, résolution de nuit, victoires, points,
> projection anti-fuite `toMafiaView`, 20 rôles), serveur (`apps/back/src/mafia`
> : manager + timers, bots LLM, persistance `MafiaSessions`, portefeuille
> `MafiaCareers`), front (`apps/front/src/pages/mafia` : setup, siège joueur,
> carte iso SVG 24 parcelles sans skins, `components/chat/ChatPanel` réutilisable).
> Bots : `MAFIA_BOT_PROVIDER=ollama` (défaut, `qwen3.5:4b` local, sortie
> contrainte par schéma JSON — même philosophie que le design deity-game :
> le LLM choisit une direction, le moteur déterministe valide et exécute),
> `anthropic` (Haiku), ou `scripted` (silencieux, aléatoire légal, aucun réseau).
> Simulation headless : `pnpm --filter back mafia:sim`.
> Rôles restants, boutique, sons/musique : à venir (voir ci-dessous).

Jeu de déduction sociale inspiré de l'arcade SC2 *Mafia* (et de ce que *Town of
Salem* était avant les achats intégrés). Entièrement gratuit : on gagne des
points en jouant, les points débloquent des titres, des skins de maison et des
skins de personnage. Rien d'autre. Aucun élément payant, aucun élément qui
affecte le gameplay.

## Nom

Le décor change d'une partie à l'autre (Gotham un soir, hameau Dofus le
lendemain), donc le nom ne doit pas désigner une ville : il doit désigner le
**rituel** (accuser, voter, exiler). Candidats vérifiés (2026-08) :

| Candidat | Statut | Note |
| --- | --- | --- |
| **Ostrakon** | quasi libre (un jeu de plateau obscur de 2004) | le tesson de poterie avec lequel Athènes votait l'exil — littéralement le verbe du jeu ; unique, SEO parfait |
| **Ousted** | libre | compris instantanément en anglais, punchy |
| Hearsay | pris (Jackbox *Hear Say*, Party Pack 11) | — |
| Effigy | pris (FPS Steam 2023) | — |

Non tranché. « Ostrakon » est le plus brandable, « Ousted » le plus accessible.

## Direction artistique

**2.5D isométrique**, pipeline CoronaZ réutilisé (`iso/geometry`, `iso/scene`,
canvas offscreen + couche DOM pour les personnages, caméras téléphone/PC/TV).

Style : **Tim Burton × DC × Ghibli × Dofus** — l'incohérence est assumée, c'est
un carnaval, pas un univers. Le joueur s'exprime :

- **La carte change** et n'a **aucun effet gameplay** : Gotham gothique, village
  Dofus, etc. Une carte = un décor de fond + 24 parcelles + une place centrale.
- **Positions fixes** : maisons et joueurs placés par numéro de slot (1–24).
  Même layout logique sur toutes les cartes ; seul l'habillage change.
- **Skins forcés par joueur** : chaque joueur impose son skin de maison sur sa
  parcelle et son skin de personnage, quel que soit le thème de la carte. Un
  manoir vampire à côté d'une chaumière Dofus dans Gotham : voulu.
- **Le skin de personnage ne révèle jamais le rôle.** Les skins sont un
  catalogue commun sans rapport avec les rôles ; aucun skin « shérif », aucun
  indice visuel. Le rôle ne se lit que dans les actes.
- Personnages en **paper-doll** (corps / tenue / tête / chapeau / objet tenu) :
  les skins se composent, peu d'états d'animation (idle, marche,
  accusation, mort, célébration).
- Maisons = **sprite de façade + couche « fenêtres allumées »** ; la nuit est un
  color grade canvas + lueurs chaudes.

## Anti-fuite : l'API n'envoie que le strict nécessaire

Serveur autoritaire, **projection de vue par joueur** (même principe que
`CzView` par rôle dans CoronaZ). Règles :

- Le rôle d'un joueur n'apparaît que dans **sa** vue ; les mafieux voient leurs
  coéquipiers via le canal de faction, jamais dans un payload commun.
- Résultats de nuit (enquêtes, protections, visites) : envoyés **uniquement aux
  concernés**. Le Lookout reçoit ses visites, personne d'autre.
- **Sons et effets de pouvoirs** : diffusés seulement aux joueurs qui ont le
  droit de les percevoir. Jamais de son « global » déclenché par une action
  secrète.
- **Canaux temporels** : résoudre la nuit en lot et pousser toutes les vues
  au même tick, payloads de taille comparable (padding si besoin) — ni le
  timing ni la taille des paquets ne doivent trahir qui a agi.
- Pas d'identifiants séquentiels d'actions ; pas de champs « optionnels »
  présents/absents selon le rôle (structure de payload identique pour tous).
- Morts : la vue publique ne révèle que ce que les règles de la partie
  révèlent (rôle affiché ou non, testament, nettoyage par Janitor…).
- Chat des morts, chuchotements, canal mafia : **routés serveur**, jamais
  filtrés client.
- Le **replay complet** n'existe côté client qu'après la fin de partie.

## Chat : paquet générique réutilisable

Le chat *est* le gameplay d'un jeu de Mafia ; il doit pourtant être générique
pour servir aussi CoronaZ et les jeux suivants.

- `packages/chat-core` — logique pure, agnostique du transport (branchable sur
  le realtime existant `apps/back/src/realtime`) :
  - modèle **canaux + règles de visibilité** côté serveur : `lobby`, `day`,
    `whisper(a,b)`, `faction(mafia)`, `dead`, `spectator`, `gm` — un canal =
    un prédicat « qui lit / qui écrit » évalué serveur ;
  - types de messages : texte, système, émote, ping ; métadonnées d'auteur
    (titre équipé, couleur de slot) ;
  - anti-spam (rate limit, longueur), hooks de modération/filtre de mots,
    silence (Blackmailer !) exprimé comme une règle de canal ;
  - historique par canal avec rétention configurable, i18n des messages
    système.
- `packages/chat-react` — composant React sans style imposé : slots de rendu
  (avatar, badge de titre), thème par variables CSS. CoronaZ le stylise
  zombie, Mafia le stylise Burton.
- Le jeu déclare ses canaux et leurs prédicats ; le paquet ne connaît ni les
  rôles ni les règles.

## Format de partie

- 4 à **24 joueurs**, slots numérotés à positions fixes.
- Boucle jour/nuit classique : discussion → accusations → procès/défense →
  vote → nuit (pouvoirs simultanés, résolution serveur par lot).
- Phases chronométrées (leçon de CoronaZ : simultané et chronométré, jamais
  séquentiel qui traîne).

## Rôles — recensement complet SC2 Mafia (v1 : tout implémenter)

Source : wiki officiel sc2mafia.com (63 rôles).

**Ville (20)** : Bodyguard, Bus Driver, Citizen, Coroner, Crier, Detective,
Doctor, Escort, Investigator, Jailor, Lookout, Marshall, Mason, Mason Leader,
Mayor, Sheriff, Spy, Stump, Veteran, Vigilante.

**Mafia (15)** : Actress, Agent, Beguiler, Blackmailer, Caporegime,
Consigliere, Consort, Disguiser, Framer, Godfather, Heartbreaker, Janitor,
Kidnapper, Mafioso, Soldato.

**Triade (12)** : Administrator, Deceiver, Diva, Dragon Head, Enforcer,
Forger, Incense Master, Informant, Interrogator, Liaison, Silencer, Vanguard.

**Neutres (16)** : Amnesiac, Arsonist, Auditor, Cultist, Electromaniac,
Executioner, Jester, Judge, Lover, Mass Murderer, Poisoner, Scumbag, Serial
Killer, Survivor, Witch, Witch Doctor.

La Mafia et la Triade sont deux factions miroirs (Godfather↔Dragon Head,
Mafioso↔Enforcer, Consigliere↔Administrator, etc.) : une seule implémentation
paramétrée par faction.

**Ajouts envisagés ensuite** (hors SC2 Mafia) : Vampires + Vampire Hunter
(faction convertisseuse, façon ToS), Werewolf (tueur lié aux nuits de pleine
lune), Farmer (à définir). À ne faire qu'après la v1 complète.

## Le petit plus (propositions, à trancher)

1. **Le replay de fin de partie** (recommandé) — cinématique isométrique
   automatique : toutes les nuits rejouées sur la carte, silhouettes qui
   sortent des maisons, visites, échanges du Bus Driver, le tout en accéléré.
   Le serveur a déjà le log complet ; c'est le moment « ahhh c'était TOI ».
   Partageable (lien/GIF) = acquisition gratuite.
2. **Les morts parient** (recommandé) — les fantômes placent des paris secrets
   (« X est le Parrain », « le Jester gagne ») et gagnent des points de
   boutique si juste. Les morts restent engagés sans pouvoir influencer ni
   fuiter (paris révélés en fin de partie seulement).
3. **Tombes persistantes** — un mort laisse une pierre tombale sur sa parcelle
   avec épitaphe personnalisée (et skins de tombes en boutique). La ville
   devient cimetière au fil de la partie : la tension se *voit*.
4. **Théâtre du procès** — l'accusé est amené sur la place, projecteur,
   30 s de défense, la foule vote pouce levé/baissé avec animations. Le
   moment social clé mérite une mise en scène.
5. **Roue d'émotes sonores** — expression sans chat vocal (toxicité), sons
   courts déblocables en boutique.

1 + 2 sont les plus différenciants ; 3 et 4 sont peu coûteux avec le pipeline
iso ; 5 est du contenu de boutique gratuit.

## Son et musique

**Direction** : jour = pastoral Ghibli (bois, cordes légères, guitare) ;
nuit = Elfman/Burton (boîte à musique, pizzicato, nappes graves, chœurs
lointains). Variantes par carte (Gotham = cuivres noir/jazz sombre ; village
Dofus = folk celtique léger). Pouvoirs = signatures courtes par *catégorie*
(investigation, protection, attaque, tromperie) — jamais par rôle précis dans
un contexte audible d'autrui (cf. anti-fuite).

**Éviter la boucle pénible** :

- boucles longues (2–3 min minimum), **sans hook mélodique** dans le lit
  ambiant — la mélodie est réservée aux *stingers* (aube, crépuscule, mort,
  verdict), qui masquent d'ailleurs les points de bouclage ;
- **couches verticales** : 3–4 stems (nappe, rythme, texture, tension) montés/
  descendus selon la phase et la tension (procès = +tension) plutôt qu'une
  seule piste ;
- **re-séquencement horizontal** : 4–8 phrases interchangeables jouées dans un
  ordre mélangé ;
- lit ambiant mince + **one-shots aléatoires** (oiseaux, grillons, cloche,
  chien au loin) plutôt qu'une boucle dense ; le silence partiel est un outil ;
- Web Audio : boucles sample-accurate via `AudioBufferSourceNode`
  (`loopStart`/`loopEnd`), **OGG et non MP3** (le MP3 ajoute un gap de
  padding), crossfade entre stems.

**Outils** (génération, pas de production maison) :

- Musique : **Suno** ou **Udio** (stems, prompts par ambiance) ; **Stable
  Audio** (fonction boucle seamless native, adapté à l'ambiant) ; en local et
  libre : **MusicGen (Meta AudioCraft)**.
- SFX de pouvoirs : **ElevenLabs SFX** (text-to-sound), complété par les packs
  gratuits **Kenney**, **Sonniss GDC**, **Freesound** (vérifier licences CC).
- Blips UI : **jsfxr** / ChipTone.

## Boutique et économie

- Points gagnés **en jouant** uniquement : participation, victoire, bonus de
  style (accusation juste, survie, victoire Jester, paris de fantôme).
- Catalogue : titres (affichés dans le chat/au-dessus du perso), skins de
  maison, skins de personnage, épitaphes/tombes, émotes sonores, dos de carte
  de rôle.
- Aucun effet gameplay, aucun achat réel, pas de pub. Jamais.
