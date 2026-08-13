import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { playlistInputSchema, playlistService } from '../services/playlist-service.js';
import { idParamSchema } from './schemas.js';

const playlistRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Playlists visible to the caller, contents included.
   *
   * There is no separate "full" variant any more. The old API had `/playlists` and
   * `/playlists/full` returning different shapes, and every caller used the full
   * one; with a single media table the join is cheap enough that splitting them
   * bought nothing.
   */
  app.get('/playlists', async (request) => {
    return playlistService.list(request.currentUser.id);
  });

  app.get('/playlists/:id', { schema: { params: idParamSchema } }, async (request) => {
    const playlist = await playlistService.getById(request.params.id, request.currentUser.id);
    if (!playlist) {
      throw app.httpErrors.notFound('Playlist introuvable');
    }
    return playlist;
  });

  app.post('/playlists', { schema: { body: playlistInputSchema } }, async (request, reply) => {
    const created = await playlistService.create(request.body, request.currentUser.id);
    return reply.code(201).send(created);
  });

  app.patch(
    '/playlists/:id',
    { schema: { params: idParamSchema, body: playlistInputSchema.partial() } },
    async (request, reply) => {
      // Visibility and ownership are different questions: a public playlist is
      // readable by everyone and editable only by its owner.
      const owned = await playlistService.isOwnedBy(request.params.id, request.currentUser.id);
      if (!owned) {
        throw app.httpErrors.notFound('Playlist introuvable');
      }

      const updated = await playlistService.update(request.params.id, request.body, request.currentUser.id);
      if (!updated) {
        throw app.httpErrors.notFound('Playlist introuvable');
      }
      return reply.send(updated);
    }
  );

  /**
   * Copies a playlist into the caller's own, contents and order included.
   *
   * Allowed on anything they can see rather than only on what they own, because
   * taking a public playlist as a starting point is the reason to make it public.
   * What survives the copy is decided by the service.
   */
  app.post('/playlists/:id/duplicate', { schema: { params: idParamSchema } }, async (request, reply) => {
    const result = await playlistService.duplicate(request.params.id, request.currentUser.id);
    if (!result) {
      throw app.httpErrors.notFound('Playlist introuvable');
    }
    return reply.code(201).send({ ...result.playlist, dropped: result.dropped });
  });

  app.delete('/playlists/:id', { schema: { params: idParamSchema } }, async (request, reply) => {
    const deleted = await playlistService.remove(request.params.id, request.currentUser.id);
    if (!deleted) {
      throw app.httpErrors.notFound('Playlist introuvable');
    }
    return reply.code(204).send();
  });
};

export default playlistRoutes;
