import {
  addMafiaBot,
  advanceMafia,
  callCourt,
  castBallot,
  castVote,
  jailTarget,
  legalNightAction,
  revealMayor,
  setNightAction,
  startMafia
} from '../engine.js';
import { roleDef, type RoleId } from '../roles.js';
import { createMafiaGame, isLodgeMate, playerBySlot, playerFamily, type MafiaConfig, type MafiaState } from '../state.js';
import {
  bindPersonalities,
  decideBallot,
  decideDay,
  decideNightTarget,
  isEvilRole,
  makePersonality,
  DEFAULT_PROFILE,
  type Brain,
  type Claim,
  type Personality,
  type PublicInfo
} from './policies.js';

/**
 * One full game, synchronously, through the real engine — the same functions
 * the server calls, with virtual time instead of timers. Thousands of games a
 * minute, each fully determined by its seed.
 */

export interface SimOptions {
  players: number;
  seed: number;
  profile?: Partial<Personality>;
  config?: Partial<MafiaConfig>;
}

export interface SimResult {
  seed: number;
  players: number;
  days: number;
  winner: 'town' | 'mafia' | 'triad' | 'cult' | 'solo' | 'draw';
  jesterWin: boolean;
  jesterPresent: boolean;
  exeWin: boolean;
  exePresent: boolean;
  survivorWin: boolean;
  survivorPresent: boolean;
  lynches: number;
  evilLynches: number;
  jesterLynches: number;
  townLynches: number;
  nightDeaths: number;
  vigMisfires: number;
  saves: number;
  executions: number;
  wrongExecutions: number;
  /** Diagnostics: what the rumour mill produced, and who stood at the end. */
  claimsTrue: number;
  claimsFalse: number;
  finalAlive: RoleId[];
}

