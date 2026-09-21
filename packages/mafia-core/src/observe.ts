import {
  BOARD_MEMO,
  isEvilRole,
  sheriffSuspects,
  type Claim,
  type PublicInfo,
  type VoteRecord
} from './sim/policies.js';
import { roleDef, ROLES, type RoleId } from './roles.js';
import type { DeathSource } from './messages.js';
import { tableRoleList, type MafiaState, type VoteNote } from './state.js';
import { slotPool, type SlotToken } from './setups.js';

/**
 * The killers with nobody to answer to. Past a couple of their corpses the whole
 * town smells the bigger threat, and even the families briefly vote with it.
 */
const LONE_BLADES = new Set<DeathSource>(['serialKiller', 'massMurderer', 'arsonist', 'electromaniac', 'poison']);

/**
 * A role that stands for its camp, for a graveyard that only named the camp.
 *
 * Deliberately the plainest member of each: a board reasoning from "some
 * mafioso" must not accidentally conclude that the Godfather is accounted for,
 * or that the table's only Sheriff is dead.
 */
function campStandIn(role: RoleId): RoleId {
  const faction = roleDef(role).faction;
  if (faction === 'mafia') return 'mafioso';
  if (faction === 'triad') return 'enforcer';
  if (faction === 'cult') return 'cultist';
  if (faction === 'neutral') return 'survivor';
  return 'citizen';
}

/**
 * One game's board, kept between reads and rebuilt a layer at a time.
 *
 * A board read is the single hottest thing the bench does: every seat asks for
 * one before every decision, and a day of twenty-four seats with three voting
 * passes asks for the better part of a hundred. Almost nothing changes between
 * two of them. A vote moves; the graveyard, the roster, the role list and the
 * claims pile all stay exactly where they were.
 *
 * So the pieces are grouped by what makes them stale and each group is rebuilt
 * only when its own inputs move:
 *
 * - **roster**: the expanded role list, which is fixed for the whole game.
 * - **grave**: everything read off the graveyard and the seating — the deaths,
 *   the revealed roles, the living, the sash. Moves when somebody dies, is
 *   converted, or reveals.
 * - **claims**: the claims pile with the wills folded in, and what the record
 *   proves from it. Moves when somebody speaks or somebody dies.
 * - **trials**: the public trial record. Moves when a trial ends.
 * - **votes**: rebuilt on every read, because it genuinely does change on
 *   almost every one.
 *
 * Staleness is decided by *comparison*, never by a hash: the previous seating
 * and the previous ballot box are kept beside the layers and compared field by
 * field. Twenty-four integer comparisons cost nothing next to the rebuild they
 * skip, and unlike a fingerprint they cannot collide — a board that silently
 * failed to notice a death would be the worst bug this file could have.
 */
interface BoardCache {
  /** Seating as it was when `grave` was built: one entry per player, in order. */
  seatAlive: boolean[];
  seatRevealed: boolean[];
  seatRole: (RoleId | null)[];
  deathCount: number;
  hiddenCount: number;
  day: number;

  rolesInPlay: Set<RoleId>;
  roleSlots: SlotToken[];
  dealCopies: Map<RoleId, number>;

  grave: {
    deaths: PublicInfo['deaths'];
    deadRoles: Map<number, RoleId>;
    lastNightDeathSlots: Set<number>;
    nightDeathsTotal: number;
    totalDead: number;
    rampage: number;
    aliveSlots: number[];
    humanSlots: Set<number>;
    revealedMayorSlot: number | null;
  } | null;

  /** The `spoken` array this claims layer was built from, and its length then. */
  spokenRef: Claim[] | null;
  spokenLen: number;
  claims: Claim[];
  provenRoles: Map<number, RoleId>;

  trialLogLen: number;
  trials: PublicInfo['trials'];

  /** The ballot box as it was on the last read, key and value side by side. */
  voteKeys: string[];
  voteVals: string[];
  votes: Map<number, number>;

  /** The last board handed out, returned again when literally nothing moved. */
  info: PublicInfo | null;
  voteHistoryRef: VoteRecord[] | null;
  voteHistoryLen: number;
  /** Per-board working memory, kept alive across reads that only moved a vote. */
  memo: BoardMemo;
}

