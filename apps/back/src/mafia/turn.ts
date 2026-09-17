import { legalNightAction, toMafiaView, type MafiaState } from 'mafia-core';

import type { Decision } from './bots.js';

/**
 * What a turn is allowed to be, checked against the engine rather than trusted.
 *
 * This is the whole of "the model decides and the engine refuses". The model is
 * handed the entire action space — say, vote, skip, night target and its second
 * house, verdict, the cell, the sash — and believed about none of it: every
 * field is checked against what this seat may actually do this second, using
 * the same calls the engine itself makes when the action arrives.
 *
 * Written as a per-field fallback rather than an all-or-nothing rejection, and
 * that choice is the interesting one. Handing the engine whatever came back and
 * letting it refuse is also safe, and it produces a seat that does *nothing* on
 * the turn it hallucinated — which is the failure that reads from the outside
 * as "the bots do not use their powers". Falling back field by field onto the
 * played brain's decision, which is always a complete legal turn, means a model
 * that gets its vote right and its night target wrong still casts the vote, and
 * the night still happens.
 *
 * Pure, and out here rather than on the driver, because the contract it
 * enforces is the one thing in the model mind that has to be right every time:
 * it is what stands between a hallucinated house number and the game state.
 */
export interface Vetted {
  decision: Decision;
  /** Every move that was asked for and refused, in words, for the trace. */
  refused: string[];
}

export function vetTurn(
  state: MafiaState,
  botId: string,
  /** What the model asked for, read for shape and not for legality. */
  wanted: Decision,
  /** The played brain's complete legal turn, which every field falls back to. */
  floor: Decision,
  /** Injectable so a test can put the clock where it needs it. See the ballot lock. */
  now: number = Date.now()
): Vetted {
  const bot = state.players[botId];
  const view = toMafiaView(state, { kind: 'player', playerId: botId });
  const me = view.me;
  if (!bot || !me) return { decision: floor, refused: [] };

  const refused: string[] = [];
  const alive = (slot: number | null): boolean =>
    slot !== null && Object.values(state.players).some((player) => player.alive && player.slot === slot);

  const decision: Decision = { ...floor, say: wanted.say, claim: wanted.claim, intent: floor.intent };

  if (view.phase === 'night') {
    /**
     * The night, where the legal set is small, exact and already computed.
     *
     * `legalNightAction` is the same call the engine makes when the action
     * arrives, so a target that passes here is a target that lands.
     */
    const legal = legalNightAction(state, botId);
    if (!legal) {
      if (wanted.targetSlot !== null) refused.push('no power tonight');
      decision.targetSlot = null;
      decision.secondTargetSlot = null;
    } else if (wanted.targetSlot !== null && legal.targets.includes(wanted.targetSlot)) {
      decision.targetSlot = wanted.targetSlot;
      const needsTwo = (legal.secondTargets ?? []).length > 0;
      if (needsTwo) {
        const second = wanted.secondTargetSlot ?? null;
        if (second !== null && (legal.secondTargets ?? []).includes(second)) {
          decision.secondTargetSlot = second;
        } else {
          // A two-house power arrives whole or not at all, so half of one is
          // the brain's whole answer rather than the model's half.
          refused.push('second house not legal');
          decision.targetSlot = floor.targetSlot;
          decision.secondTargetSlot = floor.secondTargetSlot ?? null;
        }
      } else {
        decision.secondTargetSlot = null;
      }
    } else if (wanted.targetSlot !== null) {
      refused.push(`house ${String(wanted.targetSlot)} is not a legal target`);
    }
    decision.verdict = null;
    decision.skipVote = false;
    decision.jailSlot = null;
    decision.revealMayor = false;
    return { decision, refused };
  }

  if (view.stage === 'judgement') {
    // In the booth there is exactly one decision, and the accused has no vote.
    decision.targetSlot = null;
    decision.skipVote = false;
    if (view.trial?.slot === me.slot) {
      if (wanted.verdict) refused.push('the accused does not vote');
      decision.verdict = null;
    } else if (wanted.verdict) {
      decision.verdict = wanted.verdict;
    }
    return { decision, refused };
  }

  /* -------------------------------- daylight ------------------------------- */
  decision.verdict = null;

  const ballotOpen = view.day > 1 && (view.voteOpensAt === null || now >= view.voteOpensAt);
  if (!ballotOpen) {
    if (wanted.targetSlot !== null || wanted.skipVote === true) {
      refused.push(view.day <= 1 ? 'no vote on the first day' : 'the ballot has not opened');
    }
    decision.targetSlot = null;
    decision.skipVote = false;
  } else if (wanted.targetSlot !== null && wanted.targetSlot !== me.slot && alive(wanted.targetSlot)) {
    decision.targetSlot = wanted.targetSlot;
    decision.skipVote = false;
  } else if (wanted.targetSlot !== null) {
    refused.push(wanted.targetSlot === me.slot ? 'you cannot vote for yourself' : 'that house is not at the table');
  } else {
    decision.targetSlot = null;
    decision.skipVote = wanted.skipVote === true;
  }

  /**
   * The cell, which only a Jailor has and only during the day.
   *
   * Unreachable by a model until now, because the action space had no field for
   * it — so the Jailor, the seat with the most decisive power in the game,
   * played every model-mind game as though it were a Citizen.
   */
  const cell = wanted.jailSlot ?? null;
  if (cell !== null) {
    if (bot.role === 'jailor' && cell !== me.slot && alive(cell)) decision.jailSlot = cell;
    else refused.push('you cannot put that house in the cell');
  }

  /** The sash: once, publicly, and only if you are wearing one. */
  if (wanted.revealMayor === true) {
    if ((bot.role === 'mayor' || bot.role === 'marshall') && !bot.revealed) decision.revealMayor = true;
    else refused.push('you have nothing to reveal');
  }

  return { decision, refused };
}
