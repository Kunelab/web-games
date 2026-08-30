/**
 * The complete SC2 Mafia census: all 63 roles across Town, Mafia, Triad and
 * Neutral (docs/mafia.md). Mafia and Triad are rival *families* sharing the
 * same machinery — leader, executors, private channel — and the Cult is a
 * third, conversion-based family that only exists once a Cultist recruits.
 *
 * Roles are data; the mechanics live in the engine keyed by `nightAction`.
 * Triad roles are exact mirrors of mafia roles and share their action types.
 */

export type Faction = 'town' | 'mafia' | 'triad' | 'cult' | 'neutral';

/**
 * What a player is told their camp is called.
 *
 * A `Record` rather than a chain of ternaries on purpose: the screen that shows
 * this used two branches for a five-member union, so every Triad member and
 * every convert was told they were Neutral — on the one card that exists to say
 * which side you are on. Keyed by the type, so adding a sixth faction is a
 * compile error here instead of a lie on a phone.
 */
export const FACTION_LABELS: Record<Faction, string> = {
  town: 'Ville',
  mafia: 'Mafia',
  triad: 'Triade',
  cult: 'Secte',
  neutral: 'Neutre'
};

 
export type RoleId =
  // Town (20)
  | 'bodyguard'
  | 'bus-driver'
  | 'citizen'
  | 'coroner'
  | 'crier'
  | 'detective'
  | 'doctor'
  | 'escort'
  | 'investigator'
  | 'jailor'
  | 'lookout'
  | 'marshall'
  | 'mason'
  | 'mason-leader'
  | 'mayor'
  | 'sheriff'
  | 'spy'
  | 'stump'
  | 'veteran'
  | 'vigilante'
  // Mafia (15)
  | 'actress'
  | 'agent'
  | 'beguiler'
  | 'blackmailer'
  | 'caporegime'
  | 'consigliere'
  | 'consort'
  | 'disguiser'
  | 'framer'
  | 'godfather'
  | 'heartbreaker'
  | 'janitor'
  | 'kidnapper'
  | 'mafioso'
  | 'soldato'
  // Triad (12)
  | 'administrator'
  | 'deceiver'
  | 'diva'
  | 'dragon-head'
  | 'enforcer'
  | 'forger'
  | 'incense-master'
  | 'informant'
  | 'interrogator'
  | 'liaison'
  | 'silencer'
  | 'vanguard'
  // Neutral (16)
  | 'amnesiac'
  | 'arsonist'
  | 'auditor'
  | 'cultist'
  | 'electromaniac'
  | 'executioner'
  | 'jester'
  | 'judge'
  | 'lover'
  | 'mass-murderer'
  | 'poisoner'
  | 'scumbag'
  | 'serial-killer'
  | 'survivor'
  | 'witch'
  | 'witch-doctor';
 

/** What a role does when night falls. Drives the action UI and the resolver. */
export type NightActionType =
  | 'kill' // family executors/leaders, vigilante, serial killer
  | 'heal' // doctor, witch doctor
  | 'guard' // bodyguard
  | 'block' // escort, consort, liaison
  | 'investigate' // sheriff: suspect / not suspect
  | 'examine' // investigator/detective(line); consigliere/administrator (exact)
  | 'watch' // lookout: who visited the house
  | 'track' // detective: where the target went
  | 'shadow' // agent, informant: both directions
  | 'frame' // framer, forger
  | 'jail-execute' // jailor, on the player jailed during the day
  | 'alert' // veteran, self
  | 'vest' // survivor, self
  | 'douse' // arsonist; self = ignite
  | 'control' // witch: redirect an action (two targets)
  | 'silence' // blackmailer, silencer
  | 'clean' // janitor, incense master: hide the victim's role
  | 'swap' // bus driver: exchange two houses' fates (two targets)
  | 'kidnap' // kidnapper, interrogator: block + shelter, roughly
  | 'recruit' // mason leader: a citizen joins the lodge
  | 'convert' // cultist: a town soul joins the cult (cooldown)
  | 'remember' // amnesiac: become a dead player's role
  | 'audit' // auditor: strip a role down to its street clothes
  | 'imitate' // actress, diva: wear a target's face for the examiners
  | 'hide' // beguiler, deceiver: attacks on you land on your host
  | 'charm' // heartbreaker: if you die, your beloved follows
  | 'bond' // lover: pick a partner; live together or die together
  | 'autopsy' // coroner: read a corpse, cleaned or not
  | 'rampage' // mass murderer: kill a house and everyone in it
  | 'poison' // poisoner: death tomorrow unless a doctor intervenes
  | 'charge'; // electromaniac; self = discharge