/** mulberry32: tiny, fast, good enough for dice. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulateGame(options: SimOptions): SimResult {
  const rng = mulberry32(options.seed);
  const state = createMafiaGame({
    code: 'SIM',
    hostToken: 'sim',
    hostUserId: null,
    // Clock lengths are irrelevant here — time is virtual — but short values
    // keep the announced deadlines sane if a trace is ever read.
    config: { dayMs: 1000, nightMs: 1000, defenseMs: 100, judgementMs: 100, aftermathMs: 100, ...options.config },
    now: 0
  });

  for (let index = 0; index < options.players; index++) {
    addMafiaBot(state, `t${index}`, `p${index}`);
  }
  let now = 1000;
  startMafia(state, now, rng);

  const players = Object.values(state.players);
  const profile: Personality = { ...DEFAULT_PROFILE, ...options.profile };
  const brains = new Map<string, Brain>(
    players.map((player) => [
      player.playerId,
      { slot: player.slot, personality: makePersonality(profile, rng), checked: new Set<number>(), lastKillTarget: null }
    ])
  );
  bindPersonalities([...brains.values()]);

  for (const player of players) {
    player.obsessionSlotHint = player.obsessionId ? (state.players[player.obsessionId]?.slot ?? null) : null;
  }
  // Computed live: conversions, recruitments and remembered roles reshuffle
  // who knows whom mid-game.
  const teammatesOf = (playerId: string): Set<number> => {
    const self = state.players[playerId];
    if (!self) return new Set();
    return new Set(players.filter((other) => other !== self && isLodgeMate(self, other)).map((other) => other.slot));
  };
  const knownEvilFor = (playerId: string): Set<number> => {
    const self = state.players[playerId];
    const family = self ? playerFamily(self) : null;
    if (!family) return new Set();
    return new Set(players.filter((other) => playerFamily(other) === family).map((other) => other.slot));
  };

  const claims: Claim[] = [];
  /** Final accusations of past days, for the town's pattern-readers. */
  const voteHistory: { day: number; voterSlot: number; targetSlot: number }[] = [];
  /** Seats whose last will has already been read out. */
  const willsRead = new Set<string>();
  let lastOpenedDay = 0;
  let guard = 0;

  const stampAndPush = (claim: Claim): void => {
    const target = playerBySlot(state, claim.targetSlot);
    const targetEvil = target ? isEvilRole(target.role!) : false;
    claim.truthful =
      claim.kind === 'clear'
        ? !targetEvil
        : claim.kind === 'role-claim'
          ? target?.role === claim.claimedRole
          : targetEvil;
    claims.push(claim);
  };

  /** The day's final accusations go on the record before night falls. */
  const recordVotes = (): void => {
    for (const [voterId, targetId] of Object.entries(state.votes)) {
      const voter = state.players[voterId];
      const target = state.players[targetId];
      if (voter && target) voteHistory.push({ day: state.day, voterSlot: voter.slot, targetSlot: target.slot });
    }
  };

  /**
   * Last wills: the dead still speak, and the town reads every word — against
   * the corpse's revealed role (claimerWeight handles the credibility).
   *
   *  - Investigative town dumps everything it hoarded: sheriff results,
   *    the detective's fatal-house catches, the lookout's visitor lists.
   *    Self-preservation in life, full disclosure in death — which is the
   *    whole tension the mafia's kill order navigates.
   *  - Liars (families, jester, scumbag, witch, executioner) leave *fake*
   *    wills: invented accusations. A revealed liar's will is kindling, but
   *    a janitor-cleaned liar keeps his voice…
   */
  const wasNightDeathAt = (slot: number, night: number): boolean =>
    state.deaths.some(
      (death) => death.phase === 'night' && death.day === night && state.players[death.playerId]?.slot === slot
    );

  const readWills = (): void => {
    for (const player of players) {
      if (player.alive || willsRead.has(player.playerId)) continue;
      willsRead.add(player.playerId);
      const role = player.role!;

      if (role === 'sheriff' || role === 'investigator') {
        for (const entry of player.intel) {
          if (entry.kind !== 'sheriff') continue;
          stampAndPush({
            day: state.day,
            claimerSlot: player.slot,
            targetSlot: entry.targetSlot,
            kind: entry.value === 'suspect' ? 'accuse' : 'clear',
            truthful: false
          });
        }
      }
      if (role === 'detective') {
        for (const entry of player.intel) {
          if (entry.kind !== 'tracked') continue;
          if ((entry.slots ?? []).some((slot) => wasNightDeathAt(slot, entry.night))) {
            stampAndPush({ day: state.day, claimerSlot: player.slot, targetSlot: entry.targetSlot, kind: 'accuse', truthful: false });
          }
        }
      }
      if (role === 'lookout') {
        for (const entry of player.intel) {
          if (entry.kind !== 'visitors' || !wasNightDeathAt(entry.targetSlot, entry.night)) continue;
          for (const visitor of entry.slots ?? []) {
            stampAndPush({ day: state.day, claimerSlot: player.slot, targetSlot: visitor, kind: 'accuse', truthful: false });
          }
        }
      }

      // The liars' poisoned testaments.
      const liar = isEvilRole(role) || role === 'jester' || role === 'scumbag' || role === 'witch' || role === 'executioner';
      if (liar) {
        const marks = players.filter((other) => other.alive && other.playerId !== player.playerId);
        const count = 1 + Math.floor(rng() * 2);
        for (let i = 0; i < count && marks.length > 0; i++) {
          const mark = marks[Math.floor(rng() * marks.length)];
          stampAndPush({ day: state.day, claimerSlot: player.slot, targetSlot: mark.slot, kind: 'accuse', truthful: false });
        }
      }
    }
  };

  const publicInfo = (): PublicInfo => ({
    day: state.day,
    aliveSlots: players.filter((player) => player.alive).map((player) => player.slot),
    // A janitor-cleaned corpse keeps its secret from the public board too.
    deadRoles: new Map(
      players
        .filter(
          (player) =>
            !player.alive && !state.deaths.some((death) => death.playerId === player.playerId && death.hidden)
        )
        .map((player) => [player.slot, player.role!])
    ),
    lastNightDeathSlots: new Set(
      state.deaths
        .filter((death) => death.phase === 'night' && death.day === state.day - 1)
        .map((death) => state.players[death.playerId]?.slot)
        .filter((slot): slot is number => slot !== undefined)
    ),
    nightDeathsTotal: state.deaths.filter((death) => death.phase === 'night').length,
    totalDead: state.deaths.length,
    trials: (state.trialLog ?? []).map((trial) => ({
      day: trial.day,
      accusedSlot: state.players[trial.accusedId]?.slot ?? 0,
      lynched: trial.lynched,
      guiltySlots: trial.guiltyIds.map((id) => state.players[id]?.slot).filter((slot): slot is number => slot !== undefined),
      innocentSlots: trial.innocentIds.map((id) => state.players[id]?.slot).filter((slot): slot is number => slot !== undefined)
    })),
    voteHistory,
    rampage: state.deaths.filter(
      (death) =>
        death.cause.includes('Tueur') ||
        death.cause.includes('Incendiaire') ||
        death.cause.includes('Électromane') ||
        death.cause.includes('poison')
    ).length,
    votes: new Map(
      Object.entries(state.votes)
        .map(([voterId, targetId]) => {
          const voter = state.players[voterId];
          const target = state.players[targetId];
          return voter && target ? ([voter.slot, target.slot] as [number, number]) : null;
        })
        .filter((entry): entry is [number, number] => entry !== null)
    ),
    revealedMayorSlot: players.find((player) => player.revealed && player.alive)?.slot ?? null,
    trialSlot: state.trial ? (state.players[state.trial.accusedId]?.slot ?? null) : null,
    claims
  });

  const familyIntelFor = (playerId: string) => {
    const self = state.players[playerId];
    const family = self ? playerFamily(self) : null;
    if (!family) return [];
    return players.filter((player) => playerFamily(player) === family && player.alive).flatMap((player) => player.intel);
  };

  const shuffledAlive = () => {
    const alive = players.filter((player) => player.alive);
    for (let i = alive.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = alive[i];
      alive[i] = alive[j]!;
      alive[j] = tmp;
    }
    return alive;
  };

  const advance = () => {
    now = (state.phaseEndsAt ?? now) + 1;
    advanceMafia(state, now, rng);
  };

  while (state.phase !== 'ended' && guard++ < 600) {
    if (state.phase === 'day' && state.stage === 'discussion') {
      // Once per dawn: claims land, the jailor picks, the mayor weighs his sash.
      if (lastOpenedDay !== state.day) {
        lastOpenedDay = state.day;
        readWills();
        for (const player of shuffledAlive()) {
          const decision = decideDay(player, brains.get(player.playerId)!, publicInfo(), teammatesOf(player.playerId), knownEvilFor(player.playerId), rng);
          // Ground truth is stamped at push time, where the full state is
          // known — the brains themselves never see other players' roles.
          for (const claim of decision.publishes) stampAndPush(claim);
          if (decision.jailSlot !== null) jailTarget(state, player.playerId, decision.jailSlot);
          if (decision.revealMayor) revealMayor(state, player.playerId, now);
        }
      }

      // Voting passes: seats react to the wagons the previous pass built.
      if (state.day > 1) {
        for (let pass = 0; pass < 3 && state.stage === 'discussion'; pass++) {
          for (const player of shuffledAlive()) {
            if (state.stage !== 'discussion') break;
            const decision = decideDay(player, brains.get(player.playerId)!, publicInfo(), teammatesOf(player.playerId), knownEvilFor(player.playerId), rng);
            if (decision.voteSlot !== null) {
              castVote(state, player.playerId, decision.voteSlot, now);
            }
            if (decision.revealMayor) revealMayor(state, player.playerId, now);
            if (decision.callCourt) callCourt(state, player.playerId, now);
          }
        }
      }

      if (state.phase === 'day' && state.stage === 'discussion') {
        recordVotes();
        advance();
      }
      continue;
    }

    if (state.phase === 'day' && state.stage === 'defense') {
      const accused = state.trial ? state.players[state.trial.accusedId] : null;
      if ((accused?.role === 'mayor' || accused?.role === 'marshall') && !accused.revealed) {
        revealMayor(state, accused.playerId, now);
      }
      advance();
      continue;
    }

    if (state.phase === 'day' && state.stage === 'judgement') {
      const info = publicInfo();
      const accusedSlot = info.trialSlot;
      if (accusedSlot !== null) {
        for (const player of shuffledAlive()) {
          if (player.slot === accusedSlot) continue;
          castBallot(state, player.playerId, decideBallot(player, brains.get(player.playerId)!, info, accusedSlot, teammatesOf(player.playerId), rng));
        }
      }
      advance();
      continue;
    }

    if (state.phase === 'night') {
      const info = publicInfo();
      for (const player of shuffledAlive()) {
        const legal = legalNightAction(state, player.playerId);
        if (!legal) continue;
        const target = decideNightTarget(
          player,
          brains.get(player.playerId)!,
          info,
          legal.targets,
          legal.type,
          teammatesOf(player.playerId),
          familyIntelFor(player.playerId),
          rng
        );
        if (target !== null) setNightAction(state, player.playerId, target);
      }
      advance();
      continue;
    }

    advance();
  }


  return tally(state, options, claims);
}

