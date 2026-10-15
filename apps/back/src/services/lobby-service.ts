import type { LobbyCard, LobbyGame } from 'lobby-core';

import type { QuickplayManager } from '../quickplay/manager.js';
import type { Tables } from '../tables/host.js';
import { userService } from './user-service.js';

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

export function createLobbyService(sources: { tables: Record<LobbyGame, Tables>; quick: QuickplayManager }) {
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
      /**
       * Each card with the account that opened it, resolved to a login below.
       * What goes on a card, and which rooms get one, is each game's to say.
       */
      const rows = Object.values(sources.tables)
        .filter((tables) => wants(tables.game))
        .flatMap((tables) => tables.board());

      const byId = await logins(rows.map((row) => row.hostUserId));
      const cards: LobbyCard[] = rows.map((row) => ({
        ...row.card,
        host: row.hostUserId === null ? null : (byId.get(row.hostUserId) ?? null)
      }));

      const quick = sources.quick.cards().filter((card) => wants(card.game));

      // Quick rooms first: they are the ones that start on their own, so they are
      // the ones a stranger can join without wondering whether anybody is coming.
      return [...quick, ...cards.sort((left, right) => right.createdAt - left.createdAt)];
    }
  };
}

export type LobbyService = ReturnType<typeof createLobbyService>;