/**
 * The verb on the button, per power.
 *
 * The seat screen puts each night action on the row of the player it targets, so
 * every power needs a word short enough to sit beside a name. Content, not
 * presentation, which is why it lives next to the role names rather than in the
 * frontend: a bot's prompt and a future TV screen want the same word.
 */
export const ACTION_LABELS: Record<NightActionType, string> = {
  kill: 'Tuer',
  heal: 'Soigner',
  guard: 'Protéger',
  block: 'Occuper',
  investigate: 'Sonder',
  examine: 'Examiner',
  watch: 'Surveiller',
  track: 'Pister',
  shadow: 'Suivre',
  frame: 'Piéger',
  'jail-execute': 'Exécuter',
  alert: 'Se mettre en alerte',
  vest: 'Enfiler le gilet',
  douse: 'Arroser',
  control: 'Envoûter',
  silence: 'Faire taire',
  clean: 'Nettoyer',
  swap: 'Échanger',
  kidnap: 'Enlever',
  recruit: 'Initier',
  convert: 'Convertir',
  remember: 'Se souvenir',
  audit: 'Contrôler',
  imitate: 'Emprunter le visage',
  hide: 'Se cacher chez',
  charm: 'Séduire',
  bond: 'Aimer',
  autopsy: 'Autopsier',
  rampage: 'Massacrer',
  poison: 'Empoisonner',
  charge: 'Câbler'
};

/**
 * The powers whose own house is the target: the match, the lever, the ignition.
 *
 * `legalNightAction` offers the actor's own slot for these, and pointing one at
 * yourself is what fires it — so the button on your own row has to read
 * differently from the same button on somebody else's.
 */
export const SELF_FIRES: Partial<Record<NightActionType, string>> = {
  douse: 'Tout brûler',
  charge: 'Envoyer le courant'
};

export interface RoleDef {
  id: RoleId;
  name: string;
  faction: Faction;
  nightAction: NightActionType | null;
  /** Self-targeted actions (alert, vest) need no target picker. */
  selfTarget?: boolean;
  /** Uses per game for limited actions. */
  charges?: number;
  /** Survives basic (power 1) night attacks. */
  nightImmune?: boolean;
  /** Reads innocent to the sheriff despite being evil. */
  detectionImmune?: boolean;
  /** Reads SUSPECT to the sheriff. */
  suspicious?: boolean;
  /** At most one per table. */
  unique?: boolean;
  /** Family kill chain: leaders order, executors carry. */
  familyRank?: 'leader' | 'executor';
  /** Solo killing role: wins alone, counted apart from families. */
  soloKiller?: boolean;
  /** One-line pitch shown on the role card. */
  description: string;
  /** What the investigator sees, as a trade id: `mafia.trade.<id>`. */
  investigated: string;
}

/**
 * The Investigator's answer sheet, as trade *ids*.
 *
 * Roles sharing a trade share a line, which is the whole mechanic: an ambiguous
 * result is the information, so two roles must read identically rather than
 * merely similarly. That is also why these are ids and not sentences — the words
 * live in one catalogue entry per trade (`mafia.trade.*`), so a translator
 * physically cannot give the Doctor and the Witch Doctor two different phrasings
 * of "well-kept hands" and quietly break the bluff.
 */
