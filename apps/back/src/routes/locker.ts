import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CURRENCIES, LOBBY_GAMES, SHOP, shopFor } from 'lobby-core';
import { z } from 'zod';

import { lockerService } from '../services/locker-service.js';

/**
 * The shop and the wardrobe.
 *
 * Signed in, always: this is the one part of the site that spends something, and
 * a purchase has to belong to somebody who will still be there tomorrow. The
 * catalogue itself is public — knowing what a hat costs is not a secret, and the
 * game menus show it to visitors as a reason to make an account.
 */
const lockerRoutes: FastifyPluginAsyncZod = async (app) => {
  const gameParam = z.object({ game: z.enum(LOBBY_GAMES) });

  /** The whole catalogue, with the currency each game charges in. */
  app.get('/shop', async () => ({ items: SHOP, currencies: CURRENCIES }));

  app.get('/shop/:game', { schema: { params: gameParam } }, async (request) => ({
    items: shopFor(request.params.game),
    currency: CURRENCIES[request.params.game]
  }));

  app.get(
    '/locker/:game',
    { preHandler: app.requireAuth, schema: { params: gameParam } },
    async (request) => lockerService.get(request.currentUser.id, request.currentUser.login, request.params.game)
  );

  app.post(
    '/locker/:game/buy',
    {
      preHandler: app.requireAuth,
      schema: { params: gameParam, body: z.object({ itemId: z.string().min(1).max(64) }) }
    },
    async (request, reply) => {
      const result = await lockerService.buy(
        request.currentUser.id,
        request.currentUser.login,
        request.params.game,
        request.body.itemId
      );

      if (!result.ok) {
        return reply.code(400).send({ message: result.error });
      }
      return result.locker;
    }
  );

  app.post(
    '/locker/:game/wear',
    {
      preHandler: app.requireAuth,
      schema: {
        params: gameParam,
        body: z.object({
          slot: z.string().min(1).max(32),
          /** Null takes the slot's item back off. */
          itemId: z.string().min(1).max(64).nullable()
        })
      }
    },
    async (request, reply) => {
      const result = await lockerService.wear(
        request.currentUser.id,
        request.currentUser.login,
        request.params.game,
        request.body.slot,
        request.body.itemId
      );

      if (!result.ok) {
        return reply.code(400).send({ message: result.error });
      }
      return result.locker;
    }
  );
};

export default lockerRoutes;
