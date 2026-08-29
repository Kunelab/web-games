import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { env } from '../env.js';
import { loginBlockedFor, noteLoginFailure, noteLoginSuccess } from '../services/login-throttle.js';
import { userService } from '../services/user-service.js';
import { changePasswordSchema, credentialsSchema, registerSchema } from './schemas.js';

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

/** Changing a password is rarer still, and it verifies the old one to do it. */
const passwordLimit = { max: 5, timeWindow: '15 minutes' };

/**
 * Everything a session hands out is re-issued here.
 *
 * Fastify's session keeps the same identifier when you write to it, so signing
 * somebody in used to authenticate whatever id their browser already carried —
 * including one an attacker had planted, which is session fixation and the one
 * real hole this file had. Regenerating means the cookie that walks out of a
 * login is one nobody else has ever seen.
 */
async function startSession(
  request: { session: { regenerate: () => Promise<void>; save: () => Promise<void>; user?: unknown } },
  user: { id: number; login: string; role: string }
): Promise<void> {
  await request.session.regenerate();
  request.session.user = user;
  await request.session.save();
}

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

      /**
       * Checked before argon2 runs, not after. A throttled account should cost
       * the server nothing, and 19 MiB of hashing per guess is otherwise a
       * denial of service an attacker gets handed for free.
       */
      const blockedFor = loginBlockedFor(username);
      if (blockedFor > 0) {
        return reply
          .code(429)
          .header('retry-after', Math.ceil(blockedFor / 1000))
          .send({ message: 'Trop de tentatives. Réessayez dans un instant.' });
      }

      const user = await userService.authenticate(username, password);

      if (!user || !user.login) {
        noteLoginFailure(username);
        return reply.code(400).send({ message: 'Invalid username or password' });
      }

      noteLoginSuccess(username);
      await startSession(request, { id: user.id, login: user.login, role: user.role ?? 'member' });

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

      // The check above is for the error message; this is for the truth. Two
      // registrations racing for one name both clear it, and the unique index
      // is what stops the second from creating an account nobody can reach.
      const created = await userService.create(username, password, email);
      if (!created.ok) {
        return reply.code(409).send({ message: 'That username is already taken' });
      }

      const { user } = created;
      await startSession(request, { id: user.id, login: user.login ?? username, role: user.role ?? 'member' });

      return reply.code(201).send({ login: user.login, id: user.id });
    }
  );

  /**
   * Change a password, the old one being the proof.
   *
   * Not a reset: nothing leaves this deployment by e-mail yet, so the only way
   * back into an account is to already be in it. The session is re-issued on the
   * way out, which is what makes this useful after a scare — whoever else was
   * holding a cookie for this account stops being logged in.
   */
  app.post(
    '/user/password',
    {
      preHandler: app.requireAuth,
      config: { rateLimit: passwordLimit },
      schema: { body: changePasswordSchema }
    },
    async (request, reply) => {
      const { current, next } = request.body;
      const me = request.currentUser;

      const changed = await userService.changePassword(me.id, current, next);
      if (!changed) {
        return reply.code(400).send({ message: 'Mot de passe actuel incorrect' });
      }

      // Every session, this one included: whoever else was holding a cookie for
      // this account stops being logged in, which is the reason somebody changes
      // a password in a hurry. The caller gets a brand new one immediately below,
      // so they are not signed out of the tab they did it from.
      app.sessions.destroyForUser(me.id);
      await startSession(request, { id: me.id, login: me.login, role: me.role ?? 'member' });
      return reply.send({ message: 'Mot de passe modifié' });
    }
  );

  app.post('/user/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.send({ message: 'Logged out successfully' });
  });
};

export default userRoutes;
