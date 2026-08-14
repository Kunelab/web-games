import type { FinalAward } from 'game-core';

import type { SessionState } from './session.js';

/**
 * The end-of-game distinctions, computed from the tallies banked as rounds closed.
 *
 * Deliberately small and deliberately silly: the podium already honours the score,
 * so these exist to give the other players something to walk away with. Keys are
 * stable identifiers the client maps to French labels; values arrive formatted
 * because only this side has the numbers.
 *
 * Every award is skipped rather than forced when the game cannot support it: no
 * fastest answer means no speed award, not a speed award for nobody.
 */
export function computeAwards(state: SessionState): FinalAward[] {
  const stats = state.stats ?? {};
  const awards: FinalAward[] = [];

  const entries = Object.entries(stats)
    .map(([playerId, aggregate]) => ({
      playerId,
      name: state.players[playerId]?.name ?? '?',
      ...aggregate
    }))
    // A kicked player's tallies survive in `stats`; their seat does not. Skipping
    // them keeps the ceremony to people who finished the game.
    .filter((entry) => state.players[entry.playerId] !== undefined);

  if (entries.length === 0) return awards;

  const push = (key: string, entry: { playerId: string; name: string }, value: string) => {
    awards.push({ key, playerId: entry.playerId, playerName: entry.name, value });
  };

  // Ties are broken by name so the outcome is stable, not by object order.
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'fr');

  const fastest = entries
    .filter((entry) => entry.fastestMs !== null)
    .sort((a, b) => (a.fastestMs ?? 0) - (b.fastestMs ?? 0) || byName(a, b))[0];
  if (fastest && fastest.fastestMs !== null) {
    push('fastest', fastest, `${(fastest.fastestMs / 1000).toFixed(2).replace('.', ',')} s`);
  }

  const workhorse = [...entries].sort((a, b) => b.correct - a.correct || byName(a, b))[0];
  if (workhorse && workhorse.correct > 0) {
    push(
      'workhorse',
      workhorse,
      `${workhorse.correct} bonne${workhorse.correct > 1 ? 's' : ''} réponse${workhorse.correct > 1 ? 's' : ''}`
    );
  }

  // Accuracy needs a denominator worth speaking about.
  const marksmen = entries
    .filter((entry) => entry.correct + entry.wrong >= 5)
    .map((entry) => ({ ...entry, accuracy: entry.correct / (entry.correct + entry.wrong) }))
    .sort((a, b) => b.accuracy - a.accuracy || byName(a, b));
  const sniper = marksmen[0];
  if (sniper && sniper.accuracy > 0) {
    push('sniper', sniper, `${Math.round(sniper.accuracy * 100)} % de réussite`);
  }

  const scattergun = [...entries].sort((a, b) => b.wrong - a.wrong || byName(a, b))[0];
  if (scattergun && scattergun.wrong >= 3) {
    push('scattergun', scattergun, `${scattergun.wrong} réponses à côté`);
  }

  const streak = [...entries].sort((a, b) => b.bestCombo - a.bestCombo || byName(a, b))[0];
  if (streak && streak.bestCombo >= 2) {
    push('streak', streak, `${streak.bestCombo} manches d’affilée`);
  }

  return awards;
}
