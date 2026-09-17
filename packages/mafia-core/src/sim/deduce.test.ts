import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import { deductions, deductionWeight, type Deduction } from './deduce.js';
import type { Claim, PublicInfo } from './policies.js';

/**
 * A board built by hand, because these are arithmetic tests.
 *
 * Every finding in `deduce.ts` is a statement about the morning report, the
 * roster and the claims board, so a test that spun up a real game would be
 * testing the simulator's luck. What it needs instead is exactly those three
 * things, set to the awkward value.
 */
function board(parts: Partial<PublicInfo> = {}): PublicInfo {
  return {
    day: 4,
    aliveSlots: [1, 2, 3, 4, 5],
    deadRoles: new Map(),
    lastNightDeathSlots: new Set(),
    nightDeathsTotal: 0,
    rampage: 0,
    votes: new Map(),
    totalDead: 0,
    trials: [],
    voteHistory: [],
    revealedMayorSlot: null,
    humanSlots: new Set(),
    trialSlot: null,
    claims: [],
    deaths: [],
    provenRoles: new Map(),
    rolesInPlay: new Set<RoleId>(['jailor', 'doctor', 'bodyguard', 'poisoner', 'mafioso', 'citizen', 'sheriff']),
    ...parts
  };
}

const said = (parts: Partial<Claim> & Pick<Claim, 'claimerSlot' | 'targetSlot' | 'kind'>): Claim => ({
  day: 2,
  truthful: false,
  ...parts
});

/** Just the kinds, which is what every assertion below is actually about. */
const kinds = (found: Deduction[]): string[] => found.map((entry) => entry.kind).sort();