/**
 * Scratch space the policies hang their per-board answers on.
 *
 * `claimerWeight` and friends are pure functions of the board, and they are
 * asked the same question hundreds of times per decision, so they cache. The
 * container lives here rather than on the board object because a board is
 * rebuilt whenever a single vote moves, and none of what they cache depends on
 * the votes — throwing the work away four times a day per seat was most of what
 * the caching was supposed to save.
 *
 * Attached to the board non-enumerably on purpose. A caller that builds a
 * variant with `{ ...board, voteHistory }` gets a board with no scratch space
 * rather than one carrying answers computed against the other history, and
 * simply pays for a cold read.
 */
export interface BoardMemo {
  [key: string]: unknown;
}

const BOARDS = new WeakMap<MafiaState, BoardCache>();

/** Has the seating moved since the cached layers were built? */
function seatingMoved(cache: BoardCache, players: MafiaState['players'][string][]): boolean {
  const { seatAlive, seatRevealed, seatRole } = cache;
  if (seatAlive.length !== players.length) return true;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (seatAlive[i] !== player.alive || seatRevealed[i] !== player.revealed || seatRole[i] !== player.role) {
      return true;
    }
  }
  return false;
}

/** Has the ballot box moved? Compared entry by entry, in insertion order. */
function ballotsMoved(cache: BoardCache, votes: Record<string, string>): boolean {
  const { voteKeys, voteVals } = cache;
  let index = 0;
  for (const voterId in votes) {
    if (index >= voteKeys.length || voteKeys[index] !== voterId || voteVals[index] !== votes[voterId]) return true;
    index++;
  }
  return index !== voteKeys.length;
}

/**
 * The town as anybody in it can see it, assembled from authoritative state.
 *
 * This exists because two very different brains need to agree about the board.
 * The headless simulator runs thousands of games a minute off it; the live server
 * builds the same thing to brief an LLM. When those two disagree about what is
 * public, the bench stops predicting the game — so there is one builder, here,
 * and both callers use it.
 *
 * Everything in the result is genuinely public: the living, the identified dead,
 * last night's corpses, the running accusations, the trial record with its
 * ballots. The two arguments are the parts the *game* does not store in a
 * structured form — spoken claims and the history of past days' accusations —
 * which each caller accumulates as it goes.
 *
 * The result is shared, not copied: two reads that found the same board hand
 * back the same object, and a read that only saw a vote move reuses every
 * collection that did not. Nothing downstream writes to a board, and nothing
 * may start to.
 */
/**
 * How many seats could be wearing each badge, from the published roster.
 *
 * A category slot counts as one copy of every role in its pool: "random town"
 * could be the Sheriff, so a table with two of them could hold two Sheriffs and
 * a second claim proves nothing. Counting it any other way would have the board
 * calling honest seats liars, which is the one mistake it must not make.
 */
function copiesDealt(tokens: readonly SlotToken[]): Map<RoleId, number> {
  const copies = new Map<RoleId, number>();
  for (const token of tokens) {
    for (const role of slotPool(token)) copies.set(role, (copies.get(role) ?? 0) + 1);
  }
  return copies;
}

