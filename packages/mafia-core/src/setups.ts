import type { Faction, RoleId } from './roles.js';
import { ROLES, rolesOfFaction } from './roles.js';

/**
 * Setups, the SC2 Mafia way: a setup is a list of *slots*, each either an
 * exact role or a category that rolls a random role from its pool at start.
 * The same setup therefore deals a different table every game — "Town
 * Investigative" might be the sheriff tonight and the lookout tomorrow.
 *
 * Used twice: by the simulator to measure win rates per setup, and by the
 * lobby as proposed templates (plus the player-saved custom ones).
 */

export type SlotToken =
  | RoleId
  | 'town-core'
  | 'town-investigative'
  | 'town-protective'
  | 'town-killing'
  | 'town-power'
  | 'town-support'
  | 'town-random'
  | 'mafia-support'
  | 'mafia-deception'
  | 'mafia-random'
  | 'triad-random'
  | 'neutral-benign'
  | 'neutral-evil'
  | 'neutral-killing'
  | 'neutral-random'
  | 'any';

const TOWN_ALL = rolesOfFaction('town');
const MAFIA_ALL = rolesOfFaction('mafia').filter((role) => role !== 'godfather');
const TRIAD_ALL = rolesOfFaction('triad').filter((role) => role !== 'dragon-head');
const NEUTRAL_ALL = [...rolesOfFaction('neutral'), 'cultist' as RoleId];

const CATEGORY_POOLS: Record<Exclude<SlotToken, RoleId>, RoleId[]> = {
  'town-core': ['citizen', 'sheriff', 'doctor', 'escort', 'crier', 'mason'],
  'town-investigative': ['sheriff', 'investigator', 'detective', 'lookout', 'spy', 'coroner'],
  'town-protective': ['doctor', 'bodyguard'],
  'town-killing': ['vigilante', 'veteran'],
  'town-power': ['jailor', 'mayor', 'marshall', 'mason-leader'],
  'town-support': ['escort', 'bus-driver', 'crier', 'mason', 'stump'],
  'town-random': TOWN_ALL,
  'mafia-support': ['consort', 'consigliere', 'blackmailer', 'agent', 'kidnapper', 'heartbreaker'],
  'mafia-deception': ['framer', 'janitor', 'beguiler', 'disguiser', 'actress'],
  'mafia-random': MAFIA_ALL,
  'triad-random': TRIAD_ALL,
  'neutral-benign': ['survivor', 'jester', 'executioner', 'amnesiac', 'lover'],
  'neutral-evil': ['witch', 'judge', 'auditor', 'scumbag', 'cultist'],
  'neutral-killing': ['serial-killer', 'arsonist', 'mass-murderer', 'poisoner', 'electromaniac'],
  'neutral-random': NEUTRAL_ALL,
  any: Object.keys(ROLES) as RoleId[]
};

export const SLOT_TOKENS: SlotToken[] = [
  ...(Object.keys(ROLES) as RoleId[]),
  ...(Object.keys(CATEGORY_POOLS) as Exclude<SlotToken, RoleId>[])
];

export function isSlotToken(value: string): value is SlotToken {
  return (SLOT_TOKENS as string[]).includes(value);
}

/**
 * Every role a category slot could roll, in order.
 *
 * Published so the role list can answer "what is a Random Town, actually?" the
 * moment somebody taps one — which is the whole point of showing the list. An
 * exact-role slot answers with itself.
 */
export function slotPool(token: SlotToken): RoleId[] {
  return token in CATEGORY_POOLS ? CATEGORY_POOLS[token as Exclude<SlotToken, RoleId>] : [token as RoleId];
}

/**
 * The camp a slot belongs to, or `null` when it could be anything.
 *
 * Used to group the published role list the way a player reads one — town, then
 * the families, then the neutrals — and to colour each line. A category is
 * judged by its pool: every pool here is single-camp except `any`, and `neutral-*`
 * carries the Cultist, whose faction is `cult` but whose slot is a neutral one.
 */
export function slotFaction(token: SlotToken): Faction | null {
  if (token in ROLES) return ROLES[token as RoleId].faction;
  if (token === 'any') return null;
  if (token.startsWith('town-')) return 'town';
  if (token.startsWith('mafia-')) return 'mafia';
  if (token.startsWith('triad-')) return 'triad';
  return 'neutral';
}

/** Reading order for the published list: the town first, the knives last. */
const CAMP_ORDER: Record<string, number> = { town: 0, mafia: 1, triad: 2, cult: 3, neutral: 4, unknown: 5 };

