import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toPublicInfo } from "../observe.js";
import { familyOf, type RoleId } from "../roles.js";
import { sameCause } from "./simulate.js";

import {
  createMafiaGame,
  playerBySlot,
  type MafiaPlayer,
  type MafiaState,
} from "../state.js";
import {
  bindPersonalities,
  buddyScore,
  friendlySeats,
  DEFAULT_PROFILE,
  claimerWeight,
  contradicted,
  ownsUpTo,
  copiesOf,
  decideBallot,
  decideDay,
  decideNightTarget,
  feelPressure,
  losingClock,
  makeBrain,
  parityPressure,
  rivalThreat,
  EVEN_TEMPERAMENT,
  steadyVote,
  styleOf,
  suspicionParts,
  isEvilRole,
  ALLY_TRUST,
  tide,
  tradeSuspects,
  tradeVerdict,
  type Claim,
  type PublicInfo,
} from "./policies.js";

/** A table of the given roles, already mid-game on day `day`. */
function table(roles: RoleId[], day = 2): MafiaState {
  const state = createMafiaGame({
    code: "POL",
    hostToken: "h",
    hostUserId: null,
    now: 0,
  });
  roles.forEach((role, index) => {
    const id = `s${index + 1}`;
    state.players[id] = {
      playerId: id,
      token: `t${id}`,
      name: `P${index + 1}`,
      slot: index + 1,
      isBot: true,
      connected: true,
      alive: true,
      role,
      charges: 3,
      obsessionId: null,
      revealed: false,
      doused: false,
      charged: false,
      poisonedNight: null,
      disguiseRole: null,
      bondPartnerId: null,
      bondKind: null,
      cooldownUntilDay: null,
      silencedDay: null,
      lastWill: "",
      notifications: [],
      intel: [],
      death: null,
    } satisfies MafiaPlayer;
  });
  state.phase = "day";
  state.stage = "discussion";
  state.day = day;
  return state;
}

const claim = (
  parts: Partial<Claim> & Pick<Claim, "claimerSlot" | "targetSlot" | "kind">,
): Claim => ({
  day: 2,
  truthful: false,
  ...parts,
});

describe("the claims board", () => {
  /**
   * The afternoon loop this whole layer exists for: somebody is asked to account
   * for their night, says they stayed home, and a watcher puts them on a
   * doorstep. Only a *sighting* closes it — the first version accepted any
   * credible accusation and cost the town nine points of correct lynches,
   * because it punished honest seats who happened to be framed.
   */
  it("catches a false account, but only on movement evidence", () => {
    const state = table(["citizen", "lookout", "mafioso", "doctor", "sheriff"]);
    const board = (claims: Claim[]): PublicInfo =>
      toPublicInfo(state, claims, []);

    const saidHome = claim({
      claimerSlot: 3,
      targetSlot: 3,
      kind: "account",
      account: "home",
    });

    assert.equal(
      contradicted(3, board([saidHome])),
      false,
      "an unchallenged account stands",
    );

    const merelyAccused = board([
      saidHome,
      claim({ claimerSlot: 2, targetSlot: 3, kind: "accuse" }),
    ]);
    assert.equal(
      contradicted(3, merelyAccused),
      false,
      "suspicion is not testimony",
    );

    const seenOut = board([
      saidHome,
      claim({ claimerSlot: 2, targetSlot: 3, kind: "sighting" }),
    ]);
    assert.equal(
      contradicted(3, seenOut),
      true,
      'a sighting against "I was home" is the catch',
    );

    /**
     * And the seat that corrects itself is not held to the sentence it withdrew.
     *
     * People misspeak, and a reader turning a hesitant line into an alibi is a
     * rope the person never asked for. The account they are standing on now is
     * the one they answer for.
     */
    const corrected = board([
      saidHome,
      claim({ claimerSlot: 2, targetSlot: 3, kind: "sighting" }),
      claim({
        claimerSlot: 3,
        targetSlot: 1,
        kind: "account",
        account: "visited",
      }),
    ]);
    assert.equal(
      contradicted(3, corrected),
      false,
      "the newest account is the one that counts",
    );
  });

  it("admitting you went out cannot be contradicted", () => {
    const state = table(["citizen", "lookout", "doctor"]);
    const board = toPublicInfo(
      state,
      [
        claim({
          claimerSlot: 3,
          targetSlot: 1,
          kind: "account",
          account: "visited",
        }),
        claim({ claimerSlot: 2, targetSlot: 3, kind: "sighting" }),
      ],
      [],
    );
    assert.equal(
      contradicted(3, board),
      false,
      "the honest answer carries no trap",
    );
  });

  /**
   * The other half of that catch, which nothing was asking for.
   *
   * `contradicted` answers "did the doorstep refute the story". Nothing
   * answered "did the doorstep confirm it", so a sighting was worth the same
   * half point whichever way it pointed. A real table paid for it: the town's
   * Doctor had published his round two nights running, a dead Lookout's will
   * then named him at exactly those houses on exactly those nights, and eight
   * seats hanged him citing that will. The Bodyguard he had saved voted with
   * them.
   */
  it("a doorstep that agrees with the account is corroboration, not evidence", () => {
    const state = table(["citizen", "lookout", "doctor", "mafioso"]);
    const board = (claims: Claim[]): PublicInfo =>
      toPublicInfo(state, claims, []);

    const wentToOne = claim({
      claimerSlot: 3,
      targetSlot: 1,
      kind: "account",
      account: "visited",
      night: 1,
      day: 2,
    });
    const sawHimAtOne = claim({
      claimerSlot: 2,
      targetSlot: 3,
      kind: "sighting",
      at: 1,
      night: 1,
      day: 3,
    });

    assert.equal(
      ownsUpTo(3, sawHimAtOne, board([wentToOne, sawHimAtOne])),
      "volunteered",
      "he named that house a day before the watcher did",
    );

    assert.equal(
      ownsUpTo(
        3,
        sawHimAtOne,
        board([
          claim({ ...wentToOne, targetSlot: 4 }),
          sawHimAtOne,
        ]),
      ),
      null,
      "a doorstep he did not claim confirms nothing",
    );

    assert.equal(
      ownsUpTo(3, sawHimAtOne, board([sawHimAtOne])),
      null,
      "a seat that never accounted for the night owns up to nothing",
    );

    /**
     * Said only once the report was on the board. The sighting stops counting
     * against him, because a confirmed visit is not a crime, but a story that
     * could have been cut to fit the evidence earns nothing back.
     */
    assert.equal(
      ownsUpTo(
        3,
        sawHimAtOne,
        board([sawHimAtOne, claim({ ...wentToOne, day: 4 })]),
      ),
      "matches",
      "agreeing after the fact is worth neutrality, not credit",
    );

    /**
     * And the seat that said "home", heard the doorstep and came back with a
     * visit is the one move this tier exists to refuse. It has an earlier
     * account and a matching standing one, and it has told two stories.
     */
    assert.equal(
      ownsUpTo(
        3,
        sawHimAtOne,
        board([
          claim({
            claimerSlot: 3,
            targetSlot: 3,
            kind: "account",
            account: "home",
            night: 1,
            day: 2,
          }),
          sawHimAtOne,
          claim({ ...wentToOne, day: 4 }),
        ]),
      ),
      "matches",
      "revising the story after the report is not volunteering it",
    );
  });

  it("and the score stops charging him for a doorstep he named himself", () => {
    const state = table(["citizen", "lookout", "doctor", "mafioso"]);
    const judge = playerBySlot(state, 1)!;
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);

    const sawHimAtOne = claim({
      claimerSlot: 2,
      targetSlot: 3,
      kind: "sighting",
      at: 1,
      night: 1,
      day: 3,
    });
    const wentToOne = claim({
      claimerSlot: 3,
      targetSlot: 1,
      kind: "account",
      account: "visited",
      night: 1,
      day: 2,
    });

    const evidence = (claims: Claim[]): number =>
      suspicionParts(3, judge, toPublicInfo(state, claims, []), () => 0)
        .evidence;

    assert.ok(
      evidence([sawHimAtOne, wentToOne]) < evidence([sawHimAtOne]),
      "the same doorstep weighs less once the seat has owned up to it",
    );
  });

  it("a discredited witness cannot catch anybody", () => {
    const state = table(["citizen", "lookout", "mafioso", "doctor"]);
    // Slot 2 vouched for slot 3's killer and the graveyard showed it up: either
    // it was lying or it was used, and the room cannot tell which.
    state.players.s3.alive = false;
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 2, targetSlot: 3, kind: "clear" }),
        claim({
          claimerSlot: 4,
          targetSlot: 4,
          kind: "account",
          account: "home",
        }),
        claim({ claimerSlot: 2, targetSlot: 4, kind: "sighting" }),
      ],
      [],
    );
    assert.equal(
      contradicted(4, board),
      false,
      "a burnt witness is not a witness",
    );
  });

  /**
   * The other half of the same rule, and the reason it needed splitting.
   *
   * Being wrong once used to burn a witness exactly as badly as vouching for a
   * murderer: `claimerWeight` dropped to zero either way, permanently, so a
   * Lookout who read one nervous villager wrong could never catch anybody
   * again. The bench found the town hanging its own people on afternoons where
   * not one juror held a checkable thing, and this was part of why — the seats
   * that had tried to help were the first to be silenced.
   */
  it("and one wrong call does not burn one", () => {
    const state = table(["citizen", "lookout", "mafioso", "doctor"]);
    // Slot 2 accused slot 4, who died town. An honest misread, not a lie.
    state.players.s4.alive = false;
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 2, targetSlot: 4, kind: "accuse" }),
        claim({
          claimerSlot: 3,
          targetSlot: 3,
          kind: "account",
          account: "home",
        }),
        claim({ claimerSlot: 2, targetSlot: 3, kind: "sighting" }),
      ],
      [],
    );
    assert.equal(
      contradicted(3, board),
      true,
      "a townie who guessed wrong is still a witness",
    );
  });
});