export function toPublicInfo(state: MafiaState, spoken: Claim[], voteHistory: VoteRecord[]): PublicInfo {
  const players = Object.values(state.players);
  const slotOf = (playerId: string): number | undefined => state.players[playerId]?.slot;

  let cache = BOARDS.get(state);
  if (!cache) {
    cache = {
      seatAlive: [],
      seatRevealed: [],
      seatRole: [],
      deathCount: -1,
      hiddenCount: -1,
      day: -1,
      /**
       * The roster, expanded. Public on every screen, so nothing leaks by
       * putting it here — and it is what lets a liar tell a lie the room could
       * believe rather than one the role list flatly contradicts.
       *
       * Dealt once and never again: the setup is fixed before the first night,
       * so re-sorting and re-expanding it on every board read was pure waste,
       * and it was one of the two most expensive things a read did.
       */
      rolesInPlay: new Set<RoleId>(tableRoleList(state, players.length).flatMap((token) => slotPool(token))),
      /**
       * And how many of each badge the table can possibly be wearing.
       *
       * `rolesInPlay` answers "could there be a Sheriff", which catches a bluff
       * naming a role nobody was dealt and nothing else. The question the room
       * actually asks is "could there be a *second* Sheriff", and the roster on
       * every screen answers it: a pinned slot is one copy, and a category slot
       * is one copy of everything it might turn out to be, which is the honest
       * upper bound a player reading the list has.
       *
       * Without it the only badges the board could ever catch being worn twice
       * were the ones flagged `unique` — thirteen roles, none of them the three
       * that actually get bluffed. A Sheriff could be claimed by two living
       * seats with a third in the ground and the arithmetic said nothing.
       */
      /**
       * And the list itself, unexpanded.
       *
       * The expansion above answers "could this table contain a Jester" and
       * cannot answer "can it still", because a category slot that has already
       * turned out to be something else is still in the union. The slots are
       * what the room reads off the wall and what `possibleRoles` matches the
       * graveyard against, so they belong on the board next to their own
       * expansion.
       */
      roleSlots: tableRoleList(state, players.length),
      dealCopies: copiesDealt(tableRoleList(state, players.length)),
      grave: null,
      spokenRef: null,
      spokenLen: -1,
      claims: [],
      provenRoles: new Map(),
      trialLogLen: -1,
      trials: [],
      voteKeys: [],
      voteVals: [],
      votes: new Map(),
      info: null,
      voteHistoryRef: null,
      voteHistoryLen: -1,
      memo: {}
    };
    BOARDS.set(state, cache);
  }

  let hiddenCount = 0;
  for (const death of state.deaths) if (death.hidden) hiddenCount++;

  /**
   * The graveyard layer. `hiddenCount` is watched alongside the death count
   * because a janitor marks a corpse cleaned after it was filed, and a board
   * that missed that would keep naming a role the town was never told.
   */
  const graveStale =
    cache.grave === null ||
    cache.deathCount !== state.deaths.length ||
    cache.hiddenCount !== hiddenCount ||
    cache.day !== state.day ||
    seatingMoved(cache, players);

  if (graveStale) {
    cache.deathCount = state.deaths.length;
    cache.hiddenCount = hiddenCount;
    cache.day = state.day;
    cache.seatAlive.length = 0;
    cache.seatRevealed.length = 0;
    cache.seatRole.length = 0;
    for (const player of players) {
      cache.seatAlive.push(player.alive);
      cache.seatRevealed.push(player.revealed);
      cache.seatRole.push(player.role);
    }
    cache.grave = buildGrave(state, players, slotOf);
  }
  const grave = cache.grave!;

  /** The claims layer: what was said, plus the wills, plus what that proves. */
  const claimsStale = graveStale || cache.spokenRef !== spoken || cache.spokenLen !== spoken.length;
  if (claimsStale) {
    cache.spokenRef = spoken;
    cache.spokenLen = spoken.length;
    // What the dead said, joined with what was spoken while they lived.
    cache.claims = [...spoken, ...testamentClaims(state, spoken)];
    cache.provenRoles = provenRoles(state, cache.claims, grave.deaths);
  }

  /** The trial record, which only moves when a trial ends. */
  const trialLogLen = (state.trialLog ?? []).length;
  const trialsStale = graveStale || cache.trialLogLen !== trialLogLen;
  if (trialsStale) {
    cache.trialLogLen = trialLogLen;
    cache.trials = (state.trialLog ?? []).map((trial) => ({
      day: trial.day,
      accusedSlot: slotOf(trial.accusedId) ?? 0,
      lynched: trial.lynched,
      guiltySlots: trial.guiltyIds.map(slotOf).filter((slot): slot is number => slot !== undefined),
      innocentSlots: trial.innocentIds.map(slotOf).filter((slot): slot is number => slot !== undefined),
      abstainSlots: (trial.abstainIds ?? []).map(slotOf).filter((slot): slot is number => slot !== undefined)
    }));
  }

  /** The ballot box, which usually has. */
  const ballotsStale = cache.info === null || ballotsMoved(cache, state.votes);
  if (ballotsStale) {
    cache.voteKeys.length = 0;
    cache.voteVals.length = 0;
    const votes = new Map<number, number>();
    for (const voterId in state.votes) {
      const targetId = state.votes[voterId];
      cache.voteKeys.push(voterId);
      cache.voteVals.push(targetId);
      const voter = slotOf(voterId);
      const target = slotOf(targetId);
      if (voter !== undefined && target !== undefined) votes.set(voter, target);
    }
    cache.votes = votes;
  }

  const historyMoved = cache.voteHistoryRef !== voteHistory || cache.voteHistoryLen !== voteHistory.length;
  cache.voteHistoryRef = voteHistory;
  cache.voteHistoryLen = voteHistory.length;

  const trialSlot = state.trial ? (slotOf(state.trial.accusedId) ?? null) : null;

  // Nothing moved at all: hand back the very board they were given last time,
  // so everything keyed on its identity stays warm.
  if (
    !graveStale &&
    !claimsStale &&
    !trialsStale &&
    !ballotsStale &&
    !historyMoved &&
    cache.info &&
    cache.info.trialSlot === trialSlot
  ) {
    return cache.info;
  }

  // The scratch space survives a read that only moved a vote or the trial; a
  // new claim, a death or a fresh history invalidates what it holds.
  if (graveStale || claimsStale || trialsStale || historyMoved) cache.memo = {};

  const info: PublicInfo = {
    day: state.day,
    deaths: grave.deaths,
    humanSlots: grave.humanSlots,
    provenRoles: cache.provenRoles,
    aliveSlots: grave.aliveSlots,
    deadRoles: grave.deadRoles,
    lastNightDeathSlots: grave.lastNightDeathSlots,
    nightDeathsTotal: grave.nightDeathsTotal,
    totalDead: grave.totalDead,
    trials: cache.trials,
    voteHistory,
    /**
     * The log itself, handed over by reference and never copied.
     *
     * `voteHistory` is the closing position of each seat on each day, which is
     * what the pattern-readers wanted and is a summary. This is the record the
     * engine has always kept: every move of every ballot in the order it was
     * made. Read by `tempo.ts`, which is the only thing that needs the order,
     * and passed as the live array because the board object is rebuilt the
     * moment a vote moves — the two go stale together, so there is nothing to
     * keep in step.
     */
    ballots: state.voteLog ?? [],
    rampage: grave.rampage,
    votes: cache.votes,
    rolesInPlay: cache.rolesInPlay,
    roleSlots: cache.roleSlots,
    dealCopies: cache.dealCopies,
    revealedMayorSlot: grave.revealedMayorSlot,
    trialSlot,
    claims: cache.claims
  };
  Object.defineProperty(info, BOARD_MEMO, {
    value: cache.memo,
    enumerable: false,
    writable: true
  });
  cache.info = info;
  return info;
}

