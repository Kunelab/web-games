/* eslint-disable no-console -- a CLI's output is its interface */
import { DIFFICULTY_PRESETS } from '../config.js';
import { HEROES } from '../data.js';
import { ALL_GM_PERKS, ALL_HERO_PERKS } from '../perks.js';
import { gmMindsetNames, type GmMindset } from './gm-policies.js';
import { playerMindsetNames, skillNames } from './policies.js';
import { randInt, seedRng } from '../rng.js';
import { runCells, type CellOptions, type CellSummary } from './pool.js';
import { runGame, runMany, uniformParty, type PartyMember } from './simulate.js';

/**
 * The balance bench. Any combination of characters, skills, mindsets, GM class
 * and seed is one flag away:
 *
 *   pnpm --filter coronaz-core sim                          # the target matrix
 *   pnpm --filter coronaz-core sim -- --preset difficile --mindset looter --skill newbie
 *   pnpm --filter coronaz-core sim -- --team "rosa:expert:balanced,sacha:newbie:looter,diego:master:fighter"
 *   pnpm --filter coronaz-core sim -- --gm master --gmclass boucher --games 300
 *   pnpm --filter coronaz-core sim -- --party random --games 600      # messy real tables
 *   pnpm --filter coronaz-core sim -- --seed 4217 --preset normal --team "ethan:expert:rusher"
 *   pnpm --filter coronaz-core sim -- --roster --games 200            # every hero, solo-benched
 *
 * A --team entry is hero:skill:mindset; hero may be '*' for a random base one.
 * Targets (expert skill, balanced mindset): facile ≥99%, normal 94–95%,
 * difficile ≈70%, vs game master 40–50%.
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const games = Number(arg('games', '400'));
const scenario = arg('scenario', 'escape');
const heroCount = Number(arg('heroes', '3'));

/**
 * Extra bodies the horde is not told about.
 *
 * `--ghosts` runs half again as many bots as the party being measured while
 * pinning the horde's difficulty to the smaller number. It exists because the
 * bench's targets are calibrated against `expert` bots and real people beat
 * those bots comfortably — two of them walked out of "difficile" untouched
 * against a bench that says eighty per cent and half a death a game.
 *
 * So a winrate measured from bots is not the winrate of a table, and tuning
 * difficulty against it tunes for the wrong room. Three bots at the pressure
 * meant for two is a rough stand-in for two people who pass each other things,
 * cover each other, and never waste a turn.
 *
 * A calibration instrument and nothing else: it changes no default, it is
 * unreachable from the game, and a number produced with it is only comparable
 * to another number produced with it.
 */
const ghosts = has('ghosts');
const bodies = ghosts ? Math.max(heroCount + 1, Math.round(heroCount * 1.5)) : heroCount;
const hordeParty = ghosts ? heroCount : undefined;
/** One core, for when a run has to be compared against an older one exactly. */
const serial = has('serial');

function row(label: string, summary: ReturnType<typeof runMany>): void {
  console.log(
    `${label.padEnd(38)} ${(summary.winRate * 100).toFixed(1).padStart(6)}%  ` +
      `tours ${summary.avgTurns.toFixed(1).padStart(5)}  score ${summary.avgScore.toFixed(0).padStart(4)}  ` +
      `kills ${summary.avgKills.toFixed(1).padStart(5)}  morts ${summary.avgDeaths.toFixed(2)}`
  );
}

/**
 * A random living-room table: one to five seats, mixed styles, skills drawn
 * from a believable spread (most people are okay, few are masters).
 */
const SKILL_SPREAD: { skill: string; weight: number }[] = [
  { skill: 'newbie', weight: 25 },
  { skill: 'advanced', weight: 35 },
  { skill: 'expert', weight: 30 },
  { skill: 'master', weight: 10 }
];
const SIZE_SPREAD: { size: number; weight: number }[] = [
  { size: 1, weight: 10 },
  { size: 2, weight: 20 },
  { size: 3, weight: 30 },
  { size: 4, weight: 30 },
  { size: 5, weight: 10 }
];