const L = {
  quiet: 'quiet',
  snoop: 'snoop',
  watcher: 'watcher',
  healer: 'healer',
  rough: 'rough',
  night: 'night',
  powder: 'powder',
  keys: 'keys',
  hands: 'hands',
  ink: 'ink',
  laugh: 'laugh',
  blade: 'blade',
  gas: 'gas',
  herbs: 'herbs',
  wheel: 'wheel',
  chalk: 'chalk',
  paint: 'paint',
  wires: 'wires',
  bottle: 'bottle',
  rope: 'rope',
  charm: 'charm',
  dirt: 'dirt'
} as const;

const def = (role: RoleDef): RoleDef => role;

export const ROLES: Record<RoleId, RoleDef> = {
  /* --------------------------------- Town --------------------------------- */
  citizen: def({ id: 'citizen', name: 'Citoyen', faction: 'town', nightAction: null, description: 'Aucun pouvoir, une voix. Votre arme est le débat.', investigated: L.quiet }),
  sheriff: def({ id: 'sheriff', name: 'Shérif', faction: 'town', nightAction: 'investigate', description: 'Chaque nuit, sonde un joueur : suspect ou non.', investigated: L.snoop }),
  investigator: def({ id: 'investigator', name: 'Détective privé', faction: 'town', nightAction: 'examine', description: 'Chaque nuit, examine un joueur et découvre son métier probable.', investigated: L.snoop }),
  detective: def({ id: 'detective', name: 'Limier', faction: 'town', nightAction: 'track', description: 'Chaque nuit, file un joueur et découvre chez qui il est allé.', investigated: L.snoop }),
  lookout: def({ id: 'lookout', name: 'Guetteur', faction: 'town', nightAction: 'watch', description: 'Chaque nuit, surveille une maison et voit qui la visite.', investigated: L.watcher }),
  spy: def({ id: 'spy', name: 'Espion', faction: 'town', nightAction: null, description: 'Écoute les conciliabules des familles la nuit — sans jamais voir les visages — et apprend qui elles ont visé.', investigated: L.watcher }),
  coroner: def({ id: 'coroner', name: 'Légiste', faction: 'town', nightAction: 'autopsy', description: 'Chaque nuit, autopsie un cadavre et découvre son vrai rôle, maquillé ou non.', investigated: L.chalk }),
  doctor: def({ id: 'doctor', name: 'Médecin', faction: 'town', nightAction: 'heal', description: 'Chaque nuit, soigne un joueur et le sauve d’une attaque.', investigated: L.healer }),
  bodyguard: def({ id: 'bodyguard', name: 'Garde du corps', faction: 'town', nightAction: 'guard', description: 'Protège un joueur ; si on l’attaque, vous tombez avec l’agresseur.', investigated: L.rough }),
  escort: def({ id: 'escort', name: 'Hôtesse', faction: 'town', nightAction: 'block', description: 'Chaque nuit, retient un joueur chez lui : son action est annulée.', investigated: L.night }),
  'bus-driver': def({ id: 'bus-driver', name: 'Chauffeur de bus', faction: 'town', nightAction: 'swap', description: 'Chaque nuit, échange deux maisons : tout ce qui visait l’une arrive chez l’autre.', investigated: L.wheel }),
  vigilante: def({ id: 'vigilante', name: 'Justicier', faction: 'town', nightAction: 'kill', charges: 3, description: 'Trois balles pour rendre justice vous-même. Visez juste.', investigated: L.powder }),
  veteran: def({ id: 'veteran', name: 'Vétéran', faction: 'town', nightAction: 'alert', selfTarget: true, charges: 3, unique: true, description: 'En alerte, abat quiconque lui rend visite cette nuit-là.', investigated: L.powder }),
  jailor: def({ id: 'jailor', name: 'Geôlier', faction: 'town', nightAction: 'jail-execute', charges: 3, unique: true, description: 'Le jour, choisit un prisonnier ; la nuit, l’interroge en cellule et peut l’exécuter.', investigated: L.keys }),
  mayor: def({ id: 'mayor', name: 'Maire', faction: 'town', nightAction: null, unique: true, description: 'Peut se révéler en plein jour : son vote compte alors triple.', investigated: L.hands }),
  marshall: def({ id: 'marshall', name: 'Prévôt', faction: 'town', nightAction: null, unique: true, description: 'Peut se révéler en plein jour : ce jour-là, la ville juge sans défense et pend à la chaîne.', investigated: L.hands }),
  crier: def({ id: 'crier', name: 'Crieur public', faction: 'town', nightAction: null, description: 'Sa voix porte même la nuit — anonyme, sur la place du village.', investigated: L.hands }),
  mason: def({ id: 'mason', name: 'Franc-maçon', faction: 'town', nightAction: null, description: 'Membre de la loge : les frères se connaissent et se parlent la nuit.', investigated: L.rough }),
  'mason-leader': def({ id: 'mason-leader', name: 'Maître de loge', faction: 'town', nightAction: 'recruit', unique: true, description: 'Chaque nuit, peut initier un citoyen à la loge.', investigated: L.rough }),
  stump: def({ id: 'stump', name: 'Souche', faction: 'town', nightAction: null, nightImmune: true, description: 'Un arbre a des racines et un avis. Ne parle pas, ne meurt pas la nuit, vote.', investigated: L.dirt }),

  /* -------------------------------- Mafia --------------------------------- */
  godfather: def({ id: 'godfather', name: 'Parrain', faction: 'mafia', nightAction: 'kill', nightImmune: true, detectionImmune: true, unique: true, familyRank: 'leader', description: 'Ordonne le meurtre de la nuit. Insoupçonnable, intouchable chez lui.', investigated: L.hands }),
  mafioso: def({ id: 'mafioso', name: 'Mafioso', faction: 'mafia', nightAction: 'kill', familyRank: 'executor', description: 'Le bras armé de la famille : exécute l’ordre du Parrain.', investigated: L.powder }),
  caporegime: def({ id: 'caporegime', name: 'Caporegime', faction: 'mafia', nightAction: 'kill', familyRank: 'executor', description: 'Lieutenant de la famille. Quand le Parrain tombe, il apprend à sourire comme lui.', investigated: L.powder }),
  soldato: def({ id: 'soldato', name: 'Soldato', faction: 'mafia', nightAction: 'kill', familyRank: 'executor', description: 'Un soldat de plus dans la famille. Les ordres sont les ordres.', investigated: L.powder }),
  consigliere: def({ id: 'consigliere', name: 'Consigliere', faction: 'mafia', nightAction: 'examine', description: 'Chaque nuit, découvre le rôle exact d’un joueur.', investigated: L.snoop }),
  consort: def({ id: 'consort', name: 'Escorte de la famille', faction: 'mafia', nightAction: 'block', description: 'Chaque nuit, retient un joueur chez lui : son action est annulée.', investigated: L.night }),
  framer: def({ id: 'framer', name: 'Faussaire', faction: 'mafia', nightAction: 'frame', description: 'Maquille un innocent en suspect pour la nuit.', investigated: L.ink }),
  blackmailer: def({ id: 'blackmailer', name: 'Maître chanteur', faction: 'mafia', nightAction: 'silence', description: 'Chaque nuit, bâillonne un joueur : demain, il votera mais ne dira pas un mot.', investigated: L.watcher }),
  janitor: def({ id: 'janitor', name: 'Nettoyeur', faction: 'mafia', nightAction: 'clean', charges: 3, description: 'Fait disparaître l’identité du cadavre — la ville enterre un inconnu, la famille apprend son rôle.', investigated: L.chalk }),
  agent: def({ id: 'agent', name: 'Agent', faction: 'mafia', nightAction: 'shadow', description: 'Chaque nuit, piste un joueur : qui l’a visité, et chez qui il est allé.', investigated: L.watcher }),
  beguiler: def({ id: 'beguiler', name: 'Enjôleur', faction: 'mafia', nightAction: 'hide', description: 'Se cache chez quelqu’un : ce qu’on lui destinait frappe son hôte.', investigated: L.night }),
  disguiser: def({ id: 'disguiser', name: 'Imposteur', faction: 'mafia', nightAction: 'imitate', description: 'Vole le profil d’un joueur : les enquêteurs verront l’autre visage.', investigated: L.paint }),
  actress: def({ id: 'actress', name: 'Actrice', faction: 'mafia', nightAction: 'imitate', description: 'Joue le rôle d’un autre : les enquêteurs applaudissent sans comprendre.', investigated: L.paint }),
  kidnapper: def({ id: 'kidnapper', name: 'Ravisseur', faction: 'mafia', nightAction: 'kidnap', description: 'Enlève un joueur pour la nuit : injoignable, inoffensif, furieux.', investigated: L.rope }),
  heartbreaker: def({ id: 'heartbreaker', name: 'Bourreau des cœurs', faction: 'mafia', nightAction: 'charm', description: 'Rend un joueur fou d’amour : si votre cœur s’arrête, le sien aussi.', investigated: L.charm }),

  /* -------------------------------- Triade -------------------------------- */
  'dragon-head': def({ id: 'dragon-head', name: 'Tête de Dragon', faction: 'triad', nightAction: 'kill', nightImmune: true, detectionImmune: true, unique: true, familyRank: 'leader', description: 'Ordonne le meurtre de la nuit pour la Triade. Insoupçonnable, intouchable.', investigated: L.hands }),
  enforcer: def({ id: 'enforcer', name: 'Exécuteur', faction: 'triad', nightAction: 'kill', familyRank: 'executor', description: 'Le bras armé de la Triade.', investigated: L.powder }),
  vanguard: def({ id: 'vanguard', name: 'Avant-garde', faction: 'triad', nightAction: 'kill', familyRank: 'executor', description: 'Un soldat de plus pour la Triade.', investigated: L.powder }),
  administrator: def({ id: 'administrator', name: 'Administrateur', faction: 'triad', nightAction: 'examine', description: 'Chaque nuit, découvre le rôle exact d’un joueur.', investigated: L.snoop }),
  liaison: def({ id: 'liaison', name: 'Agente de liaison', faction: 'triad', nightAction: 'block', description: 'Chaque nuit, retient un joueur chez lui : son action est annulée.', investigated: L.night }),
  forger: def({ id: 'forger', name: 'Contrefacteur', faction: 'triad', nightAction: 'frame', description: 'Maquille un innocent en suspect pour la nuit.', investigated: L.ink }),
  silencer: def({ id: 'silencer', name: 'Bâillonneur', faction: 'triad', nightAction: 'silence', description: 'Chaque nuit, bâillonne un joueur : demain, il votera sans un mot.', investigated: L.watcher }),
  'incense-master': def({ id: 'incense-master', name: 'Maître de l’encens', faction: 'triad', nightAction: 'clean', charges: 3, description: 'L’encens efface l’identité du cadavre ; la Triade, elle, apprend tout.', investigated: L.chalk }),
  informant: def({ id: 'informant', name: 'Indicateur', faction: 'triad', nightAction: 'shadow', description: 'Chaque nuit, piste un joueur : visites reçues, visites rendues.', investigated: L.watcher }),
  deceiver: def({ id: 'deceiver', name: 'Trompeur', faction: 'triad', nightAction: 'hide', description: 'Se cache chez quelqu’un : ce qu’on lui destinait frappe son hôte.', investigated: L.night }),
  interrogator: def({ id: 'interrogator', name: 'Interrogateur', faction: 'triad', nightAction: 'kidnap', description: 'Enlève un joueur pour la nuit : injoignable, inoffensif, terrifié.', investigated: L.rope }),
  diva: def({ id: 'diva', name: 'Diva', faction: 'triad', nightAction: 'imitate', description: 'Se pare du visage d’un autre : les enquêteurs n’y verront que du feu.', investigated: L.paint }),

  /* ------------------------------- Neutres -------------------------------- */
  jester: def({ id: 'jester', name: 'Bouffon', faction: 'neutral', nightAction: null, description: 'Vous gagnez si la ville vous pend. Faites-vous détester.', investigated: L.laugh }),
  executioner: def({ id: 'executioner', name: 'Bourreau', faction: 'neutral', nightAction: null, description: 'Obsédé par une cible : faites-la pendre de jour et vous gagnez. Si elle meurt la nuit, le deuil vous rend Bouffon.', investigated: L.blade }),
  survivor: def({ id: 'survivor', name: 'Survivant', faction: 'neutral', nightAction: 'vest', selfTarget: true, charges: 4, description: 'Gagne s’il voit la fin, peu importe qui l’emporte. Quatre gilets pare-balles.', investigated: L.quiet }),
  amnesiac: def({ id: 'amnesiac', name: 'Amnésique', faction: 'neutral', nightAction: 'remember', description: 'Ne se souvient plus qui il est. Une nuit, au cimetière, ça lui reviendra.', investigated: L.quiet }),
  scumbag: def({ id: 'scumbag', name: 'Crapule', faction: 'neutral', nightAction: null, suspicious: true, description: 'Une sale réputation et aucun pouvoir. Gagne si la ville perd — et qu’il respire encore.', investigated: L.blade }),
  judge: def({ id: 'judge', name: 'Juge', faction: 'neutral', nightAction: null, charges: 1, unique: true, description: 'Peut convoquer un tribunal d’exception : jugement immédiat, sans défense, et sa voix compte triple. Gagne si la ville perd.', investigated: L.hands }),
  auditor: def({ id: 'auditor', name: 'Contrôleur fiscal', faction: 'neutral', nightAction: 'audit', charges: 3, description: 'Réduit un joueur à néant administratif : son rôle est dissous. Gagne si la ville perd.', investigated: L.ink }),
  witch: def({ id: 'witch', name: 'Sorcière', faction: 'neutral', nightAction: 'control', description: 'Chaque nuit, envoûte un joueur et détourne son geste vers une autre maison. Gagne si la Ville ne gagne pas — et qu’elle respire encore.', investigated: L.herbs }),
  lover: def({ id: 'lover', name: 'Amoureux', faction: 'neutral', nightAction: 'bond', charges: 1, description: 'Choisit l’élu de son cœur. Ils gagnent ensemble s’ils survivent ensemble — et meurent ensemble.', investigated: L.charm }),
  cultist: def({ id: 'cultist', name: 'Sectateur', faction: 'cult', nightAction: 'convert', suspicious: true, description: 'Une nuit sur deux, convertit une âme de la ville. La secte gagne quand elle est majoritaire.', investigated: L.herbs }),
  'witch-doctor': def({ id: 'witch-doctor', name: 'Guérisseur vaudou', faction: 'cult', nightAction: 'heal', suspicious: true, description: 'Le médecin de la secte : soigne les siens comme les autres.', investigated: L.healer }),
  'serial-killer': def({ id: 'serial-killer', name: 'Tueur en série', faction: 'neutral', nightAction: 'kill', nightImmune: true, suspicious: true, unique: true, soloKiller: true, description: 'Tue chaque nuit — sa lame perce les gilets et même la garde du Parrain. Gagne seul, quand plus personne ne peut l’arrêter.', investigated: L.powder }),
  'mass-murderer': def({ id: 'mass-murderer', name: 'Tueur de masse', faction: 'neutral', nightAction: 'rampage', nightImmune: true, suspicious: true, unique: true, soloKiller: true, description: 'Massacre une maison et tous ceux qui s’y trouvent cette nuit-là. Gagne seul.', investigated: L.blade }),
  arsonist: def({ id: 'arsonist', name: 'Incendiaire', faction: 'neutral', nightAction: 'douse', nightImmune: true, suspicious: true, unique: true, soloKiller: true, description: 'Arrose une maison d’essence chaque nuit — ou craque l’allumette chez lui et tout ce qui est imbibé s’embrase. Rien n’arrête le feu. Gagne seul.', investigated: L.gas }),
  poisoner: def({ id: 'poisoner', name: 'Empoisonneur', faction: 'neutral', nightAction: 'poison', nightImmune: true, suspicious: true, unique: true, soloKiller: true, description: 'Un poison lent : la victime s’éteint la nuit suivante, sauf si un médecin la purge à temps. Gagne seul.', investigated: L.bottle }),
  electromaniac: def({ id: 'electromaniac', name: 'Électromane', faction: 'neutral', nightAction: 'charge', nightImmune: true, suspicious: true, unique: true, soloKiller: true, description: 'Électrise les maisons en silence — puis, chez lui, abaisse la manette. Gagne seul.', investigated: L.wires })
};

