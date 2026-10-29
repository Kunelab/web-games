import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ExplorerError, explorer } from '../services/db-explorer.js';

/**
 * The database explorer, for super-admins only. Reads, never writes; see
 * `db-explorer.ts` for what is masked and why.
 *
 * Every look is logged with who took it: this is the one screen that shows
 * every player's rows, and the log is how that stays accountable.
 */
const adminDbRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireSuperAdmin);

  /** Turns the explorer's refusals into their status, anything else stays a 500. */
  function answer<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (error instanceof ExplorerError) {
        throw error.status === 404 ? app.httpErrors.notFound(error.message) : app.httpErrors.badRequest(error.message);
      }
      throw error;
    }
  }

  const tableParams = z.object({ table: z.string().min(1).max(64) });

  app.get('/admin/db/tables', async (request) => {
    request.log.info({ userId: request.currentUser.id }, 'database explorer: tables');
    return { tables: explorer.tables() };
  });

  app.get(
    '/admin/db/tables/:table',
    {
      schema: {
        params: tableParams,
        querystring: z.object({
          page: z.coerce.number().int().min(0).max(1_000_000).default(0),
          sort: z.string().min(1).max(64).optional(),
          direction: z.enum(['asc', 'desc']).default('asc')
        })
      }
    },
    async (request) => {
      const { table } = request.params;
      request.log.info({ userId: request.currentUser.id, table, page: request.query.page }, 'database explorer: rows');
      return answer(() => explorer.page(table, request.query));
    }
  );

  app.get(
    '/admin/db/tables/:table/rows/:rowid',
    { schema: { params: tableParams.extend({ rowid: z.coerce.number().int() }) } },
    async (request) => {
      const { table, rowid } = request.params;
      request.log.info({ userId: request.currentUser.id, table, rowid }, 'database explorer: row');
      return answer(() => explorer.row(table, rowid));
    }
  );
};

export default adminDbRoutes;
