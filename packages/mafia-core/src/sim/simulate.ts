import {
  addMafiaBot,
  advanceMafia,
  callCourt,
  castBallot,
  castVote,
  jailTarget,
  legalNightAction,
  needsSecondTarget,
  revealMayor,
  setNightAction,
  startMafia
} from '../engine.js';
import { ROLES, roleDef, type RoleId } from '../roles.js';
import {
  createMafiaGame,
  isLodgeMate,
  playerBySlot,
  playerFamily,
  type MafiaConfig,
  type MafiaPlayer,
  type MafiaState
} from '../state.js';
import {
  bindPersonalities,
  decideBallot,
  decideDay,
  feelPressure,
  makeBrain,
  decideNightTarget,
  unclashedTargets,
  decideSecondTarget,
  executesCaptive,
  isEvilRole,
  makePersonality,
  sheriffSuspects,
  suspicionParts,
  parityPressure,
  DEFAULT_PROFILE,
  HUMAN_PROFILE,
  type Brain,
  type Claim,
  type Personality,
  type PublicInfo
} from './policies.js';
import { closingAccusations, toPublicInfo } from '../observe.js';
import { deductions } from './deduce.js';
import { rank } from './ranking.js';

/**
 * One full game, synchronously, through the real engine — the same functions
 * the server calls, with virtual time instead of timers. Thousands of games a
 * minute, each fully determined by its seed.
 */

/**
 * What the board held against a seat at the moment it was put on the stand.
 *
 * Win rates say a lynching was wrong; they never say *why* the room believed
 * it. This does, and it is deliberately taken before the defence is heard,
 * because it is the state of the record that opened the trial — what the
 * jurors were reasoning from when they decided this was the seat worth a day.
 *
 * `hardMax` is the load-bearing number. It is the most any single living juror
 * could actually point to: a check, a fatal-house sighting, a claim the
 * graveyard had already broken. A table hanging its own people on rumour and
 * momentum shows up here as a stand full of trials where the best evidence
 * anybody held was zero, and no amount of win-rate tuning will find that.
 */
export interface TrialAutopsy {
  day: number;
  accusedSlot: number;
  accusedRole: RoleId;
  accusedEvil: boolean;
  /** The public case, averaged over the living jurors who were not on trial. */
  evidence: number;
  /** The best hard evidence held by any one of them. See above. */
  hardMax: number;
  /** How many of them held any at all. */
  hardHolders: number;
  /** Seats standing on the wagon when it tipped. */
  wagon: number;
  /** Who first accused this seat aloud, on what day, and whether they were evil. */
  firstAccuser: number | null;
  firstAccuserDay: number | null;
  firstAccuserEvil: boolean;
  /** Distinct seats that had accused them by now. */
  accusers: number;
  /** How close the game was to the parity clock, 0..1. See `parityPressure`. */
  pressure: number;
  /** Which findings from `deduce.ts` stood against them, by kind. */
  caught: string[];
  /** Whether the room went through with it. */
  hanged: boolean;
}

/**
 * One seat's standing at one dawn, with the truth attached.
 *
 * The point of a probability is that it can be *wrong in a measurable way*. A
 * ranking that says 0.7 and is right seven times in ten is worth having; one
 * that says 0.7 and is right three times in ten is worse than a coin, and the
 * two are indistinguishable from inside the game. So the bench records what the
 * ranking claimed and what the seat actually was, and the reliability table
 * falls out of it.
 */
export interface Calibration {
  day: number;
  slot: number;
  /** What `rank` said, before anybody knew. */
  p: number;
  /** What they actually were. */
  evil: boolean;
  /** How many reasons the case rested on, for the "cites more, is righter" check. */
  reasons: number;
  /**
   * Which rules fired, so the likelihood ratios can be *fitted* rather than
   * argued.
   *
   * The first set of weights was priced by reasoning about the rules, which
   * sounded careful and measured worse than useless: Brier 0.252 against 0.235
   * for flatly stating the base rate, and systematically backwards in the
   * middle of the range. Each code's real weight is an empirical question —
   * how much likelier is this observation on a killer than on anybody else —
   * and this is what answers it.
   */
  codes: string[];
}

