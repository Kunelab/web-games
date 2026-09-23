import { roleDef, staysHome, type RoleId } from '../roles.js';
import { playerBySlot, playerFamily, type MafiaPlayer, type MafiaState, type NightOutcome } from '../state.js';
import { deductions } from './deduce.js';
import {
  grounded,
  isEvilRole,
  NO_CASE_CEILING,
  sheriffSuspects,
  steadyVote,
  suspicionParts,
  type Claim,
  type DayDecision,
  type Personality,
  type PublicInfo
} from './policies.js';
import { add, type Tally } from './report.js';

/**
 * The bench's second scoreboard, filled in as the game is played.
 *
 * Win rates say which side won. They do not say whether the Jailor ever jailed
 * anybody, whether the Vigilante shot killers or neighbours, or whether a player
 * watching the ballots could have listed the family by day three. This records
 * those three kinds of thing:
 *
 *  - **What each role did with its power**, night by night: used or not, on
 *    whom, and what came of it. Keyed by the role the seat was dealt.
 *  - **Tells**: patterns a person at the table could act on. Each is a rule a
 *    watcher might apply ("whoever votes guilty on a thin trial is evil"), and
 *    the report prints how often it fires and how often it is right, against
 *    the base rate of the same situation. A rule that is right far more often
 *    than the base rate is an exploit.
 *  - **Faults**: things a bot should never do at all (deny its own teammate,
 *    name its own victim), counted per game.
 *
 * Measurement only. Nothing here draws from the game's dice, so a run with the
 * probe plays exactly the games a run without it plays. Every suspicion reading
 * is taken from a neutral observer holding no private intel, which is the view
 * a watching person has.
 */

/** A seat with no private knowledge: what the square as a whole can see. */
const OBSERVER = {
  playerId: '__observer__',
  slot: -1,
  role: 'citizen',
  intel: [],
  alive: true,
  isBot: true
} as unknown as MafiaPlayer;

/** Readings must never touch the game's dice. */
const STILL = (): number => 0;

/** What the square can point to against a seat right now. */
export function publicHard(slot: number, info: PublicInfo): number {
  return suspicionParts(slot, OBSERVER, info, STILL).hard;
}

type Side = 'evil' | 'town' | 'neutral';

function sideOf(role: RoleId): Side {
  if (isEvilRole(role)) return 'evil';
  return roleDef(role).faction === 'town' ? 'town' : 'neutral';
}

/** Town roles whose night is worth something to the town. */
function townPower(role: RoleId): boolean {
  const def = roleDef(role);
  return def.faction === 'town' && def.nightAction !== null && def.nightAction !== undefined;
}

/** A night choice, as the simulator hands it over. */
export interface ProbeChoice {
  slot: number;
  role: RoleId;
  action: string;
  targetSlot: number | null;
  /** Every house the seat could have chosen, for the chance baseline. */
  legal: readonly number[];
}

/** The two halves of a trait, for asking whether the trait shows. */
const band = (value: number, middle: number): 'bas' | 'haut' => (value < middle ? 'bas' : 'haut');

export class Probe {
  readonly tally: Tally = {};
  /** The role each seat was dealt, which is what the per-role table is keyed by. */
  private readonly dealt = new Map<string, RoleId>();
  /** First landing of each voter on each target, per day. */
  private readonly landed = new Set<string>();
  /** The trial on the stand: its accused and how thin the public case was. */
  private trial: { slot: number; hard: number } | null = null;
  /** Seats the room tried and let go, by day. */
  private readonly acquitted = new Map<number, Set<number>>();
  /** Seats that answered "where were you" with a visit, by the day they said it. */
  private readonly visitedAnswer = new Map<number, number>();
  /** Family clears of a brother, settled at the end against the gallows. */
  private readonly brotherClears: { day: number; clearer: number; brother: number }[] = [];

  /** The ballots of the trial on the stand, for its margin. */
  private ballots = { guilty: 0, innocent: 0, abstain: 0 };

  constructor(
    private readonly state: MafiaState,
    private readonly board: () => PublicInfo,
    /** Each seat's personality, for the temperament table. */
    private readonly personalityOf: (slot: number) => Personality | undefined = () => undefined
  ) {}

