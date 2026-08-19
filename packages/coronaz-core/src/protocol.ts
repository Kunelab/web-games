import { z } from 'zod';

import type { Scenario } from './config.js';
import { heroDef, type Rarity } from './data.js';
import { finalScores, gmIncome, type FinalScore } from './engine.js';
import { mutationEffects } from './mutations.js';
import { cellIndex, edgeAt, edgeCode, type FloorKind, type RoomKind, type RoomProgram } from './map.js';
import { visibleRooms, type CzPhase, type CzState, type ItemInstance, type LogEntry } from './state.js';

/**
 * What each kind of screen is allowed to see, and the socket contract that
 * carries it. Declared once, imported by both sides, same rule as game-core.
 *
 * The fog is the security boundary here: players and the television share the
 * team's fog, the game master sees the whole board. Anything a hidden room holds
 * is masked in the projection, so it cannot leak whatever the client does.
 */

export type CzRole = { kind: 'tv' } | { kind: 'player'; playerId: string } | { kind: 'gm' };

/** An item as another screen sees it: what it is and how good this one is. */
export interface CzItemView {
  def: string;
  rarity: Rarity;
}

export interface CzRoomView {
  id: string;
  /** The footprint's top-left cell. */
  x: number;
  y: number;
  /** Bounding box in cells. */
  w: number;
  h: number;
  /** Cell indices this room owns, row-major over the board's cell grid. */
  cells: number[];
  kind: RoomKind;
  hasKey: boolean;
  /** Building tint, 0–359; hidden rooms report 0 like everything else they hide. */
  hue: number;
  /** Cosmetic, and enough for a client to furnish the room identically. */
  floor: FloorKind;
  program: RoomProgram;
  decor: number;
  /** Outside: no roof, and the walls around it belong to the buildings. */
  outdoor: boolean;
  /** Which building, 0 for outdoors. Furnishing keeps a building coherent with it. */
  zone: number;
  /**
   * What searching here is worth, as a bonus on the loot roll. Sent so the map can
   * make the good rooms glitter: a player should be able to *see* that the pharmacy
   * is worth crossing the street for, without opening a wiki.
   */
  loot: number;
  seen: 'visible' | 'explored' | 'hidden';
}

export interface CzHeroView {
  playerId: string;
  name: string;
  title?: string;
  heroId: string;
  hp: number;
  maxHp: number;
  ap: number;
  roomId: string;
  alive: boolean;
  escaped: boolean;
  /** Walked away mid-raid: out of play, and not a death. */
  forfeited?: boolean;
  ready: boolean;
  connected: boolean;
  kills: number;
  /** What is in each hand: a co-op board is open information. */
  hands: (CzItemView | null)[];
  /** Roguelite perks the nickname brought in, worn openly like the title. */
  perks: string[];
  /** The lobby's pick: one signature perk plus up to two globals. */
  loadout: string[];
  /** The server plays this seat. */
  isBot?: boolean;
}

export interface CzZombieView {
  id: string;
  def: string;
  roomId: string;
  hp: number;
  maxHp: number;
  ap: number;
  /** Above the def's printed damage: elites and clawed-up GM spawns. */
  bonusDmg: number;
}

/** The acting player's own belongings, uid included so they can be moved. */
export interface CzMeView {
  playerId: string;
  hands: (ItemInstance | null)[];
  gear: (ItemInstance | null)[];
  bag: ItemInstance[];
  freeSearchAvailable: boolean;
}

export interface CzAwardView {
  key: string;
  playerId: string;
  playerName: string;
  value: string;
}

export interface CzView {
  code: string;
  phase: CzPhase;
  turn: number;
  mode: 'ai' | 'gm';
  scenario: Scenario;
  /**
   * The world's seed: same seed, same config, same map and the same dice
   * sequence. Shown so a memorable raid can be replayed.
   */
  seed: number;
  phaseEndsAt: number | null;
  /** Which layout generator drew this world. */
  layout: string;
  /** Which biome it is set in: the arsenal and the bestiary come from it. */
  biome: string;
  /**
   * Cells no room owns: collapsed, flooded, impassable. Sent as indices because a
   * district is a tenth rubble and listing the exceptions is far cheaper than
   * another string the length of the grid.
   */
  rubble: number[];
  /** The mutations the table took, and what they are worth at the end. */
  mutations: string[];
  mutationReward: number;
  /** In cells. Rooms own one to four of them. */
  width: number;
  height: number;
  rooms: CzRoomView[];
  /**
   * The boundaries, one character per cell, row-major: `.` same room, `#` wall,
   * `D` door, `A` arch, `W` window, `?` withheld. `edgeRight[i]` is the boundary between cell
   * i and its right neighbour, `edgeDown[i]` the one below it.
   */
  edgeRight: string;
  edgeDown: string;
  heroes: CzHeroView[];
  zombies: CzZombieView[];
  keysCollected: number;
  keysTotal: number;
  killsTotal: number;
  killTarget: number;
  survivalTurns: number;
  heroPhaseSeconds: number;
  /** The side quests, progress included: everyone sees the same list. */
  objectives: {
    id: string;
    kind: string;
    target: number;
    progress: number;
    done: boolean;
    label: string;
    /** Pays score, gates nothing. */
    optional?: boolean;
  }[];
  log: LogEntry[];
  me?: CzMeView;
  /** Present for the game master during the enemy phase. */
  gmBudget?: number;
  /** Present for the game master: what he has bought and what he earns. */
  gm?: {
    upgrades: { hide: number; claws: number };
    income: number;
    rushUsed: boolean;
    perks: string[];
  };
  /** Present once the game has ended. */
  scores?: FinalScore[];
  awards?: CzAwardView[];
}

