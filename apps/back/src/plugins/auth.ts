import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { isSuperAdmin } from '../services/ownership.js';

/**
 * Provides `app.requireAuth`, the replacement for the old `isAuthenticated`
 * Express middleware. Beyond returning 401 it also copies the session user onto
 * `request.currentUser`, which is what makes the services typed: they take a
 * `SessionUser`, not a whole request object.
 */
export default fp(
  async (app) => {
    // Declared without a default: Fastify 5 shares a single prototype across
    // requests, so a reference-type default would leak between them. The value
    // is set per request by requireAuth below.
    app.decorateRequest('currentUser');

    async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
      const user = request.session?.user;

      if (!user) {
        // The frontend's axios interceptor watches for exactly this status and
        // redirects to /login?expired=1.
        throw app.httpErrors.unauthorized('Unauthorized');
      }

      request.currentUser = user;
    }

    app.decorate('requireAuth', requireAuth);

    /**
     * `requireAuth`, then 403 for anyone below super-admin, admins included.
     *
     * Read from the session like every role check, so a grant from the CLI
     * applies at the next sign-in, which is when the CLI's sign-out sends them.
     */
    app.decorate('requireSuperAdmin', async function requireSuperAdmin(request: FastifyRequest, reply: FastifyReply) {
      await requireAuth(request, reply);
      if (!isSuperAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé au super-administrateur');
      }
    });
  },
  { name: 'auth', dependencies: ['@fastify/sensible'] }
);
