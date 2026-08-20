/* eslint-disable no-console -- a CLI's output is its interface */
import { DIFFICULTY_PRESETS } from '../config.js';
import { HEROES } from '../data.js';
import { ALL_GM_PERKS, ALL_HERO_PERKS } from '../perks.js';
import { gmMindsetNames, type GmMindset } from './gm-policies.js';
import { playerMindsetNames, skillNames } from './policies.js';
import { randInt, seedRng } from '../rng.js';
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
  const base = team ? parseTeam(team) : uniformParty(heroCount, arg('mindset', 'balanced'), arg('skill', 'expert'));
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
    gmMindset: gm,
    heroPerks,
    gmPerks
  });
  row(
    `${scenario}/${preset}/${arg('team', '') ? 'team' : `${arg('mindset', 'balanced')}/${arg('skill', 'expert')}`}${gm ? `/MJ:${gm}:${gmClass}` : ''}${heroPerks ? '+perks' : ''}${gmPerks ? '+gmperks' : ''}${has('luck') ? `/${arg('luck', 'lucky')}` : ''}${has('noperks') ? '/sans-atout' : ''}${has('events') ? `/evts:${arg('events', 'true')}` : ''}`,
    summary
  );
} else {
  /* ------------------------- the calibration matrix ----------------------- */
  console.log(`\n=== vs IA (évasion, ${games} parties par case, ${heroCount} héros experts) ===`);
  for (const preset of ['facile', 'normal', 'difficile', 'cauchemar', 'apocalypse']) {
    for (const mindset of playerMindsetNames) {
      const summary = runMany({
        games,
        config: { ...DIFFICULTY_PRESETS[preset], scenario: 'escape' },
        party: uniformParty(heroCount, mindset, 'expert')
      });
      row(`${preset} / ${mindset}`, summary);
    }
    console.log('');
  }

  console.log(`=== Niveaux de jeu (évasion normal, mindset balanced) ===`);
  for (const skill of skillNames) {
    const summary = runMany({
      games,
      config: { ...DIFFICULTY_PRESETS.normal, scenario: 'escape' },
      party: uniformParty(heroCount, 'balanced', skill)
    });
    row(`skill ${skill}`, summary);
  }

  console.log(`\n=== vs Maître du jeu (évasion, préréglage normal, joueurs experts) ===`);
  for (const gm of gmMindsetNames) {
    const summary = runMany({
      games,
      config: { ...DIFFICULTY_PRESETS.normal, scenario: 'escape' },
      party: uniformParty(heroCount, 'balanced', 'expert'),
      gmMindset: gm
    });
    row(`MJ ${gm}`, summary);
  }

  /**
   * How much the first six draws decide the evening.
   *
   * Loot is the one thing a player cannot play around: the table that opens a
   * sniper on turn two and the table that opens four bats are the same table
   * otherwise. Forcing both ends tells us whether the game is *decided* by the
   * dice or merely coloured by them; the gap is the number to keep small.
   */
  console.log(`\n=== Chance au butin (6 premiers tirages forcés, évasion) ===`);
  for (const preset of ['normal', 'difficile']) {
    for (const luck of [undefined, 'lucky', 'unlucky'] as const) {
      const summary = runMany({
        games,
        config: { ...DIFFICULTY_PRESETS[preset], scenario: 'escape' },
        party: uniformParty(heroCount, 'balanced', 'expert').map((member) => ({ ...member, luck }))
      });
      row(`${preset} / ${luck ?? 'butin normal'}`, summary);
    }
    console.log('');
  }

  console.log(`=== Tables sans atout (le handicap volontaire, évasion) ===`);
  for (const preset of ['normal', 'difficile']) {
    const summary = runMany({
      games,
      config: { ...DIFFICULTY_PRESETS[preset], scenario: 'escape' },
      party: uniformParty(heroCount, 'balanced', 'expert').map((member) => ({ ...member, noPerks: true }))
    });
    row(`${preset} / sans atout`, summary);
  }

  console.log(`\n=== Taille de table (évasion, experts, sans MJ) ===`);
  for (const preset of ['normal', 'difficile', 'cauchemar']) {
    for (const size of [1, 2, 3, 4, 5]) {
      const summary = runMany({
        games,
        config: { ...DIFFICULTY_PRESETS[preset], scenario: 'escape' },
        party: uniformParty(size, 'balanced', 'expert')
      });
      row(`${preset} / ${size} joueur(s)`, summary);
    }
    console.log('');
  }

  console.log(`\n=== Sans fin (score avant la nuit) ===`);
  for (const mindset of playerMindsetNames) {
    const summary = runMany({
      games: Math.min(games, 200),
      config: { ...DIFFICULTY_PRESETS.normal, scenario: 'endless' },
      party: uniformParty(heroCount, mindset, 'expert')
    });
    row(`endless / ${mindset}`, summary);
  }
}