export function toView(state: CzState, role: CzRole): CzView {
  const ended = state.phase === 'won' || state.phase === 'lost';
  const omniscient = role.kind === 'gm' || ended;
  const visible = visibleRooms(state);
  const explored = new Set(state.explored);
  const fog = state.config.fog;

  /**
   * Three fogs for three difficulties: `none` lights the whole board, `map`
   * hands out the floor plan but keeps creatures to the line of sight, `full`
   * is the dark the map was generated for.
   */
  const seenOf = (roomId: string): CzRoomView['seen'] =>
    omniscient
      ? 'visible'
      : fog === 'none'
        ? 'visible'
        : visible.has(roomId)
          ? 'visible'
          : fog === 'map' || explored.has(roomId)
            ? 'explored'
            : 'hidden';

  const rooms: CzRoomView[] = state.board.rooms.map((room) => {
    const seen = seenOf(room.id);

    if (seen === 'hidden') {
      /**
       * A hidden room leaks nothing it owns: not its purpose, not its key, not
       * its furniture. Its *footprint* it does report, and deliberately — the
       * shape of the building was never the secret (the 2020 board handed out a
       * uniform grid of squares), and a room you may walk into needs an id and a
       * place on the floor before you have seen inside it.
       *
       * Whether it is outdoors is reported too: you can see that a street is a
       * street from the other end of it, and the renderer needs to know not to
       * put a roof over the dark.
       */
      return {
        id: room.id,
        x: room.x,
        y: room.y,
        w: room.w,
        h: room.h,
        cells: room.cells,
        kind: 'normal',
        hasKey: false,
        hue: 0,
        floor: room.outdoor ? 'asphalt' : 'concrete',
        program: room.outdoor ? 'street' : 'storage',
        decor: 0,
        outdoor: room.outdoor,
        zone: room.zone,
        // A hidden room does not advertise that it is worth robbing.
        loot: 0,
        seen
      };
    }

    return {
      id: room.id,
      x: room.x,
      y: room.y,
      w: room.w,
      h: room.h,
      cells: room.cells,
      kind: room.kind,
      hasKey: room.hasKey,
      hue: room.hue,
      floor: room.floor,
      program: room.program,
      decor: room.decor,
      outdoor: room.outdoor,
      zone: room.zone,
      loot: room.loot,
      seen
    };
  });

  /**
   * The boundaries, masked by the same fog.
   *
   * A boundary is reported truthfully as soon as *one* of its two cells sits in a
   * room the team has seen: standing in a lit room, you can tell a door from a
   * wall on every side of you, which is exactly what the old `doorRight` bit on a
   * visible room gave away and what makes walking into the dark possible. A
   * boundary buried between two unseen rooms is withheld entirely.
   */
  const cellHidden = new Uint8Array(state.board.width * state.board.height);
  for (const room of rooms) {
    if (room.seen !== 'hidden') continue;
    for (const cell of room.cells) cellHidden[cell] = 1;
  }

  const edgeRight: string[] = [];
  const edgeDown: string[] = [];
  for (let y = 0; y < state.board.height; y++) {
    for (let x = 0; x < state.board.width; x++) {
      const cell = cellIndex(state.board, x, y);
      const right = cellIndex(state.board, x + 1, y);
      const down = cellIndex(state.board, x, y + 1);
      const dark = cellHidden[cell] === 1;
      edgeRight.push(
        dark && (right === -1 || cellHidden[right] === 1)
          ? edgeCode('unknown')
          : edgeCode(edgeAt(state.board, cell, 'right'))
      );
      edgeDown.push(
        dark && (down === -1 || cellHidden[down] === 1)
          ? edgeCode('unknown')
          : edgeCode(edgeAt(state.board, cell, 'down'))
      );
    }
  }

  const zombies: CzZombieView[] = Object.values(state.zombies)
    .filter((zombie) => omniscient || fog === 'none' || visible.has(zombie.roomId))
    .map((zombie) => ({
      id: zombie.id,
      def: zombie.def,
      roomId: zombie.roomId,
      hp: zombie.hp,
      maxHp: zombie.maxHp,
      ap: zombie.ap,
      bonusDmg: zombie.bonusDmg
    }));

  const heroes: CzHeroView[] = Object.values(state.heroes).map((hero) => ({
    playerId: hero.playerId,
    name: hero.name,
    title: hero.title,
    heroId: hero.heroId,
    hp: hero.hp,
    maxHp: hero.maxHp,
    ap: hero.ap,
    roomId: hero.roomId,
    alive: hero.alive,
    escaped: hero.escaped,
    forfeited: hero.forfeited,
    ready: hero.ready,
    connected: hero.connected,
    kills: hero.kills,
    hands: hero.hands.map((item) => (item ? { def: item.def, rarity: item.rarity } : null)),
    perks: hero.perks,
    loadout: hero.loadout,
    isBot: hero.isBot
  }));

  const me = role.kind === 'player' ? state.heroes[role.playerId] : undefined;

  return {
    code: state.code,
    phase: state.phase,
    turn: state.turn,
    mode: state.config.mode,
    scenario: state.config.scenario,
    seed: state.seed,
    phaseEndsAt: state.phaseEndsAt,
    layout: state.board.layout,
    biome: state.config.biome,
    rubble: state.board.cellRoom.flatMap((id, cell) => (id === '' ? [cell] : [])),
    mutations: state.config.mutations,
    mutationReward: mutationEffects(state.config.mutations).reward,
    width: state.board.width,
    height: state.board.height,
    rooms,
    edgeRight: edgeRight.join(''),
    edgeDown: edgeDown.join(''),
    heroes,
    zombies,
    keysCollected: state.keysCollected,
    keysTotal: state.config.keys,
    killsTotal: state.killsTotal,
    killTarget: state.config.killTarget,
    survivalTurns: state.config.survivalTurns,
    heroPhaseSeconds: state.config.heroPhaseSeconds,
    objectives: state.objectives.map((objective) => ({ ...objective })),
    log: state.log.slice(-12),
    me: me
      ? {
          playerId: me.playerId,
          hands: me.hands,
          gear: me.gear,
          bag: me.bag,
          freeSearchAvailable:
            !me.freeSearchUsed &&
            (heroDef(me.heroId).ability === 'scavenger' ||
              me.gear.some((item) => item !== null && item.def === 'flashlight'))
        }
      : undefined,
    gmBudget: role.kind === 'gm' ? state.gmBudget : undefined,
    gm:
      role.kind === 'gm'
        ? {
            upgrades: { ...state.gmUpgrades },
            income: gmIncome(state),
            rushUsed: state.gmRush,
            perks: state.gmPerks
          }
        : undefined,
    scores: ended ? finalScores(state) : undefined,
    awards: ended ? computeCzAwards(state) : undefined
  };
}