describe("desperation in play", () => {
  it("rises for a seat with the town closing in, and eases when it lets go", () => {
    const state = table([
      "mafioso",
      "citizen",
      "citizen",
      "citizen",
      "doctor",
      "sheriff",
    ]);
    const brain = makeBrain(1, {
      aggression: 0.5,
      herd: 0.5,
      claimRate: 0.7,
      deceit: 0.5,
      courage: 0.5,
      temperament: EVEN_TEMPERAMENT,
    });
    const self = playerBySlot(state, 1)!;

    // Three seats pointing at house 1.
    state.votes = { s2: "s1", s3: "s1", s4: "s1" };
    const hot = feelPressure(
      self,
      brain,
      toPublicInfo(state, [], []),
      new Set(),
    );
    assert.equal(hot.agenda, "family");
    assert.ok(hot.desperation > 0.3, "a wagon registers");
    assert.ok(hot.stance.fakeClaim > 0, "and it reaches for a mask");

    state.votes = {};
    const cooled = feelPressure(
      self,
      brain,
      toPublicInfo(state, [], []),
      new Set(),
    );
    assert.ok(cooled.desperation < hot.desperation, "the wagon rolled off");
  });

  it("an ignored jester is the desperate one", () => {
    const state = table(
      ["jester", "citizen", "citizen", "citizen", "doctor"],
      3,
    );
    const jester = playerBySlot(state, 1)!;

    const ignored = losingClock(
      jester,
      "jester",
      toPublicInfo(state, [], []),
      new Set(),
    );
    state.votes = { s2: "s1", s3: "s1", s4: "s1" };
    const wanted = losingClock(
      jester,
      "jester",
      toPublicInfo(state, [], []),
      new Set(),
    );

    assert.ok(ignored > wanted, "attention is what he is short of, not safety");
  });

  /**
   * The buddy tell only means anything if it fires on a real pair and stays
   * quiet on a coincidence, so both halves are worth a test: a nudge that never
   * triggers is dead weight in the scoring, and one that triggers on two days of
   * agreement is how a town lynches itself for no reason.
   */
  it("reads two seats who never vote for each other and often vote together", () => {
    const state = table(
      ["mafioso", "mafioso", "citizen", "citizen", "citizen", "doctor"],
      5,
    );
    // Slots 1 and 2 spent four days agreeing and never once crossed.
    const voteHistory = [
      { day: 1, voterSlot: 1, targetSlot: 5 },
      { day: 1, voterSlot: 2, targetSlot: 5 },
      { day: 2, voterSlot: 1, targetSlot: 4 },
      { day: 2, voterSlot: 2, targetSlot: 4 },
      { day: 3, voterSlot: 1, targetSlot: 6 },
      { day: 3, voterSlot: 2, targetSlot: 3 },
      { day: 4, voterSlot: 1, targetSlot: 3 },
      { day: 4, voterSlot: 2, targetSlot: 3 },
    ];
    const info = { ...toPublicInfo(state, [], []), voteHistory };

    assert.ok(buddyScore(1, info) > 0, "a bonded pair shows up");
    assert.ok(buddyScore(2, info) > 0, "and it shows up from either side");
    /**
     * And stays a nudge. Measured on the bench, this read points at evils
     * slightly *less* often than chance, because a table whose seats all score
     * the same public board herds, and "these two never crossed" describes most
     * of it. It is kept for the human squares that scatter their votes, and
     * capped so it can never build a wagon by itself. See `BUDDY_WEIGHT`.
     */
    assert.ok(buddyScore(1, info) < 0.5, "but it is never a case on its own");
  });

  it("does not call a pair on one afternoon of agreement", () => {
    const state = table(
      ["mafioso", "mafioso", "citizen", "citizen", "citizen", "doctor"],
      5,
    );
    const info = {
      ...toPublicInfo(state, [], []),
      voteHistory: [
        { day: 1, voterSlot: 1, targetSlot: 5 },
        { day: 1, voterSlot: 2, targetSlot: 5 },
        { day: 2, voterSlot: 1, targetSlot: 4 },
        { day: 2, voterSlot: 2, targetSlot: 4 },
      ],
    };
    assert.equal(
      buddyScore(1, info),
      0,
      "two days is a coincidence, not a pattern",
    );
  });

  it("clears a pair the moment one of them votes the other", () => {
    const state = table(
      ["citizen", "citizen", "citizen", "citizen", "citizen", "doctor"],
      5,
    );
    const info = {
      ...toPublicInfo(state, [], []),
      voteHistory: [
        { day: 1, voterSlot: 1, targetSlot: 5 },
        { day: 1, voterSlot: 2, targetSlot: 5 },
        { day: 2, voterSlot: 1, targetSlot: 4 },
        { day: 2, voterSlot: 2, targetSlot: 4 },
        { day: 3, voterSlot: 1, targetSlot: 6 },
        { day: 3, voterSlot: 2, targetSlot: 6 },
        // And then one of them turned on the other, which is the whole point.
        { day: 4, voterSlot: 1, targetSlot: 2 },
        { day: 4, voterSlot: 2, targetSlot: 3 },
      ],
    };
    assert.equal(
      buddyScore(1, info),
      0,
      "they crossed, so they are not a pair",
    );
  });

  it("a thinning family feels the board even with nothing pointed at it", () => {
    const state = table([
      "mafioso",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "doctor",
    ]);
    const lonely = playerBySlot(state, 1)!;
    const alone = losingClock(
      lonely,
      "family",
      toPublicInfo(state, [], []),
      new Set(),
    );
    const supported = losingClock(
      lonely,
      "family",
      toPublicInfo(state, [], []),
      new Set([2, 3]),
    );
    assert.ok(alone > supported, "numbers are the family clock");
  });
});

/** A middling personality: the herd factor is all `suspicionParts` reads off it. */
const HERD_HALF = {
  aggression: 0.5,
  herd: 0.5,
  claimRate: 0.5,
  deceit: 0.5,
  courage: 0.5,
  temperament: EVEN_TEMPERAMENT,
};

describe("two seats claiming one unique role", () => {
  /**
   * The table that prompted this: two Jailor claims, the town hangs one of them
   * and it is a Triad, then the town hangs the other one, who was the real
   * Jailor.
   *
   * The second hanging is the defect. Once the graveyard has shown that one of
   * the two was lying, and which one, the question the room was arguing about
   * has been answered: the survivor's claim is corroborated, not merely no
   * longer contested. Before this the penalty simply stopped applying, which
   * returned them to the middle of the pack with a warm wagon still on them.
   */
  function suspicionOfSurvivor(deadRole: RoleId | null): number {
    // Slot 1 judges. Slots 2 and 3 both claim Jailor; 3 is dead when given a role.
    const state = table([
      "sheriff",
      "jailor",
      "consigliere",
      "citizen",
      "citizen",
    ]);
    const judge = playerBySlot(state, 1);
    const corpse = playerBySlot(state, 3);
    if (!judge || !corpse) throw new Error("the table is missing a seat");

    if (deadRole !== null) {
      corpse.alive = false;
      corpse.role = deadRole;
      state.deaths.push({
        playerId: corpse.playerId,
        day: 2,
        phase: "day",
        cause: { k: "mafia.cause.lynched" },
        role: deadRole,
        hidden: false,
      });
    }

    const claims: Claim[] = [
      claim({
        claimerSlot: 2,
        targetSlot: 2,
        kind: "role-claim",
        claimedRole: "jailor",
      }),
      claim({
        claimerSlot: 3,
        targetSlot: 3,
        kind: "role-claim",
        claimedRole: "jailor",
      }),
    ];

    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    return suspicionParts(2, judge, toPublicInfo(state, claims, []), () => 0)
      .evidence;
  }

  it("makes a claimant look bad while the rival is still alive", () => {
    assert.ok(
      suspicionOfSurvivor(null) > 1,
      "a contested unique claim is evidence against both of them",
    );
  });

  it("clears the survivor once the rival is hanged and turns out to be evil", () => {
    const contested = suspicionOfSurvivor(null);
    const settled = suspicionOfSurvivor("consigliere");
    assert.ok(settled < contested, "the cost of the contest has to be gone");
    assert.ok(
      settled < 0,
      `and the survivor should read as cleared, got ${settled}`,
    );
  });

  it("does not clear them when the rival turned out to be town", () => {
    // A town seat that fake-claimed proves nothing about the other claimant.
    assert.ok(
      suspicionOfSurvivor("doctor") >= 0,
      "an innocent corpse is not corroboration",
    );
  });

  it("still condemns a seat claiming a role that is already in the ground", () => {
    const state = table([
      "sheriff",
      "jailor",
      "consigliere",
      "citizen",
      "citizen",
    ]);
    const judge = playerBySlot(state, 1);
    const corpse = playerBySlot(state, 3);
    if (!judge || !corpse) throw new Error("the table is missing a seat");

    corpse.alive = false;
    corpse.role = "jailor";
    state.deaths.push({
      playerId: corpse.playerId,
      day: 2,
      phase: "day",
      cause: { k: "mafia.cause.lynched" },
      role: "jailor",
      hidden: false,
    });

    const claims: Claim[] = [
      claim({
        claimerSlot: 2,
        targetSlot: 2,
        kind: "role-claim",
        claimedRole: "jailor",
      }),
    ];
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    assert.ok(
      suspicionParts(2, judge, toPublicInfo(state, claims, []), () => 0)
        .evidence >= 3,
    );
  });
});

