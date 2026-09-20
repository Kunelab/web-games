import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { bugReportSchema, bugReportService } from '../services/bug-report-service.js';
import { isAdmin } from '../services/ownership.js';
import { idParamSchema } from './schemas.js';

/**
 * Three a quarter of an hour from one address.
 *
 * Anonymous and free-text, so without a cap it is a way to fill the operator's
 * table with whatever somebody likes. Three is enough for a real evening of
 * finding things wrong, and the rejection says to wait rather than pretending to
 * have accepted.
 */
const reportLimit = { max: 3, timeWindow: '15 minutes' };

const bugRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Files a report. Deliberately open to anyone.
   *
   * Requiring a session here would lose the reports that matter most: the
   * commonest moment to meet a bug is halfway through a game, and the players in
   * a game joined with a nickname and have no account at all. What an anonymous
   * report costs is one row; what it buys is the only account of a fault nobody
   * can reproduce afterwards.
   *
   * Nothing is mailed. There is no SMTP path out of this deployment, so the
   * report waits in a table for whoever runs the box; see `bug-report-service`.
   */
  app.post(
    '/bugs',
    { config: { rateLimit: reportLimit }, schema: { body: bugReportSchema } },
    async (request, reply) => {
      const id = await bugReportService.create(request.body, {
        // `request.session?.user` rather than `currentUser`, which only exists on
        // routes behind `requireAuth` and this one deliberately is not.
        user: request.session?.user ?? null,
        userAgent: request.headers['user-agent']
      });

      request.log.info({ id, area: request.body.area }, 'bug report filed');

      return reply.code(201).send({ id, message: 'Merci, le rapport est bien arrivé.' });
    }
  );

  /**
   * Reading them is the operator's, and only the operator's.
   *
   * A report carries a page path, a user agent and whatever its author chose to
   * type, which taken together is about a named person. `isAdmin` rather than
   * ownership: these belong to whoever runs the deployment, not to whoever sent
   * one, and nobody gets to read their own back.
   */
  app.get(
    '/bugs',
    {
      preHandler: app.requireAuth,
      schema: { querystring: z.object({ status: z.enum(['new', 'seen', 'closed']).optional() }) }
    },
    async (request) => {
      if (!isAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé à un administrateur');
      }
      return bugReportService.list(request.query.status);
    }
  );

  app.patch(
    '/bugs/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: idParamSchema, body: z.object({ status: z.enum(['new', 'seen', 'closed']) }) }
    },
    async (request, reply) => {
      if (!isAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé à un administrateur');
      }

      const moved = await bugReportService.setStatus(request.params.id, request.body.status);
      if (!moved) {
        throw app.httpErrors.notFound('Rapport introuvable');
      }
      return reply.send({ message: 'Rapport mis à jour' });
    }
  );

  /** The answer to "please delete what I sent you"; see the privacy page. */
  app.delete(
    '/bugs/:id',
    { preHandler: app.requireAuth, schema: { params: idParamSchema } },
    async (request, reply) => {
      if (!isAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé à un administrateur');
      }

      const removed = await bugReportService.remove(request.params.id);
      if (!removed) {
        throw app.httpErrors.notFound('Rapport introuvable');
      }
      return reply.code(204).send();
    }
  );
};

export default bugRoutes;
