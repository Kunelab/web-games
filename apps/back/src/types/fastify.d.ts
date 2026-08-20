import type { Server as SocketServer } from 'socket.io';

import type { GameManager } from '../game/manager.js';
import type { SqliteSessionStore } from '../db/session-store.js';
import type { MafiaManager } from '../mafia/manager.js';
import type { CzManager } from '../zombie/manager.js';

/** Everything the API stores in the session cookie. */
export interface SessionUser {
  id: number;
  login: string;
  role: string;
}

declare module 'fastify' {
  interface Session {
    user?: SessionUser;
  }

  interface FastifyInstance {
    /** socket.io server, attached by the realtime plugin. */
    io: SocketServer;

    /** Owns every live game session. */
    games: GameManager;

    /** The session store, for resolving accounts outside the HTTP lifecycle. */
    sessions: SqliteSessionStore;

    /** Owns every live CoronaZ raid. */
    cz: CzManager;

    /** Owns every live Mafia table. */
    mafia: MafiaManager;
    /**
     * Throws 401 unless the request carries a logged-in session. Use as a
     * route-level `preHandler`.
     */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /**
     * The logged-in user, guaranteed present on routes guarded by
     * `requireAuth`. Prefer this over reaching into `request.session`.
     */
    currentUser: SessionUser;
  }
}