describe("a second look at the ballot", () => {
  /**
   * The complaint this answers: a bot never switched its vote, and could not be
   * argued with before the trial.
   *
   * Nothing about the decision was ever sticky. `pickVote` holds no state and
   * never consults the seat's own standing vote, so it would happily change its
   * mind. It was simply never asked again: the one guaranteed day turn lands
   * between 5% and 45% of the phase, which is before the ear has turned a single
   * human sentence into a claim, and the second turn was a 40% coin flip.
   */
  function board(
    state: MafiaState,
    claims: Claim[],
    votes: Record<string, string> = {},
  ): PublicInfo {
    state.votes = votes;
    return toPublicInfo(state, claims, []);
  }

  function seat(state: MafiaState, slot: number): MafiaPlayer {
    const player = playerBySlot(state, slot);
    if (!player) throw new Error("no seat " + slot);
    bindPersonalities([makeBrain(player.slot, HERD_HALF)]);
    return player;
  }

  it("casts a vote when the seat has none standing", () => {
    const state = table(["sheriff", "citizen", "mafioso", "doctor", "citizen"]);
    const self = seat(state, 1);
    assert.deepEqual(
      steadyVote(self, board(state, []), null, 3, new Set(), () => 0),
      { slot: 3, skip: false },
    );
  });

  it("leaves a standing vote alone when the proposal is no better", () => {
    const state = table(["sheriff", "citizen", "mafioso", "doctor", "citizen"]);
    const self = seat(state, 1);
    // Nothing on the board, so 3 and 4 look identical: jitter must not move it.
    assert.deepEqual(
      steadyVote(self, board(state, []), 4, 3, new Set(), () => 0),
      { slot: null, skip: false },
      "a weathervane is worse than a stubborn seat",
    );
  });

  it("switches when the board turns up a real case", () => {
    const state = table(["sheriff", "citizen", "mafioso", "doctor", "citizen"]);
    const self = seat(state, 1);
    const claims: Claim[] = [
      // Grounded on purpose: a bare hunch is worth almost nothing to the
      // accused now, so "a real case" has to actually be one. See `grounding`.
      claim({ claimerSlot: 2, targetSlot: 3, kind: "accuse", from: "sheriff", worked: true }),
      claim({ claimerSlot: 5, targetSlot: 3, kind: "accuse" }),
    ];
    assert.deepEqual(
      steadyVote(self, board(state, claims), 4, 3, new Set(), () => 0),
      { slot: 3, skip: false },
    );
  });

  /**
   * The deadlock, which is the one case worth crossing the floor for: two seats
   * level at the bell means nobody hangs and the night side keeps a free day.
   */
  it("breaks a tie towards the seat it actually suspects", () => {
    const state = table(["sheriff", "citizen", "mafioso", "doctor", "citizen"]);
    const self = seat(state, 1);
    const claims: Claim[] = [
      claim({ claimerSlot: 2, targetSlot: 3, kind: "accuse", from: "sheriff", worked: true }),
      claim({ claimerSlot: 5, targetSlot: 3, kind: "accuse" }),
    ];
    // 3 and 4 are level on two votes each, and only 3 has a case against it.
    const votes = { s2: "s3", s5: "s3", s3: "s4", s4: "s4" };
    assert.deepEqual(
      steadyVote(self, board(state, claims, votes), 4, 4, new Set(), () => 0),
      { slot: 3, skip: false },
      "the tie should break towards the evidence",
    );
  });

  it("does not break a tie towards a seat nobody has a case against", () => {
    const state = table(["sheriff", "citizen", "mafioso", "doctor", "citizen"]);
    const self = seat(state, 1);
    const votes = { s2: "s3", s5: "s3", s3: "s4", s4: "s4" };
    assert.equal(
      steadyVote(self, board(state, [], votes), 4, 3, new Set(), () => 0).slot,
      null,
      "a tie-break is not a licence to guess",
    );
  });

  /**
   * And the other half of it: they do not pass often enough when the square has
   * found nothing at all.
   */
  it("votes to hang nobody when the board holds no case against anyone", () => {
    /**
     * Fourteen alive, because twelve is no longer a quiet afternoon.
     *
     * A board built by hand has no roster on it, so the clock falls back to
     * assuming three in ten of the seats are killers and that they are one
     * bloc: four of twelve, which leaves the town exactly one wrong rope, which
     * is a table that cannot afford to go home early. The old ladder read that
     * same board as comfortable and it was simply wrong about it. Two more
     * citizens buys the second mislynch that makes a skip honest. See
     * `townClock`.
     */
    const state = table([
      "sheriff",
      "citizen",
      "mafioso",
      "doctor",
      "citizen",
      "lookout",
      "escort",
      "citizen",
      "godfather",
      "citizen",
      "jailor",
      "citizen",
      "citizen",
      "citizen",
    ]);
    const self = seat(state, 1);
    assert.deepEqual(
      steadyVote(self, board(state, []), null, null, new Set(), () => 0),
      { slot: null, skip: true },
    );
  });

  it("but never at the parity clock, where a wasted day loses the game", () => {
    // Three alive, so one more empty afternoon hands it to whoever kills at night.
    const state = table(["sheriff", "citizen", "mafioso", "doctor", "citizen"]);
    for (const slot of [4, 5]) {
      const dead = playerBySlot(state, slot);
      if (dead) dead.alive = false;
    }
    const self = seat(state, 1);
    assert.equal(
      steadyVote(self, board(state, []), null, null, new Set(), () => 0).skip,
      false,
      "a town seat at the parity clock must not help the day end early",
    );
  });

  it("holds its vote rather than passing once it has already accused somebody", () => {
    const state = table(["sheriff", "citizen", "mafioso", "doctor", "citizen"]);
    const self = seat(state, 1);
    assert.deepEqual(
      steadyVote(self, board(state, []), 3, null, new Set(), () => 0),
      { slot: null, skip: false },
      "an empty proposal is not a retraction",
    );
  });
});

