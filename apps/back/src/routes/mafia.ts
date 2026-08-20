import { SETUPS, isSlotToken, mafiaConfigSchema } from 'mafia-core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { mafiaTemplates } from '../db/schema.js';
import { mafiaCareerService } from '../services/mafia-career-service.js';

/** Custom setup slots per account. Ten is plenty; the DB stays a shoebox. */
const MAX_TEMPLATES = 10;

const templateSchema = z.object({
  name: z.string().min(1).max(30),
  slots: z.array(z.string().max(24).refine(isSlotToken, 'Slot inconnu')).min(4).max(24)
});

/**
 * Mafia session lifecycle over REST; everything in-game runs on the socket.
 * Same contract as the CoronaZ routes: creation returns the host token once.
 */
const mafiaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/mafia/sessions',
    {
      preHandler: app.requireAuth,
      schema: { body: z.object({ config: mafiaConfigSchema.optional() }) }
    },
    async (request, reply) => {
      const taken = new Set<string>([...app.games.activeCodes(), ...app.cz.activeCodes()]);
      const state = app.mafia.create({
        hostUserId: request.currentUser.id,
        config: request.body.config,
        takenCodes: taken
      });
      return reply.code(201).send({ code: state.code, hostToken: state.hostToken });
    }
  );

  /** Thin and public, so the join screen can validate a code before asking a name. */
  app.get(
    '/mafia/sessions/:code',
    { schema: { params: z.object({ code: z.string().min(1).max(16) }) } },
    async (request) => {
      const state = app.mafia.get(request.params.code.trim().toUpperCase());
      if (!state) {
        throw app.httpErrors.notFound('Aucune partie avec ce code');
      }
      return {
        code: state.code,
        phase: state.phase,
        players: Object.keys(state.players).length,
        maxPlayers: state.config.maxPlayers
      };
    }
  );

  app.delete(
    '/mafia/sessions/:code',
    {
      preHandler: app.requireAuth,
      schema: { params: z.object({ code: z.string().min(1).max(16) }) }
    },
    async (request, reply) => {
      const state = app.mafia.get(request.params.code.trim().toUpperCase());
      if (!state) {
        throw app.httpErrors.notFound('Aucune partie avec ce code');
      }
      if (state.hostUserId !== request.currentUser.id) {
        throw app.httpErrors.forbidden("Cette partie n'est pas la vôtre");
      }
      await app.mafia.destroy(state.code);
      return reply.code(204).send();
    }
  );

  /** Live tables this account hosts, for the reattach banner. */
  app.get('/mafia/mine', { preHandler: app.requireAuth }, async (request) => {
    const mine: { code: string; hostToken: string; phase: string; players: number }[] = [];
    for (const code of app.mafia.activeCodes()) {
      const state = app.mafia.get(code);
      if (state?.hostUserId === request.currentUser.id) {
        mine.push({
          code: state.code,
          hostToken: state.hostToken,
          phase: state.phase,
          players: Object.keys(state.players).length
        });
      }
    }
    return mine;
  });

  /** The signed-in account's wallet: points and unlocks for the future store. */
  app.get('/mafia/me', { preHandler: app.requireAuth }, async (request) =>
    mafiaCareerService.forName(`@${request.currentUser.login}`)
  );

  /* ------------------------------ templates ------------------------------ */

  /** The proposed setups, for the lobby's first tab. */
  app.get('/mafia/setups', async () => SETUPS);

  /** The account's saved setups, for the second tab. */
  app.get('/mafia/templates', { preHandler: app.requireAuth }, async (request) => {
    const rows = await db.select().from(mafiaTemplates).where(eq(mafiaTemplates.user_id, request.currentUser.id));
    return rows.map((row) => ({ name: row.name, slots: JSON.parse(row.slots) as string[] }));
  });

  app.put(
    '/mafia/templates',
    { preHandler: app.requireAuth, schema: { body: templateSchema } },
    async (request, reply) => {
      const { name, slots } = request.body;
      const rows = await db.select().from(mafiaTemplates).where(eq(mafiaTemplates.user_id, request.currentUser.id));
      const exists = rows.some((row) => row.name === name);
      if (!exists && rows.length >= MAX_TEMPLATES) {
        throw app.httpErrors.badRequest(`Maximum ${MAX_TEMPLATES} modèles — supprimez-en un d'abord`);
      }
      await db
        .insert(mafiaTemplates)
        .values({
          user_id: request.currentUser.id,
          name,
          slots: JSON.stringify(slots),
          updated_at: new Date().toISOString()
        })
        .onConflictDoUpdate({
          target: [mafiaTemplates.user_id, mafiaTemplates.name],
          set: { slots: JSON.stringify(slots), updated_at: new Date().toISOString() }
        });
      return reply.code(204).send();
    }
  );

  app.delete(
    '/mafia/templates/:name',
    { preHandler: app.requireAuth, schema: { params: z.object({ name: z.string().min(1).max(30) }) } },
    async (request, reply) => {
      await db
        .delete(mafiaTemplates)
        .where(and(eq(mafiaTemplates.user_id, request.currentUser.id), eq(mafiaTemplates.name, request.params.name)));
      return reply.code(204).send();
    }
  );
};

export default mafiaRoutes;
