/* eslint-disable no-console */
import { SETUPS, setupById } from '../setups.js';
import type { Personality } from './policies.js';
import { simulateGame, type Calibration, type SimResult, type TrialAutopsy } from './simulate.js';
import { roleDef, type RoleId } from '../roles.js';
import { merge, printReport, type Tally } from './report.js';
import { SCENARIOS } from './scenarios.js';

/**
 * Batch runner for the fast simulation.
 *
 *   pnpm --filter mafia-core sim -- --games 1000 --players 12,16,20,24
 *   pnpm --filter mafia-core sim -- --games 500 --players 15 --profile aggressive --json
 *   pnpm --filter mafia-core sim -- --games 300 --players 12,16,20 --report --talk
 *   pnpm --filter mafia-core sim -- --games 300 --players 12,16,20 --talk --scenario famille,peche
 *
 * `--report` adds the second scoreboard (what each role did, the tells a player
 * could read, the faults), `--talk` lets the voting passes speak as a live table
 * does, and `--scenario` forces situations a person would create. See `Probe`
 * and `Scenarios`. Compare runs made with the same flags.
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

/**
 * `--autopsy`: every trial the run opened, and what the board held at the time.
 *
 * Win rates say a lynching was wrong. They never say what the room was
 * reasoning from, so a table that hangs its own people looks the same on the
 * scoreboard whether it is guessing badly or being lied to well, and those want
 * opposite fixes. This reads the record at the moment each trial opened — see
 * `TrialAutopsy` — and the number to look at is how often the best evidence
 * anybody held was nothing at all.
 */
const autopsying = process.argv.includes('--autopsy');
const trials: TrialAutopsy[] = [];
const autopsy = autopsying ? (trial: TrialAutopsy) => trials.push(trial) : undefined;

/**
 * `--calibrate`: does the ranking's probability mean what it says?
 *
 * The one question a number like this has to answer. A ranking that says 0.7
 * and is right seven times in ten is evidence; one that says 0.7 and is right
 * three times in ten is worse than a coin flip and looks identical from inside
 * a game. The reliability table below is the answer, and the Brier score is the
 * single number to watch when the weights are touched.
 */
const calibrating = process.argv.includes('--calibrate');
const rows: Calibration[] = [];
const calibrate = calibrating ? (row: Calibration) => rows.push(row) : undefined;

/**
 * `--report`: the second scoreboard. What each role did with its power, the
 * tells a watching player could read off the bots, and the faults a bot should
 * never commit. See `Probe`. Pooled over every size in the run, and it plays the
 * same games as a run without it.
 */
const reporting = process.argv.includes('--report');
const report: Tally = {};

/** `--talk`: the voting passes speak too, as on a live table. See `SimOptions.talk`. */
const talk = process.argv.includes('--talk');

/**
 * `--scenario famille,peche,...`: situations forced into every game, to see how
 * the bots react. See `Scenarios`. Implies `--report`, which is where they print.
 */
const scenarioArg = arg('scenario', '');
const scenarios = scenarioArg ? scenarioArg.split(',').map((name) => name.trim()) : [];
const unknown = scenarios.filter((name) => !(SCENARIOS as readonly string[]).includes(name));
if (unknown.length > 0) {
  console.error(`scénario inconnu: ${unknown.join(', ')}. Disponibles: ${SCENARIOS.join(', ')}`);
  process.exit(1);
}
const reportingAny = reporting || scenarios.length > 0;

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
  /** A parasite left holding the board. See `witchDuel`. */
  witch: number;
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
  /**
   * Every knife swung, by the role that swung it. See `SimResult.strikes`.
   *
   * Two numbers the bench never had: how often a killer lands the knife at all,
   * and how often it lands it in somebody playing for the same result. The
   * second is the one worth watching — a town killer that shoots town is not a
   * balance problem, it is the town losing to itself.
   */
  kills: Map<RoleId, { swings: number; landed: number; allyLanded: number }>;
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
    witch: 0,
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
    botFollowed: 0,
    kills: new Map()
  };
  for (const result of results) {
    if (result.report) merge(report, result.report);
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
    for (const strike of result.strikes) {
      const row = agg.kills.get(strike.by) ?? { swings: 0, landed: 0, allyLanded: 0 };
      row.swings += 1;
      if (strike.landed) row.landed += 1;
      if (strike.landed && strike.ally) row.allyLanded += 1;
      agg.kills.set(strike.by, row);
    }
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
          autopsy,
          calibrate,
          report: reportingAny,
          talk,
          scenarios,
          config: setupConfig
        })
      );
      censusResults.push(
        simulateGame({
          players,
          seed: baseSeed * 2_000_003 + players * 10_007 + index,
          profile,
          humans,
          autopsy,
          calibrate,
          report: reportingAny,
          talk,
          scenarios,
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
          autopsy,
          calibrate,
          report: reportingAny,
          talk,
          scenarios,
          config: censusConfig
        })
      );
    }
    tables.push({ ...aggregate(results), mode: 'census' });
  }
}

