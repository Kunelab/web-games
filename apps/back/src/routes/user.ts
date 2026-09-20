import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { env, frontOrigin } from '../env.js';
import { loginBlockedFor, noteLoginFailure, noteLoginSuccess } from '../services/login-throttle.js';
import { passwordResetService } from '../services/password-reset-service.js';
import { userService } from '../services/user-service.js';
import {
  changePasswordSchema,
  credentialsSchema,
  forgotPasswordSchema,
  registerSchema,
  resetPasswordSchema,
  resetTokenSchema
} from './schemas.js';

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
 * Asking for a reset link is cheap to request and not cheap to receive.
 *
 * Unauthenticated and it names somebody else's address, so without a cap it is a
 * way to have this server mail a stranger repeatedly. Five an hour is more than
 * anybody locked out of an account needs.
 */
const forgotLimit = { max: 5, timeWindow: '1 hour' };

/**
 * Spending a link, and checking one.
 *
 * Guessing a 256-bit token is not a threat this number exists for; it is here so
 * that a script cannot sit on the endpoint burning server time for free. The
 * check route shares it because the two are the same request as far as an
 * attacker with a list of candidate tokens is concerned.
 */
const resetLimit = { max: 20, timeWindow: '15 minutes' };

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

    // The role travels so a screen can offer only what the server will allow.
    // It is never the authority; see `AuthUser.role`.
    return reply.send({ login: user.login, id: user.id, role: user.role ?? "member" });
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

      /*
       * The role travels with the sign-in, exactly as it does from `GET /user`.
       *
       * It used to be left out, and the shape of the bug that caused is worth
       * remembering: the frontend does `setUser(await api.login(...))`, so the
       * account object it holds came from *this* response. Without the role, a
       * freshly signed-in admin was an admin on the server and a member in the
       * browser, until something happened to trigger a full page load and the
       * session probe filled it in. Every screen that offers admin controls went
       * missing for exactly one session, and came back after a refresh, which is
       * the most confusing way a permission can behave.
       */
      return reply.send({ login: user.login, id: user.id, role: user.role ?? 'member' });
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

      // With the role, for the reason spelled out on the login route above.
      return reply.code(201).send({ login: user.login, id: user.id, role: user.role ?? 'member' });
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

  /**
   * Asks for a reset link.
   *
   * Answers the same thing whether or not the address is known here, and takes
   * roughly as long either way: the work done for a hit is a `randomBytes` and
   * two small writes, so there is no argon2-shaped pause to distinguish the two.
   * Somebody probing a list of addresses learns nothing about which of them have
   * an account on this box.
   *
   * **There is no SMTP path yet**, so the link is written to the server log and
   * nothing is sent anywhere. That is the whole of the delivery for now, and it
   * is deliberate rather than unfinished: a reset flow that works end to end
   * except for the transport can be tested, reviewed and left in place, and the
   * day a mailer exists it replaces one function call here.
   */
  app.post(
    '/user/forgot-password',
    { config: { rateLimit: forgotLimit }, schema: { body: forgotPasswordSchema } },
    async (request, reply) => {
      const issued = await passwordResetService.issueForEmail(request.body.email);

      // Said before the branch below, so the two cases read alike from here on.
      const answer = {
        message: 'Si un compte utilise cette adresse, un lien de réinitialisation vient de lui être envoyé.'
      };

      if (!issued) {
        request.log.info({ email: request.body.email }, 'password reset asked for an unknown address');
        return reply.send(answer);
      }

      const link = `${frontOrigin}/nouveau-mot-de-passe?token=${encodeURIComponent(issued.token)}`;

      /**
       * At `warn` so it survives a production log level, and on its own line so
       * it can be copied out of `docker compose logs` without ceremony. This is
       * the mail, until there is a mailer.
       */
      app.log.warn(
        { login: issued.user.login, expiresAt: new Date(issued.expiresAt).toISOString() },
        `password reset link (no mailer configured): ${link}`
      );

      // Development only, and off unless asked for. See `PASSWORD_RESET_ECHO`.
      if (env.PASSWORD_RESET_ECHO) {
        return reply.send({ ...answer, link });
      }

      return reply.send(answer);
    }
  );

  /**
   * Whether a link is still good, so the page can say "expired" before asking
   * somebody to think of a password it is then going to refuse.
   *
   * A POST rather than a GET with the token in the path: a token in a URL ends
   * up in access logs and in `Referer` headers on the way to anything the page
   * loads afterwards, and this one is a credential for as long as it lives.
   */
  app.post(
    '/user/reset-password/check',
    { config: { rateLimit: resetLimit }, schema: { body: resetTokenSchema } },
    async (request, reply) => {
      const userId = await passwordResetService.userIdFor(request.body.token);
      return reply.send({ valid: userId !== undefined });
    }
  );

  /**
   * Spends a link and sets the password.
   *
   * The token is consumed before the write, not after: if setting the password
   * somehow fails, a link that has already been presented once should not still
   * be lying around working. Every session for the account goes too, on the same
   * reasoning as a password change — somebody resetting a password they did not
   * lose is somebody who thinks another person is in their account.
   *
   * No session is issued in return. A reset is the one password path where the
   * person at the keyboard may not be the account's owner, so it ends at the
   * login form rather than signing the browser straight in.
   */
  app.post(
    '/user/reset-password',
    { config: { rateLimit: resetLimit }, schema: { body: resetPasswordSchema } },
    async (request, reply) => {
      const userId = await passwordResetService.consume(request.body.token);
      if (userId === undefined) {
        return reply.code(400).send({ message: 'Ce lien est invalide ou a expiré' });
      }

      const changed = await userService.setPassword(userId, request.body.password);
      if (!changed) {
        return reply.code(400).send({ message: 'Ce lien est invalide ou a expiré' });
      }

      await passwordResetService.clearFor(userId);
      app.sessions.destroyForUser(userId);

      return reply.send({ message: 'Mot de passe réinitialisé' });
    }
  );

  app.post('/user/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.send({ message: 'Logged out successfully' });
  });
};

export default userRoutes;