export interface SimOptions {
  players: number;
  seed: number;
  profile?: Partial<Personality>;
  config?: Partial<MafiaConfig>;
  /**
   * How many of the seats play as people rather than as the policy.
   *
   * They are the same brain with `HUMAN_PROFILE`'s habits: they stonewall, they
   * change their story, they move their vote on less. What they are really for
   * is the half of the board that has never run here — `humanSlots` is empty in
   * every all-bot game, so `claimerWeight`'s human branch multiplies nothing
   * and any rule about being ignored has nothing to fire on. With a person at
   * the table those paths run, and the bench can be asked what the bots do
   * about somebody who will not answer them.
   *
   * Zero by default, and a table of zero draws exactly the numbers it always
   * drew.
   */
  humans?: number;
  /** What those seats play like. Defaults to `HUMAN_PROFILE`. */
  humanProfile?: Partial<Personality>;
  /**
   * Called once per trial, as it opens. See `TrialAutopsy`.
   *
   * A hook rather than a field on `SimResult` because it is a forensic tool
   * and not a score: a run of six hundred games asking why the rope keeps
   * finding town wants every trial, and a run measuring balance wants none of
   * them. Absent, this costs nothing.
   */
  autopsy?: (trial: TrialAutopsy) => void;
  /**
   * Called once per dawn, for every living seat. See `Calibration`.
   *
   * A hook for the same reason `autopsy` is one: it is a measurement and not a
   * score, it costs a ranking per living seat per day, and a run that is not
   * asking the question should not pay for it.
   */
  calibrate?: (row: Calibration) => void;
  /**
   * Called once for every seat that could act tonight, target or no target. See `NightChoice`.
   *
   * The third hook of the same kind, and it answers the questions the score columns structurally cannot: a
   * Vigilante who never fires and a Vigilante who has no bullets left produce the same zero in `vigMisfires`,
   * an Escort who blocks a Citizen every night for six nights produces nothing at all anywhere, and "the bots
   * never use their powers" is not a thing a win rate can confirm or deny. A declined action is an event, so
   * it is reported as one.
   */
  nightWatch?: (choice: NightChoice) => void;
}

/** One seat's decision on one night, including the decision not to act. */
export interface NightChoice {
  night: number;
  slot: number;
  role: RoleId;
  action: string;
  /** Null when the seat had a legal move and declined it. */
  targetSlot: number | null;
  /** The target's true role, for asking whether a power landed on anything. */
  targetRole: RoleId | null;
  /** Seats it could legally have chosen, so a refusal can be told from having no choice. */
  choices: number;
}