if (calibrating) {
  const bands = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const pct = (part: number, whole: number) => `${((100 * part) / Math.max(1, whole)).toFixed(1)}%`;

  console.log('');
  console.log(`fiabilité du classement (${rows.length} relevés)`);
  console.log('  annoncé      | n      | réellement mauvais | écart');
  for (let index = 0; index < bands.length - 1; index++) {
    const low = bands[index];
    const high = bands[index + 1];
    const band = rows.filter((row) => row.p >= low && row.p < high);
    if (band.length === 0) continue;
    const said = band.reduce((sum, row) => sum + row.p, 0) / band.length;
    const were = band.filter((row) => row.evil).length / band.length;
    const gap = were - said;
    console.log(
      `  ${low.toFixed(1)}–${high === 1.01 ? '1.0' : high.toFixed(1)}      | ${String(band.length).padStart(6)} |` +
        ` ${pct(band.filter((row) => row.evil).length, band.length).padStart(18)} |` +
        ` ${gap >= 0 ? '+' : ''}${(100 * gap).toFixed(1)}pt`
    );
  }

  /**
   * Brier: the mean squared error of the probability itself.
   *
   * Lower is better, and the number to beat is the base rate said flatly for
   * everybody — a "ranking" that ignores all evidence and answers with the
   * proportion of killers at the table. Anything above that line is a ranking
   * doing harm.
   */
  const brier = rows.reduce((sum, row) => sum + (row.p - (row.evil ? 1 : 0)) ** 2, 0) / Math.max(1, rows.length);
  const base = rows.filter((row) => row.evil).length / Math.max(1, rows.length);
  const flat = rows.reduce((sum, row) => sum + (base - (row.evil ? 1 : 0)) ** 2, 0) / Math.max(1, rows.length);
  console.log(
    `  Brier ${brier.toFixed(4)} contre ${flat.toFixed(4)} pour le taux de base (${(100 * base).toFixed(1)}%)`
  );

  /**
   * The empirical likelihood ratio of each rule, which is what the weights
   * should have been all along.
   *
   * For each code: how often it fires on a killer against how often it fires on
   * anybody else. The log of that ratio *is* the weight, by definition, and it
   * settles by measurement what the first version of this file settled by
   * argument and got wrong. Laplace-smoothed, so a rule that fired four times
   * does not come back as infinity.
   */
  const evilRows = rows.filter((row) => row.evil).length;
  const goodRows = rows.length - evilRows;
  const codes = [...new Set(rows.flatMap((row) => row.codes))].sort();
  console.log('');
  console.log('  règle                | sur les tueurs | sur les autres | log-rapport');
  for (const code of codes) {
    const onEvil = rows.filter((row) => row.evil && row.codes.includes(code)).length;
    const onGood = rows.filter((row) => !row.evil && row.codes.includes(code)).length;
    const pEvil = (onEvil + 1) / (evilRows + 2);
    const pGood = (onGood + 1) / (goodRows + 2);
    const lr = Math.log(pEvil / pGood);
    console.log(
      `  ${code.padEnd(20)} | ${pct(onEvil, evilRows).padStart(14)} | ${pct(onGood, goodRows).padStart(14)} |` +
        ` ${lr >= 0 ? '+' : ''}${lr.toFixed(3)}`
    );
  }

  /** And whether a case that cites more reasons is actually a better case. */
  console.log('');
  for (const count of [0, 1, 2, 3]) {
    const band = rows.filter((row) => (count === 3 ? row.reasons >= 3 : row.reasons === count));
    if (band.length === 0) continue;
    console.log(
      `  ${count === 3 ? '3+' : String(count)} raison(s) | n=${String(band.length).padStart(6)} |` +
        ` réellement mauvais ${pct(band.filter((row) => row.evil).length, band.length)}`
    );
  }
  console.log('');
}

