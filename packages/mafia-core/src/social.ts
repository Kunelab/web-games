import { familyOf, isSoloKiller, roleDef, type RoleId } from './roles.js';

/**
 * How a seat *feels* about its position, and what that makes it do.
 *
 * The rest of the engine is about what is legal; this file is about what is
 * tempting. It exists because both brains need the same answer: the scripted
 * policies read these numbers directly, and the LLM driver turns them into the
 * sentence that tells a model who it is being tonight. Keeping the model here —
 * pure, deterministic, no state of its own — is what stops the two from drifting
 * into two different games.
 *
 * Nothing in here reads a hidden role. Every input is either the seat's own
 * secret (which it is entitled to) or something the whole square can see.
 */

/* -------------------------------- agendas -------------------------------- */

/**
 * What a seat is actually trying to do, which is not the same as its faction.
 *
 * A Witch and a Scumbag are both "neutral" and want opposite things from the
 * evening; a Survivor and a Jester are both "neutral" and want opposite things
 * from their own throat. Faction is for victory checks. This is for behaviour.
 */
export type Agenda =
  /** Wants the killers found. Truth is a weapon it can actually use. */
  | 'town'
  /** Mafia, Triade, Secte: wants to be the last bloc standing. */
  | 'family'
  /** Serial killer, arsonist, poisoner, mass murderer, electromaniac. */
  | 'butcher'
  /** Wants to be hanged, and must be *believed* to be worth hanging. */
  | 'jester'
  /** Wants one specific head, and does not care whose side it was on. */
  | 'executioner'
  /** Wins if the town fails: witch, scumbag, auditor, judge. Feeds on chaos. */
  | 'parasite'
  /** Wins by still breathing, or alongside whoever wins: survivor, amnesiac, lover. */
  | 'passenger';

export function agendaOf(role: RoleId): Agenda {
  if (role === 'jester') return 'jester';
  if (role === 'executioner') return 'executioner';
  if (familyOf(role) !== null) return 'family';
  if (isSoloKiller(role)) return 'butcher';
  if (roleDef(role).faction === 'town') return 'town';
  if (role === 'witch' || role === 'scumbag' || role === 'auditor' || role === 'judge') return 'parasite';
  return 'passenger';
}

/** Agendas that would rather the town won, or do not mind if it does. */
export function ridesWithTown(agenda: Agenda): boolean {
  return agenda === 'town' || agenda === 'passenger';
}

/* ------------------------------ desperation ------------------------------ */

/**
 * Everything that can make a seat sweat, gathered per decision round.
 *
 * All of it is legitimately knowable by the seat itself: the votes on the board,
 * whether it is at the barre, whether somebody has said its real role out loud,
 * whether something came to its door last night, and the arithmetic of who is
 * left. Nobody peeks.
 */
export interface Pressure {
  day: number;
  /** Living seats, so a wagon of three means different things at 5 and at 20. */
  aliveCount: number;
  /** Accusations currently pointed at me. */
  votesAgainstMe: number;
  onTrial: boolean;
  /** Somebody named my actual role in public — the mask is off. */
  roleOuted: boolean;
  /** Something came to my house last night: an attack, a block, a visit. */
  targetedLastNight: boolean;
  /**
   * How close the people I need to lose are to winning, 0..1.
   *
   * For the town this is the parity clock. For a family it is the town closing
   * out the board. For a butcher it is either. Supplied by the caller because
   * only the caller knows which way round the seat is facing.
   */
  losingClock: number;
}

/** Nobody is desperate before the first night. */
export const CALM = 0;

/**
 * How fast yesterday's panic fades. Kept low: a seat that was nearly hanged on
 * Tuesday does not wake up on Wednesday feeling fine, but it does stop
 * screaming.
 */
const EASE = 0.72;

/**
 * The desperation meter, advanced one round.
 *
 * Two halves, deliberately. The *structural* half is `losingClock` — a floor
 * the meter cannot ease below, because the board being lost is not a mood that
 * passes. The *personal* half is spikes: the rope, the wagon, an outed role, a
 * visitor in the night. Spikes decay, the floor does not.
 *
 * The consequence worth knowing when reading the policies: a seat can be calm
 * while losing badly (early, nothing pointed at it) and frantic while winning
 * (three votes on its head), and those two produce very different play. That is
 * the point — panic is local, and local panic is what makes a table talk.
 */
export function advanceDesperation(previous: number, pressure: Pressure): number {
  if (pressure.day <= 0) return CALM;

  // The wagon, measured against how many votes it actually takes to hang.
  const needed = Math.max(2, Math.floor(pressure.aliveCount / 2) + 1);
  const wagon = Math.min(1, pressure.votesAgainstMe / needed);

  const spike =
    (pressure.onTrial ? 0.4 : 0) +
    wagon * 0.35 +
    (pressure.roleOuted ? 0.25 : 0) +
    (pressure.targetedLastNight ? 0.12 : 0);

  const floor = Math.min(1, Math.max(0, pressure.losingClock));
  const eased = Math.max(floor, previous * EASE);
  return Math.min(1, Math.max(floor, eased + spike));
}