export interface SimResult {
  seed: number;
  players: number;
  days: number;
  winner: 'town' | 'mafia' | 'triad' | 'cult' | 'solo' | 'witch' | 'draw';
  /**
   * Why a drawn game drew, read off the engine rather than inferred here.
   *
   * The bench used to guess from what was left standing, which cannot tell a
   * clock running out from a position nobody could break — and those are not
   * the same bug. See `MafiaState.drawReason`.
   */
  drawReason?: 'hollow' | 'clock' | 'frozen';
  /** Who was still alive when it ended, for reading a draw back. */
  aliveAtEnd: { slot: number; role: RoleId }[];
  jesterWin: boolean;
  jesterPresent: boolean;
  exeWin: boolean;
  exePresent: boolean;
  survivorWin: boolean;
  survivorPresent: boolean;
  lynches: number;
  evilLynches: number;
  jesterLynches: number;
  /** Seats the Jester took with him: a guilty voter dead of remorse at dawn. */
  remorseDeaths: number;
  townLynches: number;
  nightDeaths: number;
  vigMisfires: number;
  saves: number;
  executions: number;
  wrongExecutions: number;
  /** Captives the Kidnapper or the Interrogator did not release. See `optionalCharges`. */
  cellarKills: number;
  /** Tables that dealt a cell at all, so the two counts above can be read as rates. */
  jailorPresent: boolean;
  keeperPresent: boolean;
  /** Diagnostics: what the rumour mill produced, and who stood at the end. */
  claimsTrue: number;
  claimsFalse: number;
  finalAlive: RoleId[];
  /**
   * What the table did with the person at it. See `SimOptions.humans`.
   *
   * Not a balance measurement. Win rates say nothing about whether a game was
   * any fun to sit through, and the thing a person actually complains about is
   * being ignored: they named somebody and nobody looked, they asked somebody a
   * question and the square moved on, they were hunted from the first afternoon
   * for having spoken at all. Those are countable, so they are counted here,
   * and a change meant to make the bots feel more attentive can be checked
   * against them rather than argued about.
   */
  human: {
    seats: number;
    /** Person-seats still standing at the end. */
    survived: number;
    /** Questions a person put to a bot, and how many got an account that day. */
    asked: number;
    answered: number;
    /** Questions a bot put to a person: the square taking an interest. */
    questioned: number;
    /** Accusations by a person, and how many the room then voted for that day. */
    accusations: number;
    followed: number;
    /** Day accusations aimed at a person, against the day's total. */
    votesAgainst: number;
    votesTotal: number;
    /**
     * The same two rates for the bots, as a control.
     *
     * Without them the human figures mean nothing. "Only one accusation in ten
     * by a person is ever acted on" is an indictment of how the square treats
     * people; it is a fact about how the square treats accusations. Only the
     * gap between the two says which.
     */
    botAsked: number;
    botAnswered: number;
    botAccusations: number;
    botFollowed: number;
  };
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

/**
 * A town role the accused is not, that the board cannot immediately disprove.
 *
 * Deliberately the same test the live driver's `bluffRole` applies: not already
 * claimed by somebody living, and not lying in the graveyard. A lie that the
 * room can break by reading its own notes is not a bluff, it is a confession
 * with extra steps — and it should be punished as one, which it now is.
 */
function bluffFor(accused: MafiaPlayer, info: PublicInfo, rng: () => number): RoleId | null {
  const spoken = new Set(info.claims.filter((claim) => claim.kind === 'role-claim').map((claim) => claim.claimedRole));
  const buried = new Set(info.deadRoles.values());
  const options = (Object.keys(ROLES) as RoleId[]).filter(
    (role) => roleDef(role).faction === 'town' && role !== accused.role && !spoken.has(role) && !buried.has(role)
  );
  return options.length === 0 ? null : (options[Math.floor(rng() * options.length)] ?? null);
}

export function simulateGame(options: SimOptions): SimResult {
  const rng = mulberry32(options.seed);
  const state = createMafiaGame({
    code: 'SIM',
    hostToken: 'sim',
    hostUserId: null,
    // Clock lengths are irrelevant here — time is virtual — but short values
    // keep the announced deadlines sane if a trace is ever read.
    config: {
      dayMs: 1000,
      nightMs: 1000,
      defenseMs: 100,
      judgementMs: 100,
      aftermathMs: 100,
      /**
       * No ballot lock here, because there is nobody to wait for.
       *
       * The lock buys people seconds to type before the day can be ended. This
       * loop has no people and no real seconds: it advances `now` only at
       * `phaseEndsAt`, so every seat votes at the instant the day opened and any
       * lock at all refuses every ballot in the game. Measured the hard way —
       * 186 lynches over forty games became zero, and the town went from winning
       * 45% of them to none.
       */
      voteLockMs: 0,
      ...options.config
    },
    now: 0
  });

  for (let index = 0; index < options.players; index++) {
    addMafiaBot(state, `t${index}`, `p${index}`, (max) => Math.floor(rng() * max));
  }
  let now = 1000;
  startMafia(state, now, rng);

  const players = Object.values(state.players);
  const profile: Personality = { ...DEFAULT_PROFILE, ...options.profile };

  /**
   * The seats that play as people, drawn before the brains so the roll is part
   * of the seed. Marked `isBot: false`, which is the only thing that puts a
   * slot in `humanSlots` and therefore the only thing the board reads.
   *
   * Drawn last-first rather than at random, so a run with one person always
   * seats them in the same chair and a trace is comparable to the run before.
   * Nothing in the headless path consults `isBot` other than the board: the
   * presence model that does is only reached from the live server's ticker.
   */
  const humanCount = Math.max(0, Math.min(options.humans ?? 0, players.length));
  const humanProfile: Personality = { ...DEFAULT_PROFILE, ...HUMAN_PROFILE, ...options.humanProfile };
  for (let index = 0; index < humanCount; index++) {
    const seat = players[players.length - 1 - index];
    if (seat) seat.isBot = false;
  }

  const brains = new Map<string, Brain>(
    players.map((player) => [
      player.playerId,
      makeBrain(player.slot, makePersonality(player.isBot ? profile : humanProfile, rng))
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

  const brainOf = (slot: number): Brain | undefined => [...brains.values()].find((brain) => brain.slot === slot);

  const claims: Claim[] = [];
  /** Final accusations of past days, for the town's pattern-readers. */
  const voteHistory: { day: number; voterSlot: number; targetSlot: number }[] = [];
  /** Seats whose last will has already been read out. */
  const willsRead = new Set<string>();
  let lastOpenedDay = 0;
  /** The last day whose closing accusations were filed. See `recordVotes`. */
  let lastRecordedDay = 0;
  let guard = 0;
  /** The trial on the stand, read before its defence. See `TrialAutopsy`. */
  let pending: Omit<TrialAutopsy, 'hanged'> | null = null;

  const stampAndPush = (claim: Claim): void => {
    const target = playerBySlot(state, claim.targetSlot);
    const targetEvil = target ? isEvilRole(target.role!) : false;
    claim.truthful =
      claim.kind === 'clear'
        ? !targetEvil
        : claim.kind === 'role-claim'
          ? target?.role === claim.claimedRole
          : claim.kind === 'account'
            ? // An account is honest when it matches where the seat actually went.
              claim.account === 'home'
              ? (brainOf(claim.claimerSlot)?.wentTo ?? null) === null
              : (brainOf(claim.claimerSlot)?.wentTo ?? null) === claim.targetSlot
            : claim.kind === 'question' || claim.kind === 'taunt'
              ? true // neither states a fact, so neither can be a lie
              : targetEvil;
    claims.push(claim);
  };

  /**
   * The day's final accusations go on the record before night falls.
   *
   * Read off `state.voteLog` rather than the live ballot box, and guarded by
   * the day rather than by the stage, because a day that opened a trial had
   * both emptied the box and left `discussion` before this ever ran. See
   * `closingAccusations`.
   */
  const recordVotes = (): void => {
    if (lastRecordedDay === state.day) return;
    lastRecordedDay = state.day;
    for (const record of closingAccusations(state, state.day)) voteHistory.push(record);
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
            kind: sheriffSuspects(entry.value) ? 'accuse' : 'clear',
            truthful: false
          });
        }
      }
      if (role === 'detective') {
        for (const entry of player.intel) {
          if (entry.kind !== 'tracked') continue;
          if ((entry.slots ?? []).some((slot) => wasNightDeathAt(slot, entry.night))) {
            stampAndPush({
              day: state.day,
              claimerSlot: player.slot,
              targetSlot: entry.targetSlot,
              kind: 'accuse',
              truthful: false
            });
          }
        }
      }
      if (role === 'lookout') {
        for (const entry of player.intel) {
          if (entry.kind !== 'visitors' || !wasNightDeathAt(entry.targetSlot, entry.night)) continue;
          for (const visitor of entry.slots ?? []) {
            stampAndPush({
              day: state.day,
              claimerSlot: player.slot,
              targetSlot: visitor,
              kind: 'accuse',
              truthful: false
            });
          }
        }
      }

      // The liars' poisoned testaments.
      const liar =
        isEvilRole(role) || role === 'jester' || role === 'scumbag' || role === 'witch' || role === 'executioner';
      if (liar) {
        const marks = players.filter((other) => other.alive && other.playerId !== player.playerId);
        const count = 1 + Math.floor(rng() * 2);
        for (let i = 0; i < count && marks.length > 0; i++) {
          const mark = marks[Math.floor(rng() * marks.length)];
          stampAndPush({
            day: state.day,
            claimerSlot: player.slot,
            targetSlot: mark.slot,
            kind: 'accuse',
            truthful: false
          });
        }
      }
    }
  };

  /**
   * The public board, from the shared observer — the same function the live
   * server uses to brief its LLM bots, so the bench and the real table never
   * disagree about what a seat can see.
   */
  const publicInfo = (): PublicInfo => toPublicInfo(state, claims, voteHistory);

  const familyIntelFor = (playerId: string) => {
    const self = state.players[playerId];
    const family = self ? playerFamily(self) : null;
    if (!family) return [];
    return players
      .filter((player) => playerFamily(player) === family && player.alive)
      .flatMap((player) => player.intel);
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
        /**
         * The mood of the morning, taken once, before a word is said.
         *
         * Advanced here rather than inside `decideDay` because that runs several
         * times a day (claims, then three voting passes) and desperation is a
         * state of mind, not a per-decision reading — ticking it per call would
         * have it compound four times a day and everybody would be frantic by
         * Tuesday.
         */
        const dawn = publicInfo();
        for (const player of players) {
          if (!player.alive) continue;
          feelPressure(player, brains.get(player.playerId)!, dawn, teammatesOf(player.playerId));
        }

        /**
         * What the ranking believed this morning, against what was true.
         *
         * Taken at dawn rather than at a trial, because a trial is a biased
         * sample by construction: the room only tries the seats it already
         * suspects, so measuring there would only ever tell us how good the
         * ranking is at the top of its own list. Every living seat, every day,
         * is the sample that can answer whether 0.7 means 0.7.
         */
        if (options.calibrate) {
          const standing = rank(dawn);
          for (const suspect of standing) {
            const seat = playerBySlot(state, suspect.slot);
            if (!seat?.role) continue;
            options.calibrate({
              day: state.day,
              slot: suspect.slot,
              p: suspect.p,
              evil: isEvilRole(seat.role),
              reasons: suspect.against.length,
              codes: [...suspect.against, ...suspect.standing].map((reason) => reason.code)
            });
          }
        }
        for (const player of shuffledAlive()) {
          const decision = decideDay(
            player,
            brains.get(player.playerId)!,
            publicInfo(),
            teammatesOf(player.playerId),
            knownEvilFor(player.playerId),
            rng
          );
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
            const decision = decideDay(
              player,
              brains.get(player.playerId)!,
              publicInfo(),
              teammatesOf(player.playerId),
              knownEvilFor(player.playerId),
              rng
            );
            if (decision.voteSlot !== null) {
              castVote(state, player.playerId, decision.voteSlot, now);
            }
            if (decision.revealMayor) revealMayor(state, player.playerId, now);
            if (decision.callCourt) callCourt(state, player.playerId, now);
          }
        }
      }

      if (state.phase === 'day' && state.stage === 'discussion') {
        advance();
      }
      continue;
    }

    if (state.phase === 'day' && state.stage === 'defense') {
      const accused = state.trial ? state.players[state.trial.accusedId] : null;
      if (options.autopsy && accused?.role) pending = advocate(accused);
      if ((accused?.role === 'mayor' || accused?.role === 'marshall') && !accused.revealed) {
        revealMayor(state, accused.playerId, now);
      }

      /**
       * The accused answers, and the answer goes on the board.
       *
       * The bench used to skip this stage outright: the trial opened, nobody
       * said anything, and the ballots were cast against a record identical to
       * the one that had opened it. That made every measurement of the trial
       * meaningless — a defence could not help because there was no defence —
       * and it hid the fact that the live game had the same problem for the
       * opposite reason (bots spoke but filed nothing).
       *
       * Town claims its real role; everything else claims a plausible town role
       * it is not, which is what makes a bluff catchable: `suspicion` punishes a
       * claim that clashes with a living rival or with the graveyard, and
       * `defenceStrength` only rewards one that survives both.
       */
      if (accused?.role) {
        const brain = brains.get(accused.playerId);
        const info = publicInfo();
        const claimed = roleDef(accused.role).faction === 'town' ? accused.role : bluffFor(accused, info, rng);
        if (claimed && (brain?.personality.claimRate ?? 0) > 0.25) {
          claims.push({
            day: state.day,
            claimerSlot: accused.slot,
            targetSlot: accused.slot,
            kind: 'role-claim',
            claimedRole: claimed,
            truthful: claimed === accused.role
          });
        }
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
          castBallot(
            state,
            player.playerId,
            decideBallot(player, brains.get(player.playerId)!, info, accusedSlot, teammatesOf(player.playerId), rng)
          );
        }
      }
      advance();
      if (pending) {
        const verdict = pending;
        pending = null;
        options.autopsy?.({
          ...verdict,
          hanged: state.deaths.some(
            (death) =>
              death.phase === 'day' &&
              death.source === undefined &&
              state.players[death.playerId]?.slot === verdict.accusedSlot
          )
        });
      }
      continue;
    }

    if (state.phase === 'night') {
      // The day is over however it ended, with a trial or without one, so this
      // is the one place its ballots are certainly all in.
      recordVotes();
      const info = publicInfo();
      for (const player of shuffledAlive()) {
        const legal = legalNightAction(state, player.playerId);
        if (!legal) continue;
        const target = decideNightTarget(
          player,
          brains.get(player.playerId)!,
          info,
          // The orders already in tonight decide what is left worth aiming at:
          // the family's own knife and its own cellar must not meet. See
          // `unclashedTargets`.
          unclashedTargets(state, player.playerId, legal.type, legal.targets),
          legal.type,
          teammatesOf(player.playerId),
          familyIntelFor(player.playerId),
          rng
        );
        // A two-house power is submitted whole or not at all: the engine refuses a
        // control or a swap that names only one doorstep. The cellar's second
        // slot is optional and is the captive named again; see `executesCaptive`.
        const second =
          target === null
            ? null
            : needsSecondTarget(legal.type)
              ? decideSecondTarget(player, info, legal.type, target, legal.secondTargets ?? [], rng)
              : legal.type === 'kidnap' && (legal.secondTargets ?? []).includes(target)
                ? executesCaptive(player, brains.get(player.playerId)!, info, target, player.charges, rng)
                  ? target
                  : null
                : null;
        if (target !== null && (!needsSecondTarget(legal.type) || second !== null)) {
          setNightAction(state, player.playerId, target, second);
        }
        if (options.nightWatch && player.role) {
          const aimedAt = target === null ? null : players.find((seat) => seat.slot === target);
          options.nightWatch({
            night: state.day,
            slot: player.slot,
            role: player.role,
            action: legal.type,
            targetSlot: target,
            targetRole: aimedAt?.role ?? null,
            choices: legal.targets.length
          });
        }
        // What this seat will be able to say tomorrow if asked — and what the
        // record can catch it out on if it says otherwise.
        const brain = brains.get(player.playerId)!;
        brain.wentTo = target !== null && target !== player.slot && legal.targets.length > 0 ? target : null;
      }
      advance();
      continue;
    }

    advance();
  }

  /**
   * What the record held against the accused, read from the jury box.
   *
   * Per juror rather than from a neutral observer, because `suspicionParts`
   * answers "how suspicious is that one, *to this one*" — the intel is private
   * and the temperament is personal, so a public-observer reading would
   * describe a seat nobody at the table was.
   */
  function advocate(accused: MafiaPlayer): Omit<TrialAutopsy, 'hanged'> {
    const info = publicInfo();
    const jurors = players.filter((player) => player.alive && player.slot !== accused.slot);
    const readings = jurors.map((juror) => suspicionParts(accused.slot, juror, info, rng));
    const accusations = info.claims.filter((claim) => claim.kind === 'accuse' && claim.targetSlot === accused.slot);
    const first = accusations[0] ?? null;
    const firstSeat = first ? playerBySlot(state, first.claimerSlot) : null;

    return {
      day: state.day,
      accusedSlot: accused.slot,
      accusedRole: accused.role!,
      accusedEvil: isEvilRole(accused.role!),
      evidence: readings.reduce((sum, parts) => sum + parts.evidence, 0) / Math.max(1, readings.length),
      hardMax: readings.reduce((most, parts) => Math.max(most, parts.hard), 0),
      hardHolders: readings.filter((parts) => parts.hard > 0).length,
      wagon: [...info.votes.values()].filter((voted) => voted === accused.slot).length,
      firstAccuser: first?.claimerSlot ?? null,
      firstAccuserDay: first?.day ?? null,
      firstAccuserEvil: firstSeat?.role ? isEvilRole(firstSeat.role) : false,
      accusers: new Set(accusations.map((claim) => claim.claimerSlot)).size,
      pressure: parityPressure(info),
      caught: deductions(accused.slot, info).map((finding) => finding.kind)
    };
  }

  return tally(state, options, claims, voteHistory);
}

