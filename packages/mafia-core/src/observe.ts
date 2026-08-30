import type { Claim, PublicInfo, VoteRecord } from './sim/policies.js';
import { roleDef, type RoleId } from './roles.js';
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

export function toPublicInfo(state: MafiaState, claims: Claim[], voteHistory: VoteRecord[]): PublicInfo {
  const players = Object.values(state.players);
  const slotOf = (playerId: string): number | undefined => state.players[playerId]?.slot;

  return {
    day: state.day,
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
