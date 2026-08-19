import { unsign } from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { Socket } from 'socket.io';

import { env } from '../env.js';

/**
 * Resolves the Kune account behind a socket, or null for an anonymous phone.
 *
 * Sockets have never carried an identity in this codebase: players join a raid
 * from a phone with a nickname and a token they store themselves. But rewards
 * should follow the *account* when there is one, so a laptop that is logged in
 * banks its rations under its login and keeps them across nicknames.
 *
 * The handshake carries the same `kune.sid` cookie the REST API uses, signed by
 * `@fastify/session` with `env.SECRET`. We verify the signature ourselves and
 * read the session row directly: trusting a client-sent login would let anyone
 * bank rations into anyone's account.
 */
export async function accountOf(app: FastifyInstance, socket: Socket): Promise<string | null> {
  const header = socket.handshake.headers.cookie;
  if (!header) return null;

  const raw = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('kune.sid='))
    ?.slice('kune.sid='.length);
  if (!raw) return null;

  const unsigned = unsign(decodeURIComponent(raw), env.SECRET);
  if (!unsigned.valid || !unsigned.value) return null;

  try {
    const sessionId = unsigned.value;
    const session = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
      app.sessions.get(sessionId, (error, found) => {
        if (error) reject(new Error('session lookup failed'));
        else resolve((found as Record<string, unknown> | null) ?? null);
      });
    });
    const user = session?.user as { login?: string } | undefined;
    return typeof user?.login === 'string' && user.login ? user.login : null;
  } catch {
    // A session we cannot read is an anonymous player, not an error: the raid
    // must still start.
    return null;
  }
}