/** Everything a board reads off the graveyard and the seating. */
function buildGrave(
  state: MafiaState,
  players: MafiaState['players'][string][],
  slotOf: (playerId: string) => number | undefined
): NonNullable<BoardCache['grave']> {
  const reveal = state.config.revealOnDeath ?? 'role';

  const deaths: PublicInfo['deaths'] = [];
  const lastNightDeathSlots = new Set<number>();
  const hiddenIds = new Set<string>();
  let nightDeathsTotal = 0;
  let rampage = 0;
  for (const death of state.deaths) {
    if (death.hidden) hiddenIds.add(death.playerId);
    if (death.phase === 'night') {
      nightDeathsTotal++;
      if (death.day === state.day - 1) {
        const slot = slotOf(death.playerId);
        if (slot !== undefined) lastNightDeathSlots.add(slot);
      }
    }
    if (death.source !== undefined && LONE_BLADES.has(death.source)) rampage++;
    const slot = slotOf(death.playerId);
    if (slot === undefined) continue;
    deaths.push({
      slot,
      day: death.day,
      phase: death.phase,
      source: death.source ?? null
    });
  }

  const aliveSlots: number[] = [];
  const humanSlots = new Set<number>();
  const deadRoles = new Map<number, RoleId>();
  let revealedMayorSlot: number | null = null;
  for (const player of players) {
    if (!player.isBot) humanSlots.add(player.slot);
    if (player.alive) {
      aliveSlots.push(player.slot);
      if (player.revealed && revealedMayorSlot === null) revealedMayorSlot = player.slot;
      continue;
    }
    /**
     * A janitor-cleaned corpse keeps its secret from the public board, and so
     * does a table playing without role reveals — the graveyard only knows what
     * the game agreed to say out loud.
     */
    if (player.role === null || reveal === 'none' || hiddenIds.has(player.playerId)) continue;
    /**
     * Under a faction-reveal table, a stand-in of the right camp.
     *
     * This map is how the board remembers what the graveyard turned out to
     * be, and almost everything downstream only asks it a *camp* question:
     * `trustOf` scores old ballots by whether the corpse was evil,
     * `parityPressure` counts dead evils, `possibilitySet` eliminates.
     * None of them needs the exact role.
     *
     * It used to be populated only under full role reveal, so on a table set
     * to reveal factions the map came back empty and the entire trust system
     * silently did nothing — nobody was ever held responsible for having
     * voted to spare a mafioso, which is the loudest tell in the game. The
     * town played on with no memory of who had protected whom.
     *
     * A faction-revealed corpse therefore reports a *representative* role of
     * its camp rather than its own. Anything that wants the real one asks the
     * player; anything that wants the camp gets a truthful answer either way,
     * which is exactly as much as the table said out loud.
     */
    deadRoles.set(player.slot, reveal === 'role' ? player.role : campStandIn(player.role));
  }

  return {
    deaths,
    deadRoles,
    lastNightDeathSlots,
    /**
     * Corpses signed by a lone blade. The dawn report names the weapon, so the
     * count is public — and past a couple of them everyone smells the bigger
     * threat, which briefly puts the families on the town's side.
     */
    rampage,
    nightDeathsTotal,
    totalDead: state.deaths.length,
    aliveSlots,
    humanSlots,
    revealedMayorSlot
  };
}

