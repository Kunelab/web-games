/* eslint-disable no-console */
import { SETUPS, setupById } from '../setups.js';
import type { Personality } from './policies.js';
import { simulateGame, type SimResult } from './simulate.js';

/**
 * Batch runner for the fast simulation.
 *
 *   pnpm --filter mafia-core sim -- --games 1000 --players 12,16,20,24
 *   pnpm --filter mafia-core sim -- --games 500 --players 15 --profile aggressive --json
 *
 * Pure engine, virtual time: thousands of games a minute. Same seed, same
 * arguments, same numbers.
 */

const PROFILES: Record<string, Partial<Personality>> = {
  default: {},
  aggressive: { aggression: 0.8, herd: 0.7, deceit: 0.6 },
  calm: { aggression: 0.25, herd: 0.3, claimRate: 0.9 },
  chaotic: { aggression: 0.9, herd: 0.9, claimRate: 0.3, deceit: 0.8 },
  /** Upper bound for the town: every investigator publishes, nobody lies. */
  honest: { claimRate: 1, deceit: 0, aggression: 0.4 }
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const games = Number(arg('games', '1000'));
const profileName = arg('profile', 'default');
const baseSeed = Number(arg('seed', '1'));
const asJson = process.argv.includes('--json');
/**
 * Seats that play like people rather than like the policy. See `SimOptions.humans`.
 *
 * With any of these the run prints a second table about how the square treated
 * them — whether it answered them, whether it followed them, and whether it hunted
 * them — which is the part of bot quality that win rates have never measured.
 */
const humans = Math.max(0, Number(arg('humans', '0')) || 0);

/** 'auto' (balanced roster), 'chaos', or a preset id from SETUPS. */
const setupName = arg('setup', 'auto');
const special = setupName === 'auto' || setupName === 'chaos' || setupName === 'census';
const preset = !special ? setupById(setupName) : undefined;
if (!special && !preset) {
  console.error(`setup inconnu: ${setupName} — disponibles: ${SETUPS.map((s) => s.id).join(', ')}, chaos, census`);
  process.exit(1);
}
const setupConfig =
  setupName === 'auto'
    ? undefined
    : setupName === 'chaos'
      ? ({ setup: { mode: 'chaos' } } as const)
      : ({ setup: { mode: 'preset', presetId: setupName } } as const);

const playerCounts = arg('players', preset ? String(preset.slots.length) : '12,16,20,24')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => value >= 4 && value <= 24);

const profile = PROFILES[profileName] ?? {};

interface Aggregate {
  players: number;
  games: number;
  town: number;
  mafia: number;
  triad: number;
  cult: number;
  solo: number;
  draw: number;
  jesterWins: number;
  jesterGames: number;
  exeWins: number;
  exeGames: number;
  survivorWins: number;
  survivorGames: number;
  totalDays: number;
  lynches: number;
  evilLynches: number;
  townLynches: number;
  jesterLynches: number;
  vigMisfires: number;
  saves: number;
  executions: number;
  wrongExecutions: number;
  /** See `SimResult.human`: how the square treated the people at it. */
  humanSeats: number;
  humanSurvived: number;
  humanAsked: number;
  humanAnswered: number;
  humanQuestioned: number;
  humanAccusations: number;
  humanFollowed: number;
  humanVotesAgainst: number;
  humanVotesTotal: number;
  botAsked: number;
  botAnswered: number;
  botAccusations: number;
  botFollowed: number;
}

function aggregate(results: SimResult[]): Aggregate {
  const agg: Aggregate = {
    players: results[0]?.players ?? 0,
    games: results.length,
    town: 0,
    mafia: 0,
    triad: 0,
    cult: 0,
    solo: 0,
    draw: 0,
    jesterWins: 0,
    jesterGames: 0,
    exeWins: 0,
    exeGames: 0,
    survivorWins: 0,
    survivorGames: 0,
    totalDays: 0,
    lynches: 0,
    evilLynches: 0,
    townLynches: 0,
    jesterLynches: 0,
    vigMisfires: 0,
    saves: 0,
    executions: 0,
    wrongExecutions: 0,
    humanSeats: 0,
    humanSurvived: 0,
    humanAsked: 0,
    humanAnswered: 0,
    humanQuestioned: 0,
    humanAccusations: 0,
    humanFollowed: 0,
    humanVotesAgainst: 0,
    humanVotesTotal: 0,
    botAsked: 0,
    botAnswered: 0,
    botAccusations: 0,
    botFollowed: 0
  };
  for (const result of results) {
    agg[result.winner] += 1;
    agg.jesterWins += result.jesterWin ? 1 : 0;
    agg.jesterGames += result.jesterPresent ? 1 : 0;
    agg.exeWins += result.exeWin ? 1 : 0;
    agg.exeGames += result.exePresent ? 1 : 0;
    agg.survivorWins += result.survivorWin ? 1 : 0;
    agg.survivorGames += result.survivorPresent ? 1 : 0;
    agg.totalDays += result.days;
    agg.lynches += result.lynches;
    agg.evilLynches += result.evilLynches;
    agg.townLynches += result.townLynches;
    agg.jesterLynches += result.jesterLynches;
    agg.vigMisfires += result.vigMisfires;
    agg.saves += result.saves;
    agg.executions += result.executions;
    agg.wrongExecutions += result.wrongExecutions;
    agg.humanSeats += result.human.seats;
    agg.humanSurvived += result.human.survived;
    agg.humanAsked += result.human.asked;
    agg.humanAnswered += result.human.answered;
    agg.humanQuestioned += result.human.questioned;
    agg.humanAccusations += result.human.accusations;
    agg.humanFollowed += result.human.followed;
    agg.humanVotesAgainst += result.human.votesAgainst;
    agg.humanVotesTotal += result.human.votesTotal;
    agg.botAsked += result.human.botAsked;
    agg.botAnswered += result.human.botAnswered;
    agg.botAccusations += result.human.botAccusations;
    agg.botFollowed += result.human.botFollowed;
  }
  return agg;
}

