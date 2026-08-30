import { msg } from 'i18n';
import type { LobbyCard, LobbyGame } from 'lobby-core';

import type { GameManager } from '../game/manager.js';
import type { MafiaManager } from '../mafia/manager.js';
import type { QuickplayManager } from '../quickplay/manager.js';
import { userService } from './user-service.js';
import type { CzManager } from '../zombie/manager.js';

/**
 * The board: every room in the house that said it wanted company.
 *
 * Three engines with three lobbies and three vocabularies, flattened into one
 * list. What makes that possible is that a player scanning for a game to join is
 * not asking an engine question — they want to know what is being played, by how
 * many, and whether there is space. Those four fields are the same everywhere, so
 * the board is the same everywhere.
 *
 * Only rooms that have not started are listed, and only those whose config says
 * `public`. A private game is not hidden by obscurity here: it is simply never in
 * the list, and its code remains the only way in.
 */

/** Every card line is a key: the board is read by phones in two languages. */
const MAFIA_SETUP_KEYS: Record<string, string> = {
  auto: 'lobby.card.setup.auto',
  chaos: 'lobby.card.setup.chaos',
  census: 'lobby.card.setup.census',
  preset: 'lobby.card.setup.preset',
  custom: 'lobby.card.setup.custom'
};

export function createLobbyService(managers: {
  games: GameManager;
  cz: CzManager;
  mafia: MafiaManager;
  quick: QuickplayManager;
}) {
  /** Logins are looked up once per board rather than once per row. */
  async function logins(ids: (number | null)[]): Promise<Map<number, string | null>> {
    const unique = [...new Set(ids.filter((id): id is number => id !== null))];
    const entries = await Promise.all(
      unique.map(async (id) => {
        const user = await userService.getById(id);
        return [id, user?.login ?? null] as const;
      })
    );
    return new Map(entries);
  }

  return {
    async board(game?: LobbyGame): Promise<LobbyCard[]> {
      const wants = (candidate: LobbyGame) => game === undefined || game === candidate;
      /** Each card with the account that opened it, resolved to a login below. */
      const rows: { card: LobbyCard; hostId: number | null }[] = [];

      if (wants('quiz')) {
        for (const code of managers.games.activeCodes()) {
          const state = managers.games.get(code);
          if (!state || state.phase !== 'lobby' || !state.config.public) continue;
          rows.push({ hostId: state.hostUserId, card: {
            game: 'quiz',
            code: state.code,
            title: state.playlistName,
            detail: msg('lobby.card.rounds', { count: state.order.length }),
            host: null,
            players: Object.keys(state.players).length,
            maxPlayers: null,
            createdAt: state.lastActivityAt,
            quick: false
          } });
        }
      }

      if (wants('coronaz')) {
        for (const code of managers.cz.activeCodes()) {
          const state = managers.cz.get(code);
          if (!state || state.phase !== 'lobby' || !state.config.public) continue;
          rows.push({ hostId: state.hostUserId, card: {
            game: 'coronaz',
            code: state.code,
            title: msg(`coronaz.scenario.${state.config.scenario}.name`),
            detail: msg(state.config.mode === 'gm' ? 'lobby.card.hordeGm' : 'lobby.card.hordeAi'),
            host: null,
            players: Object.keys(state.heroes).length,
            maxPlayers: 5,
            createdAt: state.lastActivityAt,
            quick: false
          } });
        }
      }

      if (wants('mafia')) {
        for (const code of managers.mafia.activeCodes()) {
          const state = managers.mafia.get(code);
          if (!state || state.phase !== 'lobby' || !state.config.public) continue;
          rows.push({ hostId: state.hostUserId, card: {
            game: 'mafia',
            code: state.code,
            title: msg(MAFIA_SETUP_KEYS[state.config.setup.mode] ?? 'lobby.card.table'),
            detail: msg('lobby.card.dayLength', { minutes: Math.round(state.config.dayMs / 60_000) }),
            host: null,
            players: Object.keys(state.players).length,
            maxPlayers: state.config.maxPlayers,
            createdAt: state.lastActivityAt,
            quick: false
          } });
        }
      }

      const byId = await logins(rows.map((row) => row.hostId));
      const cards = rows.map((row) => ({
        ...row.card,
        host: row.hostId === null ? null : (byId.get(row.hostId) ?? null)
      }));

      const quick = managers.quick.cards().filter((card) => wants(card.game));

      // Quick rooms first: they are the ones that start on their own, so they are
      // the ones a stranger can join without wondering whether anybody is coming.
      return [...quick, ...cards.sort((left, right) => right.createdAt - left.createdAt)];
    }
  };
}

export type LobbyService = ReturnType<typeof createLobbyService>;
