import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

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

    app.decorate('requireAuth', async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
      const user = request.session?.user;

      if (!user) {
        // The frontend's axios interceptor watches for exactly this status and
        // redirects to /login?expired=1.
        throw app.httpErrors.unauthorized('Unauthorized');
      }

      request.currentUser = user;
    });
  },
  { name: 'auth', dependencies: ['@fastify/sensible'] }
);
