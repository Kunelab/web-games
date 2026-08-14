import type { FloorKind, RoomProgram } from '../map.js';
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
    name: 'Maison',
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
    name: 'Immeuble',
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
    name: 'Bureaux',
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
    name: 'Boîte de nuit',
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
    name: 'Complexe',
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
    name: 'Commerce',
    rooms: [
      { program: 'hall', count: [1, 1], wants: 'big' },
      { program: 'storage', count: [1, 2], wants: 'dead-end' },
      { program: 'office', count: [0, 1], wants: 'dead-end' },
      { program: 'restroom', count: [0, 1], wants: 'dead-end' }
    ]
  },
  {
    id: 'workshop',
    name: 'Atelier',
    rooms: [
      { program: 'workshop', count: [1, 2], wants: 'big' },
      { program: 'storage', count: [1, 2] },
      { program: 'office', count: [0, 1], wants: 'dead-end' },
      { program: 'restroom', count: [0, 1], wants: 'dead-end' }
    ]
  }
];

export function buildingProgram(id: string): BuildingProgram {
  const found = BUILDING_PROGRAMS.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown building programme: ${id}`);
  return found;
}

/**
 * Expands a programme into a flat list of room programmes to hand out, longest
 * first. Rolled once per building, so two houses on the same street differ.
 */
export function roomList(rng: RngState, program: BuildingProgram): ProgramEntry[] {
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
  street: ['asphalt'],
  crossing: ['asphalt'],
  alley: ['asphalt', 'gravel'],
  yard: ['grass', 'gravel', 'pavement'],
  parking: ['asphalt', 'gravel'],
  dock: ['concrete', 'asphalt']
};

export function floorFor(rng: RngState, program: RoomProgram): FloorKind {
  return pick(rng, FLOORS[program]);
}

/** Human-readable, for the log and the game master's screen. */
export const PROGRAM_LABELS: Record<RoomProgram, string> = {
  living: 'séjour',
  kitchen: 'cuisine',
  bath: 'salle d’eau',
  bedroom: 'chambre',
  office: 'bureau',
  archive: 'archives',
  lab: 'laboratoire',
  server: 'serveurs',
  workshop: 'atelier',
  storage: 'réserve',
  lobby: 'hall d’entrée',
  corridor: 'couloir',
  hall: 'grande salle',
  bar: 'bar',
  restroom: 'sanitaires',
  backstage: 'loges',
  dorm: 'dortoir',
  canteen: 'cantine',
  street: 'rue',
  crossing: 'carrefour',
  alley: 'ruelle',
  yard: 'cour',
  parking: 'parking',
  dock: 'quai'
};
