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
> Bots : `MAFIA_BOT_PROVIDER` est une *chaîne* de cerveaux essayés dans
> l'ordre, par exemple `openai,ollama` — une API gratuite tant qu'elle
> répond, la machine locale sinon, et le cerveau du simulateur quand aucun
> des deux ne répond. Chaque barreau tombe au suivant sur une erreur ou un
> quota, et le dernier barreau est toujours le cerveau joué (`sim/policies`),
> qui est un vrai joueur : la table ne se tait jamais.
>
> - `openai` : n'importe quel point d'entrée compatible OpenAI —
>   `MAFIA_API_URL` (défaut Groq) + `MAFIA_API_KEY` + `MAFIA_API_MODEL`.
>   Couvre Groq, Cerebras, OpenRouter, Together, un vLLM maison.
> - `anthropic` : `ANTHROPIC_API_KEY`.
> - `ollama` : `OLLAMA_URL`, qui n'a pas besoin d'être local — un tunnel
>   `ssh -N -L 11434:127.0.0.1:11434 debian` suffit à faire tourner le modèle
>   sur l'autre machine. Le tag configuré (`MAFIA_BOT_MODEL`) est une
>   *préférence* : le pilote demande à Ollama ce qui est réellement installé et
>   prend le meilleur petit modèle de conversation présent (Qwen d'abord).
> - `scripted` : n'appelle rien.
>
> Le LLM choisit une direction, le moteur déterministe valide et exécute —
> même philosophie que le design deity-game.
> Simulation headless : `pnpm --filter back mafia:sim`.
> **v3 (voir en bas)** : l'interface du siège est une *liste de joueurs* avec
> l'action sur la ligne de sa cible, la ville n'est plus que du décor, la télé
> (`/mafia/tv/:code`) est une option avec mode sans spoiler, `revealOnDeath`
> règle ce qu'un cadavre livre, et quatre correctifs de règles.
> Boutique, skins, sons/musique : à venir (voir ci-dessous).

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

## v3 : l'interface est une liste, la télé est une option

### Le siège : la liste des joueurs *est* le jeu

Toute action de ce jeu vise une personne, donc chaque action vit sur la ligne de
cette personne : « Accuser » à côté d'un nom le jour, « Soigner » à côté du même
nom la nuit. Un seul endroit à regarder, un seul type de geste, un libellé
lisible. Les verbes viennent de `ACTION_LABELS` dans `roles.ts` — c'est du
contenu, pas de la présentation : un prompt de bot et un futur écran veulent le
même mot.

Ce que ça remplace : une carte isométrique non zoomable qui était à la fois le
tableau de bord, le trombinoscope et le seul moyen de viser quoi que ce soit. Sur
un téléphone de 360 px, le viewBox de 596 unités tombait à ~0,57 : les libellés
en `font-size: 11px` s'affichaient à **six pixels**, et la cible tactile était un
losange de 40×20 px dont la surface utile est bien plus petite. CoronaZ avait
déjà résolu exactement ça (`useCzCamera`, cible de 44 px qui annule le zoom) ;
Mafia n'en avait rien hérité.

La ville reste, en décor. `MafiaTown` ne prend **aucun handler**, n'expose rien
de focusable et est `aria-hidden` — ce qui règle au passage l'accessibilité
clavier, puisque tout est devenu de vrais `<button>` dans une vraie liste. Elle
porte ce qui se lit à travers une pièce : qui est debout, qui est en terre,
jour ou nuit, et si le gibet est occupé. Les pouvoirs auto-ciblés (Vétéran,
Survivant) tombent naturellement sur *votre* ligne au lieu d'un bouton niché
dans un paragraphe d'aide.

Les thèmes sont un bloc de tokens `--town-*` et rien d'autre (`[data-town-theme]`),
donc une nouvelle ville est du CSS ; les skins de maison et de personnage se
glisseront derrière les mêmes noms de classe sans toucher aux composants.

### La télé est une option, pas la prémisse

La plupart des parties se jouent **à distance** — téléphones et PC dans des
maisons différentes — donc `/mafia/tv/:code` est un *ajout* pour le cas « on est
tous dans la même pièce ». Elle ne joue pas, ne prend pas de siège, et se
réclame avec le seul code de la table : la projection qu'elle reçoit est celle de
la console hôte, strictement publique (pas de `me`, aucun rôle de vivant, le chat
de la place uniquement). Un secret dans l'URL n'achèterait aucune confidentialité
et coûterait la mise en place en un geste.

**Le mode sans spoiler est actif par défaut**, parce qu'un grand écran partagé
est le seul endroit où une fuite atteint tout le monde d'un coup. Il ne suffit
pas de voiler le trombinoscope : la première version masquait le rôle dans la
liste et l'annonçait en prose juste en dessous. Le moteur marque donc lui-même
ses lignes porteuses d'identité (`ChatMessage.reveals`), et l'écran les retient —
pas de reconnaissance de motif sur du français, le jeu sait et il le dit.

### Ce qu'un cadavre livre : `revealOnDeath`

`role` (classique), `faction` (le camp seulement — et le Coroner vaut soudain un
siège), ou `none` (rien avant la fin : chaque mort devient un argument). Le nom
du rôle s'affiche dans **la couleur de son camp** à côté du nom barré.

Trois choses restent volontairement **hors** du réglage, parce que ce sont des
mécaniques et pas de la présentation :

- un corps **nettoyé** (Nettoyeur, Maître d'encens) reste anonyme quel que soit
  le réglage — c'est ce que le pouvoir achète ;
- un **visage emprunté** (Imposteur, Actrice, Diva) n'arrive jamais sur la
  table d'autopsie : la révélation lit toujours le vrai `role`, parce que
  `disguiseRole` existe pour tromper les *enquêteurs* et rien d'autre ;
- un rôle **réellement changé** — contrôlé, converti, remémoré, initié, ou un
  Bourreau veuf devenu fou — révèle ce qu'il est *devenu*, ce qui est tout
  l'intérêt de ces pouvoirs.

La fin de partie lève tous les réglages : c'est le moment où les masques tombent.

### Quatre correctifs de règles

1. **Le Vétéran et le Tueur de masse ne touchaient jamais un enquêteur.** Les
   visites des rôles d'enquête étaient enregistrées *après* la riposte du perron
   et *après* le massacre de la maison. La nuit se déroule maintenant en deux
   temps explicites — tout le monde déclare son déplacement, *puis* les ripostes
   se résolvent — et le carnage du Tueur de masse est étendu dans sa propre passe
   au lieu d'en ligne, où il ne voyait que les trajets des joueurs déjà parcourus
   par la boucle (l'ordre des sièges décidait donc qui mourait). Trois tests
   tiennent l'invariant.
2. **Le Juge se déduisait de l'arithmétique du verdict.** Le décompte est
   *pondéré* et la liste des noms est un *effectif* : les publier tous les deux
   donnait la différence, et dans un tribunal le seul poids caché du plateau est
   son maillet triple. Le tribunal d'exception vote donc à bulletin secret ; un
   procès ordinaire publie les deux sans risque, le Maire révélé étant le seul
   poids supérieur à un et son écharpe étant déjà publique.
3. **Une journée chargée effaçait toute la mémoire de la partie.** `chat-core`
   gardait 500 messages *au total*, tous canaux confondus, et `castVote`
   annonçait *chaque* vote y compris chaque changement d'avis. La rétention est
   maintenant par canal, et *dans* un canal les annonces du jeu sont comptées
   séparément du bavardage : la place garde ses 250 dernières paroles **et** ses
   250 dernières annonces, et aucun cri ne peut chasser un rapport de l'aube. Les
   accusations ne s'annoncent plus du tout — le décompte vit sur la liste des
   joueurs, où il ne coûte rien.
4. **Les joueurs de la Triade et de la Secte s'entendaient dire « Neutre ».** Le
   libellé de camp était un ternaire à deux branches pour une union à cinq
   membres. C'est un `Record<Faction, string>` (`FACTION_LABELS`), donc un
   sixième camp serait une erreur de compilation et non un mensonge sur un
   téléphone.

Effet mesuré du correctif nº 1 sur le banc (1000 parties par taille) : la Ville
perd de 0 à 1,8 point selon la case, dans le bruit — attendu, puisque ses
enquêteurs meurent maintenant sur les perrons où ils allaient gratuitement.

### Reste à faire, révisé

- **Quatre rôles sans interface** : le tribunal du Juge, la révélation du Prévôt,
  et la seconde cible de la Sorcière et du Chauffeur de bus (`secondTargetSlot`
  existe côté moteur et n'est émis par rien). La liste rend les deux premiers
  triviaux ; les deux autres veulent un second état de sélection.
- **Skins et animations de mort**, pour les procès seulement : les seams sont en
  place (tokens `--town-*`, classes `.mz-house` / `.mz-villager`), la boutique
  et l'économie ne le sont pas.
- **Le census** est absent du sélecteur de setup alors qu'il est la moitié du
  banc.
- **La composition n'est jamais affichée** au lobby : la déduction se raisonne
  sur un pool de rôles connu.

## Ce que la table sait compter

Le cerveau déterministe (`packages/mafia-core/src/sim`) est le vrai joueur :
le LLM parle et écoute, il ne décide presque rien. Quatre couches de
raisonnement, de la plus certaine à la plus statistique.

**L'horloge (`clock.ts`)**. Ce n'était qu'une humeur : quatre crans lus sur un
total de tueurs, avec une barre décalée d'une corde. C'est maintenant un
**budget d'erreurs**. Une pendaison ratée coûte la corde et la nuit et laisse
les tueurs entiers, donc la marge baisse ; une pendaison juste coûte les mêmes
têtes et emporte un tueur, donc elle ne coûte rien. D'où trois phrases qu'un
joueur dit à voix haute et que la table ne pouvait pas calculer :

- « il nous reste une erreur » : `mislynches`, disponible dès le jour deux
  puisque la liste des rôles est affichée ;
- « passer coûte moins cher que se tromper » : une journée jetée coûte une
  tête, une pendaison ratée en coûte deux ;
- « ils ne sont pas un seul camp » : la parité est la victoire d'une *famille*,
  pas d'un tueur solo. Attention, corrigé par le banc : séparer par faction sans
  compter les couteaux par nuit a rendu la ville insouciante face aux tueurs
  solos, +5 points de victoires solo en une passe. Le coût d'une journée perdue
  se compte donc en morts observées, pas en rôles distribués.

**Le comptage (`beliefs.ts`)**. Qui pouvait tuer cette nuit, une fois rayés ceux
que ce siège sait innocents. Il ne parlait qu'à un ou deux noms restants ; il
rapporte maintenant la liste entière, **sans score** : tarifée à un sur quatre,
elle remonte tous les sièges de la liste à l'identique, ne réordonne personne
et coûtait 1,7 point de victoire au banc. La phrase reste, parce que « c'est
l'un de ces quatre, et voilà qui ce n'est pas » vaut un après-midi.

**Les déductions (`deduce.ts`)**. Uniquement du certain. Nouveauté : le
**principe des tiroirs** sur les vivants. Trois sièges annoncent un badge
d'enquête, la liste n'a que deux places qui pourraient en contenir un, donc l'un
des trois ment et l'arithmétique le dit avant que personne n'ait rien vu. Prudent
par construction : dernière annonce par siège, vivants seulement, rien du tout
si le cimetière lui-même ne rentre plus dans la liste (conversion, promotion,
amnésique).

**Le classement (`ranking.ts`, `visits.ts`, `tempo.ts`)**. Chaque règle est un
rapport de vraisemblance *mesuré* au banc (`sim --calibrate`), jamais discuté :
le log du rapport *est* le poids. Deux ajouts, deux abandons documentés.

| Règle | Sur les tueurs | Sur les autres | Poids |
| --- | --- | --- | --- |
| `led-town-wagon` (a lancé la meute sur un innocent) | 6,1 % | 4,1 % | +0,383 |
| `led-killer-wagon` (l'a lancée sur un tueur) | 5,4 % | 8,5 % | -0,450 |
| `accuser-silenced` (son accusateur meurt la nuit même) | 1,5 % | 1,0 % | +0,385 |
| `hammered-town` (a donné la voix qui ouvre le procès) | 2,8 % | 3,0 % | abandonnée |
| `never-first` (n'ouvre jamais une meute) | 5,6 % | 7,5 % | abandonnée |

`hammered-town` ne mesure rien : quand une meute atteint la barre, l'après-midi
est déjà décidé et le dernier votant ne porte l'intention de personne.
`never-first` mesure quelque chose de réel et de mauvais : nos tueurs jouent une
politique plus agressive que nos villageois, donc la règle détecte *quel bot
tourne*, ce qui flatte le banc et ne dit rien d'une personne.

`tempo.ts` lit enfin l'ordre des votes, que `state.voteLog` enregistrait depuis
toujours sans lecteur : qui a ouvert la meute, qui l'a rejointe, qui en est
descendu au bord de la corde. Détail amusant : `lateSwitch` est un trait de
personnalité que les bots *jouent* et que rien ne pouvait détecter.
`saved-at-the-edge` est détecté et volontairement non tarifé, parce qu'un bot
tueur ne monte jamais sur la meute de son frère et que le banc ne mesurerait
donc que des villageois qui changent d'avis.

## Boîte noire : les dix dernières parties

Tout ce qui est intéressant chez ces bots se passe entre le moment où quelqu'un
appuie sur entrée et la seconde qui suit, et cette seconde ne laissait aucune
trace : le chat montre la réponse, le journal du serveur montre un barreau
d'échelle, et rien ne montrait le brouillon écrit par la politique, la
revendication déposée par le lecteur, le prompt envoyé au modèle, la phrase
renvoyée, ni laquelle des deux la table a réellement dite.

`src/trace.ts` enregistre une partie par fichier, une ligne JSON par événement,
et ne garde que les dernières (dix par défaut). Mafia et CoronaZ écrivent tous
les deux ; Mafia écrit beaucoup plus, parce qu'il y a beaucoup plus à expliquer.

| Événement | Ce qu'il dit |
| --------- | ------------ |
| `deal` | la distribution complète, écrite au début et pas à la fin : une partie qui plante est justement celle qu'on veut relire |
| `phase` | chaque battement d'horloge, avec les vivants et le temps restant |
| `chat` | chaque ligne dite, par qui, dans quel salon |
| `parse` | ce que le lecteur déterministe a compris d'une ligne humaine, **y compris quand il n'a rien compris** |
| `ear` | la transcription envoyée au modèle et les revendications qu'il en a tirées, côte à côte |
| `room-parse`, `room-ear` | les mêmes deux lectures pour un salon privé |
| `draft` | le brouillon de la politique : vote, cible, revendication, phrase de secours, et pourquoi la bouche a été appelée ou non |
| `llm` | un appel : barreau, modèle, durée, prompt, réponse, ou le statut du refus |
| `chain` | un barreau mis au banc, ou une marche qui a manqué de temps |
| `unsaid` | une phrase décidée et jamais dite, avec la raison (budget de parole, doublon, salon inexistant) |
| `vote`, `ballot`, `night-action`, `day-action`, `will` | chaque coup, humain comme bot, par la même porte |
| `death`, `close` | le cimetière et l'issue |

```
pnpm --filter back trace                 # les dernières parties
pnpm --filter back trace latest          # le résumé de la plus récente
pnpm --filter back trace latest --talk   # et la conversation, lectures comprises
pnpm --filter back trace latest --raw=llm
```

Le résumé répond aux quatre questions qu'on pose vraiment : en combien de temps
la table a répondu à une personne, quel barreau a répondu et en combien de
temps, ce que les deux lecteurs ont compris, et ce que les sièges ont décidé
sans jamais le dire.

`GAME_TRACE=off` coupe tout, `full` ne tronque plus les longues chaînes (le
réglage des soirées où la question est « qu'y avait-il exactement dans ce
prompt »), `GAME_TRACE_KEEP` change le nombre de parties gardées.

## La ville : deux rues, aucune maison au premier plan

Les vingt-quatre parcelles formaient l'anneau d'une grille 7×7, ce qui mettait un
quart de la ville sur le bord bas de l'écran, dos à la caméra, devant tout le
reste et masquant la place qu'elle était censée entourer. Elles forment
maintenant un chevron : deux rues de deux rangées qui descendent vers le
spectateur, rien en travers du premier plan, la place devant.

- **La maison est tournée vers la place.** Le sprite est dessiné porte en bas à
  gauche, donc la rue de droite le garde tel quel et celle de gauche le
  retourne. C'est la seule rotation qu'un sprite plat autorise et c'est la
  bonne : une rangée de maisons toutes orientées pareil se lit comme du papier
  peint, et une maison qui tourne le dos à la place se lit comme un bug.
- **La parcelle est tirée au sort**, à partir du code de la table. Avant, l'ordre
  des sièges était l'ordre des parcelles : la colline était un diagramme de
  l'ordre d'arrivée. Le tirage est déterministe, donc tous les écrans sont
  d'accord sans que le serveur porte un champ de plus, et stable pour toute la
  partie.
- **Le villageois se tient devant sa propre porte.** Il était calé sur le coin
  de la tuile suivante et semblait appartenir à la maison d'à côté.
- **On peint par profondeur, maison puis habitant, parcelle par parcelle.** En
  deux passes (tous les toits, puis tous les gens), un villageois de la rangée
  du fond se retrouvait peint par-dessus le toit de la maison devant lui.
- **Rien sur la colline ne doit trahir un rôle.** La ville est publique : les
  modèles `doctor`, `mafia` et `sheriff` existent dans les rendus et n'ont rien
  à y faire. Seuls le villageois neutre, l'accusé et le mort sont livrés.

L'art vient de `D:\ComfyUI\output\final\mafia`, en RGB plat sur fond gris studio.
`apps/front/scripts/art-cutout.mjs` le détoure (remplissage depuis les bords,
bord adouci), le recadre sur le sujet et enlève le compteur de rendu. Si un
fichier manque, la ville vectorielle d'origine reste dessinée dessous : une
copie fraîche du dépôt sans art montre toujours une ville.

## Le son

Huit prises, pas une synthèse : `mafiaSound.ts`. CoronaZ synthétise parce qu'il
lui faut une détonation par calibre ; Mafia veut l'inverse, une poignée de
moments qui arrivent une fois et qui comptent (l'aube, la nuit, l'ouverture du
procès, la corde, un corps, la fin).

La difficulté n'est pas le son, c'est le *quand* : chaque événement est une
transition observée par plusieurs écrans à la fois. Chaque signal est donc
accroché à une valeur qui ne bouge qu'une fois, le premier état vu ne déclenche
rien (ouvrir une table à minuit ne doit pas annoncer la nuit), et deux signaux
dans le même tick ne se superposent pas. Coupure du son par appareil,
`localStorage`, une clé.
