import { desc } from 'drizzle-orm';
import { buildLeaderboard, type BadgeProgressView, type FinalAward, type GameReward } from 'game-core';

import { db } from '../db/index.js';
import { gameResults } from '../db/schema.js';
import { computeAwards } from '../game/awards.js';
import type { SessionState } from '../game/session.js';
import { quizCareerService, quizLedgerKey } from './quiz-career-service.js';

/**
 * Finished games and what can be read back out of them.
 *
 * The row is denormalised on purpose: by the time anyone reads history, the session
 * it came from is gone and the players in it were nicknames on phones, not accounts.
 * Names are therefore the identity here, which is the honest model for a living-room
 * instance where "Max" is always the same Max.
 */

export interface ResultPlayer {
  name: string;
  score: number;
  rank: number;
  correct: number;
  wrong: number;
  /** Quickest correct answer in ms, when they had one. */
  fastestMs: number | null;
  roundsWon: number;
  bestCombo: number;
}

export interface GameResultView {
  id: number;
  code: string;
  playlistName: string;
  finishedAt: number;
  roundsTotal: number;
  players: ResultPlayer[];
  awards: FinalAward[];
}

/** Lifetime tallies for one nickname, across every recorded game. */
export interface PlayerCareer {
  name: string;
  games: number;
  wins: number;
  totalPoints: number;
  bestScore: number;
  correct: number;
  wrong: number;
  awards: number;
  /** Quickest correct answer across all games, ms. */
  fastestEverMs: number | null;
  /** Longest round-win streak ever held. */
  bestComboEver: number;
  /** Achievement keys earned, in definition order. The client owns the labels. */
  badges: string[];
  /** The most prestigious badge, worn as a title next to the name. */
  title: string | null;
}

/** The bar "lightning" is measured against, in ms. */
const LIGHTNING_MS = 1_500;

interface BadgeDef {
  key: string;
  earned: (career: PlayerCareer) => boolean;
  /**
   * How close this career is, as a count against a target.
   *
   * Declared next to `earned` and never derived from it, because a boolean cannot
   * be drawn and a bar is the whole reason anybody looks at this screen twice. The
   * two agree by construction for every badge below, and a test walks a career from
   * nothing to well past every threshold to make sure they never come apart.
   */
  progress: (career: PlayerCareer) => { current: number; target: number; unit: string };
}

/** The common shape: a tally that climbs to a threshold. */
function count(
  of: (career: PlayerCareer) => number,
  target: number,
  unit: string
): Pick<BadgeDef, 'earned' | 'progress'> {
  return {
    earned: (career) => of(career) >= target,
    progress: (career) => ({ current: Math.min(of(career), target), target, unit })
  };
}

/**
 * Achievements, as thresholds over a career.
 *
 * Declared last-is-most-prestigious so the title is simply the final badge earned.
 * Everything free, everything earned by playing: this is the whole "battle pass",
 * minus the pressure to log in on a Tuesday.
 */
const BADGES: BadgeDef[] = [
  { key: 'first-game', ...count((c) => c.games, 1, 'badge.unit.games') },
  { key: 'regular', ...count((c) => c.games, 10, 'badge.unit.games') },
  { key: 'pillar', ...count((c) => c.games, 50, 'badge.unit.games') },
  { key: 'first-win', ...count((c) => c.wins, 1, 'badge.unit.wins') },
  {
    key: 'lightning',
    earned: (c) => c.fastestEverMs !== null && c.fastestEverMs <= LIGHTNING_MS,
    /**
     * Counted backwards, because this is the one badge that is not an
     * accumulation: it asks for a *faster* answer, so progress is how much of the
     * gap has been closed from a first correct answer down towards a second and a
     * half. Before any correct answer there is nothing to close and it reads zero.
     */
    progress: (c) => {
      const best = c.fastestEverMs;
      if (best === null) return { current: 0, target: LIGHTNING_MS, unit: 'badge.unit.ms' };
      return {
        current: Math.max(0, Math.min(LIGHTNING_MS, LIGHTNING_MS - (best - LIGHTNING_MS))),
        target: LIGHTNING_MS,
        unit: 'badge.unit.ms'
      };
    }
  },
  { key: 'streak-3', ...count((c) => c.bestComboEver, 3, 'badge.unit.streak') },
  { key: 'hundred-right', ...count((c) => c.correct, 100, 'badge.unit.correct') },
  { key: 'decorated', ...count((c) => c.awards, 10, 'badge.unit.awards') },
  { key: 'five-wins', ...count((c) => c.wins, 5, 'badge.unit.wins') },
  { key: 'encyclopedia', ...count((c) => c.correct, 500, 'badge.unit.correct') },
  { key: 'living-room-king', ...count((c) => c.wins, 20, 'badge.unit.wins') }
];