describe('reading the night back to people', () => {
  it('finds nothing to say about a seat that has said nothing', () => {
    assert.deepEqual(deductions(3, board()), []);
    assert.equal(deductionWeight([]), 0);
  });

  /**
   * The one the whole layer was built for, and the sentence the user asked for
   * by name: "5 claimed to be poisoned yet he is not dead, did a doctor heal
   * him? If not let us vote him."
   */
  it('remembers that poison kills at the second dawn', () => {
    const poisoned = said({ claimerSlot: 5, targetSlot: 5, kind: 'ailing', ailment: 'poison', day: 2, night: 1 });

    const sameAfternoon = board({ day: 2, claims: [poisoned] });
    assert.deepEqual(kinds(deductions(5, sameAfternoon)), [], 'the claim has not come due yet');

    const nextDay = board({ day: 3, claims: [poisoned] });
    assert.deepEqual(kinds(deductions(5, nextDay)), [], 'nor the morning after, which is when it would kill');

    const twoDawnsOn = board({ day: 4, claims: [poisoned] });
    assert.deepEqual(kinds(deductions(5, twoDawnsOn)), ['poison-survived'], 'still standing, so it was never true');
  });

  it('and lets a doctor settle it, from either side', () => {
    const poisoned = said({ claimerSlot: 5, targetSlot: 5, kind: 'ailing', ailment: 'poison', day: 2, night: 1 });

    const saidCured = board({
      day: 4,
      claims: [poisoned, said({ claimerSlot: 5, targetSlot: 5, kind: 'ailing', ailment: 'healed', day: 3, night: 2 })]
    });
    assert.deepEqual(kinds(deductions(5, saidCured)), [], 'the patient says it was purged');

    const doctorSpoke = board({
      day: 4,
      claims: [poisoned, said({ claimerSlot: 2, targetSlot: 5, kind: 'account', account: 'visited', day: 2, night: 1 })]
    });
    assert.deepEqual(kinds(deductions(5, doctorSpoke)), [], 'somebody says they called on that house');
  });

  /**
   * The cheapest check in the game, and nothing was doing it: a bodyguard who
   * steps in front of a knife is a corpse in the morning report.
   */
  it('knows a bodyguard who saved somebody is dead by morning', () => {
    const guarded = said({ claimerSlot: 3, targetSlot: 3, kind: 'ailing', ailment: 'guarded', day: 3, night: 2 });

    const quietNight = board({ claims: [guarded] });
    assert.deepEqual(kinds(deductions(3, quietNight)), ['guarded-nobody-died']);

    const somebodyDied = board({
      claims: [guarded],
      deaths: [{ slot: 4, day: 2, phase: 'night', source: 'mafia' }]
    });
    assert.deepEqual(kinds(deductions(3, somebodyDied)), [], 'a corpse on that night is the whole proof');
  });

  it('will not let a seat call on a house whose owner was already buried', () => {
    const visited = said({ claimerSlot: 2, targetSlot: 4, kind: 'account', account: 'visited', day: 4, night: 3 });

    const stillAlive = board({ claims: [visited] });
    assert.deepEqual(kinds(deductions(2, stillAlive)), []);

    const buriedFirst = board({
      claims: [visited],
      deaths: [{ slot: 4, day: 2, phase: 'night', source: 'mafia' }]
    });
    assert.deepEqual(kinds(deductions(2, buriedFirst)), ['visited-a-corpse']);

    // Hanged on the afternoon of night 3: buried before the night, not during it.
    const hangedThatDay = board({
      claims: [visited],
      deaths: [{ slot: 4, day: 3, phase: 'day', source: null }]
    });
    assert.deepEqual(kinds(deductions(2, hangedThatDay)), ['visited-a-corpse']);

    // Killed *on* night 3 is no contradiction at all: the caller may be why.
    const diedThatNight = board({
      claims: [visited],
      deaths: [{ slot: 4, day: 3, phase: 'night', source: 'mafia' }]
    });
    assert.deepEqual(kinds(deductions(2, diedThatNight)), [], 'calling on somebody the night they died explains it');
  });

  it('holds two seats to one cell', () => {
    const one = said({ claimerSlot: 2, targetSlot: 2, kind: 'ailing', ailment: 'jailed', day: 3, night: 2 });
    const other = said({ claimerSlot: 5, targetSlot: 5, kind: 'ailing', ailment: 'jailed', day: 3, night: 2 });

    assert.deepEqual(kinds(deductions(2, board({ claims: [one] }))), [], 'one seat in the cell is the normal case');
    assert.deepEqual(kinds(deductions(2, board({ claims: [one, other] }))), ['two-in-one-cell']);
    assert.deepEqual(
      kinds(deductions(5, board({ claims: [one, other] }))),
      ['two-in-one-cell'],
      'and it lands on both'
    );

    const differentNights = board({
      claims: [one, said({ claimerSlot: 5, targetSlot: 5, kind: 'ailing', ailment: 'jailed', day: 4, night: 3 })]
    });
    assert.deepEqual(kinds(deductions(2, differentNights)), [], 'a jailor works every night');
  });

  it('and knows the cell has no door', () => {
    const jailed = said({ claimerSlot: 2, targetSlot: 2, kind: 'ailing', ailment: 'jailed', day: 3, night: 2 });
    const wentOut = said({ claimerSlot: 2, targetSlot: 4, kind: 'account', account: 'visited', day: 3, night: 2 });
    assert.deepEqual(kinds(deductions(2, board({ claims: [jailed, wentOut] }))), ['acted-from-the-cell']);

    const wentOutLater = said({ claimerSlot: 2, targetSlot: 4, kind: 'account', account: 'visited', day: 4, night: 3 });
    assert.deepEqual(kinds(deductions(2, board({ claims: [jailed, wentOutLater] }))), [], 'a different night is fine');
  });

  /**
   * The reader half of `couldStillAct`, which until now only ever helped the
   * liars pick a safe lie.
   */
  it('checks the reported effect against the published roster', () => {
    const doused = said({ claimerSlot: 3, targetSlot: 3, kind: 'ailing', ailment: 'douse', day: 3, night: 2 });

    const noArsonist = board({ claims: [doused] });
    assert.deepEqual(kinds(deductions(3, noArsonist)), ['impossible-ailment'], 'no arsonist on the list');

    const withArsonist = board({
      claims: [doused],
      rolesInPlay: new Set<RoleId>(['arsonist', 'citizen'])
    });
    assert.deepEqual(kinds(deductions(3, withArsonist)), []);

    const arsonistBuried = board({
      claims: [doused],
      rolesInPlay: new Set<RoleId>(['arsonist', 'citizen']),
      deadRoles: new Map<number, RoleId>([[4, 'arsonist']]),
      deaths: [{ slot: 4, day: 1, phase: 'night', source: 'mafia' }]
    });
    assert.deepEqual(
      kinds(deductions(3, arsonistBuried)),
      ['impossible-ailment'],
      'the only one who could was already in the ground that night'
    );

    /**
     * The half that matters more, because getting it wrong convicts honest
     * people: a claim is a lie if it was impossible *when it was made*, not if
     * it became impossible later. A seat doused on night 2 by an arsonist who
     * is killed on night 5 was still doused on night 2.
     */
    const arsonistDiedLater = board({
      claims: [doused],
      rolesInPlay: new Set<RoleId>(['arsonist', 'citizen']),
      deadRoles: new Map<number, RoleId>([[4, 'arsonist']]),
      deaths: [{ slot: 4, day: 3, phase: 'night', source: 'mafia' }]
    });
    assert.deepEqual(kinds(deductions(3, arsonistDiedLater)), [], 'a later death does not unmake an earlier night');

    const unknownRoster = board({ claims: [doused], rolesInPlay: undefined });
    assert.deepEqual(kinds(deductions(3, unknownRoster)), [], 'an unknown roster allows everything');
  });

  it('catches a badge the table never dealt', () => {
    const claimed = said({ claimerSlot: 3, targetSlot: 3, kind: 'role-claim', claimedRole: 'veteran', day: 3 });
    assert.deepEqual(kinds(deductions(3, board({ claims: [claimed] }))), ['role-not-in-play']);

    const dealt = board({ claims: [claimed], rolesInPlay: new Set<RoleId>(['veteran', 'citizen']) });
    assert.deepEqual(kinds(deductions(3, dealt)), []);
  });

  it('settles a promise the next dawn, and not before', () => {
    const promised = said({ claimerSlot: 4, targetSlot: 4, kind: 'promise', promise: 'night', day: 3 });

    assert.deepEqual(kinds(deductions(4, board({ day: 3, claims: [promised] }))), [], 'the night has not happened yet');
    assert.deepEqual(kinds(deductions(4, board({ day: 4, claims: [promised] }))), ['broken-promise']);

    const kept = board({ day: 4, claims: [promised], provenRoles: new Map<number, RoleId>([[4, 'crier']]) });
    assert.deepEqual(kinds(deductions(4, kept)), [], 'the record moved, which is what was promised');

    const dead = board({ day: 4, claims: [promised], aliveSlots: [1, 2, 3, 5] });
    assert.deepEqual(kinds(deductions(4, dead)), [], 'a seat killed overnight did not break anything');
  });

  it('lets a living seat deny words put in its mouth', () => {
    const relayed = said({ claimerSlot: 2, targetSlot: 5, kind: 'relay', relayedFrom: 3, day: 3 });

    assert.deepEqual(kinds(deductions(2, board({ claims: [relayed] }))), [], 'an unchallenged relay stands');

    const denied = board({
      claims: [relayed, said({ claimerSlot: 3, targetSlot: 2, kind: 'counter-claim', day: 3 })]
    });
    assert.deepEqual(kinds(deductions(2, denied)), ['relay-denied']);

    const deadSource = board({
      claims: [relayed, said({ claimerSlot: 3, targetSlot: 2, kind: 'counter-claim', day: 3 })],
      aliveSlots: [1, 2, 4, 5]
    });
    assert.deepEqual(kinds(deductions(2, deadSource)), [], 'a corpse cannot be cross-examined');
  });

  /**
   * The cap, which is what stops this layer becoming the only thing on the
   * board. Each finding is close to certain, so an uncapped pile would let one
   * careless afternoon outweigh a Sheriff's check.
   */
  it('caps the pile just above its heaviest single finding', () => {
    const one = deductionWeight([{ kind: 'role-not-in-play', role: 'veteran' }]);
    const several = deductionWeight([
      { kind: 'role-not-in-play', role: 'veteran' },
      { kind: 'guarded-nobody-died', night: 2 },
      { kind: 'acted-from-the-cell', night: 3 },
      { kind: 'poison-survived', night: 1 }
    ]);
    assert.ok(one >= 3, `the flattest lie should be worth a check, got ${String(one)}`);
    assert.ok(several <= 3.2, `four findings should not bury anybody, got ${String(several)}`);
    assert.ok(several > one, 'but more of them is still worse than one');
  });
});
