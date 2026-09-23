import { roleDef, ROLES, type RoleId } from '../roles.js';
import { playerBySlot, playerFamily, type IntelEntry, type MafiaPlayer, type MafiaState } from '../state.js';
import { deductions } from './deduce.js';
import { decideNightTarget, isEvilRole, judgeRequest, type Brain, type Claim, type PublicInfo } from './policies.js';
import { add, type Tally } from './report.js';

/**
 * Situations forced into a bench game, to see how the bots handle them.
 *
 * The bench is all bots, so the moves a person makes at the table never happen
 * in it: nobody asks the family for a house, nobody fishes for the Jailor with a
 * fake claim, nobody stands on the stand wearing a role another seat holds.
 * Each scenario here plays one of those moves on the bots' behalf and records
 * what the table did about it. They change the games they run in, so compare a
 * scenario only against the same scenario.
 *
 *  - `famille`: every night, a member of a family that is not holding the knife
 *    asks for a different house than the knife holder picked, as a person in the
 *    family room would. Counts how often the knife follows, and what it hits.
 *  - `peche`: on day two, a family seat claims a town role another living seat
 *    really holds, the classic fishing move. Counts whether the real holder
 *    stands up, and whether the family's knife finds it that night.
 *  - `barre`: an evil seat on the stand claims a unique town role whose real
 *    holder is sitting on the jury. Counts the hangings and the holder's ballot.
 *  - `meneur`: a Mayor, forced out on day two, names a seat every morning with
 *    no reason given, as a revealed player calling a vote would. Counts how many
 *    town seats follow, split by whether the named seat was really evil.
 *  - `promesse`: an evil seat on the stand promises to prove itself tonight and
 *    says something, anything, the next day. Counts hangings and whether the
 *    board called the promise broken.
 *  - `muet`: the person-shaped seats (`--humans`) never say a word and still
 *    vote, as somebody away from the keyboard or new to the game does. Read
 *    against the humans-and-bots table: they should not hang for silence alone.
 *  - `mal-lu`: every line from a person-shaped seat reaches the board the way
 *    the live parser files it, as a reading it is not sure of, and one in ten is
 *    filed the wrong way round (an accusation read as a clearing, "home" read as
 *    a visit). A misreading should not be what hangs somebody.
 *
 * Every choice a scenario makes is drawn from its own dice, so the game's own
 * stream is untouched until the injected move changes what the bots see.
 */