if (autopsying) {
  const hanged = trials.filter((trial) => trial.hanged);
  const townish = (trial: TrialAutopsy) => roleDef(trial.accusedRole).faction === 'town';
  const pct = (part: number, whole: number) => `${((100 * part) / Math.max(1, whole)).toFixed(1)}%`;
  const avg = (values: number[]) =>
    (values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(2);

  const row = (label: string, set: TrialAutopsy[]) =>
    console.log(
      `${label.padEnd(14)} n=${String(set.length).padStart(5)} | dossier ${avg(set.map((trial) => trial.evidence)).padStart(5)}` +
        ` | meilleure preuve ${avg(set.map((trial) => trial.hardMax)).padStart(5)}` +
        ` | personne n'avait rien ${pct(set.filter((trial) => trial.hardMax <= 0).length, set.length).padStart(6)}` +
        ` | accusateurs ${avg(set.map((trial) => trial.accusers))}` +
        ` | jour ${avg(set.map((trial) => trial.day))}`
    );

  console.log('');
  console.log(`procès ${trials.length}, pendus ${hanged.length}`);
  row('ville pendue', hanged.filter(townish));
  row(
    'mal pendu',
    hanged.filter((trial) => trial.accusedEvil)
  );
  row(
    'acquitté',
    trials.filter((trial) => !trial.hanged)
  );
  /**
   * Which findings actually hanged people, by kind.
   *
   * The reason this is printed rather than inferred: the first run with the
   * deduction layer in sent the town's win rate to 61%, and the flattering
   * explanation was that the bots had learned to catch liars. The real one was
   * that `pickMask` never read the roster, so every bluff claimed a role the
   * table had not dealt and `role-not-in-play` collected it for free. A tally
   * says which of those two it is in one line.
   */
  const tally = new Map<string, number>();
  for (const trial of hanged) for (const kind of trial.caught) tally.set(kind, (tally.get(kind) ?? 0) + 1);
  if (tally.size > 0) {
    console.log('');
    console.log('déductions retenues contre les pendus :');
    for (const [kind, count] of [...tally].sort((left, right) => right[1] - left[1])) {
      console.log(`  ${kind.padEnd(22)} ${String(count).padStart(5)}`);
    }
  }
  console.log('');
  for (let day = 2; day <= 9; day++) {
    const inDay = hanged.filter((trial) => trial.day === day);
    if (inDay.length === 0) continue;
    console.log(
      `jour ${day} | n=${String(inDay.length).padStart(5)} | ville ${pct(inDay.filter(townish).length, inDay.length).padStart(6)}` +
        ` | meilleure preuve ${avg(inDay.map((trial) => trial.hardMax))} | pression ${avg(inDay.map((trial) => trial.pressure))}`
    );
  }
  console.log('');
}

if (asJson) {
  console.log(JSON.stringify({ profile: profileName, games, tables, ...(reportingAny ? { report } : {}) }, null, 2));
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
  // Every table of the run pooled, which is the one line to compare between two runs.
  const all = tables.reduce(
    (sum, agg) => ({
      games: sum.games + agg.games,
      town: sum.town + agg.town,
      mafia: sum.mafia + agg.mafia,
      triad: sum.triad + agg.triad,
      cult: sum.cult + agg.cult,
      solo: sum.solo + agg.solo,
      draw: sum.draw + agg.draw,
      lynches: sum.lynches + agg.lynches,
      evilLynches: sum.evilLynches + agg.evilLynches
    }),
    { games: 0, town: 0, mafia: 0, triad: 0, cult: 0, solo: 0, draw: 0, lynches: 0, evilLynches: 0 }
  );
  console.log(
    [
      '   tous',
      'tailles',
      pct(all.town, all.games).padStart(6),
      pct(all.mafia, all.games).padStart(6),
      pct(all.triad, all.games).padStart(6),
      pct(all.cult, all.games).padStart(6),
      pct(all.solo, all.games).padStart(6),
      pct(all.draw, all.games).padStart(6),
      '     ',
      `${pct(all.evilLynches, all.lynches)} (${(all.lynches / Math.max(1, all.games)).toFixed(1)}/p)`.padStart(17)
    ].join(' | ')
  );

  /**
   * Every killer's aim, pooled across the sizes.
   *
   * Per size it is too thin to read: a Vigilante appears in a fraction of the
   * tables and fires three bullets when it does. Pooled, the two columns answer
   * the two questions worth asking about a killing role. "réussis" is how often
   * a swing produces a body at all, which is the role's throughput against
   * every doctor, jail and vest in the game. "sur les siens" is how many of
   * those bodies were playing for the same result as the killer, which for a
   * town gun is the whole question: a Vigilante with a high one is not a strong
   * role, it is the town shooting itself and calling it a power.
   *
   * Solo killers are in the table and their ally column is structurally zero,
   * because a seat with no side cannot betray one. See `sameCause`.
   */
  const guns = new Map<RoleId, { swings: number; landed: number; allyLanded: number }>();
  for (const agg of tables) {
    for (const [role, row] of agg.kills) {
      const into = guns.get(role) ?? { swings: 0, landed: 0, allyLanded: 0 };
      into.swings += row.swings;
      into.landed += row.landed;
      into.allyLanded += row.allyLanded;
      guns.set(role, into);
    }
  }
  if (guns.size > 0) {
    console.log('\nrôle             | coups | réussis | sur les siens');
    const rows = [...guns].sort((left, right) => right[1].landed - left[1].landed);
    for (const [role, row] of rows) {
      console.log(
        [
          role.padEnd(16),
          String(row.swings).padStart(5),
          pct(row.landed, row.swings).padStart(7),
          pct(row.allyLanded, row.landed).padStart(13)
        ].join(' | ')
      );
    }
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

if (reportingAny && !asJson) printReport(report);