/* --------------------------------- stance -------------------------------- */

/**
 * The behaviour dial for one seat, one round. Every field is 0..1 and reads as
 * "how much do I want to do this right now".
 *
 * These are *appetites*, not permissions. A stance saying `fakeClaim: 0.9` still
 * goes through the same engine validation as everything else; all it changes is
 * what the brain reaches for first.
 */
export interface Stance {
  /** Ask people to account for their night. The engine of a real day phase. */
  seekInfo: number;
  /** Answer honestly when asked. Low means dodge, deflect or invent. */
  answerHonestly: number;
  /** Point at somebody I have no reason to suspect. */
  falseAccuse: number;
  /** Wear a role I do not have. */
  fakeClaim: number;
  /**
   * The two jester gambits, which point in opposite directions.
   *
   * A real Jester wants to be *disbelieved*: he claims something big and
   * checkable so the town concludes he is lying and reaches for the rope. A
   * villain wants to be *believed* to be a jester, because hanging a jester
   * hands him the game — so "I'm the Bouffon, go on, hang me" is the safest
   * thing a cornered mafioso can say.
   */
  jesterGambit: number;
  /** Needle somebody for the sport of it. Noise that muddies the record. */
  troll: number;
  /** Vote with the town on things I actually agree about, to be trusted later. */
  buildTrust: number;
  /** Let an ally hang — or push them — to buy standing with the room. */
  sacrificeAlly: number;
  /** Force the tempo: lynch somebody today, end this. */
  pushHard: number;
}

const ZERO: Stance = {
  seekInfo: 0,
  answerHonestly: 1,
  falseAccuse: 0,
  fakeClaim: 0,
  jesterGambit: 0,
  troll: 0,
  buildTrust: 0,
  sacrificeAlly: 0,
  pushHard: 0
};

/** Traits the caller already has; only the two that shape social play are read. */
export interface StanceTraits {
  /** Willingness to lie at all. */
  deceit: number;
  /** Willingness to act on thin evidence. */
  aggression: number;
}

/**
 * What a seat wants to do, given who it is and how cornered it feels.
 *
 * The shape of each agenda is the interesting part:
 *
 * - **Town** seeks information hardest and lies least — but not never. A townie
 *   with a wagon on them will absolutely claim a role they do not have to get
 *   through the afternoon, and pretending otherwise made the simulated town
 *   read like a committee of saints.
 * - **Family** wants to be *liked*: it votes with the room on things it agrees
 *   about, because credibility spent on day five is earned on day two. Cornered,
 *   it reaches for a mask — and past a certain point it will feed the room one
 *   of its own, which buys more trust than any claim ever will.
 * - **Butchers** have no allies to trade and no bloc to protect, so they lean on
 *   noise: false accusations, trolling, and a claimed role nobody can check.
 * - **Jester** is the mirror of everyone else: he *wants* the wagon, so his
 *   desperation runs backwards. Calm, he clowns; ignored, he escalates until
 *   somebody takes the bait.
 * - **Parasites** feed on a town that fails, so they push hard and rarely help.
 * - **Passengers** cooperate almost always — being useful is how you are not
 *   the one people reach for — and only reach for a mask when truly cornered.
 */