describe("what the record proves", () => {
  /**
   * The deduction a person makes without thinking and the bots never made: the
   * dawn report says the Veteran shot the Sheriff, the Sheriff’s will says
   * "night 2: I went to 4", so 4 is the Veteran. Read off the board, so it works
   * from a bot’s rendered will and from a person’s will once the ear has read it.
   */
  function porch(): { state: MafiaState; info: PublicInfo } {
    const state = table(
      ["citizen", "sheriff", "veteran", "citizen", "mafioso", "doctor"],
      3,
    );
    const sheriff = playerBySlot(state, 2);
    if (!sheriff) throw new Error("no sheriff");
    sheriff.alive = false;
    sheriff.isBot = true;
    sheriff.lastWill = "rendered from intel";
    sheriff.intel.push({
      night: 2,
      kind: "went",
      targetSlot: 4,
      value: "went",
    });
    state.deaths.push({
      playerId: sheriff.playerId,
      day: 2,
      phase: "night",
      cause: { k: "mafia.cause.killedBy" },
      source: "veteran",
      role: "sheriff",
      hidden: false,
    });
    return { state, info: toPublicInfo(state, [], []) };
  }

  it("names the veteran from a corpse’s last journey", () => {
    const { info } = porch();
    assert.equal(info.provenRoles.get(4), "veteran");
  });

  it("and then nobody visits that porch", () => {
    const { state, info } = porch();
    const doctor = playerBySlot(state, 6);
    if (!doctor) throw new Error("no doctor");
    bindPersonalities([makeBrain(doctor.slot, HERD_HALF)]);
    const brain = makeBrain(doctor.slot, HERD_HALF);
    for (let i = 0; i < 20; i++) {
      const target = decideNightTarget(
        doctor,
        brain,
        info,
        [1, 4, 5],
        "heal",
        new Set(),
        [],
        () => i / 20,
      );
      assert.notEqual(target, 4, "the proven veteran is never a night target");
    }
  });

  /**
   * A room agreeing about nothing is not evidence.
   *
   * Six seats naming the quiet one, none of them holding anything, used to
   * reach a conviction by the fourth voice - so the room settled on whoever was
   * named first and every bot then confirmed what the room had already done.
   * The loudest voice keeps its full weight; what is discounted is the echo.
   */
  it("a pile-on with nothing under it does not convict", () => {
    const state = table(
      ["citizen", "citizen", "citizen", "citizen", "citizen", "citizen"],
      3,
    );
    const judge = playerBySlot(state, 1);
    if (!judge) throw new Error("no judge");
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);

    const pileOn = [2, 3, 4, 5].map((slot) =>
      claim({ claimerSlot: slot, targetSlot: 6, kind: "accuse" }),
    );
    const crowd = suspicionParts(
      6,
      judge,
      toPublicInfo(state, pileOn, []),
      () => 0,
    );

    assert.equal(crowd.hard, 0, "nobody is holding anything");
    assert.ok(
      crowd.evidence < 2.2,
      `four voices and no evidence still convicted: ${crowd.evidence}`,
    );
  });


  /**
   * And it does not convict however many voices join it.
   *
   * The discount above bounds the echo and not the first voice, so a name
   * several credible seats repeat used to climb without limit: measured on a
   * real table, a case rose from 1.21 to 5.33 across four seats' reads with
   * nothing held in any of them, and the room hanged him. The cap is what makes
   * the hearsay floor a floor.
   */
  it("and a whole room repeating it still cannot reach the rope", () => {
    const state = table(
      ["citizen", "citizen", "citizen", "citizen", "citizen", "citizen", "citizen", "citizen"],
      3,
    );
    const judge = playerBySlot(state, 1);
    if (!judge) throw new Error("no judge");
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);

    // Everybody who can, naming the same seat, and one of them trusted for it.
    const roomful = [2, 3, 4, 5, 6, 7].map((slot) =>
      claim({ claimerSlot: slot, targetSlot: 8, kind: "accuse" }),
    );
    const crowd = suspicionParts(
      8,
      judge,
      toPublicInfo(state, roomful, []),
      () => 0,
    );

    assert.equal(crowd.hard, 0, "still nobody holding anything");
    assert.ok(
      crowd.evidence < 2.2,
      `a roomful of agreement reached the rope on its own: ${crowd.evidence}`,
    );
  });
  /** And one voice that actually holds something still does. */
  it("but one seat with a real case still does", () => {
    const state = table(
      ["citizen", "lookout", "citizen", "citizen", "citizen", "citizen"],
      3,
    );
    const judge = playerBySlot(state, 1);
    if (!judge) throw new Error("no judge");
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);

    const caught = [
      claim({
        claimerSlot: 6,
        targetSlot: 6,
        kind: "account",
        account: "home",
      }),
      claim({ claimerSlot: 2, targetSlot: 6, kind: "sighting" }),
    ];
    const one = suspicionParts(
      6,
      judge,
      toPublicInfo(state, caught, []),
      () => 0,
    );

    assert.ok(one.hard > 0, "a sighting against an alibi is something held");
    assert.ok(
      one.evidence > 2.2,
      `a real case no longer convicts: ${one.evidence}`,
    );
  });

  it("a dead sheriff’s record accuses for it", () => {
    const state = table(["citizen", "sheriff", "mafioso", "citizen"], 3);
    const sheriff = playerBySlot(state, 2);
    if (!sheriff) throw new Error("no sheriff");
    sheriff.alive = false;
    sheriff.isBot = true;
    sheriff.lastWill = "rendered from intel";
    sheriff.intel.push({
      night: 2,
      kind: "sheriff",
      targetSlot: 3,
      value: "suspect",
    });
    state.deaths.push({
      playerId: sheriff.playerId,
      day: 2,
      phase: "night",
      cause: { k: "mafia.cause.killedBy" },
      source: "mafia",
      role: "sheriff",
      hidden: false,
    });

    const info = toPublicInfo(state, [], []);
    const accusation = info.claims.find(
      (claim) => claim.claimerSlot === 2 && claim.kind === "accuse",
    );
    assert.equal(
      accusation?.targetSlot,
      3,
      "the will is on the board under the dead seat",
    );

    const judge = playerBySlot(state, 1);
    if (!judge) throw new Error("no judge");
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    assert.ok(
      suspicionParts(3, judge, info, () => 0).evidence >= 3,
      "and it is read as a town corpse’s testimony",
    );
  });

  it("a person’s private record is not their will", () => {
    const state = table(["citizen", "sheriff", "mafioso", "citizen"], 3);
    const sheriff = playerBySlot(state, 2);
    if (!sheriff) throw new Error("no sheriff");
    sheriff.alive = false;
    sheriff.isBot = false;
    sheriff.lastWill = "I saw nothing.";
    sheriff.intel.push({
      night: 2,
      kind: "sheriff",
      targetSlot: 3,
      value: "suspect",
    });
    state.deaths.push({
      playerId: sheriff.playerId,
      day: 2,
      phase: "night",
      cause: { k: "mafia.cause.killedBy" },
      source: "mafia",
      role: "sheriff",
      hidden: false,
    });
    const info = toPublicInfo(state, [], []);
    assert.equal(
      info.claims.some((claim) => claim.claimerSlot === 2),
      false,
      "what a person learned and did not write down stays theirs",
    );
  });

  it("a living sheriff whose accusation hanged a mafioso is a proven sheriff", () => {
    const state = table(["citizen", "sheriff", "mafioso", "citizen"], 3);
    const wolf = playerBySlot(state, 3);
    if (!wolf) throw new Error("no wolf");
    wolf.alive = false;
    state.deaths.push({
      playerId: wolf.playerId,
      day: 2,
      phase: "day",
      cause: { k: "mafia.cause.lynched" },
      role: "mafioso",
      hidden: false,
    });
    const claims: Claim[] = [
      claim({
        claimerSlot: 2,
        targetSlot: 2,
        kind: "role-claim",
        claimedRole: "sheriff",
      }),
      claim({ claimerSlot: 2, targetSlot: 3, kind: "accuse" }),
    ];
    const info = toPublicInfo(state, claims, []);
    assert.equal(info.provenRoles.get(2), "sheriff");
    assert.ok(
      claimerWeight(2, info) >= 2,
      "and the badge is the loudest voice in the room",
    );
  });
});

describe("the second look and the family", () => {
  it("never breaks a tie onto its own brother", () => {
    const state = table(
      ["citizen", "citizen", "mafioso", "citizen", "godfather", "citizen"],
      3,
    );
    const me = playerBySlot(state, 3);
    if (!me) throw new Error("no seat");
    bindPersonalities([makeBrain(me.slot, HERD_HALF)]);
    const claims: Claim[] = [
      claim({ claimerSlot: 1, targetSlot: 5, kind: "accuse" }),
      claim({ claimerSlot: 2, targetSlot: 5, kind: "accuse" }),
    ];
    // The room sits level between the Godfather (5) and a townie (4); the
    // mafioso stands on 4, and the case against 5 is the strongest on the board.
    state.votes = { s1: "s5", s2: "s5", s3: "s4", s6: "s4" };
    const info = toPublicInfo(state, claims, []);
    assert.equal(
      steadyVote(me, info, 4, 4, new Set([5]), () => 0).slot,
      null,
      "a tie-break is not a bus",
    );
  });
});

describe("what a will actually said", () => {
  function bury(
    state: MafiaState,
    slot: number,
    day: number,
    source?: "mafia",
  ): MafiaPlayer {
    const corpse = playerBySlot(state, slot);
    if (!corpse) throw new Error("no seat " + slot);
    corpse.alive = false;
    corpse.lastWill = "rendered from intel";
    state.deaths.push({
      playerId: corpse.playerId,
      day,
      phase: "night",
      cause: { k: "mafia.cause.killedBy" },
      ...(source ? { source } : {}),
      role: corpse.role ?? "citizen",
      hidden: false,
    });
    return corpse;
  }

  it("a claim said in life and written in death is one claim", () => {
    const state = table(["citizen", "sheriff", "mafioso", "citizen"], 3);
    const sheriff = bury(state, 2, 3, "mafia");
    sheriff.intel.push({
      night: 2,
      kind: "sheriff",
      targetSlot: 3,
      value: "suspect",
    });
    // Reported on day 3 while alive, learned on night 2: the same assertion.
    const spoken: Claim[] = [
      claim({ day: 3, claimerSlot: 2, targetSlot: 3, kind: "accuse" }),
    ];
    const info = toPublicInfo(state, spoken, []);
    const accusations = info.claims.filter(
      (entry) =>
        entry.claimerSlot === 2 &&
        entry.targetSlot === 3 &&
        entry.kind === "accuse",
    );
    assert.equal(
      accusations.length,
      1,
      "the testament does not double what the corpse said alive",
    );
  });

  it("a dead evil bot’s record is not a will, whatever the reveal policy", () => {
    const state = table(["citizen", "consigliere", "mafioso", "sheriff"], 3);
    state.config = { ...state.config, revealOnDeath: "none" };
    const consigliere = bury(state, 2, 3);
    consigliere.intel.push({
      night: 1,
      kind: "role",
      targetSlot: 3,
      value: "mafioso",
    });
    consigliere.intel.push({
      night: 2,
      kind: "role",
      targetSlot: 4,
      value: "sheriff",
    });
    const info = toPublicInfo(state, [], []);
    assert.equal(
      info.claims.length,
      0,
      "an unsigned will has nothing in it for the board to read",
    );
  });
});