const pct = (value: number, total: number) => `${((100 * value) / Math.max(1, total)).toFixed(1)}%`;

const startedAt = Date.now();
const tables: (Aggregate & { mode: string })[] = [];

/**
 * The benchmark is fifty-fifty: half the games run the requested setup, half
 * run the census — random town/mafia/neutral counts, 50% chance the Triad is
 * present at the mafia's size. Explicitly asking for `--setup census` (or any
 * other setup) still runs 100% of it… except census-vs-census, which is just
 * one batch.
 */
const censusConfig = { setup: { mode: 'census' } } as const;
const splitBenchmark = setupName !== 'census';

for (const players of playerCounts) {
  if (splitBenchmark) {
    const half = Math.ceil(games / 2);
    const setupResults: SimResult[] = [];
    const censusResults: SimResult[] = [];
    for (let index = 0; index < half; index++) {
      setupResults.push(
        simulateGame({
          players,
          seed: baseSeed * 1_000_003 + players * 10_007 + index,
          profile,
          humans,
          config: setupConfig
        })
      );
      censusResults.push(
        simulateGame({
          players,
          seed: baseSeed * 2_000_003 + players * 10_007 + index,
          profile,
          humans,
          config: censusConfig
        })
      );
    }
    tables.push({ ...aggregate(setupResults), mode: setupName });
    tables.push({ ...aggregate(censusResults), mode: 'census' });
  } else {
    const results: SimResult[] = [];
    for (let index = 0; index < games; index++) {
      results.push(
        simulateGame({
          players,
          seed: baseSeed * 2_000_003 + players * 10_007 + index,
          profile,
          humans,
          config: censusConfig
        })
      );
    }
    tables.push({ ...aggregate(results), mode: 'census' });
  }
}

if (asJson) {
  console.log(JSON.stringify({ profile: profileName, games, tables }, null, 2));
} else {
  console.log(
    `profil ${profileName}, setup ${setupName} + census (50/50), ${games} parties par taille, ${Date.now() - startedAt}ms\n`
  );
  console.log(
    'joueurs | mode    | ville   mafia   triade  secte   solo    nul    | jours | pendaisons justes | bouffon | bourreau | surviv. | exéc. ratées'
  );
  for (const agg of tables) {
    const cells = [
      String(agg.players).padStart(7),
      agg.mode.slice(0, 7).padEnd(7),
      pct(agg.town, agg.games).padStart(6),
      pct(agg.mafia, agg.games).padStart(6),
      pct(agg.triad, agg.games).padStart(6),
      pct(agg.cult, agg.games).padStart(6),
      pct(agg.solo, agg.games).padStart(6),
      pct(agg.draw, agg.games).padStart(6),
      (agg.totalDays / agg.games).toFixed(1).padStart(5),
      `${pct(agg.evilLynches, agg.lynches)} (${(agg.lynches / agg.games).toFixed(1)}/p)`.padStart(17),
      pct(agg.jesterWins, agg.jesterGames).padStart(7),
      pct(agg.exeWins, agg.exeGames).padStart(8),
      pct(agg.survivorWins, agg.survivorGames).padStart(7),
      pct(agg.wrongExecutions, agg.executions).padStart(12)
    ];
    console.log(cells.join(' | '));
  }

  /**
   * And what the table did with the person sitting at it.
   *
   * Printed only when there was one. Read it as three questions, in order of
   * how much a player would care: when I asked somebody where they were, did
   * the square answer me; when I named somebody, did anybody move; and was I
   * hunted harder than my share of the table for having said anything at all.
   * "part des votes" is against an even share, so 1.0 is being treated like
   * everybody else and 2.0 is being treated as the problem.
   */
  if (humans > 0) {
    console.log(
      `\njoueurs | mode    | survie | questions répondues  | accusations suivies  | on m'interroge | part des votes`
    );
    console.log(
      `        |         |        | joueur   bot   écart | joueur   bot   écart |     /partie    | reçus contre part`
    );
    for (const agg of tables) {
      const share = agg.humanSeats / Math.max(1, agg.games * agg.players);
      const hunted = agg.humanVotesAgainst / Math.max(1, agg.humanVotesTotal) / Math.max(1e-9, share);
      const answered = (100 * agg.humanAnswered) / Math.max(1, agg.humanAsked);
      const botAnswered = (100 * agg.botAnswered) / Math.max(1, agg.botAsked);
      const followed = (100 * agg.humanFollowed) / Math.max(1, agg.humanAccusations);
      const botFollowed = (100 * agg.botFollowed) / Math.max(1, agg.botAccusations);
      const gap = (mine: number, theirs: number) => `${mine >= theirs ? '+' : ''}${(mine - theirs).toFixed(0)}pt`;
      const cells = [
        String(agg.players).padStart(7),
        agg.mode.slice(0, 7).padEnd(7),
        pct(agg.humanSurvived, agg.humanSeats).padStart(6),
        `${answered.toFixed(0)}%`.padStart(6) +
          `${botAnswered.toFixed(0)}%`.padStart(7) +
          gap(answered, botAnswered).padStart(7),
        `${followed.toFixed(0)}%`.padStart(6) +
          `${botFollowed.toFixed(0)}%`.padStart(7) +
          gap(followed, botFollowed).padStart(7),
        (agg.humanQuestioned / agg.games).toFixed(1).padStart(14),
        `${hunted.toFixed(2)}x`.padStart(17)
      ];
      console.log(cells.join(' | '));
    }
  }
}