  private isTown(slot: number): boolean {
    const role = this.roleAt(slot);
    return role !== null && roleDef(role).faction === 'town';
  }

  private roleAt(slot: number): RoleId | null {
    return playerBySlot(this.state, slot)?.role ?? null;
  }

  private evilAt(slot: number): boolean {
    const role = this.roleAt(slot);
    return role !== null && isEvilRole(role);
  }

  private familyAt(slot: number): string | null {
    const seat = playerBySlot(this.state, slot);
    return seat ? playerFamily(seat) : null;
  }

  private dealtAt(slot: number): RoleId | null {
    const seat = playerBySlot(this.state, slot);
    return seat ? (this.dealt.get(seat.playerId) ?? seat.role) : null;
  }

  /** One observation of a tell: the situation arose, and whether the rule fired. */
  private tell(code: string, actorSlot: number, fired: boolean): void {
    const evil = this.evilAt(actorSlot);
    add(this.tally, `tell:${code}:pool`);
    if (evil) add(this.tally, `tell:${code}:poolEvil`);
    if (!fired) return;
    add(this.tally, `tell:${code}:fires`);
    if (evil) add(this.tally, `tell:${code}:evil`);
  }

  private fault(code: string): void {
    add(this.tally, `fault:${code}`);
  }

  private role(dealt: RoleId | null, metric: string, by = 1): void {
    if (dealt) add(this.tally, `r:${dealt}:${metric}`, by);
  }

  start(): void {
    add(this.tally, 'games');
    for (const player of Object.values(this.state.players)) {
      if (!player.role) continue;
      this.dealt.set(player.playerId, player.role);
      this.role(player.role, 'seats');
    }
  }

  /* --------------------------------- day --------------------------------- */

  /**
   * Everything one seat decided to say at dawn, with the decision it came from.
   *
   * Called with the board as it stood when the seat spoke, before its own
   * claims were added, which is the board a listener would have read it against.
   */
  spoke(player: MafiaPlayer, decision: DayDecision, info: PublicInfo): void {
    const slot = player.slot;
    const family = playerFamily(player);

    for (const claim of decision.publishes) {
      if (claim.kind === 'account') this.account(player, claim, info);

      if (claim.kind === 'accuse' && claim.claimerSlot === slot && claim.targetSlot !== slot) {
        this.tell('accuse-sans-raison', slot, !grounded(claim, info));

        // A cold board: nobody has a vote or an accusation on them yet.
        if (family !== null && !grounded(claim, info)) {
          const strangers = info.aliveSlots.filter((seat) => seat !== slot && this.familyAt(seat) !== family);
          const heat = (seat: number): number =>
            [...info.votes.values()].filter((target) => target === seat).length +
            info.claims.filter((other) => other.kind === 'accuse' && other.targetSlot === seat).length;
          if (strangers.length > 1 && strangers.every((seat) => heat(seat) === 0)) {
            const first = Math.min(...strangers);
            add(this.tally, 'cold:accusations');
            add(this.tally, 'cold:expected', 1 / strangers.length);
            if (claim.targetSlot === first) add(this.tally, 'cold:firstSeat');
          }
        }

        const sameFamily = family !== null && this.familyAt(claim.targetSlot) === family;
        const danger =
          [...info.votes.values()].filter((target) => target === claim.targetSlot).length >= 2 ||
          info.trialSlot === claim.targetSlot;
        if (sameFamily && !danger) this.fault('accuse-un-frere-hors-danger');
      }

      if (claim.kind === 'counter-claim' && family !== null && this.familyAt(claim.targetSlot) === family) {
        this.fault('conteste-le-badge-d-un-frere');
      }

      if (claim.kind === 'clear' && family !== null && this.familyAt(claim.targetSlot) === family) {
        this.brotherClears.push({ day: info.day, clearer: slot, brother: claim.targetSlot });
      }

      // Standing up for a seat the room is about to try.
      if (claim.kind === 'clear' && claim.targetSlot !== slot) {
        const heat = [...info.votes.values()].filter((target) => target === claim.targetSlot).length;
        if (heat >= 2 || info.trialSlot === claim.targetSlot) this.tell('blanchit-un-siege-sous-un-chariot', slot, true);
        else this.tell('blanchit-un-siege-sous-un-chariot', slot, false);
      }

      if (claim.kind === 'urge') {
        if (claim.urge === 'skip') {
          const caseStands = info.aliveSlots.some((seat) => seat !== slot && publicHard(seat, info) >= NO_CASE_CEILING);
          this.tell('passer-malgre-un-dossier', slot, caseStands);
        } else {
          /**
           * "We have to vote", from a seat whose own ballot would then skip.
           *
           * `steadyVote` is the live table's ballot layer. The bench does not use
           * it to cast votes, so it is asked here what it would have done with
           * this seat's own proposal.
           */
          const allies = new Set([...this.allySlots(player)]);
          const ballot = steadyVote(player, info, null, decision.voteSlot, allies, STILL);
          add(this.tally, 'urge:vote');
          if (ballot.skip) add(this.tally, 'urge:voteThenSkip');
        }
      }

      if (claim.kind === 'promise') {
        add(this.tally, `promise:${this.evilAt(slot) ? 'evil' : 'town'}`);
      }
    }

  }

