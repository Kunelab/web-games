import { BADGE_ROLES, isEvilRole, type Claim, type PublicInfo, type VoteRecord } from './sim/policies.js';
import { roleDef, ROLES, type RoleId } from './roles.js';
import type { DeathSource } from './messages.js';
import type { MafiaState } from './state.js';

/**
 * The killers with nobody to answer to. Past a couple of their corpses the whole
 * town smells the bigger threat, and even the families briefly vote with it.
 */
const LONE_BLADES = new Set<DeathSource>(['serialKiller', 'massMurderer', 'arsonist', 'electromaniac', 'poison']);

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
 */
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

export function toPublicInfo(state: MafiaState, spoken: Claim[], voteHistory: VoteRecord[]): PublicInfo {
  const players = Object.values(state.players);
  const slotOf = (playerId: string): number | undefined => state.players[playerId]?.slot;

  const deaths = state.deaths
    .map((death) => ({
      slot: slotOf(death.playerId),
      day: death.day,
      phase: death.phase,
      source: death.source ?? null
    }))
    .filter((death): death is { slot: number; day: number; phase: 'day' | 'night'; source: DeathSource | null } =>
      death.slot !== undefined
    );

  // What the dead said, joined with what was spoken while they lived.
  const claims = [...spoken, ...testamentClaims(state, spoken)];

  return {
    day: state.day,
    deaths,
    provenRoles: provenRoles(state, claims, deaths),
    aliveSlots: players.filter((player) => player.alive).map((player) => player.slot),
    /**
     * A janitor-cleaned corpse keeps its secret from the public board, and so
     * does a table playing without role reveals — the graveyard only knows what
     * the game agreed to say out loud.
     */
    deadRoles: new Map(
      players
        .filter(
          (player) =>
            !player.alive &&
            player.role !== null &&
            (state.config.revealOnDeath ?? 'role') !== 'none' &&
            !state.deaths.some((death) => death.playerId === player.playerId && death.hidden)
        )
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
        .map((player) => [
          player.slot,
          (state.config.revealOnDeath ?? 'role') === 'role' ? player.role! : campStandIn(player.role!)
        ])
    ),
    lastNightDeathSlots: new Set(
      state.deaths
        .filter((death) => death.phase === 'night' && death.day === state.day - 1)
        .map((death) => slotOf(death.playerId))
        .filter((slot): slot is number => slot !== undefined)
    ),
    nightDeathsTotal: state.deaths.filter((death) => death.phase === 'night').length,
    totalDead: state.deaths.length,
    trials: (state.trialLog ?? []).map((trial) => ({
      day: trial.day,
      accusedSlot: slotOf(trial.accusedId) ?? 0,
      lynched: trial.lynched,
      guiltySlots: trial.guiltyIds.map(slotOf).filter((slot): slot is number => slot !== undefined),
      innocentSlots: trial.innocentIds.map(slotOf).filter((slot): slot is number => slot !== undefined)
    })),
    voteHistory,
    /**
     * Corpses signed by a lone blade. The dawn report names the weapon, so the
     * count is public — and past a couple of them everyone smells the bigger
     * threat, which briefly puts the families on the town's side.
     */
    rampage: state.deaths.filter((death) => death.source !== undefined && LONE_BLADES.has(death.source)).length,
    votes: new Map(
      Object.entries(state.votes)
        .map(([voterId, targetId]) => {
          const voter = slotOf(voterId);
          const target = slotOf(targetId);
          return voter !== undefined && target !== undefined ? ([voter, target] as [number, number]) : null;
        })
        .filter((entry): entry is [number, number] => entry !== null)
    ),
    revealedMayorSlot: players.find((player) => player.revealed && player.alive)?.slot ?? null,
    trialSlot: state.trial ? (slotOf(state.trial.accusedId) ?? null) : null,
    claims
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
      const base = { day: entry.night, claimerSlot: player.slot, truthful: false } as const;
      switch (entry.kind) {
        case 'sheriff':
          file({ ...base, targetSlot: entry.targetSlot, kind: entry.value === 'suspect' ? 'accuse' : 'clear' });
          break;
        case 'role':
          // Guarded, so a stray string in a record cannot become a claim.
          if (entry.value in ROLES) {
            file({ ...base, targetSlot: entry.targetSlot, kind: isEvilRole(entry.value as RoleId) ? 'accuse' : 'clear' });
          }
          break;
        case 'visitors':
          for (const visitor of entry.slots ?? []) file({ ...base, targetSlot: visitor, kind: 'sighting' });
          break;
        case 'tracked':
          file({ ...base, targetSlot: entry.targetSlot, kind: 'sighting' });
          break;
        case 'went':
          file({ ...base, targetSlot: entry.targetSlot, kind: 'account', account: 'visited' });
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
const PORCH_KILLS: Partial<Record<DeathSource, RoleId>> = { veteran: 'veteran' };

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
    if (!BADGE_ROLES.has(claim.claimedRole) || proven.has(claim.claimerSlot)) continue;
    const outcomes = (accusationsBy.get(claim.claimerSlot) ?? [])
      .map((other) => deadRoleOf(other.targetSlot))
      .filter((role): role is RoleId => role !== null);
    const hangedEvil = outcomes.some((role) => isEvilRole(role));
    const hangedTown = outcomes.some((role) => roleDef(role).faction === 'town');
    if (hangedEvil && !hangedTown) proven.set(claim.claimerSlot, claim.claimedRole);
  }

  return proven;
}
