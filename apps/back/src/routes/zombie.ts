import { gameConfigSchema } from 'coronaz-core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { accountKey, czCareerService } from '../services/cz-career-service.js';

/**
 * CoronaZ session lifecycle over REST; everything in-game runs on the socket.
 *
 * Creation returns the host token (proves the television) and the GM token
 * (proves the game master) exactly once, like the quiz sessions: they are never
 * broadcast afterwards.
 */
const zombieRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/zombie/sessions',
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.object({
          config: gameConfigSchema.partial().optional(),
          /** Replays a world: same seed + same config = same map, same dice. */
          seed: z.number().int().min(0).max(2_147_483_647).optional(),
          /** The game master's perk pick, validated against his class. */
          gmLoadout: z.array(z.string().max(24)).max(3).optional()
        })
      }
    },
    async (request, reply) => {
      const state = await app.cz.create({
        hostUserId: request.currentUser.id,
        config: request.body.config ?? {},
        quizCodes: app.games.activeCodes(),
        seed: request.body.seed,
        gmLoadout: request.body.gmLoadout
      });

      return reply.code(201).send({
        code: state.code,
        hostToken: state.hostToken,
        gmToken: state.config.mode === 'gm' ? state.gmToken : undefined
      });
    }
  );

  /** Thin and public, so the join screen can validate a code before asking a name. */
  app.get(
    '/zombie/sessions/:code',
    { schema: { params: z.object({ code: z.string().min(1).max(16) }) } },
    async (request) => {
      const state = app.cz.get(request.params.code.trim().toUpperCase());
      if (!state) {
        throw app.httpErrors.notFound('Aucune partie avec ce code');
      }
      return {
        code: state.code,
        phase: state.phase,
        scenario: state.config.scenario,
        mode: state.config.mode,
        players: Object.keys(state.heroes).length
      };
    }
  );

  app.delete(
    '/zombie/sessions/:code',
    {
      preHandler: app.requireAuth,
      schema: { params: z.object({ code: z.string().min(1).max(16) }) }
    },
    async (request, reply) => {
      const state = app.cz.get(request.params.code.trim().toUpperCase());
      if (!state) {
        throw app.httpErrors.notFound('Aucune partie avec ce code');
      }
      if (state.hostUserId !== request.currentUser.id) {
        throw app.httpErrors.forbidden("Cette partie n'est pas la vôtre");
      }
      await app.cz.destroy(state.code);
      return reply.code(204).send();
    }
  );

  /** Live raids this account hosts, mirroring /play/mine for the reattach banner. */
  app.get('/zombie/mine', { preHandler: app.requireAuth }, async (request) => {
    const mine: { code: string; hostToken: string; gmToken?: string; phase: string; scenario: string }[] = [];

    for (const code of app.cz.activeCodes()) {
      const state = app.cz.get(code);
      if (state?.hostUserId === request.currentUser.id) {
        mine.push({
          code: state.code,
          hostToken: state.hostToken,
          gmToken: state.config.mode === 'gm' ? state.gmToken : undefined,
          phase: state.phase,
          scenario: state.config.scenario
        });
      }
    }

    return mine;
  });

  /**
   * The roguelite ledger: lifetime tallies, trophies, perks and speedrun bests
   * per nickname. Shared with every signed-in account, same reasoning as the
   * quiz history: the living room owns its records together.
   */
  app.get('/zombie/careers', { preHandler: app.requireAuth }, async () => czCareerService.list());

  /** The host's own ledger, for the setup screen's class picker. */
  app.get('/zombie/me', { preHandler: app.requireAuth }, async (request) =>
    czCareerService.forName(accountKey(request.currentUser.login))
  );

  /** Spends the host's rations on a horde class. Survivors unlock over the socket. */
  app.post(
    '/zombie/unlock',
    {
      preHandler: app.requireAuth,
      schema: { body: z.object({ classId: z.string().max(24) }) }
    },
    async (request, reply) => {
      const result = await czCareerService.unlockGm(request.currentUser.login, request.body.classId);
      if (!result.ok) {
        return reply.code(400).send({ message: result.error });
      }
      return czCareerService.forName(accountKey(request.currentUser.login));
    }
  );
};

export default zombieRoutes;
