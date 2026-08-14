import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sessionConfigSchema } from 'game-core';
import { z } from 'zod';

import { frontOrigin } from '../env.js';
import { loadAssetOnce, resolveAsset } from '../game/assets.js';
import { playlistService } from '../services/playlist-service.js';
import { resultsService } from '../services/results-service.js';

/**
 * Types the proxy will serve. SVG is included because a flag, a logo or a diagram is
 * usually one, and the response hardens itself against the one risk that brings.
 */
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml'
]);

/** Wikimedia throttles unidentified callers, and this proxy talks to it a lot. */
const ASSET_USER_AGENT = 'KuneLabWebGames/0.3 (game asset proxy; https://github.com/Kunelab)';

/** Cap on a proxied image, so a hostile source cannot exhaust memory. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const playRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Starts a game from a playlist. Host-only, so this one needs a session.
   *
   * Returns the join code and the host token. The host token is what proves later
   * socket messages really come from the host, so it is returned once here and never
   * broadcast.
   */
  app.post(
    '/play/sessions',
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.object({
          playlistId: z.coerce.number().int().positive(),
          config: sessionConfigSchema.partial().optional()
        })
      }
    },
    async (request, reply) => {
      const playlist = await playlistService.getById(request.body.playlistId, request.currentUser.id);
      if (!playlist) {
        throw app.httpErrors.notFound('Playlist introuvable');
      }

      if (playlist.items.length === 0) {
        return reply.code(400).send({ message: 'Cette playlist est vide' });
      }

      const state = await app.games.create({
        playlistId: playlist.id,
        playlistName: playlist.name ?? 'Partie',
        hostUserId: request.currentUser.id,
        items: playlist.items,
        config: request.body.config
      });

      if (state.order.length === 0) {
        await app.games.destroy(state.code);
        return reply.code(400).send({
          message: "Aucun média de cette playlist n'est prêt à être joué",
          skipped: state.skipped
        });
      }

      return reply.code(201).send({
        code: state.code,
        hostToken: state.hostToken,
        total: state.order.length,
        skipped: state.skipped
      });
    }
  );

  /**
   * Whether a code is live, so the join screen can say "no such game" before asking
   * for a nickname. Deliberately public and deliberately thin: it reveals only that
   * a code exists and how many players are in it.
   */
  app.get(
    '/play/sessions/:code',
    { schema: { params: z.object({ code: z.string().min(1).max(16) }) } },
    async (request) => {
      const state = app.games.get(request.params.code.trim().toUpperCase());
      if (!state) {
        throw app.httpErrors.notFound('Aucune partie avec ce code');
      }

      return {
        code: state.code,
        phase: state.phase,
        playlistName: state.playlistName,
        players: Object.keys(state.players).length,
        total: state.order.length
      };
    }
  );

  app.delete(
    '/play/sessions/:code',
    {
      preHandler: app.requireAuth,
      schema: { params: z.object({ code: z.string().min(1).max(16) }) }
    },
    async (request, reply) => {
      const state = app.games.get(request.params.code.trim().toUpperCase());
      if (!state) {
        throw app.httpErrors.notFound('Aucune partie avec ce code');
      }
      if (state.hostUserId !== request.currentUser.id) {
        throw app.httpErrors.forbidden("Cette partie n'est pas la vôtre");
      }

      await app.games.destroy(state.code);
      return reply.code(204).send();
    }
  );

  /**
   * Serves a round asset behind an opaque token.
   *
   * Public on purpose: players are not logged in. The token is a keyed hash the
   * server issued for this round, so possessing it is the authorisation. The bytes
   * are proxied rather than redirected to, because a redirect's Location header would
   * carry the filename, and in a guessing game the filename is frequently the answer.
   */
  app.get(
    '/play/asset/:token',
    { schema: { params: z.object({ token: z.string().length(32) }) } },
    async (request, reply) => {
      const source = resolveAsset(request.params.token);
      if (!source) {
        throw app.httpErrors.notFound('Ressource expirée');
      }

      // Relative paths are frontend assets; resolve them against the frontend origin.
      const target = /^https?:\/\//i.test(source)
        ? source
        : `${frontOrigin}${source.startsWith('/') ? '' : '/'}${source}`;

      /**
       * Fetched once per source, not once per player.
       *
       * A panel is twenty or forty images and every phone in the room asks for all of
       * them within a second or two. Going upstream for each one earns a 429 from
       * Wikimedia and a scattering of broken cells, so identical requests share a
       * single fetch and the bytes are kept for the length of a round.
       */
      const asset = await loadAssetOnce(source, async () => {
        let upstream: Response;
        try {
          upstream = await fetch(target, {
            signal: AbortSignal.timeout(10_000),
            // Wikimedia rate-limits anonymous agents hardest, and asks callers to say
            // who they are.
            headers: { 'user-agent': ASSET_USER_AGENT }
          });
        } catch (error) {
          request.log.warn({ err: error, target }, 'asset proxy fetch failed');
          throw app.httpErrors.badGateway('Ressource inaccessible');
        }

        if (!upstream.ok || !upstream.body) {
          throw app.httpErrors.badGateway(`Ressource inaccessible (${upstream.status})`);
        }

        const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
        if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
          throw app.httpErrors.unsupportedMediaType(`Type non autorisé : ${contentType || 'inconnu'}`);
        }

        const declaredLength = Number(upstream.headers.get('content-length') ?? '0');
        if (declaredLength > MAX_ASSET_BYTES) {
          throw app.httpErrors.payloadTooLarge('Image trop volumineuse');
        }

        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.byteLength > MAX_ASSET_BYTES) {
          throw app.httpErrors.payloadTooLarge('Image trop volumineuse');
        }

        return { contentType, body };
      });

      return (
        reply
          .header('content-type', asset.contentType)
          .header('cache-control', 'private, max-age=1800')
          // The token already scopes this to one round; nothing else should index it.
          .header('x-robots-tag', 'noindex')
          .header('x-content-type-options', 'nosniff')
          /**
           * An SVG opened as a document can run script, and these are served from the
           * API's own origin. In an `img` tag that never happens, but the URL is a plain
           * link a player could paste into the address bar, so the response refuses to
           * load anything of its own.
           */
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
          .send(asset.body)
      );
    }
  );

  /** Live sessions the caller hosts, so a reload can reattach to their game. */
  app.get('/play/mine', { preHandler: app.requireAuth }, async (request) => {
    const mine: { code: string; hostToken: string; phase: string; playlistName: string }[] = [];

    for (const code of app.games.activeCodes()) {
      const state = app.games.get(code);
      if (state?.hostUserId === request.currentUser.id) {
        mine.push({
          code: state.code,
          hostToken: state.hostToken,
          phase: state.phase,
          playlistName: state.playlistName
        });
      }
    }

    return mine;
  });

  /**
   * Finished games, newest first.
   *
   * Any signed-in account sees all of them, not only its own: this is a shared
   * instance for one living room, and "who won last Saturday" is a question the
   * whole room owns. Players themselves have no accounts, so scoping by host would
   * hide most of the history from the people who played it.
   */
  app.get(
    '/play/results',
    {
      preHandler: app.requireAuth,
      schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) }) }
    },
    async (request) => resultsService.list(request.query.limit)
  );

  /** Lifetime tallies per nickname, across every recorded game. */
  app.get('/play/careers', { preHandler: app.requireAuth }, async () => resultsService.careers());
};

export default playRoutes;