describe("a badge nobody disputes", () => {
  const badges: RoleId[] = [
    "sheriff",
    "investigator",
    "lookout",
    "detective",
    "coroner",
    "spy",
  ];

  it("lends a living investigator a little more voice, whichever badge it is", () => {
    for (const badge of badges) {
      const state = table(["citizen", "citizen", "mafioso", "citizen"], 3);
      const info = toPublicInfo(
        state,
        [
          claim({
            claimerSlot: 2,
            targetSlot: 2,
            kind: "role-claim",
            claimedRole: badge,
          }),
        ],
        [],
      );
      assert.ok(
        claimerWeight(2, info) > claimerWeight(1, info),
        `${badge}: an uncontested badge is provisionally believed`,
      );
      // A seat that has shown the room nothing is discounted for it, and more
      // so in the first days when nobody has had the chance.
      assert.ok(
        claimerWeight(1, info) < 1,
        "and a stranger is only a stranger",
      );
    }
  });

  it("and none once somebody else claims the same badge", () => {
    const state = table(["citizen", "citizen", "mafioso", "citizen"], 3);
    const claims: Claim[] = [
      claim({
        claimerSlot: 2,
        targetSlot: 2,
        kind: "role-claim",
        claimedRole: "sheriff",
      }),
      claim({
        claimerSlot: 3,
        targetSlot: 3,
        kind: "role-claim",
        claimedRole: "sheriff",
      }),
    ];
    const info = toPublicInfo(state, claims, []);
    assert.equal(
      claimerWeight(2, info),
      claimerWeight(1, info),
      "two sheriffs is at least one liar",
    );
  });
});

describe("what the killers leave standing", () => {
  /**
   * The oldest instinct in the game, and the one this file did not have: a
   * family does not knife the seat that stood up at a brother's trial and voted
   * to spare him. See `friendlySeats`.
   */
  it("spares the seat that voted innocent on one of ours", () => {
    const state = table(
      ["mafioso", "mafioso", "citizen", "citizen", "citizen", "doctor"],
      4,
    );
    // Slot 2 was tried and spared; 3 voted innocent, 4 voted guilty.
    state.trialLog = [
      {
        day: 3,
        accusedId: "s2",
        lynched: false,
        guiltyIds: ["s4"],
        innocentIds: ["s3"], abstainIds: [],
      },
    ];
    const info = toPublicInfo(state, [], []);
    const self = playerBySlot(state, 1)!;

    const friends = friendlySeats(self, info, new Set([2]));
    assert.ok(
      friends.has(3),
      "the seat that voted to spare a brother is a friend",
    );
    assert.ok(!friends.has(4), "and the one that voted to hang him is not");
  });

  it("and counts an accusation against us as the opposite of a favour", () => {
    const state = table(
      ["mafioso", "mafioso", "citizen", "citizen", "citizen", "doctor"],
      4,
    );
    state.trialLog = [
      {
        day: 3,
        accusedId: "s2",
        lynched: false,
        guiltyIds: [],
        innocentIds: ["s3"], abstainIds: [],
      },
    ];
    const claims: Claim[] = [
      claim({ claimerSlot: 3, targetSlot: 1, kind: "accuse", day: 4 }),
    ];
    const info = toPublicInfo(state, claims, []);
    const self = playerBySlot(state, 1)!;

    const friends = friendlySeats(self, info, new Set([2]));
    assert.ok(
      !friends.has(3),
      "one innocent ballot does not buy a seat the right to name us",
    );
  });

  /**
   * A butcher has no family, so the question is asked of a side of one: the
   * seats that spoke for *it*.
   */
  it("lets a lone killer keep the seats that defended it", () => {
    const state = table(
      ["serial-killer", "citizen", "citizen", "citizen", "doctor"],
      4,
    );
    state.trialLog = [
      {
        day: 3,
        accusedId: "s1",
        lynched: false,
        guiltyIds: ["s3"],
        innocentIds: ["s2"], abstainIds: [],
      },
    ];
    const info = toPublicInfo(state, [], []);
    const self = playerBySlot(state, 1)!;

    const friends = friendlySeats(self, info, new Set());
    assert.ok(
      friends.has(2),
      "the seat that voted to spare the butcher is worth keeping",
    );
    assert.ok(!friends.has(3), "the one that voted to hang it is not");
  });
});

describe("the witch learns by doing", () => {
  /**
   * Every control is an experiment with a published result: she is told whether
   * the hand held an order, she chose where it went, and the morning says who
   * died. A hand that produced a corpse is a hand holding a knife, and she goes
   * back to it. Before this she picked uniformly at random, all game.
   */
  const witchTable = (): MafiaState => {
    const state = table(
      ["witch", "citizen", "citizen", "citizen", "citizen", "doctor"],
      4,
    );
    return state;
  };

  it("returns to the hand that produced a corpse", () => {
    const state = witchTable();
    const witch = playerBySlot(state, 1)!;
    // Night 2: took 4's hand, sent it at 6. Night 3: took 3's hand, sent it at 5.
    witch.intel = [
      {
        night: 2,
        kind: "controlled",
        targetSlot: 4,
        value: "sent",
        slots: [6],
      },
      {
        night: 3,
        kind: "controlled",
        targetSlot: 3,
        value: "sent",
        slots: [5],
      },
    ];
    // Only 6 died, and on the night 4's hand was pointed at it.
    const victim = state.players.s6;
    victim.alive = false;
    state.deaths = [
      {
        playerId: "s6",
        day: 2,
        phase: "night",
        cause: { key: "x" },
        source: "mafia",
      },
    ] as never;

    const info = toPublicInfo(state, [], []);
    const brain = makeBrain(1, { ...DEFAULT_PROFILE });
    bindPersonalities([brain]);

    // Deterministic dice: always take the first ranked choice.
    const picks = new Set<number | null>();
    for (let i = 0; i < 40; i++) {
      picks.add(
        decideNightTarget(
          witch,
          brain,
          info,
          [2, 3, 4, 5],
          "control",
          new Set(),
          [],
          () => 0.01,
        ),
      );
    }
    assert.deepEqual(
      [...picks],
      [4],
      "she goes back to the hand the corpse came out of",
    );
  });

  it("and tries a hand she has never held before trying an empty one", () => {
    const state = witchTable();
    const witch = playerBySlot(state, 1)!;
    // 3 was empty, 4 was never tried, and nobody has died.
    witch.intel = [
      { night: 2, kind: "controlled", targetSlot: 3, value: "idle" },
    ];

    const info = toPublicInfo(state, [], []);
    const brain = makeBrain(1, { ...DEFAULT_PROFILE });
    bindPersonalities([brain]);

    for (let i = 0; i < 40; i++) {
      const pick = decideNightTarget(
        witch,
        brain,
        info,
        [3, 4],
        "control",
        new Set(),
        [],
        () => 0.01,
      );
      assert.equal(
        pick,
        4,
        "an untried hand teaches her something; an empty one does not",
      );
    }
  });
});

/**
 * The two roles that choose how to play, and keep the choice.
 *
 * Neither the Jester nor the Survivor has a side, so nothing about the game
 * says how they will vote — and a single scripted habit would, after a few
 * games. So each rolls a style once and plays it out. These pin the parts that
 * are deterministic: the roll sticks, the `scum` Jester's ballots are the
 * mafioso's, and a Survivor on a losing town rides the biggest wagon.
 */