  /** A keeper took somebody for the night. */
  jailed(keeper: MafiaPlayer, slot: number): void {
    this.role(this.dealtAt(keeper.slot), 'jailed');
    if (this.evilAt(slot)) this.role(this.dealtAt(keeper.slot), 'jailedEvil');
  }

  private allySlots(player: MafiaPlayer): number[] {
    const family = playerFamily(player);
    if (family === null) return [];
    return Object.values(this.state.players)
      .filter((other) => other.playerId !== player.playerId && playerFamily(other) === family)
      .map((other) => other.slot);
  }

  /** "Where were you?" answered. See the faults and tells it feeds. */
  private account(player: MafiaPlayer, claim: Claim, info: PublicInfo): void {
    const slot = player.slot;
    if (claim.account === 'visited') {
      const died = info.lastNightDeathSlots.has(claim.targetSlot);
      this.tell('avoue-une-visite-chez-le-mort', slot, died);
      if (died && this.evilAt(slot)) this.fault('un-mal-nomme-la-maison-du-mort');
      this.visitedAnswer.set(slot, info.day);
      const role = this.roleAt(slot);
      add(this.tally, 'scan:visited');
      if (role && roleDef(role).nightAction) add(this.tally, 'scan:visitedHasPower');
    }

    // Against the badge the seat is wearing: a homebody that went out, a visitor that stayed in.
    const badge = info.claims
      .filter((other) => other.kind === 'role-claim' && other.claimerSlot === slot && other.claimedRole)
      .map((other) => other.claimedRole as RoleId)
      .pop();
    if (badge && badge !== player.role) {
      const visits = roleDef(badge).nightAction !== null && roleDef(badge).nightAction !== undefined && !staysHome(badge);
      const clash = claim.account === 'visited' ? staysHome(badge) : visits;
      add(this.tally, 'mask:accounts');
      if (clash) this.fault('recit-contraire-a-son-masque');
    }
  }

  /** A ballot placed on the square. Only the first landing of a voter on a target counts. */
  voted(player: MafiaPlayer, target: number, info: PublicInfo): void {
    const key = `${info.day}:${player.slot}:${target}`;
    if (this.landed.has(key)) return;
    this.landed.add(key);
    this.tell('vote-sans-preuve', player.slot, publicHard(target, info) <= 0);

    const family = playerFamily(player);
    if (family !== null && this.familyAt(target) === family) {
      add(this.tally, 'bus:votes');
      const opened = this.state.trial !== null && playerBySlot(this.state, target)?.playerId === this.state.trial.accusedId;
      if (opened) add(this.tally, 'bus:hammer');
    }
  }

  trialOpened(accusedSlot: number, info: PublicInfo): void {
    this.trial = { slot: accusedSlot, hard: publicHard(accusedSlot, info) };
    this.ballots = { guilty: 0, innocent: 0, abstain: 0 };
    add(this.tally, 'trials');
    add(this.tally, `trials:${this.evilAt(accusedSlot) ? 'evil' : 'other'}`);
    if (this.trial.hard < 1) add(this.tally, 'trials:thin');
  }