/**
 * The raid's distinctions, same shape as the quiz ceremony so the history page
 * renders both without knowing which game produced them.
 */
export function computeCzAwards(state: CzState): CzAwardView[] {
  const heroes = Object.values(state.heroes);
  if (heroes.length === 0) return [];
  const awards: CzAwardView[] = [];
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'fr');

  const butcher = [...heroes].sort((a, b) => b.killPoints - a.killPoints || byName(a, b))[0];
  if (butcher && butcher.kills > 0) {
    awards.push({
      key: 'butcher',
      playerId: butcher.playerId,
      playerName: butcher.name,
      value: `${butcher.kills} victime${butcher.kills > 1 ? 's' : ''}`
    });
  }

  const locksmith = [...heroes].sort((a, b) => b.keysPicked - a.keysPicked || byName(a, b))[0];
  if (locksmith && locksmith.keysPicked > 0) {
    awards.push({
      key: 'locksmith',
      playerId: locksmith.playerId,
      playerName: locksmith.name,
      value: `${locksmith.keysPicked} clé${locksmith.keysPicked > 1 ? 's' : ''}`
    });
  }

  const looter = [...heroes].sort((a, b) => b.searches - a.searches || byName(a, b))[0];
  if (looter && looter.searches >= 2) {
    awards.push({
      key: 'looter',
      playerId: looter.playerId,
      playerName: looter.name,
      value: `${looter.searches} fouilles`
    });
  }

  const untouched = heroes.filter((hero) => hero.alive && hero.damageTaken === 0).sort(byName)[0];
  if (untouched && state.phase === 'won') {
    awards.push({
      key: 'untouchable',
      playerId: untouched.playerId,
      playerName: untouched.name,
      value: '0 blessure'
    });
  }

  const magnet = [...heroes].sort((a, b) => b.damageTaken - a.damageTaken || byName(a, b))[0];
  if (magnet && magnet.damageTaken >= 3) {
    awards.push({
      key: 'magnet',
      playerId: magnet.playerId,
      playerName: magnet.name,
      value: `${magnet.damageTaken} blessures`
    });
  }

  return awards;
}