describe("a style, chosen once", () => {
  const always = (value: number) => () => value;

  it("sticks to the brain for the whole game", () => {
    const state = table(["jester", "citizen", "citizen"]);
    const jester = playerBySlot(state, 1)!;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const first = styleOf(jester, brain, always(0.9));
    assert.equal(first, "scum", "a high roll is the scum jester");
    assert.equal(
      styleOf(jester, brain, always(0.1)),
      first,
      "and the next roll changes nothing",
    );
    assert.equal(
      styleOf(
        playerBySlot(state, 2)!,
        makeBrain(2, DEFAULT_PROFILE),
        always(0.9),
      ),
      null,
      "a citizen has no style",
    );
  });

  it("gives the scum jester the bus driver's ballot", () => {
    const state = table(
      ["jester", "citizen", "mafioso", "citizen", "citizen"],
      3,
    );
    const jester = playerBySlot(state, 1)!;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    brain.style = "scum";
    const board = toPublicInfo(state, [], []);

    // The room has the mafioso's badge on him; the jester votes to spare him.
    const caught: PublicInfo = {
      ...board,
      provenRoles: new Map([[3, "mafioso"]]),
    };
    assert.equal(
      decideBallot(jester, brain, caught, 3, new Set(), always(0.5)),
      "innocent",
    );

    // Nothing on the citizen at all; the jester votes to hang him.
    assert.equal(
      decideBallot(jester, brain, board, 2, new Set(), always(0.5)),
      "guilty",
    );
  });

  it("reads the tide off the graveyard and the clock", () => {
    const losing = table(
      ["survivor", "citizen", "citizen", "mafioso", "citizen"],
      4,
    );
    assert.equal(
      tide(toPublicInfo(losing, [], [])),
      "evil",
      "five alive with two evils expected is parity",
    );

    const winning = table(
      [
        "survivor",
        "citizen",
        "citizen",
        "mafioso",
        "citizen",
        "citizen",
        "citizen",
        "citizen",
      ],
      6,
    );
    const board: PublicInfo = {
      ...toPublicInfo(winning, [], []),
      totalDead: 4,
      deadRoles: new Map<number, RoleId>([
        [9, "mafioso"],
        [10, "consort"],
        [11, "serial-killer"],
      ]),
      lastNightDeathSlots: new Set<number>(),
    };
    assert.equal(
      tide(board),
      "town",
      "three of four expected evils buried and a quiet clock",
    );
  });

  /**
   * The square and the booth, made to agree at the bell.
   *
   * Reported from a real table: three seats alive, one of them the killer, and
   * the town put him on the stand nine times across three days and acquitted
   * him every time. `pickVote` returns its top suspect unconditionally at full
   * pressure and `decideBallot` did not, so the two halves of the same seat
   * voted opposite ways on the same board, all afternoon.
   */
  it("votes guilty at the parity bell unless it is holding a better name", () => {
    const state = table(["citizen", "doctor", "serial-killer"], 8);
    const juror = playerBySlot(state, 1)!;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    // Three alive with an evil still out there: the parity clock is at the bell.
    const board: PublicInfo = {
      ...toPublicInfo(state, [], []),
      totalDead: 12,
      day: 8,
    };
    assert.equal(parityPressure(board), 1, "three alive, one evil expected");

    assert.equal(
      decideBallot(juror, brain, board, 3, new Set(), always(0.5)),
      "guilty",
      "nothing on either of them, and the one on the stand is as good a name as the other",
    );

    /**
     * And the acquittal that is still allowed: a juror holding something real
     * about somebody else says so with its ballot, and nominates them next.
     */
    const elsewhere: PublicInfo = {
      ...board,
      claims: [
        claim({
          claimerSlot: 2,
          targetSlot: 2,
          kind: "account",
          account: "home",
          day: 8,
        }),
        claim({ claimerSlot: 1, targetSlot: 2, kind: "sighting", day: 8 }),
      ],
    };
    assert.equal(
      decideBallot(juror, brain, elsewhere, 3, new Set(), always(0.5)),
      "innocent",
      "a caught liar in the other chair is a better name than the one standing there",
    );
  });

  /**
   * And the loop itself: the same seat, tried again on the same evidence.
   */
  it("does not put a seat acquitted today back on the stand with nothing new", () => {
    const state = table(["citizen", "doctor", "serial-killer"], 8);
    const voter = playerBySlot(state, 1)!;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const board: PublicInfo = {
      ...toPublicInfo(state, [], []),
      totalDead: 12,
      day: 8,
    };

    const picked = decideDay(
      voter,
      brain,
      board,
      new Set(),
      new Set(),
      always(0.5),
    ).voteSlot;
    assert.notEqual(picked, null, "at the bell the town must name somebody");
    const first = picked!;

    const tried: PublicInfo = {
      ...board,
      trials: [
        {
          day: 8,
          accusedSlot: first,
          lynched: false,
          guiltySlots: [],
          innocentSlots: [1, 2, 3], abstainSlots: [],
        },
      ],
    };
    assert.notEqual(
      decideDay(voter, brain, tried, new Set(), new Set(), always(0.5))
        .voteSlot,
      first,
      "the room asked that question today and got its answer",
    );

    /**
     * Hard evidence reopens it, because that is a different question.
     */
    const confessed: PublicInfo = {
      ...tried,
      claims: [
        claim({
          claimerSlot: first,
          targetSlot: first,
          kind: "account",
          account: "home",
          day: 8,
        }),
        claim({ claimerSlot: 3, targetSlot: first, kind: "sighting", day: 8 }),
      ],
    };
    assert.equal(
      decideDay(voter, brain, confessed, new Set(), new Set(), always(0.5))
        .voteSlot,
      first,
      "caught out since the acquittal is new, and it is allowed back on the stand",
    );
  });

  /**
   * Two Jailors at a chaos table, which is still two Jailors.
   *
   * A chaos or census roster is published as "any" in every slot, because any
   * slot really could be anything — so counting the roster gives every role as
   * many possible copies as there are seats, and no two claimants can ever
   * contradict each other. The dealer says otherwise: it refuses to deal a
   * second Jailor whatever the mode. Caught on a live chaos table where two
   * seats wore badges nobody can wear twice and the board said nothing.
   */
  it("still catches a doubled unique badge when the roster says anything goes", () => {
    const state = table(
      ["citizen", "jailor", "doctor", "mafioso", "citizen"],
      4,
    );
    state.config.setup = { mode: "chaos" };
    const reader = playerBySlot(state, 1)!;
    const board = toPublicInfo(
      state,
      [
        claim({
          claimerSlot: 2,
          targetSlot: 2,
          kind: "role-claim",
          claimedRole: "jailor",
          day: 3,
        }),
        claim({
          claimerSlot: 3,
          targetSlot: 3,
          kind: "role-claim",
          claimedRole: "jailor",
          day: 3,
        }),
      ],
      [],
    );
    assert.equal(
      copiesOf(board, "jailor"),
      1,
      "the dealer never deals two, whatever the roster says",
    );
    assert.ok(
      suspicionParts(2, reader, board, always(0.5)).hard >= 1.5,
      "so one of the two is lying, and it is hard evidence",
    );

    // And a role the deal really can hold twice is not a contest at all.
    assert.ok(copiesOf(board, "citizen") > 1);
  });

  it("puts a survivor on the biggest wagon once the town is losing", () => {
    const state = table(
      ["survivor", "citizen", "citizen", "mafioso", "citizen"],
      4,
    );
    const survivor = playerBySlot(state, 1)!;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    brain.style = "careful";
    const board: PublicInfo = {
      ...toPublicInfo(state, [], []),
      votes: new Map<number, number>([
        [2, 3],
        [5, 3],
        [4, 2],
      ]),
    };
    assert.equal(tide(board), "evil");
    const decision = decideDay(
      survivor,
      brain,
      board,
      new Set(),
      new Set(),
      always(0.5),
    );
    assert.equal(
      decision.voteSlot,
      3,
      "two votes on 3 beat one on 2, whoever 3 is",
    );
    assert.equal(
      decideBallot(survivor, brain, board, 2, new Set(), always(0.5)),
      "guilty",
      "and any hanging ends it sooner",
    );
  });
});

/**
 * The other half of the acquittal rule, which had no test and no answer.
 *
 * The filter above is right that a seat tried and released today is a question
 * already asked. It was also the only thing standing between the town and a
 * null vote at the parity bell, where a null vote is the game.
 */
describe("the bell overrides the acquittal filter, but only when it must", () => {
  const always = (value: number) => () => value;
  it("still names somebody when every living seat was acquitted today", () => {
    const state = table(["citizen", "doctor", "serial-killer"], 8);
    const voter = playerBySlot(state, 1)!;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const board: PublicInfo = {
      ...toPublicInfo(state, [], []),
      totalDead: 12,
      day: 8,
    };

    // Everybody the voter could name has already stood today and been released,
    // and nothing hard came out of any of it.
    const others = board.aliveSlots.filter((slot) => slot !== voter.slot);
    const exhausted: PublicInfo = {
      ...board,
      trials: others.map((slot) => ({
        day: 8,
        accusedSlot: slot,
        lynched: false,
        guiltySlots: [],
        innocentSlots: [...board.aliveSlots], abstainSlots: [],
      })),
    };

    assert.notEqual(
      decideDay(voter, brain, exhausted, new Set(), new Set(), always(0.5))
        .voteSlot,
      null,
      "a town that names nobody at the bell does not skip, it spends the day, and that is the game",
    );
  });
});