  ballot(player: MafiaPlayer, verdict: 'guilty' | 'innocent' | 'abstain'): void {
    if (!this.trial) return;
    if (this.trial.hard < 1) this.tell('coupable-sur-proces-mince', player.slot, verdict === 'guilty');
    else this.tell('epargne-un-proces-solide', player.slot, verdict !== 'guilty');
    this.ballots[verdict] += 1;

    // Does a follower's temperament show in the booth? Town bots only, on thin cases where it should.
    const personality = this.personalityOf(player.slot);
    if (personality && player.isBot && this.isTown(player.slot) && this.trial.hard < 1) {
      const herd = band(personality.herd, 0.5);
      add(this.tally, `pers:herd:${herd}:thin`);
      if (verdict === 'guilty') add(this.tally, `pers:herd:${herd}:thinGuilty`);
    }
  }

  trialClosed(day: number, hanged: boolean): void {
    if (!this.trial) return;
    if (hanged) add(this.tally, `trials:${this.evilAt(this.trial.slot) ? 'evil' : 'other'}Hanged`);

    /**
     * How the room split. A jury of people rarely votes as one on a case with
     * nothing in it; a jury of one policy read twenty times does.
     */
    const cast = this.ballots.guilty + this.ballots.innocent;
    const share = cast > 0 ? this.ballots.guilty / cast : 0;
    const shape = !hanged ? 'acquitte' : share >= 0.999 ? 'unanime' : share >= 0.9 ? 'ecrasant' : 'partage';
    const scope = this.trial.hard < 1 ? 'mince' : 'solide';
    add(this.tally, `jury:${scope}:trials`);
    add(this.tally, `jury:${scope}:${shape}`);
    if (hanged && this.isTown(this.trial.slot)) add(this.tally, `jury:${scope}:townHanged`);
    if (!hanged) {
      const set = this.acquitted.get(day) ?? new Set<number>();
      set.add(this.trial.slot);
      this.acquitted.set(day, set);
    }
    this.trial = null;
  }

  revealed(player: MafiaPlayer, day: number): void {
    this.role(this.dealtAt(player.slot), 'revealed');
    this.role(this.dealtAt(player.slot), 'revealDay', day);
  }

  /* -------------------------------- night -------------------------------- */