function tally(
  state: MafiaState,
  options: SimOptions,
  claims: Claim[],
  voteHistory: { day: number; voterSlot: number; targetSlot: number }[]
): SimResult {
  const players = Object.values(state.players);

  /**
   * Every outcome this bench reports, read off `WinKind`.
   *
   * It used to match the winners' French prose — including
   * `reason.includes('survécu')`, which the *lovers'* line also contains, so a
   * table with a Lover pair and no Survivor scored a survivor win and the
   * printed survivor rate could pass 100%. Same principle the death record
   * already follows two blocks down: read the record, not the sentence.
   */
  const won = new Set(state.winners.map((winner) => winner.kind));

  const winner: SimResult['winner'] = won.has('town')
    ? 'town'
    : won.has('mafia')
      ? 'mafia'
      : won.has('triad')
        ? 'triad'
        : won.has('cult')
          ? 'cult'
          : won.has('solo-killer')
            ? 'solo'
            : /**
               * A win nobody else's condition covers, and it is not a draw.
               *
               * The seats that live off the town's failure carry the game when they are the last thing standing —
               * a Witch alone with somebody whose hand she has been holding every night has won, and reporting that
               * as "nobody won" hides both the result and the fact that the rule fired at all.
               */
              won.has('parasite')
              ? 'witch'
              : 'draw';

  // A lynching is a daytime death with no killer behind it; an execution is the
  // jailor's. Both read off the record rather than off the sentence.
  const lynched = state.deaths.filter((death) => death.phase === 'day' && death.source === undefined);
  const executed = state.deaths.filter((death) => death.source === 'jailor');
  const rolePresent = (role: RoleId) => players.some((player) => player.role === role);

  return {
    seed: options.seed,
    players: options.players,
    days: state.day,
    winner,
    jesterWin: won.has('jester'),
    jesterPresent: rolePresent('jester'),
    exeWin: won.has('executioner'),
    exePresent: players.some((player) => player.obsessionSlotHint != null) || rolePresent('executioner'),
    survivorWin: won.has('survivor'),
    survivorPresent: rolePresent('survivor'),
    lynches: lynched.length,
    evilLynches: lynched.filter((death) => isEvilRole(death.role)).length,
    jesterLynches: lynched.filter((death) => death.role === 'jester').length,
    remorseDeaths: state.deaths.filter((death) => death.source === 'remorse').length,
    townLynches: lynched.filter((death) => roleDef(death.role).faction === 'town').length,
    nightDeaths: state.deaths.filter((death) => death.phase === 'night').length,
    vigMisfires: state.deaths.filter((death) => death.source === 'vigilante' && roleDef(death.role).faction === 'town')
      .length,
    saves: state.points.filter((entry) => entry.reason === 'save').length,
    executions: executed.length,
    wrongExecutions: executed.filter((death) => !isEvilRole(death.role)).length,
    cellarKills: state.deaths.filter((death) => death.source === 'kidnapper').length,
    jailorPresent: rolePresent('jailor'),
    keeperPresent: rolePresent('kidnapper') || rolePresent('interrogator'),
    claimsTrue: claims.filter((claim) => claim.truthful).length,
    claimsFalse: claims.filter((claim) => !claim.truthful).length,
    finalAlive: players.filter((player) => player.alive).map((player) => player.role!),
    ...(state.drawReason ? { drawReason: state.drawReason } : {}),
    aliveAtEnd: players.filter((player) => player.alive).map((player) => ({ slot: player.slot, role: player.role! })),
    human: humanReport(players, claims, voteHistory)
  };
}