function tally(state: MafiaState, options: SimOptions, claims: Claim[]): SimResult {
  const players = Object.values(state.players);
  const reasons = state.winners.map((winner) => winner.reason);

  const winner: SimResult['winner'] = reasons.some((reason) => reason === 'Victoire de la Ville')
    ? 'town'
    : reasons.some((reason) => reason === 'Victoire de la Mafia')
      ? 'mafia'
      : reasons.some((reason) => reason === 'Victoire de la Triade')
        ? 'triad'
        : reasons.some((reason) => reason === 'Victoire de la Secte')
          ? 'cult'
          : reasons.some((reason) => reason.startsWith('Dernier') || reason.startsWith('Dernière'))
            ? 'solo'
            : 'draw';

  const lynched = state.deaths.filter((death) => death.cause.includes('pendu'));
  const executed = state.deaths.filter((death) => death.cause.includes('Geôlier'));
  const rolePresent = (role: RoleId) => players.some((player) => player.role === role);

  return {
    seed: options.seed,
    players: options.players,
    days: state.day,
    winner,
    jesterWin: reasons.some((reason) => reason.includes('Bouffon')),
    jesterPresent: rolePresent('jester'),
    exeWin: reasons.some((reason) => reason.includes('Bourreau')),
    exePresent: players.some((player) => player.obsessionSlotHint != null) || rolePresent('executioner'),
    survivorWin: reasons.some((reason) => reason.includes('survécu')),
    survivorPresent: rolePresent('survivor'),
    lynches: lynched.length,
    evilLynches: lynched.filter((death) => isEvilRole(death.role)).length,
    jesterLynches: lynched.filter((death) => death.role === 'jester').length,
    townLynches: lynched.filter((death) => roleDef(death.role).faction === 'town').length,
    nightDeaths: state.deaths.filter((death) => death.phase === 'night').length,
    vigMisfires: state.deaths.filter((death) => death.cause.includes('Justicier') && roleDef(death.role).faction === 'town').length,
    saves: state.points.filter((entry) => entry.reason === 'save').length,
    executions: executed.length,
    wrongExecutions: executed.filter((death) => !isEvilRole(death.role)).length,
    claimsTrue: claims.filter((claim) => claim.truthful).length,
    claimsFalse: claims.filter((claim) => !claim.truthful).length,
    finalAlive: players.filter((player) => player.alive).map((player) => player.role!)
  };
}