  /**
   * One night, after it has resolved.
   *
   * `orders` is what every seat submitted, read before the engine cleared it;
   * `log` is every attack and what stopped it; `dead` is who the morning found.
   */
  night(
    night: number,
    choices: ProbeChoice[],
    orders: Map<number, { type: string; target: number | null }>,
    log: readonly NightOutcome[],
    before: PublicInfo
  ): void {
    for (const choice of choices) {
      const dealt = this.dealtAt(choice.slot);
      this.role(dealt, 'nights');
      if (choice.targetSlot === null) continue;
      this.role(dealt, 'acted');
      if (choice.targetSlot === choice.slot) {
        this.role(dealt, 'self');
      } else {
        const target = this.roleAt(choice.targetSlot);
        if (target) this.role(dealt, `on:${sideOf(target)}`);
        /**
         * What a blindfolded seat would have hit: the share of killers among the
         * houses it could legally have chosen. A power that aims no better than
         * this is not reading the board.
         */
        const pool = choice.legal.filter((slot) => slot !== choice.slot);
        if (pool.length > 0) {
          this.role(dealt, 'chance', pool.filter((slot) => this.evilAt(slot)).length / pool.length);
          this.role(dealt, 'chanceN');
        }
      }

      const target = choice.targetSlot;
      const targetRole = this.roleAt(target);

      if (choice.action === 'block' || choice.action === 'kidnap' || choice.action === 'silence') {
        const order = orders.get(target);
        if (order && (order.type === 'kill' || order.type === 'poison' || order.type === 'rampage')) {
          this.role(dealt, 'blockedKiller');
        }
        if (targetRole && townPower(targetRole)) this.role(dealt, 'blockedTownPower');
      }

      if (choice.action === 'heal' || choice.action === 'guard') {
        const saved = log.some(
          (outcome) =>
            outcome.targetSlot === target &&
            ((choice.action === 'heal' && outcome.outcome === 'healed') ||
              (choice.action === 'guard' && outcome.outcome === 'guarded'))
        );
        if (saved) this.role(dealt, 'saves');
      }

      if (choice.action === 'vest') {
        if (log.some((outcome) => outcome.targetSlot === choice.slot && outcome.outcome === 'vested')) {
          this.role(dealt, 'vestSaves');
        }
      }

      if (choice.action === 'douse' || choice.action === 'charge') {
        this.role(dealt, target === choice.slot ? 'ignite' : 'prepare');
      }

      if (choice.action === 'kill' && roleDef(choice.role).faction === 'town') {
        const spared = this.acquitted.get(night);
        if (spared?.has(target)) {
          add(this.tally, 'vig:onAcquitted');
          if (this.evilAt(target)) add(this.tally, 'vig:onAcquittedEvil');
        }
      }
    }

    // Every attack, credited to the role that was dealt to its author.
    for (const outcome of log) {
      if (outcome.attackerSlot === null || outcome.attackerSlot === outcome.targetSlot) continue;
      const dealt = this.dealtAt(outcome.attackerSlot);
      this.role(dealt, 'swings');
      if (outcome.outcome !== 'killed') continue;
      this.role(dealt, 'killed');
      if (outcome.targetRole) this.role(dealt, `victim:${sideOf(outcome.targetRole)}`);
    }

    /**
     * The morning read: whoever the family killed had been accusing somebody.
     *
     * The rule a watcher applies is "the seats the victim named are the
     * killers". Scored against the living seats, which is the pool the watcher
     * is choosing from.
     */
    const familyKills = log.filter(
      (outcome) =>
        outcome.outcome === 'killed' &&
        (outcome.source === 'mafia' || outcome.source === 'triad' || outcome.source === 'cult')
    );
    for (const kill of familyKills) {
      const named = new Set(
        before.claims
          .filter((claim) => claim.kind === 'accuse' && claim.claimerSlot === kill.targetSlot)
          .map((claim) => claim.targetSlot)
      );
      for (const slot of before.aliveSlots) {
        if (slot === kill.targetSlot) continue;
        this.tell('accuse-par-la-victime', slot, named.has(slot));
      }
    }

    /**
     * And whoever answered "where were you" with a house yesterday: did a
     * family knife find them tonight more often than anybody else?
     */
    const knifed = new Set(familyKills.map((outcome) => outcome.targetSlot));
    for (const slot of before.aliveSlots) {
      if (this.evilAt(slot)) continue;
      const said = this.visitedAnswer.get(slot) === night;
      add(this.tally, said ? 'scan:answeredTown' : 'scan:quietTown');
      if (knifed.has(slot)) add(this.tally, said ? 'scan:answeredKnifed' : 'scan:quietKnifed');
    }
  }

  /* --------------------------------- end --------------------------------- */