export function stanceOf(agenda: Agenda, desperation: number, traits: StanceTraits): Stance {
  const d = Math.min(1, Math.max(0, desperation));
  const lie = traits.deceit;
  const push = traits.aggression;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));

  switch (agenda) {
    case 'town':
      return {
        ...ZERO,
        seekInfo: clamp(0.55 + push * 0.3),
        // Cornered townies lie about their night to get off the wagon.
        answerHonestly: clamp(1 - d * 0.55),
        falseAccuse: clamp(d * 0.25 * push),
        fakeClaim: clamp(d * d * 0.5 * lie),
        troll: clamp(0.06 + push * 0.06),
        buildTrust: 0.4,
        pushHard: clamp(0.2 + d * 0.7)
      };

    case 'family':
      return {
        ...ZERO,
        seekInfo: clamp(0.4 + push * 0.2),
        answerHonestly: clamp(0.55 - d * 0.45),
        falseAccuse: clamp((0.2 + d * 0.55) * lie),
        fakeClaim: clamp((0.15 + d * 0.6) * lie),
        // Only worth it once the rope is genuinely close.
        jesterGambit: clamp((d - 0.6) * 2 * lie),
        troll: clamp(0.1 + lie * 0.15),
        // The long game: be agreeable early so the late lie lands.
        buildTrust: clamp(0.55 - d * 0.25),
        // Feeding the room a brother, when the alternative is being fed to it.
        sacrificeAlly: clamp((d - 0.5) * 1.6),
        pushHard: clamp(0.15 + d * 0.5)
      };

    case 'butcher':
      return {
        ...ZERO,
        seekInfo: clamp(0.3 + push * 0.2),
        answerHonestly: clamp(0.45 - d * 0.4),
        falseAccuse: clamp((0.3 + d * 0.5) * lie),
        fakeClaim: clamp((0.25 + d * 0.55) * lie),
        jesterGambit: clamp((d - 0.65) * 2 * lie),
        troll: clamp(0.2 + lie * 0.2),
        buildTrust: clamp(0.3 - d * 0.2),
        pushHard: clamp(0.25 + d * 0.55)
      };

    case 'jester':
      /**
       * Backwards on purpose. Every other seat calms down when nobody is
       * looking at it; the Jester panics. `desperation` for him is *attention*,
       * so a high meter means the plan is working and he can stop shouting.
       */
      return {
        ...ZERO,
        seekInfo: 0.3,
        answerHonestly: clamp(0.3 - d * 0.2),
        // Contradicting himself is the product, not a bug.
        falseAccuse: clamp(0.55 + (1 - d) * 0.35),
        fakeClaim: clamp(0.5 + (1 - d) * 0.4),
        jesterGambit: clamp(0.4 + (1 - d) * 0.5),
        troll: clamp(0.6 + (1 - d) * 0.3),
        buildTrust: 0.05,
        pushHard: clamp(0.3 + (1 - d) * 0.4)
      };

    case 'executioner':
      return {
        ...ZERO,
        seekInfo: 0.35,
        answerHonestly: clamp(0.7 - d * 0.4),
        falseAccuse: clamp(0.45 + d * 0.4),
        fakeClaim: clamp(d * 0.5 * lie),
        troll: clamp(0.15 + lie * 0.1),
        buildTrust: 0.35,
        pushHard: clamp(0.5 + d * 0.4)
      };

    case 'parasite':
      return {
        ...ZERO,
        seekInfo: 0.3,
        answerHonestly: clamp(0.5 - d * 0.4),
        falseAccuse: clamp((0.25 + d * 0.45) * lie),
        fakeClaim: clamp((0.2 + d * 0.5) * lie),
        jesterGambit: clamp((d - 0.7) * 2 * lie),
        troll: clamp(0.25 + lie * 0.2),
        buildTrust: clamp(0.2 - d * 0.15),
        pushHard: clamp(0.35 + d * 0.5)
      };

    case 'passenger':
    default:
      return {
        ...ZERO,
        seekInfo: clamp(0.45 + push * 0.2),
        answerHonestly: clamp(0.9 - d * 0.5),
        falseAccuse: clamp(d * 0.3 * lie),
        // The one thing a survivor will lie about is being worth killing.
        fakeClaim: clamp((d - 0.45) * 1.6 * lie),
        jesterGambit: clamp((d - 0.75) * 2 * lie),
        troll: clamp(0.1 + lie * 0.1),
        buildTrust: 0.7,
        pushHard: clamp(0.15 + d * 0.4)
      };
  }
}

/* ------------------------------- the masks ------------------------------- */

/**
 * Roles worth hiding behind, and why each list is what it is.
 *
 * `QUIET` are the faces nobody bothers to check — the point is to be boring.
 * `SCARY` are the faces that buy you a night: claiming Veteran says "visit me
 * and die", claiming Jailor says "I can execute you". They cost daylight
 * scrutiny to buy nighttime safety.
 * `BAIT` is the Jester's inverted list: big, unique, checkable claims that a
 * town will call a lie — which is exactly the reaction he is paying for.
 */
export const MASKS: { quiet: RoleId[]; scary: RoleId[]; bait: RoleId[] } = {
  quiet: ['citizen', 'escort', 'lookout', 'crier', 'coroner'],
  scary: ['veteran', 'survivor', 'jailor', 'bodyguard'],
  bait: ['veteran', 'jailor', 'mayor', 'sheriff']
};

/**
 * Which mask to reach for, or null to stay bare-faced.
 *
 * The order matters. A cornered villain claims *jester* first when the stance
 * says so, because it is the only claim that makes hanging you a mistake. Then
 * a scary face, to survive the night. Then a boring one, to survive the day.
 */
export function pickMask(
  agenda: Agenda,
  stance: Stance,
  roll: () => number,
  /** Faces already taken or already in the ground; claiming these is suicide. */
  burned: ReadonlySet<RoleId> = new Set()
): RoleId | null {
  const free = (list: RoleId[]) => list.filter((role) => !burned.has(role));
  const pick = (list: RoleId[]) => {
    const pool = free(list);
    return pool.length > 0 ? (pool[Math.floor(roll() * pool.length)] ?? null) : null;
  };

  if (agenda === 'jester') {
    // He is not hiding. He is auditioning for the rope.
    return roll() < stance.jesterGambit ? pick(MASKS.bait) : null;
  }

  if (stance.jesterGambit > 0 && roll() < stance.jesterGambit) {
    // "Hang me and you lose." The best sentence in a cornered villain's mouth.
    return burned.has('jester') ? pick(MASKS.quiet) : 'jester';
  }
  if (roll() < stance.fakeClaim * 0.45) return pick(MASKS.scary);
  if (roll() < stance.fakeClaim) return pick(MASKS.quiet);
  return null;
}
