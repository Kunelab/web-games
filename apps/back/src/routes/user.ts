import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { env } from '../env.js';
import { userService } from '../services/user-service.js';
import { credentialsSchema, registerSchema } from './schemas.js';

/**
 * Ten attempts a minute from one address.
 *
 * Generous enough that nobody mistyping their password notices, and low enough
 * that guessing at it is not worth starting. Keyed on the address, which behind
 * nginx means the forwarded one, since `trustProxy` is on in production.
 */
const loginLimit = { max: 10, timeWindow: '1 minute' };

/** Accounts are created once. Five an hour is already more than anyone needs. */
const registerLimit = { max: 5, timeWindow: '1 hour' };

const userRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Who am I? Returns `null` (not 401) when nobody is logged in, because the
   * frontend calls this on every page load including the public home page, and
   * a 401 would trip the axios interceptor into a redirect loop.
   *
   * The Express version returned without sending anything at all in the
   * anonymous case, which left the request hanging until the client timed out.
   */
  app.get('/user', async (request, reply) => {
    const user = request.session?.user;

    if (!user?.login) {
      return reply.code(200).send(null);
    }

    return reply.send({ login: user.login, id: user.id });
  });

  app.post(
    '/user/login',
    { config: { rateLimit: loginLimit }, schema: { body: credentialsSchema } },
    async (request, reply) => {
      const { username, password } = request.body;
      const user = await userService.authenticate(username, password);

      if (!user || !user.login) {
        return reply.code(400).send({ message: 'Invalid username or password' });
      }

      request.session.user = { id: user.id, login: user.login, role: user.role ?? 'member' };
      await request.session.save();

      return reply.send({ login: user.login, id: user.id });
    }
  );

  app.post(
    '/user/register',
    { config: { rateLimit: registerLimit }, schema: { body: registerSchema } },
    async (request, reply) => {
      /**
       * Closing registration is what makes a public deployment safe to leave up:
       * the accounts that exist keep working, and nobody new can create one. It is
       * checked here rather than by not registering the route, so the frontend gets
       * a message it can show instead of a 404 that looks like a broken build.
       */
      if (!env.REGISTRATION_OPEN) {
        return reply.code(403).send({ message: 'Les inscriptions sont fermées' });
      }

      const { username, password, email } = request.body;

      const existing = await userService.getByLogin(username);
      if (existing) {
        return reply.code(409).send({ message: 'That username is already taken' });
      }

      const user = await userService.create(username, password, email);

      request.session.user = { id: user.id, login: user.login ?? username, role: user.role ?? 'member' };
      await request.session.save();

      return reply.code(201).send({ login: user.login, id: user.id });
    }
  );

  app.post('/user/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.send({ message: 'Logged out successfully' });
  });
};

export default userRoutes;