/** What the square did with the people at it. See `SimResult.human`. */
function humanReport(
  players: MafiaPlayer[],
  claims: Claim[],
  voteHistory: { day: number; voterSlot: number; targetSlot: number }[]
): SimResult['human'] {
  const people = new Set(players.filter((player) => !player.isBot).map((player) => player.slot));
  const report = {
    seats: people.size,
    survived: players.filter((player) => !player.isBot && player.alive).length,
    asked: 0,
    answered: 0,
    questioned: 0,
    accusations: 0,
    followed: 0,
    votesAgainst: 0,
    votesTotal: voteHistory.length,
    botAsked: 0,
    botAnswered: 0,
    botAccusations: 0,
    botFollowed: 0
  };

  for (const entry of voteHistory) if (people.has(entry.targetSlot)) report.votesAgainst++;

  /**
   * Answered, meaning the seat that was asked gave an account that day or the
   * next. Not "said something": the question asks where you were, and a reply
   * about somebody else is the square changing the subject, which is the thing
   * a person notices and resents.
   */
  const replied = (claim: Claim): boolean =>
    claims.some(
      (other) =>
        other.kind === 'account' &&
        other.claimerSlot === claim.targetSlot &&
        other.day >= claim.day &&
        other.day <= claim.day + 1
    );

  /** Somebody other than the accuser put a vote on that house by the bell. */
  const moved = (claim: Claim): boolean =>
    voteHistory.some(
      (entry) =>
        entry.day === claim.day && entry.targetSlot === claim.targetSlot && entry.voterSlot !== claim.claimerSlot
    );

  for (const claim of claims) {
    const fromPerson = people.has(claim.claimerSlot);

    if (claim.kind === 'question') {
      if (people.has(claim.targetSlot)) {
        if (!fromPerson) report.questioned++;
        continue;
      }
      if (fromPerson) {
        report.asked++;
        if (replied(claim)) report.answered++;
      } else {
        report.botAsked++;
        if (replied(claim)) report.botAnswered++;
      }
      continue;
    }

    if (claim.kind === 'accuse') {
      if (fromPerson) {
        report.accusations++;
        if (moved(claim)) report.followed++;
      } else {
        report.botAccusations++;
        if (moved(claim)) report.botFollowed++;
      }
    }
  }

  return report;
}