function weightedPick<T extends { weight: number }>(rng: ReturnType<typeof seedRng>, table: T[]): T {
  const first = table[0];
  if (!first) throw new Error('weightedPick on an empty table');
  const total = table.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = randInt(rng, total);
  for (const entry of table) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return first;
}

function randomParty(rng: ReturnType<typeof seedRng>): PartyMember[] {
  const size = weightedPick(rng, SIZE_SPREAD).size;
  return Array.from({ length: size }, () => ({
    mindset: playerMindsetNames[randInt(rng, playerMindsetNames.length)] ?? 'balanced',
    skill: weightedPick(rng, SKILL_SPREAD).skill
  }));
}

/** Parses --team "rosa:expert:balanced,*:newbie:looter" into party members. */
function parseTeam(raw: string): PartyMember[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hero, skill, mindset] = entry.split(':');
      return {
        heroId: hero && hero !== '*' ? hero : undefined,
        skill: skill || 'expert',
        mindset: mindset || 'balanced'
      };
    });
}

function chosenParty(): PartyMember[] {
  const team = arg('team', '');
  const base = team ? parseTeam(team) : uniformParty(bodies, arg('mindset', 'balanced'), arg('skill', 'expert'));
  // --luck and --noperks apply to the whole table: what they measure is a run
  // of loot or a table that refused its perks, not one seat's story.
  const luck = has('luck') ? (arg('luck', 'lucky') as 'lucky' | 'unlucky') : undefined;
  return base.map((member) => ({ ...member, luck, noPerks: has('noperks') || member.noPerks }));
}

const gmClass = arg('gmclass', 'horde');

/**
 * The district's weather, on or off.
 *
 * Exposed because "the events cancel out" is a claim about win rate, and a claim
 * about win rate that cannot be measured is a hope. `--events false` against the
 * same seed base is the only honest way to price them.
 */
const events = has('events') ? { events: arg('events', 'true') !== 'false' } : {};

/** Overrides the preset's escalation, for pricing a difficulty without editing it. */
const escalation = has('escalation') ? { escalation: Number(arg('escalation', '1')) } : {};

/* ------------------------------- seed replay ------------------------------- */