describe("the shortlist an examiner’s line actually narrows to", () => {
  /**
   * The bug this covers, in one line: a badge that has no night cannot leave a
   * smell, so listing it as a suspect is inventing a possibility the engine
   * will never produce.
   */
  it("drops the badges that have no night to be caught on", () => {
    assert.deepEqual(
      tradeSuspects("hands"),
      ["godfather", "dragon-head"],
      "the Mayor, the Marshall, the Crier and the Judge never act, so they never shake anybody’s hand at night",
    );
    assert.deepEqual(tradeSuspects("blade"), ["mass-murderer"]);
    assert.ok(!tradeSuspects("watcher").includes("spy"));
    assert.ok(!tradeSuspects("rough").includes("mason"));
  });

  /**
   * And the point of doing it: the one line in the game that can only be a
   * family leader was being read out as a six-way shrug with three town badges
   * in it, which is a conviction thrown away every time it came up.
   */
  it("turns the leaders’ line into the conviction it always was", () => {
    assert.equal(tradeVerdict("hands"), "damning");
    assert.equal(tradeVerdict("blade"), "damning");
  });

  /** The alert is a night's work, so the Veteran stays honest company on it. */
  it("keeps the veteran on the gunpowder", () => {
    assert.ok(tradeSuspects("powder").includes("veteran"));
  });

  /**
   * A line nobody can produce is not evidence of anything. The Stump and the
   * Jester wear one each and neither has a night, so both stay shrugs rather
   * than convictions built on a role that could not have been there.
   */
  it("refuses to convict on a smell nobody can leave", () => {
    assert.deepEqual(tradeSuspects("dirt"), []);
    assert.deepEqual(tradeSuspects("laugh"), []);
    assert.equal(tradeVerdict("dirt"), "mixed");
    assert.equal(tradeVerdict("laugh"), "mixed");
  });

  /** And the quiet line is the absence of a shortlist, never a clean one. */
  it("hands out no shortlist at all for a quiet night", () => {
    assert.deepEqual(tradeSuspects("quiet"), []);
    assert.equal(tradeVerdict("quiet"), "mixed");
  });

  /** The roster still cuts it further, and still never cuts it to nothing. */
  it("crosses off what this table was never dealt", () => {
    const noVigilante = new Set<RoleId>([
      "veteran",
      "mafioso",
      "citizen",
      "doctor",
    ]);
    assert.deepEqual(tradeSuspects("powder", noVigilante), [
      "veteran",
      "mafioso",
    ]);
    assert.deepEqual(
      tradeSuspects("rope", new Set<RoleId>(["citizen"])),
      ["kidnapper", "interrogator"],
      "a roster that explains nothing allows everything: a shortlist is never cut to nothing",
    );
  });
});

describe("a family in the booth", () => {
  /**
   * The booth read `faction === 'mafia'`, which is twelve Triad roles and two
   * Cult roles short of what it meant. Everybody else fell through into the
   * town's own reasoning — reasonable doubt, the defence weight, the lot — so a
   * Triad enforcer sat there weighing whether the case against a townsperson
   * was really strong enough, and acquitted him, while its own side was trying
   * to hang him.
   */
  it("votes guilty on an outsider whatever family it belongs to", () => {
    const state = table([
      "citizen",
      "enforcer",
      "mafioso",
      "doctor",
      "sheriff",
      "cultist",
    ]);
    const info = toPublicInfo(state, [], []);

    for (const slot of [2, 3, 6]) {
      const self = playerBySlot(state, slot)!;
      const brain = makeBrain(slot, DEFAULT_PROFILE);
      assert.equal(
        decideBallot(self, brain, info, 1, new Set(), () => 0.5),
        "guilty",
        `a ${self.role} acquitted a stranger on the stand`,
      );
    }
  });

  /** And a brother on the stand is still the branch above, for all three. */
  it("does not hang its own on a thin case", () => {
    const state = table(["citizen", "enforcer", "enforcer", "doctor", "sheriff"]);
    const info = toPublicInfo(state, [], []);
    const self = playerBySlot(state, 2)!;
    const brain = makeBrain(2, DEFAULT_PROFILE);
    assert.notEqual(
      decideBallot(self, brain, info, 3, new Set([3]), () => 0.9),
      "guilty",
    );
  });
});

/**
 * The lodge in the booth, which is the opposite job.
 *
 * `teammates` holds the masons as well as the families, and everything the
 * family branch does — hide, count the room, never cast the ballot that marks
 * you — is exactly wrong for the one bloc that has nothing to hide and knows
 * for a fact that the accused is town.
 */
describe("the lodge in the booth", () => {
  it("vouches for a brother whatever the room has decided", () => {
    const state = table(["mason-leader", "mason", "mafioso", "doctor", "sheriff", "citizen"]);
    const info = toPublicInfo(state, [], []);

    for (const slot of [1, 2]) {
      const self = playerBySlot(state, slot)!;
      if (self.role !== "mason" && self.role !== "mason-leader") continue;
      const brother = slot === 1 ? 2 : 1;
      const brain = makeBrain(slot, DEFAULT_PROFILE);
      assert.equal(
        decideBallot(self, brain, info, brother, new Set([brother]), () => 0.9),
        "innocent",
        `a ${self.role} let the room hang a seat it knows to be town`,
      );
    }
  });

  /** And it is about the lodge, not about anybody who happens to be an ally. */
  it("still weighs a stranger the ordinary way", () => {
    const state = table(["mason-leader", "mason", "mafioso", "doctor", "sheriff", "citizen"]);
    const info = toPublicInfo(state, [], []);
    const self = playerBySlot(state, 1)!;
    if (self.role !== "mason-leader") return;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    assert.notEqual(
      decideBallot(self, brain, info, 3, new Set([2]), () => 0.5),
      "abstain",
      "a mason in the booth still has an opinion about everybody else",
    );
  });
});

describe("the blades that are not ours", () => {
  /**
   * The families hunted the town and nothing but the town. A rival counted for
   * exactly what the square happened to think of it, so a quiet Serial Killer
   * was, to a Mafioso, an ordinary neighbour to be weighed against the day's
   * wagon — and the wagon wins, because the wagon is on a townsperson. Three
   * sides raced to the same parity and only one was playing to remove the
   * others.
   */
  const board = (state: MafiaState): PublicInfo => toPublicInfo(state, [], []);

  it("reads a rival off the family's own examiner", () => {
    const state = table([
      "mafioso",
      "consigliere",
      "serial-killer",
      "citizen",
      "doctor",
      "witch",
    ]);
    const ours = new Set([1, 2]);
    const self = playerBySlot(state, 2)!;

    assert.equal(
      rivalThreat(self, 3, board(state), ours),
      0,
      "a seat nothing is known about is not a rival",
    );

    self.intel = [
      { night: 1, kind: "role", targetSlot: 3, value: "serial-killer" },
    ];
    assert.ok(
      rivalThreat(self, 3, board(state), ours) > 0,
      "the card the family paid a night to read moved nothing",
    );

    self.intel = [{ night: 1, kind: "role", targetSlot: 4, value: "citizen" }];
    assert.equal(
      rivalThreat(self, 4, board(state), ours),
      0,
      "a townsperson read correctly is not a rival",
    );
  });

  /** The Witch kills nobody and costs the family brothers all the same. */
  it("counts the neutrals that take a night off the family", () => {
    const state = table([
      "mafioso",
      "consigliere",
      "serial-killer",
      "citizen",
      "doctor",
      "witch",
    ]);
    const self = playerBySlot(state, 2)!;
    self.intel = [{ night: 1, kind: "role", targetSlot: 6, value: "witch" }];
    assert.ok(rivalThreat(self, 6, board(state), new Set([1, 2])) > 0);
  });

  it("never reads one of ours as one of theirs", () => {
    const state = table(["mafioso", "godfather", "serial-killer", "citizen"]);
    const self = playerBySlot(state, 1)!;
    self.intel = [{ night: 1, kind: "role", targetSlot: 2, value: "godfather" }];
    assert.equal(
      rivalThreat(self, 2, board(state), new Set([1, 2])),
      0,
      "a brother is not a rival however armoured he is",
    );
  });

  it("says nothing at all to a seat with no family", () => {
    const state = table(["citizen", "sheriff", "serial-killer", "doctor"]);
    const self = playerBySlot(state, 2)!;
    self.intel = [
      { night: 1, kind: "role", targetSlot: 3, value: "serial-killer" },
    ];
    assert.equal(
      rivalThreat(self, 3, board(state), new Set([2])),
      0,
      "this is the family's read and nobody else's",
    );
  });

  /**
   * And the whole point of it: the rope reaches the seats the knife cannot.
   * Nearly everything worth calling a rival shrugs a knife off in the dark, so
   * the day vote is the only tool a family has against one.
   */
  /**
   * The ballot, where the read has to actually beat something.
   *
   * A family knife that comes back blunted off a door is the narrowest thing a
   * Mafioso can know and the one the town can never hold: almost everything
   * wearing armour at night is a rival blade, and the family can cross its own
   * leader off the list. It was worth 1.2 and lost to any wagon the town had
   * started, so the seat the family *knew* about went on living while the
   * family helped hang a Citizen.
   */
  /**
   * An afternoon arguing about house 4: three seats have said so out loud and
   * `voters` of them have actually moved a ballot onto it.
   */
  const wagonOf = (
    voters: number[],
  ): { state: MafiaState; self: MafiaPlayer; claims: Claim[] } => {
    const state = table(
      [
        "mafioso",
        "consigliere",
        "serial-killer",
        "citizen",
        "doctor",
        "sheriff",
        "lookout",
      ],
      4,
    );
    for (const voter of voters) state.votes[`s${voter}`] = "s4";
    // The room built this wagon on something: one of the three read out a
    // night. A wagon of pure hunches is worth almost nothing now, which is the
    // point of `grounding` and not what this fixture is about.
    const claims = [5, 6, 7].map((accuser) =>
      claim({
        day: 4,
        claimerSlot: accuser,
        targetSlot: 4,
        kind: "accuse",
        ...(accuser === 5 ? { from: "sheriff" as const, worked: true } : {}),
      }),
    );
    return { state, self: playerBySlot(state, 2)!, claims };
  };

  const votes = (fixture: {
    state: MafiaState;
    self: MafiaPlayer;
    claims: Claim[];
  }): number | null => {
    const brain = makeBrain(2, DEFAULT_PROFILE);
    bindPersonalities([brain]);
    return decideDay(
      fixture.self,
      brain,
      toPublicInfo(fixture.state, fixture.claims, []),
      new Set([1]),
      new Set([1]),
      () => 0.5,
    ).voteSlot;
  };

  it("pushes the rope at the door its knife bounced off", () => {
    const blind = wagonOf([5]);
    assert.equal(
      votes(blind),
      4,
      "with nothing of its own, the family follows the room",
    );

    const knowing = wagonOf([5]);
    knowing.self.bounced = [3];
    assert.equal(
      votes(knowing),
      3,
      "the family helped hang a townie with an armoured door in front of it",
    );
  });

  /**
   * And it is a preference, not an obsession. A wagon the town has nearly
   * finished is the cheapest afternoon a family ever gets, and walking away
   * from one to open a fresh case on a seat nobody else suspects costs more
   * than it buys: the rival keeps until tomorrow, the free hanging does not.
   */
  it("still takes a hanging the town has nearly finished", () => {
    const nearly = wagonOf([5, 6, 7]);
    nearly.self.bounced = [3];
    assert.equal(votes(nearly), 4);
  });
});