export function sortRoleList(tokens: SlotToken[]): SlotToken[] {
  return [...tokens].sort((a, b) => {
    const camp = CAMP_ORDER[slotFaction(a) ?? 'unknown'] - CAMP_ORDER[slotFaction(b) ?? 'unknown'];
    if (camp !== 0) return camp;
    // Exact roles before the categories of the same camp: "Sheriff, Doctor,
    // Random Town, Random Town" reads as a promise followed by a shrug.
    const exact = Number(b in ROLES) - Number(a in ROLES);
    return exact !== 0 ? exact : a.localeCompare(b);
  });
}

export interface Setup {
  id: string;
  name: string;
  /** One token per seat; the list's length is the intended player count. */
  slots: SlotToken[];
  /** Short pitch shown in the template picker. */
  description: string;
}

/**
 * The proposed templates. The three 15-player ones follow the community
 * setups on the SC2 Mafia wiki (Raph55's Choice, Raphael's Choice, Deantwo's);
 * the 24-player ones keep roughly the same town:rest and mafia:rest ratios
 * (~60% town, ~20% mafia, ~20% neutral).
 */
export const SETUPS: Setup[] = [
  {
    id: 'classique-15',
    name: 'Classique (15)',
    description: 'Le setup de référence du wiki : 9 Ville, 3 Mafia, 3 Neutres.',
    slots: [
      'sheriff',
      'doctor',
      'jailor',
      'town-core',
      'town-killing',
      'town-investigative',
      'town-protective',
      'town-power',
      'town-random',
      'godfather',
      'mafia-support',
      'mafia-deception',
      'neutral-killing',
      'neutral-benign',
      'neutral-evil'
    ]
  },
  {
    id: 'choix-de-raphael-15',
    name: 'Choix de Raphaël (15)',
    description: 'Plus de hasard côté Mafia, deux Neutres bénins : 9 / 3 / 3.',
    slots: [
      'sheriff',
      'investigator',
      'town-core',
      'town-killing',
      'town-investigative',
      'town-protective',
      'town-power',
      'town-random',
      'town-random',
      'godfather',
      'mafia-random',
      'mafia-random',
      'neutral-evil',
      'neutral-benign',
      'neutral-benign'
    ]
  },
  {
    id: 'deantwo-15',
    name: 'Deantwo (15)',
    description: 'Ville resserrée, cinq Neutres : le chaos poli. 7 / 3 / 5.',
    slots: [
      'sheriff',
      'doctor',
      'jailor',
      'town-core',
      'town-core',
      'town-investigative',
      'town-protective',
      'godfather',
      'mafia-support',
      'mafia-deception',
      'neutral-benign',
      'neutral-benign',
      'neutral-evil',
      'neutral-killing',
      'neutral-random'
    ]
  },
  {
    id: 'grand-classique-24',
    name: 'Grand Classique (24)',
    description: 'Le Classique étiré à 24 sièges, mêmes proportions : 14 Ville, 5 Mafia, 5 Neutres.',
    slots: [
      'sheriff',
      'doctor',
      'jailor',
      'mayor',
      'town-core',
      'town-core',
      'town-investigative',
      'town-investigative',
      'town-protective',
      'town-killing',
      'town-killing',
      'town-power',
      'town-random',
      'town-random',
      'godfather',
      'mafioso',
      'mafia-support',
      'mafia-deception',
      'mafia-random',
      'neutral-killing',
      'neutral-evil',
      'neutral-benign',
      'neutral-benign',
      'neutral-random'
    ]
  },
  {
    id: 'nuit-noire-24',
    name: 'Nuit Noire (24)',
    description: 'Deux tueurs solitaires dans le même noir : 14 Ville, 5 Mafia, 5 Neutres.',
    slots: [
      'sheriff',
      'doctor',
      'doctor',
      'jailor',
      'town-core',
      'town-investigative',
      'town-investigative',
      'town-protective',
      'town-killing',
      'town-power',
      'town-random',
      'town-random',
      'town-random',
      'town-random',
      'godfather',
      'mafioso',
      'mafia-support',
      'mafia-support',
      'mafia-deception',
      'serial-killer',
      'arsonist',
      'neutral-evil',
      'neutral-benign',
      'neutral-benign'
    ]
  }
];

export function setupById(id: string): Setup | undefined {
  return SETUPS.find((setup) => setup.id === id);
}

/**
 * Rolls a slot list into concrete roles. Unique heavyweights (leaders, jailor,
 * mayor, solo killers…) are dealt at most once per table; a category that
 * would duplicate one rerolls inside its pool, falling back to a citizen
 * (town) or a soldier (family) when the pool runs dry.
 */