/** Exported for the test that holds `earned` and `progress` to the same story. */
export const BADGE_DEFS: readonly BadgeDef[] = BADGES;

/**
 * The nearest unearned badges, closest first.
 *
 * Ranked by how far along they are rather than by how prestigious they are,
 * because a bar at 72 of 100 is a better thing to show a tired room than an easier
 * badge nobody has touched. Ties break towards the earlier declaration, which is
 * the cheaper badge: the table is in prestige order.
 */
export function nextBadges(career: PlayerCareer, limit = 3): BadgeProgressView[] {
  return BADGES.filter((badge) => !badge.earned(career))
    .map((badge, index) => {
      const { current, target, unit } = badge.progress(career);
      const ratio = target > 0 ? Math.max(0, Math.min(1, current / target)) : 0;
      return { key: badge.key, current, target, unit, moved: false, ratio, index };
    })
    .sort((a, b) => b.ratio - a.ratio || a.index - b.index)
    .slice(0, limit)
    .map(({ ratio: _ratio, index: _index, ...view }) => view);
}

/**
 * The difference one game made to one career.
 *
 * Takes both snapshots rather than recomputing from the game, because "what is
 * new" is exactly a comparison and nothing else can answer it: a badge already
 * held must not be announced a second time, and a title that has not changed is
 * not news.
 */
export function gameReward(input: {
  playerId: string;
  name: string;
  before: PlayerCareer;
  after: PlayerCareer;
  gained: number;
  total: number;
}): GameReward {
  const { before, after } = input;
  const heldBefore = new Set(before.badges);

  return {
    playerId: input.playerId,
    name: input.name,
    gained: input.gained,
    total: input.total,
    newBadges: after.badges.filter((key) => !heldBefore.has(key)),
    newTitle: after.title !== before.title ? after.title : null,
    nextBadges: nextBadges(after).map((view) => {
      const was = BADGES.find((badge) => badge.key === view.key)?.progress(before).current ?? 0;
      return { ...view, moved: view.current > was };
    })
  };
}

/**
 * Fills in the derived half of a career: which badges it holds, and its title.
 *
 * Never stored, always recomputed. Writing them down would freeze today's
 * thresholds into everyone's row, so that lowering one later would leave the
 * people who had already passed it holding nothing.
 */
export function decorate(career: PlayerCareer): PlayerCareer {
  career.badges = BADGES.filter((badge) => badge.earned(career)).map((badge) => badge.key);
  career.title = career.badges.at(-1) ?? null;
  return career;
}

/** A career with nothing in it, which is what a first-time player is compared against. */
export function emptyCareer(name: string): PlayerCareer {
  return {
    name,
    games: 0,
    wins: 0,
    totalPoints: 0,
    bestScore: 0,
    correct: 0,
    wrong: 0,
    awards: 0,
    fastestEverMs: null,
    bestComboEver: 0,
    badges: [],
    title: null
  };
}

/** History is bounded: the stats scan reads whole rows, and evenings are finite. */
const MAX_ROWS = 500;