/* ----------------------------- socket contract ---------------------------- */

export const czHeroActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), roomId: z.string().max(16) }),
  z.object({
    type: z.literal('attack'),
    zombieId: z.string().max(16),
    hand: z.union([z.literal(0), z.literal(1), z.literal(2)])
  }),
  z.object({ type: z.literal('search') }),
  z.object({ type: z.literal('pickupKey') }),
  z.object({ type: z.literal('exit') }),
  z.object({ type: z.literal('use'), uid: z.number().int().positive() }),
  z.object({
    type: z.literal('equip'),
    uid: z.number().int().positive(),
    slot: z.enum(['hand0', 'hand1', 'gear0', 'gear1', 'bag'])
  }),
  z.object({ type: z.literal('drop'), uid: z.number().int().positive() }),
  z.object({ type: z.literal('give'), uid: z.number().int().positive(), toPlayerId: z.string().max(40) }),
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('forfeit') })
]);

export const czGmActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gmMove'), zombieId: z.string().max(16), roomId: z.string().max(16) }),
  z.object({ type: z.literal('gmAttack'), zombieId: z.string().max(16) }),
  z.object({ type: z.literal('gmSpawn'), roomId: z.string().max(16), def: z.string().max(16) }),
  z.object({ type: z.literal('gmUpgrade'), upgrade: z.enum(['hide', 'claws']) }),
  z.object({ type: z.literal('gmOrder'), order: z.enum(['rush']) }),
  z.object({ type: z.literal('gmForfeit') })
]);

export const czJoinSchema = z.object({
  code: z.string().min(4).max(8),
  name: z.string().trim().min(1).max(24),
  playerToken: z.string().max(64).optional()
});

export interface CzJoinAck {
  ok: boolean;
  error?: string;
  playerToken?: string;
  playerId?: string;
  view?: CzView;
  /** The joining ledger's roster economy, for the character picker. */
  career?: { rations: number; unlockedHeroes: string[] };
  /**
   * The Kune login the raid's rewards will be banked into, when the browser
   * happened to carry a session. Absent means the nickname is the ledger.
   */
  account?: string;
}

export interface CzActionAck {
  ok: boolean;
  error?: string;
  loot?: ItemInstance;
  /** Attack feedback for the phone's speaker. */
  hits?: number;
  killed?: string[];
}

export interface CzClientToServer {
  'cz:open': (payload: { code: string; hostToken: string }, ack: (response: CzJoinAck) => void) => void;
  'cz:gmOpen': (payload: { code: string; gmToken: string }, ack: (response: CzJoinAck) => void) => void;
  'cz:join': (payload: z.infer<typeof czJoinSchema>, ack: (response: CzJoinAck) => void) => void;
  'cz:selectHero': (payload: { heroId: string }, ack: (response: { ok: boolean; error?: string }) => void) => void;
  /** The lobby's CoD pick: one signature perk + up to two globals. */
  'cz:loadout': (payload: { perks: string[] }, ack: (response: { ok: boolean; error?: string }) => void) => void;
  /**
   * The table's own handicap, toggled in the lobby by any player. Not the host's
   * dial: the people who will suffer it choose it, and they are paid for it.
   */
  'cz:mutations': (
    payload: { mutations: string[] },
    ack: (response: { ok: boolean; error?: string }) => void
  ) => void;
  /** Spends the joining nickname's rations on a locked survivor. */
  'cz:unlockHero': (
    payload: { heroId: string },
    ack: (response: { ok: boolean; error?: string; career?: { rations: number; unlockedHeroes: string[] } }) => void
  ) => void;
  'cz:start': (payload: { hostToken: string }) => void;
  /** Host-only: seats or removes a machine teammate, lobby only. */
  'cz:addBot': (
    payload: { hostToken: string; skill?: string },
    ack: (response: { ok: boolean; error?: string }) => void
  ) => void;
  'cz:removeBot': (payload: { hostToken: string; playerId: string }) => void;
  'cz:action': (payload: unknown, ack: (response: CzActionAck) => void) => void;
  'cz:gmAction': (payload: unknown, ack: (response: CzActionAck) => void) => void;
  'cz:gmEnd': (payload: { gmToken: string }) => void;
}

export interface CzServerToClient {
  'cz:state': (view: CzView) => void;
  'cz:error': (payload: { message: string }) => void;
}