export function roleDef(id: RoleId): RoleDef {
  return ROLES[id];
}

/** The killing families and their chain of command. */
export const FAMILIES = {
  mafia: { channel: 'mafia', label: 'la Mafia', leader: 'godfather' as RoleId },
  triad: { channel: 'triad', label: 'la Triade', leader: 'dragon-head' as RoleId }
} as const;

export type FamilyId = keyof typeof FAMILIES | 'cult';

/** The family a role belongs to, or null for town and neutrals. */
export function familyOf(role: RoleId): FamilyId | null {
  const faction = ROLES[role].faction;
  return faction === 'mafia' || faction === 'triad' || faction === 'cult' ? faction : null;
}

export function isSoloKiller(role: RoleId): boolean {
  return !!ROLES[role].soloKiller;
}

/** Neutral roles that block nobody's victory: they win alongside, never against. */
export const BYSTANDER_ROLES: ReadonlySet<RoleId> = new Set<RoleId>([
  'jester',
  'survivor',
  'executioner',
  'witch',
  'judge',
  'scumbag',
  'auditor',
  'amnesiac',
  'lover'
]);

export function rolesOfFaction(faction: Faction): RoleId[] {
  return (Object.keys(ROLES) as RoleId[]).filter((role) => ROLES[role].faction === faction);
}

