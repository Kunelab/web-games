import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { LOBBY_GAMES } from 'lobby-core';
import { z } from 'zod';

/**
 * The public board.
 *
 * Anonymous on purpose, like every other join-side route: players have no
 * accounts, and a board you must sign in to read is a board nobody arrives at.
 * What it exposes is exactly what a join code already exposes — that a room
 * exists and how full it is — for the rooms that asked to be found.
 */
const lobbyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/lobbies',
    { schema: { querystring: z.object({ game: z.enum(LOBBY_GAMES).optional() }) } },
    async (request) => app.lobbies.board(request.query.game)
  );
};

export default lobbyRoutes;