/**
 * What a seat gets for free from the people it already knows about.
 *
 * `pickVote` refused to nominate a teammate and `decideBallot` acquitted one, so
 * the ballot was always safe. Everything in between was not: a mason would name
 * his brother in the square, argue against him and rank him top of the night
 * list, then decline to vote for the seat he had spent the afternoon accusing.
 */
describe("the trust a seat does not have to earn", () => {
  const board = (state: MafiaState) => toPublicInfo(state, [], []);

  function reading(allies: number[], bond: "lover" | "charm" | null = null): number {
    const state = table(["mason-leader", "mason", "citizen", "citizen", "godfather"]);
    const judge = playerBySlot(state, 1)!;
    judge.bondKind = bond;
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    return suspicionParts(2, judge, board(state), () => 0, new Set(allies)).evidence;
  }

  it("hands a known brother a flat credit a stranger does not get", () => {
    const stranger = reading([]);
    const brother = reading([2]);
    assert.ok(brother < stranger - 4, `the lodge should be worth ${ALLY_TRUST}, got ${stranger - brother}`);
  });

  /**
   * A lover wins with their partner whoever else wins, so the side they were
   * dealt stops being the side they are certainly playing for. Read off the
   * seat's own bond, which is the only one it can honestly know about.
   */
  it("withholds it from a seat whose heart is in another room", () => {
    assert.equal(reading([2], "lover"), reading([], "lover"), "a bonded seat extends nothing for free");
    assert.ok(reading([2], "charm") < reading([], "charm"), "a charm is not a bond");
  });

  it("gives the same credit to a sash the engine vouched for", () => {
    const state = table(["sheriff", "mayor", "citizen", "citizen", "godfather"]);
    const judge = playerBySlot(state, 1)!;
    const mayor = playerBySlot(state, 2)!;
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);

    const before = suspicionParts(2, judge, board(state), () => 0).evidence;
    mayor.revealed = true;
    const after = suspicionParts(2, judge, board(state), () => 0).evidence;
    assert.ok(after < before, "a revealed sash cannot be faked, and the square should stop hunting it");
  });
});

/**
 * A verdict is a reading of a case, not a doorway you are either side of.
 *
 * The booth used to hold two hard thresholds with a coin flip between them: at
 * or above 1.2 a juror hanged you every time, at or below 0.4 it acquitted you
 * every time, and in between it ignored the score entirely and rolled against
 * its own temperament. So 1.19 and 1.21 were different games, while 0.45 and
 * 1.19 — nothing like the same case — were treated identically.
 */
describe("the jury reads a spectrum", () => {
  const always = (value: number) => () => value;

  /** How often a juror convicts on a case of this weight, over the whole dial. */
  function convictions(accusers: number): number {
    const state = table(["citizen", "citizen", "citizen", "citizen", "godfather"], 3);
    const juror = playerBySlot(state, 1)!;
    bindPersonalities([makeBrain(juror.slot, HERD_HALF)]);

    // A wagon of the given size, which is the cheapest way to move the score.
    const claims: Claim[] = [];
    for (let accuser = 0; accuser < accusers; accuser++) {
      claims.push(claim({ claimerSlot: 3 + (accuser % 2), targetSlot: 2, kind: "accuse", day: 3 + accuser }));
    }
    const board = toPublicInfo(state, claims, []);

    let guilty = 0;
    const rolls = 400;
    for (let roll = 0; roll < rolls; roll++) {
      const at = (roll + 0.5) / rolls;
      if (decideBallot(juror, makeBrain(1, DEFAULT_PROFILE), board, 2, new Set(), always(at)) === "guilty") guilty++;
    }
    return guilty / rolls;
  }

  it("moves the odds by degrees instead of crossing a line", () => {
    const thin = convictions(0);
    const some = convictions(1);
    const plenty = convictions(3);

    assert.ok(thin <= some, `a bigger case should not convict less: ${thin} then ${some}`);
    assert.ok(some <= plenty, `and more of it should convict more: ${some} then ${plenty}`);
    assert.ok(plenty > thin, `the dial has to actually move, got ${thin} to ${plenty}`);
    // The point of the curve: neither end is a certainty the moment it is crossed.
    assert.ok(plenty < 1 || thin > 0, "a spectrum has somewhere in the middle");
  });
});

/**
 * The Triad is the Mafia in a different coat, and hostile to it.
 *
 * Nothing in the policy names either family: everything routes through
 * `familyOf`, which answers the same way for `mafia`, `triad` and `cult`. That
 * is the design, and this holds it down, because the cheapest way to break it
 * is to write one branch that says `'mafia'` somewhere and never notice that
 * half the roster now plays differently.
 */
describe("the triad is a family like the other one", () => {
  const board = (state: MafiaState) => toPublicInfo(state, [], []);

  /** What one seat's arithmetic makes of another, given who it knows. */
  function reading(roles: RoleId[], judgeSlot: number, aboutSlot: number, allies: number[]): number {
    const state = table(roles, 3);
    const judge = playerBySlot(state, judgeSlot)!;
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    return suspicionParts(aboutSlot, judge, board(state), () => 0, new Set(allies)).evidence;
  }

  const cast: RoleId[] = ['godfather', 'mafioso', 'dragon-head', 'enforcer', 'citizen', 'sheriff'];

  it("gives a brother the same free trust either family gets", () => {
    const mafiaOnBrother = reading(cast, 1, 2, [2]) - reading(cast, 1, 2, []);
    const triadOnBrother = reading(cast, 3, 4, [4]) - reading(cast, 3, 4, []);
    assert.ok(mafiaOnBrother < -4, `the family should be worth ${ALLY_TRUST}, got ${-mafiaOnBrother}`);
    assert.ok(
      Math.abs(mafiaOnBrother - triadOnBrother) < 0.001,
      `the two families must price a brother identically: ${mafiaOnBrother} against ${triadOnBrother}`
    );
  });

  it("does not hand the other family a brother's credit", () => {
    // A Dragon Head is not on the Godfather's list, and knows it is not.
    assert.equal(reading(cast, 1, 3, [2]), reading(cast, 1, 3, []), 'the triad is not the mafia');
    assert.equal(reading(cast, 3, 1, [4]), reading(cast, 3, 1, []), 'and the mafia is not the triad');
  });

  it("reads both families as their own side, and neither as town", () => {
    for (const role of ['godfather', 'mafioso', 'dragon-head', 'enforcer'] as RoleId[]) {
      assert.equal(familyOf(role) !== null, true, `${role} belongs to a family`);
      assert.equal(isEvilRole(role), true, `${role} is evil`);
    }
    assert.equal(familyOf('godfather'), 'mafia');
    assert.equal(familyOf('dragon-head'), 'triad');
    // Same side as their own, opposite sides to each other. See `sameCause`.
    assert.equal(sameCause('godfather', 'mafioso'), true);
    assert.equal(sameCause('dragon-head', 'enforcer'), true);
    assert.equal(sameCause('godfather', 'dragon-head'), false);
  });
});
