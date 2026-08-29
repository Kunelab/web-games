/* eslint-disable no-console -- a CLI's output is its interface */
import { DIFFICULTY_PRESETS } from '../config.js';
import { runGame, uniformParty } from './simulate.js';

/**
 * Why raids are lost, which is not the same question as how often.
 *
 *   pnpm --filter coronaz-core why
 *   pnpm --filter coronaz-core why -- --preset cauchemar --party 2 --games 600
 *
 * Written because a win rate says a table is losing and nothing about what to do
 * about it, and guessing at the answer had already cost several wrong fixes. It
 * pays for itself immediately: the first run said that more than half of every
 * defeat happened with the keys already collected and the exit already open —
 * teams wiping in a fight they had finished needing to have, with nobody outside.
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const games = Number(arg('games', '400'));
const preset = arg('preset', 'difficile');
const size = Number(arg('party', '3'));

const config = { ...DIFFICULTY_PRESETS[preset], scenario: 'escape' as const };
const party = uniformParty(size, 'balanced', 'expert');

let won = 0;
let wiped = 0;
let capped = 0;
let other = 0;
let turnsAtLoss = 0;
let escapedSomeAtLoss = 0;
let exitOpenAtLoss = 0;
let keysAtLoss = 0;
let losses = 0;

for (let index = 0; index < games; index++) {
  const outcome = runGame({ config, seed: 1_000_003 + index * 7919, party });
  if (outcome.won) {
    won += 1;
    continue;
  }
  losses += 1;
  turnsAtLoss += outcome.turns;
  keysAtLoss += outcome.keysCollected;
  if (outcome.turns > 60) capped += 1;
  else if (outcome.heroesDead >= size) wiped += 1;
  else other += 1;
  if (outcome.heroesEscaped > 0) escapedSomeAtLoss += 1;
  if (outcome.exitOpen) exitOpenAtLoss += 1;
}

const pct = (part: number, whole: number): string => `${((100 * part) / Math.max(1, whole)).toFixed(1)}%`;

console.log(`\n=== ${preset} · ${size} survivant(s) · ${games} parties ===\n`);
console.log(`victoires             ${pct(won, games)}`);
console.log(`défaites              ${losses}`);
console.log(`  équipe anéantie     ${pct(wiped, losses)}`);
console.log(`  plafond de tours    ${pct(capped, losses)}`);
console.log(`  autre               ${pct(other, losses)}`);
console.log(`  tours moyens        ${(turnsAtLoss / Math.max(1, losses)).toFixed(1)}`);
console.log(`  clés ramassées      ${(keysAtLoss / Math.max(1, losses)).toFixed(2)}`);
/** The two that matter: a loss with the door open was a loss that was avoidable. */
console.log(`  sortie déjà ouverte ${pct(exitOpenAtLoss, losses)}`);
console.log(`  au moins un évadé   ${pct(escapedSomeAtLoss, losses)}`);
console.log('');