export const resultsService = {
  /**
   * Writes the one permanent record of a finished session, and says what it paid.
   *
   * The return value is the end-of-game payoff screen's whole content. It has to be
   * built here because this is the only moment both halves of the comparison exist:
   * a career is derived by folding the history, so "before" stops being reachable
   * the instant the row goes in.
   */
  async record(state: SessionState): Promise<GameReward[]> {
    // Ahead of the insert, or it is not a "before" at all.
    const careersBefore = byName(await this.careers());

    const totals = new Map(Object.values(state.players).map((player) => [player.id, player.totalScore]));
    const rankById = new Map(buildLeaderboard(totals).map((row) => [row.playerId, row.rank]));

    const players: ResultPlayer[] = Object.values(state.players)
      .map((player) => {
        const aggregate = state.stats?.[player.id];
        return {
          name: player.name,
          score: player.totalScore,
          rank: rankById.get(player.id) ?? 0,
          correct: aggregate?.correct ?? 0,
          wrong: aggregate?.wrong ?? 0,
          fastestMs: aggregate?.fastestMs ?? null,
          roundsWon: aggregate?.roundsWon ?? 0,
          bestCombo: aggregate?.bestCombo ?? 0
        };
      })
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'fr'));

    await db.insert(gameResults).values({
      code: state.code,
      playlist_id: state.playlistId,
      playlist_name: state.playlistName,
      host_user_id: state.hostUserId,
      finished_at: Date.now(),
      rounds_total: state.order.length,
      players: JSON.stringify(players),
      awards: JSON.stringify(computeAwards(state))
    });

    /**
     * The wallet, credited from the same numbers and at the same moment.
     *
     * After the row rather than before it: the history is the permanent record
     * and must not be lost to a wallet write failing, whereas a token nobody
     * banked is a token, and the next game pays more.
     */
    const rewards: GameReward[] = [];
    // Careers are derived by folding the history, so "after" only exists once the
    // row above is in. Two scans of a bounded table, once per game, is the price of
    // not keeping a second running aggregate consistent with the first.
    const after = byName(await this.careers());

    for (const player of Object.values(state.players)) {
      const stats = await quizCareerService.credit(quizLedgerKey(player), player.totalScore);
      const key = player.name.toLowerCase();
      rewards.push(
        gameReward({
          playerId: player.id,
          name: player.name,
          before: careersBefore.get(key) ?? emptyCareer(player.name),
          after: after.get(key) ?? emptyCareer(player.name),
          gained: Math.max(0, Math.floor(player.totalScore)),
          total: stats.tokens
        })
      );
    }

    return rewards;
  },

  async list(limit: number): Promise<GameResultView[]> {
    const rows = await db
      .select()
      .from(gameResults)
      .orderBy(desc(gameResults.finished_at))
      .limit(Math.min(limit, MAX_ROWS));

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      playlistName: row.playlist_name,
      finishedAt: row.finished_at,
      roundsTotal: row.rounds_total,
      players: safeParse<ResultPlayer[]>(row.players, []),
      awards: safeParse<FinalAward[]>(row.awards, [])
    }));
  },

  /**
   * Careers, aggregated by nickname.
   *
   * Scanning the rows on request is deliberate: at a few games an evening the table
   * grows by dozens of rows a year, and a running aggregate would be one more thing
   * to keep consistent for no measurable gain.
   */
  async careers(): Promise<PlayerCareer[]> {
    const games = await this.list(MAX_ROWS);
    const byName = new Map<string, PlayerCareer>();

    for (const game of games) {
      for (const player of game.players) {
        const key = player.name.toLowerCase();
        const career = byName.get(key) ?? emptyCareer(player.name);

        career.games += 1;
        /**
         * Coming first among one player is not winning.
         *
         * Every solo game ranks its only player first, so trying a playlist out
         * alone on the host screen minted a career win and the "first win" badge
         * with it, which is then worn as a title next to that nickname in every
         * lobby afterwards. The game still counts, the points still count, the
         * right answers still count: only the victory needs an opponent.
         */
        career.wins += player.rank === 1 && game.players.length >= 2 ? 1 : 0;
        career.totalPoints = Math.round((career.totalPoints + player.score) * 100) / 100;
        career.bestScore = Math.max(career.bestScore, player.score);
        career.correct += player.correct;
        career.wrong += player.wrong;
        if (player.fastestMs !== null) {
          career.fastestEverMs =
            career.fastestEverMs === null ? player.fastestMs : Math.min(career.fastestEverMs, player.fastestMs);
        }
        career.bestComboEver = Math.max(career.bestComboEver, player.bestCombo);
        byName.set(key, career);
      }

      for (const award of game.awards) {
        const career = byName.get(award.playerName.toLowerCase());
        if (career) career.awards += 1;
      }
    }

    for (const career of byName.values()) {
      decorate(career);
    }

    return [...byName.values()].sort(
      (a, b) => b.wins - a.wins || b.totalPoints - a.totalPoints || a.name.localeCompare(b.name, 'fr')
    );
  },

  /** The title one nickname currently wears, for the lobby and the podium. */
  async titleFor(name: string): Promise<string | null> {
    const careers = await this.careers();
    return careers.find((career) => career.name.toLowerCase() === name.trim().toLowerCase())?.title ?? null;
  }
};

/** Careers keyed by lowercased nickname, which is how a seat finds its own row. */
function byName(careers: PlayerCareer[]): Map<string, PlayerCareer> {
  return new Map(careers.map((career) => [career.name.toLowerCase(), career]));
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