/**
 * A dead town bot's will, as claims on the board.
 *
 * A bot's will is rendered from its own structured record, so for a *signed*
 * will the record is the will and can be read back without a model: a Sheriff's
 * "night 2, checked 7, came back bad" is an accusation of 7 by the Sheriff, a
 * Lookout's "4 had callers: 6, 9" is a sighting of 6 and of 9, "I went to 5" is
 * an account of having visited 5. Filed under the dead seat's own number, so
 * `claimerWeight` reads them as a town corpse's testament.
 *
 * Town corpses only, because that is who signs. The driver writes an evil
 * seat's will as flavour and nothing else, so its record was never shown to the
 * town; reading it here anyway handed the square a dead Consigliere's exact-role
 * checks as accurate accusations, at full weight on a table that does not
 * reveal roles. What the town can read is what the town gets.
 *
 * Only wills the town was shown: a cleaned corpse's will was never announced.
 * A person's record is not their will either; they may have written none, or
 * lied in it. Their wills reach the board the way their speech does, through
 * the ear.
 *
 * Memoised per graveyard. The dead do not act, so a corpse's record and its
 * will cannot change after the death, and this is rebuilt only when somebody
 * else dies rather than on every one of the thousands of board reads a game
 * makes. The bench was half again slower before this.
 */
const TESTAMENTS = new WeakMap<MafiaState, { key: string; claims: Claim[] }>();

function testamentClaims(state: MafiaState, spoken: Claim[]): Claim[] {
  const key = `${state.deaths.map((death) => death.playerId).join(',')}|${state.config.revealOnDeath ?? 'role'}`;
  let cached = TESTAMENTS.get(state);
  if (!cached || cached.key !== key) {
    cached = { key, claims: readTestaments(state) };
    TESTAMENTS.set(state, cached);
  }

  /**
   * Said in life and written in death is one claim, not two.
   *
   * A spoken accusation carries the day it was said; the testament carries the
   * night it was learned, so a comparison that included the day never matched,
   * and a Sheriff who reported a check and then died counted double against its
   * target. Same claimer, same target, same kind is the same assertion whenever
   * it was made.
   */
  return cached.claims.filter(
    (claim) =>
      !spoken.some(
        (other) =>
          other.claimerSlot === claim.claimerSlot && other.targetSlot === claim.targetSlot && other.kind === claim.kind
      )
  );
}

