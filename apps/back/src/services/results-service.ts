import { desc } from 'drizzle-orm';
import { buildLeaderboard, type FinalAward } from 'game-core';

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

/**
 * Achievements, as thresholds over a career.
 *
 * Declared last-is-most-prestigious so the title is simply the final badge earned.
 * Everything free, everything earned by playing: this is the whole "battle pass",
 * minus the pressure to log in on a Tuesday.
 */
const BADGES: { key: string; earned: (career: PlayerCareer) => boolean }[] = [
  { key: 'first-game', earned: (c) => c.games >= 1 },
  { key: 'regular', earned: (c) => c.games >= 10 },
  { key: 'pillar', earned: (c) => c.games >= 50 },
  { key: 'first-win', earned: (c) => c.wins >= 1 },
  { key: 'lightning', earned: (c) => c.fastestEverMs !== null && c.fastestEverMs <= 1_500 },
  { key: 'streak-3', earned: (c) => c.bestComboEver >= 3 },
  { key: 'hundred-right', earned: (c) => c.correct >= 100 },
  { key: 'decorated', earned: (c) => c.awards >= 10 },
  { key: 'five-wins', earned: (c) => c.wins >= 5 },
  { key: 'encyclopedia', earned: (c) => c.correct >= 500 },
  { key: 'living-room-king', earned: (c) => c.wins >= 20 }
];

/** History is bounded: the stats scan reads whole rows, and evenings are finite. */
const MAX_ROWS = 500;

export const resultsService = {
  /** Writes the one permanent record of a finished session. */
  async record(state: SessionState): Promise<void> {
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
    for (const player of Object.values(state.players)) {
      await quizCareerService.credit(quizLedgerKey(player), player.totalScore);
    }
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
        const career = byName.get(key) ?? {
          name: player.name,
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

        career.games += 1;
        career.wins += player.rank === 1 ? 1 : 0;
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
      career.badges = BADGES.filter((badge) => badge.earned(career)).map((badge) => badge.key);
      career.title = career.badges.at(-1) ?? null;
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

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