if (has('seed')) {
  const seed = Number(arg('seed', '1'));
  const preset = arg('preset', 'normal');
  const outcome = runGame({
    config: { ...DIFFICULTY_PRESETS[preset], scenario: scenario as never, gmClass },
    seed,
    party: chosenParty(),
    gmMindset: has('gm') ? (arg('gm', 'economist') as GmMindset) : undefined,
    captureLog: true
  });

  console.log(`\n=== Replay graine ${seed} · ${scenario}/${preset} ===`);
  for (const line of outcome.log ?? []) console.log(`  ${line}`);
  console.log(
    `\n${outcome.won ? 'VICTOIRE' : 'DÉFAITE'} en ${outcome.turns} tours · score ${outcome.totalScore} · ` +
      `${outcome.kills} victimes · ${outcome.heroesDead} mort(s), ${outcome.heroesEscaped} évadé(s)`
  );
} else if (arg('party', '') === 'random') {
  /* ---------------------- messy real-world tables ------------------------- */
  const preset = arg('preset', 'normal');
  const rng = seedRng(Number(arg('seedbase', '99')));
  const bySize = new Map<number, { games: number; wins: number }>();
  let wins = 0;

  for (let i = 0; i < games; i++) {
    const party = randomParty(rng);
    const outcome = runGame({
      config: { ...DIFFICULTY_PRESETS[preset], scenario: scenario as never },
      seed: 5000 + i * 7919,
      party,
      gmMindset: has('gm') ? (arg('gm', 'economist') as GmMindset) : undefined
    });
    wins += outcome.won ? 1 : 0;
    const bucket = bySize.get(party.length) ?? { games: 0, wins: 0 };
    bucket.games += 1;
    bucket.wins += outcome.won ? 1 : 0;
    bySize.set(party.length, bucket);
  }

  console.log(`\n=== Tables aléatoires · ${scenario}/${preset} · ${games} parties ===`);
  console.log(`global ${((wins / games) * 100).toFixed(1)}%`);
  for (const size of [...bySize.keys()].sort()) {
    const bucket = bySize.get(size);
    if (!bucket) continue;
    console.log(
      `  ${size} joueur(s): ${((bucket.wins / bucket.games) * 100).toFixed(1).padStart(5)}%  (${bucket.games} parties)`
    );
  }
} else if (has('roster')) {
  /* --------------- every character, benched in the same seat --------------- */
  // Three experts, one of them forced to the character under test: the delta
  // against the all-random row is the character's real weight.
  const preset = arg('preset', 'normal');
  const baseline = runMany({
    games,
    config: { ...DIFFICULTY_PRESETS[preset], scenario: 'escape' },
    party: uniformParty(3, 'balanced', 'expert')
  });
  row('référence (héros aléatoires)', baseline);
  for (const hero of HEROES) {
    const summary = runMany({
      games,
      config: { ...DIFFICULTY_PRESETS[preset], scenario: 'escape' },
      party: [
        { heroId: hero.id, skill: 'expert', mindset: 'balanced' },
        { skill: 'expert', mindset: 'balanced' },
        { skill: 'expert', mindset: 'balanced' }
      ]
    });
    row(`${hero.emoji} ${hero.name} (${hero.ability})${hero.cost ? ' 🔒' : ''}`, summary);
  }
} else if (
  has('preset') ||
  has('mindset') ||
  has('gm') ||
  has('perks') ||
  has('gmperks') ||
  has('skill') ||
  has('escalation') ||
  has('luck') ||
  has('noperks') ||
  has('team') ||
  has('gmclass') ||
  has('events') ||
  process.argv.includes('--scenario')
) {
  /* ------------------------------- one cell ------------------------------- */
  const preset = arg('preset', 'normal');
  const gm = has('gm') ? (arg('gm', 'economist') as GmMindset) : undefined;
  const heroPerks = has('perks') ? ALL_HERO_PERKS : undefined;
  const gmPerks = has('gmperks') ? ALL_GM_PERKS : undefined;

  const summary = runMany({
    games,
    config: { ...DIFFICULTY_PRESETS[preset], ...escalation, ...events, scenario: scenario as never, gmClass },
    party: chosenParty(),
    hordeParty,
    gmMindset: gm,
    heroPerks,
    gmPerks
  });
  row(
    `${scenario}/${preset}/${arg('team', '') ? 'team' : `${arg('mindset', 'balanced')}/${arg('skill', 'expert')}`}${gm ? `/MJ:${gm}:${gmClass}` : ''}${heroPerks ? '+perks' : ''}${gmPerks ? '+gmperks' : ''}${has('luck') ? `/${arg('luck', 'lucky')}` : ''}${has('noperks') ? '/sans-atout' : ''}${has('events') ? `/evts:${arg('events', 'true')}` : ''}${ghosts ? `/fantomes:${bodies}v${heroCount}` : ''}`,
    summary
  );
} else {
  /* ------------------------- the calibration matrix ----------------------- */

  /**
   * The matrix, described before any of it is run.
   *
   * Written as a list rather than as nested loops that print as they go, because
   * a list can be handed to every core at once. `before` and `after` carry the
   * headings and the blank lines, so the sheet reads exactly as it did when one
   * core produced it top to bottom.
   */
  interface Cell {
    label: string;
    options: CellOptions;
    before?: string;
    after?: string;
  }

  const cells: Cell[] = [];
  const escape = (preset: string) => ({ ...DIFFICULTY_PRESETS[preset], scenario: 'escape' }) as const;

  cells.push(
    ...['facile', 'normal', 'difficile', 'cauchemar', 'apocalypse'].flatMap((preset, index) =>
      playerMindsetNames.map((mindset, at) => ({
        label: `${preset} / ${mindset}`,
        options: { games, config: escape(preset), party: uniformParty(heroCount, mindset, 'expert') },
        before:
          index === 0 && at === 0
            ? `\n=== vs IA (évasion, ${games} parties par case, ${heroCount} héros experts) ===`
            : undefined,
        after: at === playerMindsetNames.length - 1 ? '' : undefined
      }))
    )
  );

  cells.push(
    ...skillNames.map((skill, at) => ({
      label: `skill ${skill}`,
      options: { games, config: escape('normal'), party: uniformParty(heroCount, 'balanced', skill) },
      before: at === 0 ? `=== Niveaux de jeu (évasion normal, mindset balanced) ===` : undefined
    }))
  );

  cells.push(
    ...gmMindsetNames.map((gm, at) => ({
      label: `MJ ${gm}`,
      options: {
        games,
        config: escape('normal'),
        party: uniformParty(heroCount, 'balanced', 'expert'),
        gmMindset: gm
      },
      before: at === 0 ? `\n=== vs Maître du jeu (évasion, préréglage normal, joueurs experts) ===` : undefined
    }))
  );

  /**
   * How much the first six draws decide the evening.
   *
   * Loot is the one thing a player cannot play around: the table that opens a
   * sniper on turn two and the table that opens four bats are the same table
   * otherwise. Forcing both ends tells us whether the game is *decided* by the
   * dice or merely coloured by them; the gap is the number to keep small.
   */
  cells.push(
    ...['normal', 'difficile'].flatMap((preset, index) =>
      ([undefined, 'lucky', 'unlucky'] as const).map((luck, at) => ({
        label: `${preset} / ${luck ?? 'butin normal'}`,
        options: {
          games,
          config: escape(preset),
          party: uniformParty(heroCount, 'balanced', 'expert').map((member) => ({ ...member, luck }))
        },
        before: index === 0 && at === 0 ? `\n=== Chance au butin (6 premiers tirages forcés, évasion) ===` : undefined,
        after: at === 2 ? '' : undefined
      }))
    )
  );

  cells.push(
    ...['normal', 'difficile'].map((preset, at) => ({
      label: `${preset} / sans atout`,
      options: {
        games,
        config: escape(preset),
        party: uniformParty(heroCount, 'balanced', 'expert').map((member) => ({ ...member, noPerks: true }))
      },
      before: at === 0 ? `=== Tables sans atout (le handicap volontaire, évasion) ===` : undefined
    }))
  );

  cells.push(
    ...['normal', 'difficile', 'cauchemar'].flatMap((preset, index) =>
      [1, 2, 3, 4, 5].map((size, at) => ({
        label: `${preset} / ${size} joueur(s)`,
        options: { games, config: escape(preset), party: uniformParty(size, 'balanced', 'expert') },
        before: index === 0 && at === 0 ? `\n=== Taille de table (évasion, experts, sans MJ) ===` : undefined,
        after: at === 4 ? '' : undefined
      }))
    )
  );

  cells.push(
    ...playerMindsetNames.map((mindset, at) => ({
      label: `endless / ${mindset}`,
      options: {
        games: Math.min(games, 200),
        config: { ...DIFFICULTY_PRESETS.normal, scenario: 'endless' } as const,
        party: uniformParty(heroCount, mindset, 'expert')
      },
      before: at === 0 ? `\n=== Sans fin (score avant la nuit) ===` : undefined
    }))
  );

  /**
   * The heaviest cells first, so the last core to be given work is not the one
   * handed the endless district. Only the dispatch order changes; the sheet is
   * still printed in the order it was written.
   */
  const order = cells.map((_, index) => index);
  const weight = (cell: Cell): number =>
    cell.options.config.scenario === 'endless' ? cell.options.games * 12 : cell.options.games;
  order.sort((a, b) => weight(cells[b]) - weight(cells[a]));

  const queue = order.map((index) => cells[index].options);
  const summaries = new Array<CellSummary | undefined>(cells.length);

  await runCells(
    queue,
    (position, summary) => {
      summaries[order[position]] = summary;
    },
    serial ? 1 : undefined
  );

  for (const [index, cell] of cells.entries()) {
    const summary = summaries[index];
    if (!summary) continue;
    if (cell.before !== undefined) console.log(cell.before);
    row(cell.label, summary);
    if (cell.after !== undefined) console.log(cell.after);
  }
}