function readTestaments(state: MafiaState): Claim[] {
  const filed: Claim[] = [];
  const seen = new Set<string>();
  const file = (claim: Claim): void => {
    const id = `${claim.claimerSlot}:${claim.targetSlot}:${claim.kind}:${claim.day}`;
    if (seen.has(id)) return;
    seen.add(id);
    filed.push(claim);
  };

  for (const player of Object.values(state.players)) {
    if (player.alive || !player.isBot || !player.lastWill || !player.role) continue;
    if (roleDef(player.role).faction !== 'town') continue;
    const record = state.deaths.find((death) => death.playerId === player.playerId);
    if (!record || record.hidden) continue;

    for (const entry of player.intel) {
      const base = {
        day: entry.night,
        // Written down rather than left to be guessed from `day`. See `Claim.night`.
        night: entry.night,
        claimerSlot: player.slot,
        truthful: false,
        /**
         * Every line of this is a night somebody actually worked.
         *
         * A will rendered from `intel` is the record itself: the entry exists
         * because the engine wrote it when the power resolved. `worked` is what
         * separates "I checked 9 and he came back bad" from "I reckon 9 is
         * bad", and without it a dead investigator's testimony reached the
         * board indistinguishable from a stranger's hunch — which is how the
         * town's own corpses ended up counting as hearsay in the one place it
         * matters, the half of the score a juror is allowed to point at.
         */
        worked: true,
        /**
         * And which instrument wrote it, which is what corroborates.
         *
         * `worked` says this came out of a night; `from` says which power, and
         * two different powers pointing at one house is the strongest thing the
         * board can hold. A dead investigator's testimony arrived carrying the
         * first and not the second, so a Sheriff's check read from a will
         * counted as an ungrounded hunch the moment `grounding` started asking.
         */
        from: entry.kind
      } as const;
      switch (entry.kind) {
        case 'sheriff':
          file({
            ...base,
            targetSlot: entry.targetSlot,
            kind: sheriffSuspects(entry.value) ? 'accuse' : 'clear'
          });
          break;
        case 'role':
          // Guarded, so a stray string in a record cannot become a claim.
          if (entry.value in ROLES) {
            file({
              ...base,
              targetSlot: entry.targetSlot,
              kind: isEvilRole(entry.value as RoleId) ? 'accuse' : 'clear'
            });
          }
          break;
        case 'visitors':
          for (const visitor of entry.slots ?? []) file({ ...base, targetSlot: visitor, kind: 'sighting' });
          break;
        case 'tracked':
          file({ ...base, targetSlot: entry.targetSlot, kind: 'sighting' });
          break;
        case 'went':
          file({
            ...base,
            targetSlot: entry.targetSlot,
            kind: 'account',
            account: 'visited'
          });
          break;
        default:
          break;
      }
    }
  }
  return filed;
}

/**
 * The deaths whose weapon names a role, and which role.
 *
 * Only the ones where the *victim's own journey* identifies the killer: the
 * Veteran shoots whoever calls on him, so the house the corpse visited that
 * night is the Veteran's. A mafia kill or a vigilante's bullet says nothing
 * about where the victim went, and the jailor's execution needs no deduction,
 * so those are not here.
 */
const PORCH_KILLS: Partial<Record<DeathSource, RoleId>> = {
  veteran: 'veteran'
};

/**
 * What the record proves about the living. See `PublicInfo.provenRoles`.
 *
 * Two sources, both deliberately narrow.
 *
 * **The porch.** A seat died at night to a weapon that only fires at visitors,
 * and its will says where it went that night. That house holds the role. Read
 * off the *claims* rather than off the corpse's private record, so a person's
 * will counts only if they wrote it and a bot's counts because it always does:
 * the town knows exactly what the town was told.
 *
 * **The badge.** A living seat that claimed an investigative town role, and
 * whose accusation has since put a revealed evil in the ground, with no
 * accusation of theirs having hanged a townie. The graveyard corroborated the
 * claim; the room may treat the seat as what it says it is. Whoever the seat
 * really is: a mafioso who claimed Sheriff and handed the town a Serial Killer,
 * or a doomed brother, has bought exactly the trust a person would have bought
 * with the same play.
 *
 * Indexed once per call. This runs on every board read, and the first shape
 * of it scanned the whole roster for every accusation of every claimant.
 */