export const SCENARIOS = ['famille', 'peche', 'barre', 'meneur', 'promesse', 'muet', 'mal-lu'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface ScenarioContext {
  state: MafiaState;
  /** The scenario's own dice. */
  rng: () => number;
  tally: Tally;
  board: () => PublicInfo;
  /** Put a claim on the record, stamped with its truth like any other. */
  push: (claim: Claim) => void;
  brainOf: (playerId: string) => Brain | undefined;
  teammatesOf: (playerId: string) => Set<number>;
  familyIntelFor: (playerId: string) => IntelEntry[];
  reveal: (playerId: string) => void;
}

/** Town roles a fisher can reach for: real at this table and still held by somebody alive. */
function heldRoles(state: MafiaState, info: PublicInfo, exclude: ReadonlySet<number>): { role: RoleId; holder: MafiaPlayer }[] {
  const claimed = new Set(info.claims.filter((claim) => claim.kind === 'role-claim').map((claim) => claim.claimedRole));
  return Object.values(state.players)
    .filter(
      (player) =>
        player.alive &&
        player.role !== null &&
        !exclude.has(player.slot) &&
        roleDef(player.role).faction === 'town' &&
        player.role !== 'citizen' &&
        player.role !== 'mayor' &&
        player.role !== 'marshall' &&
        !claimed.has(player.role)
    )
    .map((player) => ({ role: player.role as RoleId, holder: player }));
}

export class Scenarios {
  private readonly on: Set<string>;
  private fishing: { day: number; fisher: number; holder: number; role: RoleId; surfaced: boolean } | null = null;
  private stand: { slot: number; holder: number | null; kind: 'barre' | 'promesse' } | null = null;
  private promised: { slot: number; day: number }[] = [];
  private leader: number | null = null;
  private named: { day: number; slot: number; control: number | null } | null = null;

  constructor(
    names: readonly string[],
    private readonly ctx: ScenarioContext
  ) {
    this.on = new Set(names);
  }

  private count(name: string, metric: string, by = 1): void {
    add(this.ctx.tally, `scen:${name}:${metric}`, by);
  }

  /* --------------------------------- day --------------------------------- */

  /** Before anybody speaks at dawn. */
  dawn(day: number): void {
    const { state } = this.ctx;
    const info = this.ctx.board();

    if (this.on.has('peche') && day === 2 && !this.fishing) {
      const family = Object.values(state.players).filter(
        (player) => player.alive && player.role && playerFamily(player) !== null && player.isBot
      );
      const fisher = family[Math.floor(this.ctx.rng() * family.length)];
      if (fisher) {
        const mates = new Set(family.filter((seat) => playerFamily(seat) === playerFamily(fisher)).map((seat) => seat.slot));
        const options = heldRoles(state, info, mates).filter((entry) => info.rolesInPlay?.has(entry.role) ?? true);
        // Unique badges first: that is the fishing move proper.
        const unique = options.filter((entry) => roleDef(entry.role).unique);
        const pool = unique.length > 0 ? unique : options;
        const pick = pool[Math.floor(this.ctx.rng() * pool.length)];
        if (pick) {
          this.ctx.push({
            day,
            night: Math.max(1, day - 1),
            claimerSlot: fisher.slot,
            targetSlot: fisher.slot,
            kind: 'role-claim',
            claimedRole: pick.role,
            truthful: false
          });
          this.fishing = { day, fisher: fisher.slot, holder: pick.holder.slot, role: pick.role, surfaced: false };
          this.count('peche', roleDef(pick.role).unique ? 'unique:faits' : 'partage:faits');
        }
      }
    }

    // Yesterday's promise, kept the cheapest way there is: by saying anything.
    if (this.on.has('promesse')) {
      for (const promise of this.promised) {
        if (promise.day !== day - 1 || !info.aliveSlots.includes(promise.slot)) continue;
        const others = info.aliveSlots.filter((slot) => slot !== promise.slot);
        const mark = others[Math.floor(this.ctx.rng() * others.length)];
        if (mark === undefined) continue;
        this.ctx.push({ day, claimerSlot: promise.slot, targetSlot: mark, kind: 'accuse', truthful: false });
        this.count('promesse', 'survivants');
        const settled = this.ctx.board();
        if (deductions(promise.slot, settled).some((finding) => finding.kind === 'broken-promise')) {
          this.count('promesse', 'jugeesRompues');
        }
      }
    }

    if (this.on.has('meneur') && day >= 2) {
      if (this.leader === null && day === 2) {
        const mayor = Object.values(state.players).find((player) => player.alive && player.role === 'mayor');
        if (mayor) {
          if (!mayor.revealed) this.ctx.reveal(mayor.playerId);
          if (mayor.revealed) this.leader = mayor.slot;
        }
      }
      const leader = this.leader === null ? null : playerBySlot(state, this.leader);
      if (leader?.alive) {
        const others = info.aliveSlots.filter((slot) => slot !== leader.slot);
        const mark = others[Math.floor(this.ctx.rng() * others.length)];
        // And a seat nobody named, drawn the same way, as the control: how often the town votes a random seat anyway.
        const rest = others.filter((slot) => slot !== mark);
        const control = rest[Math.floor(this.ctx.rng() * rest.length)];
        if (mark !== undefined) {
          this.ctx.push({ day, claimerSlot: leader.slot, targetSlot: mark, kind: 'accuse', truthful: false });
          this.named = { day, slot: mark, control: control ?? null };
        }
      }
    }
  }

  /** After the dawn pass: did the real holder stand up for its badge? */
  afterTalk(day: number): void {
    const fishing = this.fishing;
    if (!fishing || fishing.day !== day) return;
    const info = this.ctx.board();
    const kind = roleDef(fishing.role).unique ? 'unique' : 'partage';
    fishing.surfaced = info.claims.some(
      (claim) =>
        claim.day === day &&
        claim.claimerSlot === fishing.holder &&
        ((claim.kind === 'role-claim' && claim.claimedRole === fishing.role) ||
          (claim.kind === 'counter-claim' && claim.targetSlot === fishing.fisher) ||
          (claim.kind === 'accuse' && claim.targetSlot === fishing.fisher))
    );
    if (fishing.surfaced) this.count('peche', `${kind}:titulaireSeMontre`);
  }

  /** The day's closing ballots: who followed the leader's call. */
  dayOver(day: number, closing: readonly { voterSlot: number; targetSlot: number }[]): void {
    const named = this.named;
    if (!named || named.day !== day) return;
    const { state } = this.ctx;
    const evil = this.evilAt(named.slot);
    const side = evil ? 'surTueur' : 'surVille';
    const town = Object.values(state.players).filter(
      (player) =>
        player.alive &&
        player.role !== null &&
        roleDef(player.role).faction === 'town' &&
        player.slot !== this.leader &&
        player.slot !== named.slot
    );
    this.count('meneur', `${side}:appels`);
    this.count('meneur', `${side}:villeVotante`, town.length);
    const followed = closing.filter(
      (vote) => vote.targetSlot === named.slot && town.some((player) => player.slot === vote.voterSlot)
    ).length;
    this.count('meneur', `${side}:suivis`, followed);

    if (named.control !== null) {
      const control = named.control;
      const voters = town.filter((player) => player.slot !== control);
      this.count('meneur', 'controle:villeVotante', voters.length);
      this.count(
        'meneur',
        'controle:suivis',
        closing.filter((vote) => vote.targetSlot === control && voters.some((player) => player.slot === vote.voterSlot))
          .length
      );
    }
    this.named = null;
  }

  /**
   * The accused's claim on the stand, when a scenario has one to put in its mouth.
   * Returns the role to claim instead of the default, or undefined to leave it.
   */
  standClaim(accused: MafiaPlayer, info: PublicInfo): RoleId | undefined {
    if (!accused.role || !isEvilRole(accused.role)) return undefined;
    if (this.on.has('barre')) {
      const options = heldRoles(this.ctx.state, info, new Set([accused.slot])).filter(
        (entry) => roleDef(entry.role).unique && (info.rolesInPlay?.has(entry.role) ?? true)
      );
      const pick = options[Math.floor(this.ctx.rng() * options.length)];
      if (pick) {
        this.stand = { slot: accused.slot, holder: pick.holder.slot, kind: 'barre' };
        this.count('barre', 'proces');
        return pick.role;
      }
    }
    if (this.on.has('promesse')) {
      this.ctx.push({
        day: info.day,
        claimerSlot: accused.slot,
        targetSlot: accused.slot,
        kind: 'promise',
        promise: 'night',
        truthful: false
      });
      this.promised.push({ slot: accused.slot, day: info.day });
      this.stand = { slot: accused.slot, holder: null, kind: 'promesse' };
      this.count('promesse', 'proces');
    }
    return undefined;
  }

  ballot(player: MafiaPlayer, verdict: 'guilty' | 'innocent' | 'abstain'): void {
    if (this.stand?.kind !== 'barre' || player.slot !== this.stand.holder) return;
    this.count('barre', `titulaire:${verdict}`);
  }

  trialClosed(hanged: boolean): void {
    if (!this.stand) return;
    if (hanged) this.count(this.stand.kind, 'pendus');
    this.stand = null;
  }

  /**
   * What a person-shaped seat's words become on the board.
   *
   * Nothing, for a mute seat. For a misread one, the live parser's uncertain
   * reading (the ear files a person's line with a confidence under one), and
   * now and then the opposite of what was meant.
   */
  humanSpeech(player: MafiaPlayer, claims: readonly Claim[]): Claim[] {
    if (player.isBot) return [...claims];
    if (this.on.has('muet')) {
      if (claims.length > 0) this.count('muet', 'lignesTues', claims.length);
      return [];
    }
    if (!this.on.has('mal-lu')) return [...claims];
    const others = this.ctx.board().aliveSlots.filter((slot) => slot !== player.slot);
    return claims.map((claim) => {
      this.count('mal-lu', 'lignes');
      const read: Claim = { ...claim, confidence: 0.65 };
      if (this.ctx.rng() >= 0.1) return read;
      this.count('mal-lu', 'retournees');
      if (claim.kind === 'accuse') return { ...read, kind: 'clear' };
      if (claim.kind === 'clear') return { ...read, kind: 'accuse' };
      if (claim.kind === 'account' && claim.account === 'home') {
        const elsewhere = others[Math.floor(this.ctx.rng() * others.length)];
        return elsewhere === undefined ? read : { ...read, account: 'visited', targetSlot: elsewhere };
      }
      if (claim.kind === 'account' && claim.account === 'visited') {
        return { ...read, account: 'home', targetSlot: player.slot };
      }
      return read;
    });
  }

  /* -------------------------------- night -------------------------------- */

  /**
   * A family knife, with a teammate asking for a different house.
   *
   * The asker is played as a person: the live table prices a person's request
   * at twice a bot's. The house asked for is the asker's own read of the board,
   * or any other legal house when that read agrees with the knife.
   */
  knife(holder: MafiaPlayer, targets: number[], own: number | null, info: PublicInfo): number | null {
    if (!this.on.has('famille') || own === null) return own;
    const family = playerFamily(holder);
    if (family === null) return own;
    const asker = Object.values(this.ctx.state.players).find(
      (player) => player.alive && player.playerId !== holder.playerId && playerFamily(player) === family
    );
    const askerBrain = asker ? this.ctx.brainOf(asker.playerId) : undefined;
    if (!asker || !askerBrain) return own;

    const elsewhere = targets.filter((slot) => slot !== own);
    if (elsewhere.length === 0) return own;
    const preferred = decideNightTarget(
      asker,
      { ...askerBrain, lastKillTarget: null },
      info,
      elsewhere,
      'kill',
      this.ctx.teammatesOf(asker.playerId),
      this.ctx.familyIntelFor(asker.playerId),
      this.ctx.rng
    );
    const ask = preferred ?? elsewhere[Math.floor(this.ctx.rng() * elsewhere.length)];
    if (ask === undefined) return own;

    const brain = this.ctx.brainOf(holder.playerId);
    if (!brain) return own;
    // The same judgement the live driver makes. See `judgeRequest`.
    const verdict = judgeRequest(holder, brain, info, ask, targets, this.ctx.teammatesOf(holder.playerId));
    const granted = verdict.grant;
    this.count('famille', 'demandes');
    if (granted) this.count('famille', 'accordees');
    if (verdict.reason) {
      this.count('famille', 'refusExpliques');
      this.count('famille', `refus:${verdict.reason}`);
    }
    const askedRole = playerBySlot(this.ctx.state, ask)?.role ?? null;
    const ownRole = playerBySlot(this.ctx.state, own)?.role ?? null;
    if (askedRole && townPowerRole(askedRole)) this.count('famille', 'demandeSurPouvoirVille');
    if (ownRole && townPowerRole(ownRole)) this.count('famille', 'choixPropreSurPouvoirVille');
    return granted ? ask : own;
  }

  /** After the night: did the family's knife find the seat that stood up for its badge? */
  nightOver(night: number, knifed: ReadonlySet<number>): void {
    const fishing = this.fishing;
    if (!fishing || fishing.day !== night) return;
    const kind = roleDef(fishing.role).unique ? 'unique' : 'partage';
    if (knifed.has(fishing.holder)) {
      this.count('peche', `${kind}:titulaireTue`);
      if (fishing.surfaced) this.count('peche', `${kind}:tueApresSEtreMontre`);
    }
  }

  private evilAt(slot: number): boolean {
    const role = playerBySlot(this.ctx.state, slot)?.role;
    return !!role && isEvilRole(role);
  }
}

function townPowerRole(role: RoleId): boolean {
  const def = ROLES[role];
  return def.faction === 'town' && !!def.nightAction;
}
