import { ROADWAY_PROGRAMS, type FloorKind, type RoomProgram } from '../map.js';
import { pick, randInt, type RngState } from '../rng.js';

/**
 * What a building *is*.
 *
 * The previous generator rolled a theme per room, which is why a raid could hold
 * three fridges and no two rooms in a row made sense together. A building now gets
 * a **programme**: a list of rooms with counts, in the order they should be handed
 * out. A flat has one kitchen because a flat is written down as having one kitchen.
 *
 * `spread` entries repeat per dwelling — an apartment block is the same four rooms
 * two to four times over, which is exactly what an apartment block is.
 */

export interface ProgramEntry {
  program: RoomProgram;
  /** How many of these the building wants, as a range. */
  count: [number, number];
  /**
   * What shape of room it wants, so assignment is not arbitrary:
   * `big` takes the largest space, `dead-end` the most isolated, `hub` the busiest.
   */
  wants?: 'big' | 'dead-end' | 'hub';
}

export interface BuildingProgram {
  id: string;
  name: string;
  /** Rooms handed out in this order; the first entries get the best-fitting spaces. */
  rooms: ProgramEntry[];
  /** Repeated per dwelling, for blocks of flats. */
  dwellings?: { count: [number, number]; rooms: ProgramEntry[] };
  /** Roughly how many cells one room of this building should have. */
  grain?: number;
}