function provenRoles(state: MafiaState, claims: Claim[], deaths: PublicInfo['deaths']): Map<number, RoleId> {
  const proven = new Map<number, RoleId>();
  const players = Object.values(state.players);
  const bySlot = new Map(players.map((player) => [player.slot, player]));
  const alive = new Set(players.filter((player) => player.alive).map((player) => player.slot));

  /**
   * The sash: the one role claim in this game that cannot be faked.
   *
   * Revealing is an engine action, and the announcement comes from the town
   * itself rather than out of the seat's mouth, so a living revealed Mayor or
   * Marshall is confirmed town in a way no investigator's word ever is.
   *
   * Nothing said so. `revealedMayorSlot` was read by the killers choosing a
   * target and by the doctors choosing a patient, and by nothing at all on the
   * voting side — so the square would cheerfully hang the one seat it could be
   * certain of. Reported from a real game: a revealed Marshall drew a wagon at
   * parity and very nearly handed the family the win.
   */
  for (const player of players) {
    if (!player.alive || !player.revealed || !player.role) continue;
    proven.set(player.slot, player.role);
  }

  // The porch.
  for (const death of deaths) {
    const role = death.source ? PORCH_KILLS[death.source] : undefined;
    if (!role || death.phase !== 'night') continue;
    const journeys = claims.filter(
      (claim) => claim.claimerSlot === death.slot && claim.kind === 'account' && claim.account === 'visited'
    );
    // The exact night when the will was precise about it; the last journey otherwise.
    const thatNight = journeys.filter((claim) => claim.day === death.day);
    const journey = (thatNight.length > 0 ? thatNight : journeys).at(-1);
    if (journey && alive.has(journey.targetSlot)) proven.set(journey.targetSlot, role);
  }

  // The badge.
  const revealed = (state.config.revealOnDeath ?? 'role') !== 'none';
  const hidden = new Set(state.deaths.filter((death) => death.hidden).map((death) => death.playerId));
  const deadRoleOf = (slot: number): RoleId | null => {
    const player = bySlot.get(slot);
    if (!player || player.alive || !player.role || !revealed || hidden.has(player.playerId)) return null;
    return player.role;
  };
  const accusationsBy = new Map<number, Claim[]>();
  for (const claim of claims) {
    if (claim.kind !== 'accuse') continue;
    const mine = accusationsBy.get(claim.claimerSlot);
    if (mine) mine.push(claim);
    else accusationsBy.set(claim.claimerSlot, [claim]);
  }
  for (const claim of claims) {
    if (claim.kind !== 'role-claim' || !claim.claimedRole || !alive.has(claim.claimerSlot)) continue;
    /**
     * Any town badge, not only the six investigative ones.
     *
     * The rule below is about *outcomes* and never about which badge was
     * claimed: a seat whose accusations hanged killers and never a townie has
     * been reading the game right, and that is as true of a claimed Doctor or
     * Bodyguard as of a claimed Sheriff. Restricting it to `BADGE_ROLES` meant
     * the Vigilante, Jailor, Veteran, Doctor and Bodyguard could never be
     * vouched for by the record however right they turned out to be, so the
     * only roles the graveyard could confirm were the ones that already had the
     * easiest time being believed.
     *
     * Town only. Vouching for a claimed killer's badge on the strength of good
     * votes is not something a record can do, and `isEvilRole` is priced on the
     * other side of the board entirely.
     */
    if (!(claim.claimedRole in ROLES) || roleDef(claim.claimedRole).faction !== 'town') continue;
    if (proven.has(claim.claimerSlot)) continue;
    const outcomes = (accusationsBy.get(claim.claimerSlot) ?? [])
      .map((other) => deadRoleOf(other.targetSlot))
      .filter((role): role is RoleId => role !== null);
    const hangedEvil = outcomes.some((role) => isEvilRole(role));
    const hangedTown = outcomes.some((role) => roleDef(role).faction === 'town');
    if (hangedEvil && !hangedTown) proven.set(claim.claimerSlot, claim.claimedRole);
  }

  /**
   * A killing this table's own dawn report signed for.
   *
   * The record could catch a liar nine ways and vouch for nobody, which is not
   * a symmetry a game can afford: a seat that told the truth about a hard thing
   * got exactly what a seat that said nothing got. The dawn report names a
   * weapon for every night death, so a claimed killing is the one assertion the
   * graveyard settles on its own, without anybody being believed.
   *
   * Three things have to line up, and a liar cannot arrange any of them after
   * the fact: the night names a corpse, the corpse's report credits the weapon
   * the claimer says it used, and the corpse came up evil. A Vigilante that
   * shot a mafioso on night three can say so on day four and be *right* in a
   * way the room can check on its own screens.
   *
   * The victim being evil is deliberately part of it. A Vigilante that shot a
   * townie also told the truth, and the room may well still want it dead for
   * it; this vouches for the seat's usefulness, not merely its honesty.
   */
  const killers: Partial<Record<DeathSource, RoleId>> = {
    vigilante: 'vigilante',
    jailor: 'jailor',
    veteran: 'veteran'
  };
  for (const claim of claims) {
    if (claim.kind !== 'kill-claim' || !alive.has(claim.claimerSlot) || proven.has(claim.claimerSlot)) continue;
    const night = claim.night ?? Math.max(1, claim.day - 1);
    const body = deaths.find(
      (death) => death.slot === claim.targetSlot && death.phase === 'night' && death.day === night
    );
    if (!body?.source) continue;
    const role = killers[body.source];
    // The badge the claim names, when it names one; otherwise the weapon's own.
    if (!role || (claim.claimedRole !== undefined && claim.claimedRole !== role)) continue;
    const buried = deadRoleOf(claim.targetSlot);
    if (buried !== null && isEvilRole(buried)) proven.set(claim.claimerSlot, role);
  }

  return proven;
}