  end(claims: readonly Claim[], voteHistory: readonly { voterSlot: number; targetSlot: number }[]): void {
    const state = this.state;
    const winners = new Set(state.winners.map((winner) => winner.playerId));
    for (const player of Object.values(state.players)) {
      const dealt = this.dealt.get(player.playerId);
      if (!dealt) continue;
      if (winners.has(player.playerId)) this.role(dealt, 'won');
      if (player.alive) this.role(dealt, 'survived');
      const death = state.deaths.find((entry) => entry.playerId === player.playerId);
      if (death?.phase === 'day' && death.source === undefined) this.role(dealt, 'lynched');
      if (death?.phase === 'night') this.role(dealt, 'nightDead');
      if (dealt === 'vigilante') this.role(dealt, 'bulletsLeft', player.charges);

      const mine = claims.filter((claim) => claim.claimerSlot === player.slot);
      const roleClaims = mine.filter((claim) => claim.kind === 'role-claim' && claim.claimedRole);
      if (roleClaims.some((claim) => claim.claimedRole === dealt)) this.role(dealt, 'ownClaim');
      if (roleClaims.some((claim) => claim.claimedRole !== dealt && claim.claimedRole !== player.role)) {
        this.role(dealt, 'fakeClaim');
      }
      const worked = mine.filter((claim) => claim.worked === true);
      if (worked.length > 0) {
        this.role(dealt, 'publishedSeats');
        this.role(dealt, 'published', worked.length);
      }

      /**
       * Two houses reported for one night, by an instrument that reads one.
       *
       * A check, a smell, an exact role, a block, a tail: each is one house a
       * night, so a seat reporting two different houses for the same night with
       * the same instrument has told the room something the role cannot do. A
       * Lookout's list and a Spy's report legitimately name several seats, so
       * they are not counted.
       */
      const single = new Set(['sheriff', 'trade', 'role', 'blocked', 'tracked']);
      const perNight = new Map<string, Set<number>>();
      for (const claim of worked) {
        if (!claim.from || !single.has(claim.from)) continue;
        const key = `${claim.from}:${claim.night ?? Math.max(1, claim.day - 1)}`;
        const set = perNight.get(key) ?? new Set<number>();
        set.add(claim.targetSlot);
        perNight.set(key, set);
      }
      const overran = [...perNight.values()].some((set) => set.size > 1);
      if (overran) this.fault(isEvilRole(player.role ?? dealt) ? 'plus-de-rapports-que-de-nuits' : 'plus-de-rapports-ville');
    }

    // A brother cleared in public and then hanged: the clearer is now a proven liar.
    for (const cover of this.brotherClears) {
      add(this.tally, 'cover:clears');
      const seat = playerBySlot(state, cover.brother);
      const hanged = state.deaths.some(
        (death) =>
          death.playerId === seat?.playerId && death.phase === 'day' && death.source === undefined && death.day <= cover.day + 1
      );
      if (hanged) this.fault('blanchit-un-frere-ensuite-pendu');
    }

    const lastDay = state.day;
    const deathOf = (playerId: string) => state.deaths.find((entry) => entry.playerId === playerId);

    /**
     * A person and a bot in the same camp should run the same risks.
     *
     * Per seat: dead at night, hanged, dead before the end of day three (the
     * player who barely got to play), and day votes received per day alive.
     */
    for (const player of Object.values(state.players)) {
      if (!player.role) continue;
      const dealt = this.dealt.get(player.playerId) ?? player.role;
      const who = `par:${player.isBot ? 'bot' : 'humain'}:${sideOf(dealt)}`;
      const death = deathOf(player.playerId);
      add(this.tally, `${who}:seats`);
      if (death?.phase === 'night') add(this.tally, `${who}:nightDead`);
      if (death?.phase === 'day' && death.source === undefined) add(this.tally, `${who}:lynched`);
      if (death && death.day <= 3) add(this.tally, `${who}:early`);
      const alive = Math.max(1, (death?.day ?? lastDay) - 1);
      add(this.tally, `${who}:days`, alive);
      add(this.tally, `${who}:votes`, voteHistory.filter((vote) => vote.targetSlot === player.slot).length);
    }

    /**
     * From a finding to a rope.
     *
     * Every killer a town seat found at night (a suspicious check that was
     * right, a doorstep at a house that died): was it ever said out loud, was
     * the killer hanged, and how many days after it was said.
     */
    const hangedOn = (slot: number): number | null => {
      const seat = playerBySlot(state, slot);
      const death = seat ? deathOf(seat.playerId) : undefined;
      return death?.phase === 'day' && death.source === undefined ? death.day : null;
    };
    const diedOn = (slot: number, night: number): boolean =>
      state.deaths.some(
        (death) => death.phase === 'night' && death.day === night && playerBySlot(state, slot)?.playerId === death.playerId
      );
    for (const player of Object.values(state.players)) {
      if (!player.role || roleDef(this.dealt.get(player.playerId) ?? player.role).faction !== 'town') continue;
      const found = new Map<number, number>();
      for (const entry of player.intel) {
        if (entry.kind === 'sheriff' && sheriffSuspects(entry.value) && this.evilAt(entry.targetSlot)) {
          if (!found.has(entry.targetSlot)) found.set(entry.targetSlot, entry.night);
        }
        if (entry.kind === 'visitors' && diedOn(entry.targetSlot, entry.night)) {
          for (const visitor of entry.slots ?? []) {
            if (this.evilAt(visitor) && !found.has(visitor)) found.set(visitor, entry.night);
          }
        }
        if (entry.kind === 'tracked' && (entry.slots ?? []).some((slot) => diedOn(slot, entry.night))) {
          if (this.evilAt(entry.targetSlot) && !found.has(entry.targetSlot)) found.set(entry.targetSlot, entry.night);
        }
      }
      for (const [killer, night] of found) {
        add(this.tally, 'info:found');
        const said = claims
          .filter(
            (claim) =>
              claim.claimerSlot === player.slot &&
              claim.targetSlot === killer &&
              (claim.kind === 'accuse' || claim.kind === 'sighting')
          )
          .map((claim) => claim.day)
          .sort((left, right) => left - right)[0];
        const rope = hangedOn(killer);
        if (said !== undefined) {
          add(this.tally, 'info:said');
          add(this.tally, 'info:sayDelay', Math.max(0, said - (night + 1)));
        }
        if (rope !== null) add(this.tally, 'info:hanged');
        if (said !== undefined && rope !== null && rope >= said) {
          add(this.tally, 'info:hangedAfterSaid');
          add(this.tally, 'info:hangDelay', rope - said);
        }
        if (playerBySlot(state, killer)?.alive) add(this.tally, 'info:aliveAtEnd');
      }
    }

    /**
     * Does a temperament show? The same question asked of four traits, each
     * split at its middle: a trait that changes nothing visible is not a
     * personality.
     */
    for (const player of Object.values(state.players)) {
      const personality = this.personalityOf(player.slot);
      if (!personality || !player.isBot || !player.role) continue;
      const dealt = this.dealt.get(player.playerId) ?? player.role;
      const death = deathOf(player.playerId);
      const days = Math.max(1, (death?.day ?? lastDay) - 1);
      const mine = claims.filter((claim) => claim.claimerSlot === player.slot);
      if (roleDef(dealt).faction === 'town') {
        const aggression = band(personality.aggression, 0.5);
        add(this.tally, `pers:aggr:${aggression}:days`, days);
        add(this.tally, `pers:aggr:${aggression}:acc`, mine.filter((claim) => claim.kind === 'accuse').length);
        add(
          this.tally,
          `pers:aggr:${aggression}:votes`,
          voteHistory.filter((vote) => vote.voterSlot === player.slot).length
        );
      }
      if (dealt === 'sheriff' || dealt === 'investigator' || dealt === 'lookout' || dealt === 'detective') {
        const haste = band(personality.temperament.haste, 1);
        const first = mine.filter((claim) => claim.worked === true).map((claim) => claim.day).sort((a, b) => a - b)[0];
        add(this.tally, `pers:haste:${haste}:seats`);
        if (first !== undefined) {
          add(this.tally, `pers:haste:${haste}:published`);
          add(this.tally, `pers:haste:${haste}:firstDay`, first);
        }
      }
      if (isEvilRole(dealt)) {
        const deceit = band(personality.deceit, 0.4);
        add(this.tally, `pers:deceit:${deceit}:seats`);
        if (mine.some((claim) => claim.kind === 'role-claim' && claim.claimedRole !== dealt)) {
          add(this.tally, `pers:deceit:${deceit}:faked`);
        }
      }
    }
  }

  /**
   * Once per dusk: settle yesterday's promises the way the board settles them.
   *
   * A promise made on day D is judged by what its author put on the record on
   * day D + 1, so the verdict exists only once that day's talking is over. Read
   * earlier it is always "broken", because nobody has spoken yet.
   */
  dusk(info: PublicInfo): void {
    for (const claim of info.claims) {
      if (claim.kind !== 'promise' || claim.promise !== 'night' || claim.day !== info.day - 1) continue;
      if (!this.evilAt(claim.claimerSlot) || !info.aliveSlots.includes(claim.claimerSlot)) continue;
      add(this.tally, 'promise:evilSettled');
      const broken = deductions(claim.claimerSlot, info).some((finding) => finding.kind === 'broken-promise');
      if (!broken) add(this.tally, 'promise:evilKept');
    }
  }
}