export const BUILDING_PROGRAMS: readonly BuildingProgram[] = [
  {
    id: 'house',
    name: 'coronaz.room.house.name',
    rooms: [
      { program: 'living', count: [1, 1], wants: 'big' },
      { program: 'kitchen', count: [1, 1] },
      { program: 'bath', count: [1, 1], wants: 'dead-end' },
      { program: 'bedroom', count: [1, 2], wants: 'dead-end' },
      { program: 'corridor', count: [0, 1], wants: 'hub' },
      { program: 'storage', count: [0, 1], wants: 'dead-end' }
    ]
  },
  {
    id: 'flats',
    name: 'coronaz.room.flats.name',
    rooms: [
      { program: 'corridor', count: [1, 2], wants: 'hub' },
      { program: 'storage', count: [0, 1], wants: 'dead-end' }
    ],
    dwellings: {
      count: [2, 4],
      rooms: [
        { program: 'living', count: [1, 1], wants: 'big' },
        { program: 'kitchen', count: [1, 1] },
        { program: 'bath', count: [1, 1], wants: 'dead-end' },
        { program: 'bedroom', count: [1, 1], wants: 'dead-end' }
      ]
    }
  },
  {
    id: 'offices',
    name: 'coronaz.room.offices.name',
    rooms: [
      { program: 'lobby', count: [1, 1], wants: 'big' },
      { program: 'corridor', count: [1, 2], wants: 'hub' },
      { program: 'office', count: [2, 4] },
      { program: 'archive', count: [1, 2], wants: 'dead-end' },
      { program: 'restroom', count: [1, 1], wants: 'dead-end' },
      { program: 'canteen', count: [0, 1] },
      { program: 'server', count: [0, 1], wants: 'dead-end' }
    ]
  },
  {
    id: 'club',
    name: 'coronaz.room.club.name',
    rooms: [
      { program: 'hall', count: [1, 1], wants: 'big' },
      { program: 'bar', count: [1, 1] },
      { program: 'restroom', count: [1, 2], wants: 'dead-end' },
      { program: 'backstage', count: [1, 1], wants: 'dead-end' },
      { program: 'storage', count: [1, 1], wants: 'dead-end' },
      { program: 'lobby', count: [0, 1], wants: 'hub' }
    ],
    grain: 4
  },
  {
    id: 'facility',
    name: 'coronaz.room.facility.name',
    rooms: [
      { program: 'corridor', count: [2, 3], wants: 'hub' },
      { program: 'lab', count: [2, 3], wants: 'big' },
      { program: 'server', count: [1, 1], wants: 'dead-end' },
      { program: 'storage', count: [1, 2], wants: 'dead-end' },
      { program: 'dorm', count: [1, 2] },
      { program: 'canteen', count: [1, 1] },
      { program: 'workshop', count: [0, 1] },
      { program: 'restroom', count: [1, 1], wants: 'dead-end' }
    ],
    grain: 4
  },
  {
    id: 'shop',
    name: 'coronaz.room.shop.name',
    rooms: [
      { program: 'hall', count: [1, 1], wants: 'big' },
      { program: 'storage', count: [1, 2], wants: 'dead-end' },
      { program: 'office', count: [0, 1], wants: 'dead-end' },
      { program: 'restroom', count: [0, 1], wants: 'dead-end' }
    ]
  },
  /**
   * The landmark pool: a town draws two or three of these, never all of them.
   *
   * A town whose landmarks are always a police station and a hospital is a town you
   * have already seen, and at 22x22 you cannot fit them all anyway — which is the
   * point rather than a limitation. Everything can be missing. A raid where the
   * pharmacy is nowhere on the map is a raid about something else, and a table that
   * knows a fire station *might* be there has a reason to look.
   *
   * Each one owns a room the loot table pays for, so drawing from the pool changes
   * where the good loot is, not just the roof over it: no armoury in a town with no
   * police station, no pharmacy without a hospital or a chemist.
   */
  {
    id: 'firestation',
    name: 'coronaz.room.firestation.name',
    rooms: [
      { program: 'hall', count: [1, 1], wants: 'big' },
      { program: 'workshop', count: [1, 2] },
      { program: 'dorm', count: [1, 2], wants: 'dead-end' },
      { program: 'canteen', count: [1, 1] },
      { program: 'storage', count: [1, 2], wants: 'dead-end' },
      { program: 'restroom', count: [1, 1], wants: 'dead-end' },
      { program: 'corridor', count: [1, 2], wants: 'hub' }
    ],
    grain: 4
  },
  {
    id: 'school',
    name: 'coronaz.room.school.name',
    rooms: [
      { program: 'reception', count: [1, 1], wants: 'hub' },
      { program: 'corridor', count: [2, 3], wants: 'hub' },
      { program: 'office', count: [2, 4], wants: 'big' },
      { program: 'canteen', count: [1, 1] },
      { program: 'archive', count: [1, 1], wants: 'dead-end' },
      { program: 'lab', count: [0, 1], wants: 'dead-end' },
      { program: 'restroom', count: [1, 2], wants: 'dead-end' },
      { program: 'storage', count: [0, 1], wants: 'dead-end' }
    ],
    grain: 3
  },
  {
    id: 'supermarket',
    name: 'coronaz.room.supermarket.name',
    rooms: [
      { program: 'hall', count: [1, 2], wants: 'big' },
      { program: 'storage', count: [2, 3], wants: 'dead-end' },
      { program: 'pharmacy', count: [0, 1], wants: 'dead-end' },
      { program: 'office', count: [0, 1], wants: 'dead-end' },
      { program: 'restroom', count: [0, 1], wants: 'dead-end' },
      { program: 'corridor', count: [0, 1], wants: 'hub' }
    ],
    grain: 4
  },
  {
    id: 'church',
    name: 'coronaz.room.church.name',
    rooms: [
      { program: 'hall', count: [1, 1], wants: 'big' },
      { program: 'archive', count: [1, 1], wants: 'dead-end' },
      { program: 'storage', count: [1, 1], wants: 'dead-end' },
      { program: 'morgue', count: [0, 1], wants: 'dead-end' },
      { program: 'corridor', count: [0, 1], wants: 'hub' }
    ],
    grain: 4
  },
  /**
   * Where the people in a complex actually live.
   *
   * A wing that holds no laboratory and no armoury, which is the point of it. A
   * complex built of four lab wings has four servers, four pharmacies and sixteen
   * rooms the loot table pays double for: measured at 9.4 % of a bunker glittering
   * against 3 % of a town, and a mean loot bonus that came out *positive*. One wing
   * of bunks and a canteen is both more believable and what stops the building being
   * a vending machine.
   */
  {
    id: 'quarters',
    name: 'coronaz.room.quarters.name',
    rooms: [
      { program: 'dorm', count: [2, 3], wants: 'big' },
      { program: 'canteen', count: [1, 1] },
      { program: 'restroom', count: [1, 2], wants: 'dead-end' },
      { program: 'storage', count: [1, 1], wants: 'dead-end' },
      { program: 'corridor', count: [1, 2], wants: 'hub' }
    ],
    grain: 4
  },
  /**
   * Not a building: the corridor between two of them.
   *
   * A spine is a plot one cell wide that runs the length of a complex, and it exists
   * so that wings of different rooms are separated by a hallway instead of sharing a
   * wall. It goes through the building machinery because that is what gives it doors
   * into its neighbours and a floor of its own; it just happens to contain nothing
   * but corridor.
   */
  {
    id: 'spine',
    name: 'coronaz.room.spine.name',
    rooms: [{ program: 'corridor', count: [1, 1], wants: 'hub' }],
    grain: 2
  },
  /**
   * The two civic buildings, and the reason they exist.
   *
   * A town that is only flats and shops has nothing in it worth crossing the map
   * for: every room pays the same, so the nearest room always wins. A police
   * station holds an armoury and an evidence locker, a hospital holds a pharmacy;
   * those are the rooms the loot table pays double for, and they are recognisable
   * from the doorway. The map becomes a set of decisions rather than a floor plan.
   */
  {
    id: 'police',
    name: 'coronaz.room.police.name',
    rooms: [
      { program: 'reception', count: [1, 1], wants: 'hub' },
      { program: 'corridor', count: [1, 2], wants: 'hub' },
      { program: 'office', count: [1, 3] },
      { program: 'cell', count: [1, 3], wants: 'dead-end' },
      { program: 'evidence', count: [1, 1], wants: 'dead-end' },
      { program: 'armoury', count: [1, 1], wants: 'dead-end' },
      { program: 'archive', count: [0, 1], wants: 'dead-end' },
      { program: 'restroom', count: [0, 1], wants: 'dead-end' }
    ],
    grain: 3
  },
  {
    id: 'hospital',
    name: 'coronaz.room.hospital.name',
    rooms: [
      { program: 'reception', count: [1, 1], wants: 'hub' },
      { program: 'corridor', count: [2, 3], wants: 'hub' },
      { program: 'ward', count: [2, 4], wants: 'big' },
      { program: 'surgery', count: [1, 2] },
      { program: 'pharmacy', count: [1, 1], wants: 'dead-end' },
      { program: 'morgue', count: [0, 1], wants: 'dead-end' },
      { program: 'storage', count: [1, 1], wants: 'dead-end' },
      { program: 'restroom', count: [1, 1], wants: 'dead-end' }
    ],
    grain: 4
  },
  {
    id: 'workshop',
    name: 'coronaz.room.workshop.name',
    rooms: [
      { program: 'workshop', count: [1, 2], wants: 'big' },
      { program: 'storage', count: [1, 2] },
      { program: 'office', count: [0, 1], wants: 'dead-end' },
      { program: 'restroom', count: [0, 1], wants: 'dead-end' }
    ]
  }
];