/**
 * The accusation each seat ended a day on, read off the authoritative log.
 *
 * `voteHistory` is what the town's pattern-readers run on: `buddyScore` looks
 * for two seats whose lines never crossed, `monomaniacScore` for a seat that
 * votes one head every afternoon. Both need several days of ballots to say
 * anything, and both were being handed almost nothing.
 *
 * The cause was the same on both sides of the game, reached from opposite
 * directions. Everybody was snapshotting `state.votes`, the *live* ballot box —
 * and a wagon that reaches the threshold opens a trial, which clears that box
 * on the spot. The simulator recorded before night fell, but only while the
 * stage was still `discussion`, which a day that opened a trial had already
 * left; the live server recorded at nightfall, by which point the box had been
 * emptied twice over. So a day was written down only when nobody was ever put
 * on trial — and the days the town actually did something, which are the only
 * days worth reading, were exactly the ones that vanished. Measured on a table
 * of twelve to twenty: 0.49 recorded ballots per day, where a voting day should
 * produce one per living seat. Both reads have been dead since they were
 * written.
 *
 * `state.voteLog` is the real record and always was: every accusation of the
 * game in the order it was cast, written before the trial can clear anything,
 * withdrawals and skips included. The closing position is the last entry each
 * seat left that day, which is what the field has always claimed to hold.
 *
 * A seat that withdrew and never re-voted, or that voted to hang nobody, closed
 * the day accusing nobody and is simply absent — the readers count days a pair
 * *both* voted, so a missing ballot must not read as a ballot for nobody.
 */
export function closingAccusations(state: MafiaState, day: number): VoteRecord[] {
  const last = new Map<number, VoteNote>();
  for (const note of state.voteLog ?? []) {
    if (note.day === day) last.set(note.voterSlot, note);
  }
  const records: VoteRecord[] = [];
  for (const [voterSlot, note] of last) {
    if (note.skip || note.targetSlot === null) continue;
    records.push({ day, voterSlot, targetSlot: note.targetSlot });
  }
  return records;
}