const UNIQUE_ROLES: ReadonlySet<RoleId> = new Set<RoleId>(
  (Object.keys(ROLES) as RoleId[]).filter((role) => ROLES[role].unique)
);

export function rollSetup(slots: SlotToken[], rng: () => number): RoleId[] {
  const dealt: RoleId[] = [];
  const taken = new Set<RoleId>();

  for (const token of slots) {
    const pool: RoleId[] = token in CATEGORY_POOLS ? CATEGORY_POOLS[token as Exclude<SlotToken, RoleId>] : [token as RoleId];
    const available = pool.filter((role) => !(UNIQUE_ROLES.has(role) && taken.has(role)));
    const pick =
      available[Math.floor(rng() * available.length)] ??
      (ROLES[pool[0]].faction === 'mafia' ? 'mafioso' : 'citizen');
    dealt.push(pick);
    taken.add(pick);
  }
  return dealt;
}

/**
 * A truly random table: every seat rolls `any`. The only guarantee is that
 * the game can actually end — at least one evil and at least one town seat.
 */
export function chaosSetup(players: number, rng: () => number): RoleId[] {
  const all = Object.keys(ROLES) as RoleId[];
  const dealt: RoleId[] = [];
  const taken = new Set<RoleId>();
  for (let i = 0; i < players; i++) {
    const available = all.filter((role) => !(UNIQUE_ROLES.has(role) && taken.has(role)));
    const pick = available[Math.floor(rng() * available.length)] ?? 'citizen';
    dealt.push(pick);
    taken.add(pick);
  }
  if (!dealt.some((role) => ROLES[role].faction === 'mafia' || role === 'serial-killer' || role === 'arsonist')) {
    dealt[0] = 'godfather';
  }
  if (!dealt.some((role) => ROLES[role].faction === 'town')) {
    dealt[dealt.length - 1] = 'sheriff';
  }
  return dealt;
}

/**
 * The census table: the benchmark's random-composition mode, also playable.
 * Random town count, random mafia, random neutrals — and a 50% chance the
 * Triad is in town too, at the mafia's exact size. Ratios stay decent: the
 * town keeps at least ~45% of the seats, every present family gets a leader.
 */
export function censusSetup(players: number, rng: () => number): RoleId[] {
  const n = Math.min(24, Math.max(6, players));

  let mafiaN = Math.min(5, 2 + Math.floor(rng() * 2) + Math.floor(n / 12));
  let triadN = rng() < 0.5 && n >= 14 ? mafiaN : 0;
  let neutralN = 1 + Math.floor(rng() * Math.min(5, n / 5));
  const minTown = Math.ceil(n * 0.45);

  // Squeeze the extras until the town keeps its decent share.
  while (n - mafiaN - triadN - neutralN < minTown) {
    if (neutralN > 1) neutralN -= 1;
    else if (triadN > 0 && triadN >= mafiaN) triadN -= 1;
    else if (mafiaN > 2) mafiaN -= 1;
    else break;
  }
  const townN = Math.max(1, n - mafiaN - triadN - neutralN);

  const dealt: RoleId[] = [];
  const taken = new Set<RoleId>();
  const draw = (pool: RoleId[], fallback: RoleId): RoleId => {
    const available = pool.filter((role) => !(UNIQUE_ROLES.has(role) && taken.has(role)));
    const pick = available[Math.floor(rng() * available.length)] ?? fallback;
    dealt.push(pick);
    taken.add(pick);
    return pick;
  };

  draw(['godfather'], 'godfather');
  for (let i = 1; i < mafiaN; i++) draw(MAFIA_ALL, 'mafioso');
  if (triadN > 0) {
    draw(['dragon-head'], 'dragon-head');
    for (let i = 1; i < triadN; i++) draw(TRIAD_ALL, 'enforcer');
  }
  for (let i = 0; i < neutralN; i++) draw(NEUTRAL_ALL, 'survivor');
  for (let i = 0; i < townN; i++) draw(TOWN_ALL, 'citizen');

  return dealt;
}

/**
 * Fits a slot list to the actual number of seated players: extra seats get
 * `town-random` (the ratio-safe filler), missing seats are trimmed from the
 * end (setup authors put their essentials first).
 */
export function fitSetup(slots: SlotToken[], players: number): SlotToken[] {
  if (slots.length === players) return slots;
  if (slots.length > players) return slots.slice(0, players);
  return [...slots, ...Array<SlotToken>(players - slots.length).fill('town-random')];
}