/**
 * The buildings a town plants as landmarks, in preference to another block of flats.
 *
 * Drawn from rather than placed in full: a 22x22 town has room for two or three, so
 * any given raid is missing most of this list. That is deliberate. See the note on
 * the pool above.
 */
export const LANDMARK_PROGRAMS: readonly string[] = [
  'police',
  'hospital',
  'firestation',
  'school',
  'supermarket',
  'church'
];

export function buildingProgram(id: string): BuildingProgram {
  const found = BUILDING_PROGRAMS.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown building programme: ${id}`);
  return found;
}

/**
 * Expands a programme into a flat list of room programmes to hand out, longest
 * first. Rolled once per building, so two houses on the same street differ.
 *
 * `spaces` is how many the building actually has room for. A programme names about
 * a dozen rooms, and a bunker filling a 22x22 board has a hundred spaces to fill, so
 * the list is topped up: every entry whose cluster budget is not yet spent gets
 * offered again, which spreads a facility over several separate laboratories and
 * dormitories instead of one enormous one. Whatever is still unclaimed becomes
 * corridor, which is the honest answer to "what is the space between the rooms".
 */
export function roomList(rng: RngState, program: BuildingProgram, spaces = 0): ProgramEntry[] {
  const expand = (entries: readonly ProgramEntry[]): ProgramEntry[] => {
    const out: ProgramEntry[] = [];
    for (const entry of entries) {
      const [low, high] = entry.count;
      const count = low + randInt(rng, high - low + 1);
      for (let i = 0; i < count; i++) out.push(entry);
    }
    return out;
  };

  const list = expand(program.rooms);
  if (program.dwellings) {
    const [low, high] = program.dwellings.count;
    const homes = low + randInt(rng, high - low + 1);
    for (let i = 0; i < homes; i++) list.push(...expand(program.dwellings.rooms));
  }

  // Top up towards the number of spaces, offering each programme up to its cluster
  // budget. The count in the table is what the building *wants*; the budget is what
  // it is *allowed*, and a big building should use the difference.
  const offered = new Map<RoomProgram, number>();
  for (const entry of list) offered.set(entry.program, (offered.get(entry.program) ?? 0) + 1);

  const extras = [...program.rooms, ...(program.dwellings?.rooms ?? [])].filter(
    (entry) => !isStructural(entry.program)
  );
  let guard = 0;
  while (list.length < spaces && extras.length > 0 && guard++ < 400) {
    const entry = pick(rng, extras);
    const taken = offered.get(entry.program) ?? 0;
    if (taken >= roomBudget(entry.program).clusters) continue;
    offered.set(entry.program, taken + 1);
    list.push(entry);
  }
  return list;
}

/** The floors a programme is plausibly finished in. */
const FLOORS: Record<RoomProgram, readonly FloorKind[]> = {
  living: ['parquet', 'carpet'],
  kitchen: ['tile', 'lino'],
  bath: ['tile'],
  bedroom: ['parquet', 'carpet'],
  office: ['carpet', 'lino'],
  archive: ['lino', 'carpet'],
  lab: ['tile', 'lino'],
  server: ['grate', 'lino'],
  workshop: ['concrete', 'grate'],
  storage: ['concrete', 'lino'],
  lobby: ['tile', 'parquet'],
  corridor: ['lino', 'carpet', 'concrete'],
  hall: ['parquet', 'tile', 'concrete'],
  bar: ['parquet', 'tile'],
  restroom: ['tile'],
  backstage: ['lino', 'concrete'],
  dorm: ['lino', 'carpet'],
  canteen: ['lino', 'tile'],
  reception: ['tile', 'lino'],
  ward: ['lino', 'tile'],
  surgery: ['tile'],
  pharmacy: ['tile', 'lino'],
  morgue: ['tile', 'concrete'],
  cell: ['concrete'],
  evidence: ['concrete', 'lino'],
  armoury: ['concrete', 'grate'],
  street: ['asphalt'],
  crossing: ['asphalt'],
  // A pavement is not a road: same outdoors, different ground, and the eye reads
  // the difference before it reads anything else.
  sidewalk: ['pavement'],
  square: ['cobble', 'pavement'],
  park: ['grass'],
  alley: ['asphalt', 'gravel'],
  yard: ['grass', 'gravel', 'pavement'],
  parking: ['asphalt'],
  dock: ['concrete', 'asphalt']
};

/**
 * What searching a room of this kind is worth, as a bonus on the loot roll.
 *
 * The scale is deliberately lopsided. Most of the map sits between -0.1 and 0,
 * because "most rooms are ordinary" is what makes the exceptions mean anything; a
 * road is -0.2 (nobody keeps anything useful in the middle of a street); and the
 * handful of rooms that are *about* holding valuable things run to +1, which is one
 * guaranteed rank of loot table.
 *
 * Every entry above +0.3 is a room whose name already tells you why: a pharmacy, an
 * armoury, an evidence locker, a laboratory. That is the point of naming them. A
 * player should be able to want a room without having read this file.
 */
const LOOT_BONUS: Record<RoomProgram, number> = {
  /* The ordinary band: home, work, the places people pass through. */
  living: 0,
  bedroom: 0,
  kitchen: 0.05,
  bath: -0.1,
  office: 0,
  hall: -0.05,
  lobby: -0.1,
  corridor: -0.15,
  restroom: -0.1,
  backstage: 0,
  dorm: 0,
  canteen: 0,
  reception: -0.05,
  ward: 0.05,
  cell: -0.1,
  bar: 0.1,
  workshop: 0.15,
  morgue: 0.1,

  /* Rooms that exist to hold things. */
  storage: 0.35,
  archive: 0.3,
  server: 0.4,
  lab: 0.5,
  surgery: 0.5,
  evidence: 0.7,
  pharmacy: 0.8,
  armoury: 1,

  /* Outdoors, where nobody left anything on purpose. */
  street: -0.2,
  crossing: -0.2,
  sidewalk: -0.15,
  square: -0.1,
  park: -0.1,
  alley: -0.05,
  yard: -0.05,
  parking: -0.1,
  dock: 0.2
};

export function lootBonusFor(program: RoomProgram): number {
  return LOOT_BONUS[program];
}

/**
 * How good a room has to be before the renderer makes it glitter.
 *
 * 0.4 rather than 0.3 so that the six rooms that are genuinely *about* holding
 * something valuable light up (servers, lab, surgery, evidence, pharmacy, armoury)
 * and the merely useful ones do not. At 0.3 every storage cupboard glittered, and a
 * town where a third of the rooms sparkle is a town where none of them do.
 */
export const SHINY_LOOT = 0.4;

/**
 * How many things a room holds before it is picked clean.
 *
 * There was no such number, and nothing in the engine marked a room as searched, so
 * the best play in a room the loot table pays double for was to stand there and
 * search it again — bounded only by action points, bag space, and a fatigue counted
 * per hero rather than per room. That is the least interesting thing the game can
 * ask anybody to do, and it wasted the work that made rooms differ at all: you
 * never needed to cross the street to the pharmacy, only to arrive once and camp.
 *
 * The scale follows the loot bonus, because the same sentence should be true of
 * both: an armoury is worth going to *and* worth going to for a while. A roadway
 * holds almost nothing, which is also what a road is.
 *
 * Deliberately generous in total, and measured: a board holds 200–290 finds, while
 * five `looter` bots — the greediest brains on the bench — open about fourteen
 * crates in a whole raid, because a survivor stops when their hands are good rather
 * than when the world runs out. An order of magnitude of headroom, so this is not a
 * scarcity dial and the loot curve five versions went into balancing is untouched.
 * It binds locally, and locally is where standing still was the problem.
 */
/**
 * The floor under the start room's stock.
 *
 * Two free searches a survivor, times up to five survivors, all of them standing in
 * the same room on turn one — and that room is usually a pavement, which holds one
 * thing. Ten would make the doorstep the best room on the board; ten is also what
 * the table could theoretically spend there. Six is the compromise: nobody finds the
 * opening room empty, and nobody stays in it either.
 */
export const START_FINDS = 6;

export function findsFor(program: RoomProgram, cells: number): number {
  const bonus = LOOT_BONUS[program];

  // A road is a road. One thing in the boot of one car, and that is the street.
  if (ROADWAY_PROGRAMS.includes(program)) return 1;

  /**
   * The ordinary room holds three, not two, and the poor one two, not one.
   *
   * The first draft was one lower across the board and the bench found the cost in
   * the one place that mattered: a table forced to open badly fell from 64 % to 46 %,
   * because a survivor whose hands never improve keeps wanting to search, and if
   * every room runs dry in two he spends his whole search budget *walking* between
   * them. That is a tax paid entirely by the unluckiest tables — which the
   * documentation has flagged for two versions as where raids are actually lost — and
   * it is not what this rule was for. The rule exists to stop *camping*, and three
   * finds stops camping just as well as two.
   */
  const base = bonus >= 0.6 ? 5 : bonus >= SHINY_LOOT ? 4 : bonus >= 0 ? 3 : 2;
  /**
   * Big rooms hold a little more, capped at one extra.
   *
   * Not proportional: a nine-cell plaza is nine cells because walking across open
   * ground should be cheap, not because a plaza is a treasury. Without the cap the
   * outdoor rooms — the largest on the board and the poorest by design — would hold
   * the most.
   */
  return base + (cells >= 4 ? 1 : 0);
}

/**
 * How many separate clusters of a room a building may hold, and how big one gets.
 *
 * A **cluster** is a run of touching rooms with the same programme: five laboratory
 * rooms side by side are one laboratory, drawn as five moves. That is a good thing
 * and the generator should keep doing it. What it must not do is what it was doing,
 * which was fifty of them.
 *
 * Two numbers per programme, and the rarer the room the tighter both are:
 *
 * - `clusters` — how many separate ones. One armoury per police station; three wards
 *   per hospital, because a hospital does have wards in several places.
 * - `rooms` — how many rooms one cluster may run to. Ten is the ceiling for anything,
 *   and the rooms that pay loot are far below it: every room of a cluster pays the
 *   programme's bonus, so a ten-room armoury is ten jackpots.
 *
 * **Structural programmes are exempt from both** (`Infinity`). Corridors, streets,
 * squares and yards are what makes a building or a town read as one place rather
 * than a bag of rooms; capping them would be capping the coherence. A facility with
 * thirty corridor rooms is a facility with corridors, which is correct.
 */
export interface RoomBudget {
  clusters: number;
  rooms: number;
}

const UNLIMITED: RoomBudget = { clusters: Infinity, rooms: Infinity };

const BUDGETS: Record<RoomProgram, RoomBudget> = {
  /* Circulation and open ground: the structure of the map. No limits. */
  corridor: UNLIMITED,
  street: UNLIMITED,
  crossing: UNLIMITED,
  sidewalk: UNLIMITED,
  square: UNLIMITED,
  park: UNLIMITED,
  alley: UNLIMITED,
  yard: UNLIMITED,
  parking: UNLIMITED,
  dock: UNLIMITED,

  /* Rooms that are *about* holding something valuable: one of each, and small. */
  armoury: { clusters: 1, rooms: 1 },
  evidence: { clusters: 1, rooms: 2 },
  pharmacy: { clusters: 1, rooms: 2 },
  morgue: { clusters: 1, rooms: 2 },
  server: { clusters: 1, rooms: 3 },
  surgery: { clusters: 2, rooms: 2 },

  /* The ones you can plausibly have a few of. */
  lab: { clusters: 2, rooms: 8 },
  archive: { clusters: 2, rooms: 4 },
  storage: { clusters: 3, rooms: 6 },
  ward: { clusters: 3, rooms: 10 },
  cell: { clusters: 3, rooms: 4 },
  office: { clusters: 3, rooms: 6 },
  bedroom: { clusters: 3, rooms: 3 },
  workshop: { clusters: 2, rooms: 8 },
  dorm: { clusters: 2, rooms: 8 },
  hall: { clusters: 2, rooms: 10 },
  lobby: { clusters: 2, rooms: 6 },
  backstage: { clusters: 2, rooms: 3 },

  /* One each. A building with two kitchens is two buildings. */
  living: { clusters: 2, rooms: 4 },
  kitchen: { clusters: 1, rooms: 2 },
  bath: { clusters: 1, rooms: 2 },
  restroom: { clusters: 2, rooms: 2 },
  bar: { clusters: 1, rooms: 4 },
  canteen: { clusters: 1, rooms: 6 },
  reception: { clusters: 1, rooms: 4 }
};

/** The ceiling on any cluster, structural programmes excepted. */
export const MAX_CLUSTER_ROOMS = 10;

/**
 * How many clusters this building justifies, which is how many spaces it is cut into.
 *
 * The sum of its rooms' cluster budgets, plus a third again for circulation. Both
 * halves of that matter, and getting either wrong has already produced a bad
 * building:
 *
 * - Cutting by *area* alone gave a 484-cell facility a hundred and twenty spaces.
 *   Only about thirteen of them could be anything (every programme's cluster budget
 *   was spent), so a hundred and eight became corridor: measured 145 corridors out
 *   of 160 rooms, a bunker made of nothing but hallway.
 * - Cutting by the room *list* alone was the original bug: twelve spaces over the
 *   same board, forty cells each, each becoming a dozen rooms of one programme.
 *
 * Bounded by both, with `maxArea` holding the cluster ceiling, a big building comes
 * out as a dozen or so real rooms several moves deep, joined by hallways. Which is
 * what a bunker is.
 */
export function maxClusters(program: BuildingProgram): number {
  const seen = new Set<RoomProgram>();
  let rooms = 0;
  // A spine is all corridor, and corridors are unlimited: cut it as finely as its
  // area allows, or a hundred-cell hallway becomes two enormous rooms.
  if ([...program.rooms, ...(program.dwellings?.rooms ?? [])].every((entry) => isStructural(entry.program))) {
    return Infinity;
  }
  for (const entry of [...program.rooms, ...(program.dwellings?.rooms ?? [])]) {
    if (seen.has(entry.program) || isStructural(entry.program)) continue;
    seen.add(entry.program);
    rooms += roomBudget(entry.program).clusters;
  }
  // Flats hold their dwellings several times over, so their budget counts per home.
  const homes = program.dwellings ? program.dwellings.count[1] : 1;
  const total = rooms * (program.dwellings ? Math.max(1, homes) : 1);
  return Math.max(2, total + Math.round(total / 3));
}

export function roomBudget(program: RoomProgram): RoomBudget {
  return BUDGETS[program];
}

/** Structural: part of how the map hangs together, so never capped. */
export function isStructural(program: RoomProgram): boolean {
  return BUDGETS[program].clusters === Infinity;
}

/**
 * What the overflow of a capped cluster becomes.
 *
 * A cluster that hits its ceiling does not stop the building: the rooms past the
 * ceiling take the plainest plausible neighbour instead. Which is also what a real
 * building looks like, since an armoury is a locked cage with shelving around it
 * rather than a wing of armouries.
 */
export function overflowOf(program: RoomProgram): RoomProgram {
  switch (program) {
    case 'armoury':
    case 'evidence':
      return 'archive';
    case 'pharmacy':
    case 'surgery':
    case 'morgue':
      return 'ward';
    case 'bath':
    case 'restroom':
    case 'kitchen':
      return 'corridor';
    default:
      return 'storage';
  }
}

export function floorFor(rng: RngState, program: RoomProgram): FloorKind {
  return pick(rng, FLOORS[program]);
}

/** Human-readable, for the log and the game master's screen. */
/** A catalogue key per program, for the log and the game master's screen. */
export const PROGRAM_LABELS: Record<RoomProgram, string> = {
  living: 'coronaz.program.living',
  kitchen: 'coronaz.program.kitchen',
  bath: 'coronaz.program.bath',
  bedroom: 'coronaz.program.bedroom',
  office: 'coronaz.program.office',
  archive: 'coronaz.program.archive',
  lab: 'coronaz.program.lab',
  server: 'coronaz.program.server',
  workshop: 'coronaz.program.workshop',
  storage: 'coronaz.program.storage',
  lobby: 'coronaz.program.lobby',
  corridor: 'coronaz.program.corridor',
  hall: 'coronaz.program.hall',
  bar: 'coronaz.program.bar',
  restroom: 'coronaz.program.restroom',
  backstage: 'coronaz.program.backstage',
  dorm: 'coronaz.program.dorm',
  canteen: 'coronaz.program.canteen',
  reception: 'coronaz.program.reception',
  ward: 'coronaz.program.ward',
  surgery: 'coronaz.program.surgery',
  pharmacy: 'coronaz.program.pharmacy',
  morgue: 'coronaz.program.morgue',
  cell: 'coronaz.program.cell',
  evidence: 'coronaz.program.evidence',
  armoury: 'coronaz.program.armoury',
  street: 'coronaz.program.street',
  crossing: 'coronaz.program.crossing',
  sidewalk: 'coronaz.program.sidewalk',
  square: 'coronaz.program.square',
  park: 'coronaz.program.park',
  alley: 'coronaz.program.alley',
  yard: 'coronaz.program.yard',
  parking: 'coronaz.program.parking',
  dock: 'coronaz.program.dock'
};