/**
 * Builds the automatic role list for a table of `n` players (4–24) — mafia
 * only; the Triad appears through setups and the census benchmark.
 */
export function rosterFor(n: number): RoleId[] {
  const roster: RoleId[] = [];

  const mafiaCount = Math.max(1, Math.floor(n / 4));
  const mafiaOrder: RoleId[] = ['godfather', 'mafioso', 'consort', 'consigliere', 'framer', 'blackmailer'];
  for (let i = 0; i < mafiaCount; i++) {
    roster.push(mafiaOrder[Math.min(i, mafiaOrder.length - 1)] ?? 'mafioso');
  }

  if (n >= 6) roster.push('jester');
  if (n >= 8) roster.push('serial-killer');
  if (n >= 10) roster.push('executioner');
  if (n >= 12) roster.push('survivor');
  if (n >= 14) roster.push('witch');
  if (n >= 16) roster.push('arsonist');

  const townOrder: RoleId[] = [
    'sheriff',
    'doctor',
    'jailor',
    'escort',
    'lookout',
    'vigilante',
    'investigator',
    'bodyguard',
    'veteran',
    'mayor',
    'detective',
    'bus-driver',
    'spy',
    'coroner'
  ];
  let townIndex = 0;
  while (roster.length < n) {
    roster.push(townOrder[townIndex] ?? 'citizen');
    townIndex++;
  }

  return roster;
}
