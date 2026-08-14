import { availableMediaKinds, blindtest, validateMedia, type MediaInput } from 'game-core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { mediaQuerySchema, mediaService } from '../services/media-service.js';
import {
  buildPanel,
  DEFAULT_DIFFICULTY_RANGE,
  DIFFICULTY_PRESETS,
  lookupSubjects,
  MAX_PANEL_SIZE,
  NATIONALITIES,
  nationalityIds,
  PANEL_THEMES,
  PanelError,
  panelThemeIds,
  type NationalityId
} from '../services/panel-service.js';
import { fetchPlaylistItems, fetchVideoMetadata, YoutubeError } from '../services/youtube-service.js';
import { idParamSchema } from './schemas.js';

/** Themes arrive as a comma-separated list, so that mixing is just several ids. */
const panelQuerySchema = z.object({
  themes: z
    .string()
    .min(1)
    .max(200)
    .transform((value) => value.split(',').map((entry) => entry.trim()))
    .refine((themes) => themes.every((theme) => panelThemeIds.includes(theme)), {
      message: 'Thème de panel inconnu'
    }),
  count: z.coerce.number().int().min(1).max(MAX_PANEL_SIZE).default(20),
  /** The obscurity window, 0 (household names) to 100 (deep cuts). */
  dmin: z.coerce.number().int().min(0).max(100).default(DEFAULT_DIFFICULTY_RANGE.min),
  dmax: z.coerce.number().int().min(0).max(100).default(DEFAULT_DIFFICULTY_RANGE.max),
  /** Comma-separated nationality ids, applied to the people themes only. */
  nats: z
    .string()
    .max(80)
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry): entry is NationalityId => (nationalityIds as string[]).includes(entry))
    )
});

/** Accepts a bare id or any YouTube URL that carries one. */
const youtubeRefSchema = z.object({
  ref: z.string().min(1).max(300)
});

function extractVideoId(reference: string): string | null {
  const trimmed = reference.trim();

  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('v');
    if (fromQuery && /^[A-Za-z0-9_-]{11}$/.test(fromQuery)) {
      return fromQuery;
    }
    // youtu.be/<id> and /embed/<id> and /shorts/<id>
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (last && /^[A-Za-z0-9_-]{11}$/.test(last)) {
      return last;
    }
  } catch {
    // Not a URL; fall through.
  }

  return null;
}

const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  /**
   * The kind registry, so the editor can build its forms from the same definitions
   * the server validates against rather than duplicating them.
   */
  app.get('/media/kinds', async () => {
    return availableMediaKinds.map((kind) => ({
      id: kind.id,
      label: kind.label,
      description: kind.description,
      icon: kind.icon,
      formFields: kind.formFields,
      defaultPayload: kind.defaultPayload,
      defaultAnswers: kind.defaultAnswers,
      answersEditable: kind.answersEditable,
      defaultTiming: kind.defaultTiming,
      presentedByHost: kind.presentedByHost
    }));
  });

  app.get('/media', { schema: { querystring: mediaQuerySchema } }, async (request) => {
    return mediaService.list(request.currentUser, request.query);
  });

  app.get('/media/categories', async (request) => {
    return mediaService.categories(request.currentUser);
  });

  app.post('/media', async (request, reply) => {
    const parsed = validateMedia(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Média invalide', details: parsed.error.issues });
    }

    const created = await mediaService.create(parsed.data, request.currentUser);
    return reply.code(201).send(created);
  });

  app.get('/media/:id', { schema: { params: idParamSchema } }, async (request) => {
    const item = await mediaService.getById(request.params.id, request.currentUser);
    if (!item) {
      throw app.httpErrors.notFound('Média introuvable');
    }
    return item;
  });

  app.patch('/media/:id', { schema: { params: idParamSchema } }, async (request, reply) => {
    const parsed = validateMedia(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Média invalide', details: parsed.error.issues });
    }

    const updated = await mediaService.update(request.params.id, parsed.data, request.currentUser);

    if (!updated) {
      throw app.httpErrors.notFound('Média introuvable');
    }
    return reply.send(updated);
  });

  /**
   * Copies an item. A POST because it creates one, and it takes no body because
   * everything it needs is already on the item being copied.
   */
  app.post('/media/:id/duplicate', { schema: { params: idParamSchema } }, async (request, reply) => {
    const created = await mediaService.duplicate(request.params.id, request.currentUser);
    if (!created) {
      throw app.httpErrors.notFound('Média introuvable');
    }
    return reply.code(201).send(created);
  });

  app.delete('/media/:id', { schema: { params: idParamSchema } }, async (request, reply) => {
    const deleted = await mediaService.remove(request.params.id, request.currentUser);
    if (!deleted) {
      throw app.httpErrors.notFound('Média introuvable');
    }
    return reply.code(204).send();
  });

  /** How many playlists use an item, so the UI can warn before deleting. */
  app.get('/media/:id/usage', { schema: { params: idParamSchema } }, async (request) => {
    const item = await mediaService.getById(request.params.id, request.currentUser);
    if (!item) {
      throw app.httpErrors.notFound('Média introuvable');
    }
    return { playlists: await mediaService.usageCount(request.params.id) };
  });

  /**
   * The themes a panel can be built from, so the editor lists what exists.
   *
   * Groups, nationalities and difficulties are the server's knowledge too: the
   * editor renders whatever this returns and hardcodes none of it.
   */
  app.get('/media/panel/themes', async () => ({
    themes: PANEL_THEMES.map((theme) => ({
      id: theme.id,
      label: theme.label,
      group: theme.group,
      /** True when the nationality picker applies to this theme. */
      byNationality: (theme.sourceTemplates?.length ?? 0) > 0
    })),
    nationalities: NATIONALITIES.map((nationality) => ({
      id: nationality.id,
      label: nationality.label
    })),
    /** Named windows on the 0–100 obscurity scale; the slider is the real dial. */
    difficultyPresets: DIFFICULTY_PRESETS,
    defaultRange: DEFAULT_DIFFICULTY_RANGE
  }));

  /**
   * Builds a memory panel from Wikipedia.
   *
   * A GET because it reads: the same themes and count may return a different draw,
   * but nothing here is stored. Nothing is written to the media item either until
   * the host saves, so a draw they dislike costs one more click.
   */
  app.get('/media/panel', { schema: { querystring: panelQuerySchema } }, async (request) => {
    try {
      const items = await buildPanel(request.query.themes, request.query.count, {
        difficulty: { min: request.query.dmin, max: request.query.dmax },
        nationalities: request.query.nats
      });
      return { items };
    } catch (error) {
      if (error instanceof PanelError) {
        throw app.httpErrors.createError(error.statusCode, error.message);
      }
      throw error;
    }
  });

  /**
   * The panel pipeline pointed at a free-text query: one subject, its picture, its
   * opening lines. What the image-reveal editor calls to turn a name into a
   * playable round, and deliberately kind-agnostic so the next kind gets it free.
   */
  app.get(
    '/media/wiki/search',
    { schema: { querystring: z.object({ q: z.string().trim().min(2).max(120) }) } },
    async (request) => {
      try {
        return { results: await lookupSubjects(request.query.q) };
      } catch (error) {
        if (error instanceof PanelError) {
          throw app.httpErrors.createError(error.statusCode, error.message);
        }
        throw error;
      }
    }
  );

  /**
   * Prefill from a YouTube link. The key stays server-side, and the response is
   * a suggestion: every field remains editable, because the "Artist - Title" split
   * is a convention rather than a guarantee.
   */
  app.post('/media/youtube/lookup', { schema: { body: youtubeRefSchema } }, async (request, reply) => {
    const videoId = extractVideoId(request.body.ref);
    if (!videoId) {
      return reply.code(400).send({ message: "Impossible d'extraire un identifiant YouTube de ce lien" });
    }

    try {
      return await fetchVideoMetadata(videoId);
    } catch (error) {
      if (error instanceof YoutubeError) {
        throw app.httpErrors.createError(error.statusCode, error.message);
      }
      throw error;
    }
  });

  /**
   * Bulk import a YouTube playlist as draft blind tests.
   *
   * Everything arrives as a draft on purpose: the artist/title split is a guess, so
   * the host reviews the library afterwards rather than discovering bad answers
   * mid-game. Items with no parsed answer show as not-ready.
   */
  app.post(
    '/media/youtube/import',
    {
      schema: { body: z.object({ playlistRef: z.string().min(1).max(300), category: z.string().max(80).optional() }) }
    },
    async (request, reply) => {
      const reference = request.body.playlistRef.trim();
      let playlistId = reference;

      try {
        const url = new URL(reference);
        playlistId = url.searchParams.get('list') ?? reference;
      } catch {
        // Not a URL; treat it as a bare id.
      }

      if (!/^[A-Za-z0-9_-]{2,64}$/.test(playlistId)) {
        return reply.code(400).send({ message: 'Identifiant de playlist YouTube invalide' });
      }

      let items;
      try {
        items = await fetchPlaylistItems(playlistId);
      } catch (error) {
        if (error instanceof YoutubeError) {
          throw app.httpErrors.createError(error.statusCode, error.message);
        }
        throw error;
      }

      const { splitArtistTitle } = await import('game-core');

      const inputs: MediaInput[] = items.map((item) => {
        const { artist, title } = splitArtistTitle(item.title);
        const answers = [];

        if (title) {
          answers.push({
            key: 'title',
            label: 'Titre',
            value: title,
            aliases: [],
            points: 3,
            tolerance: 0.17,
            directBonus: 0
          });
        }
        if (artist) {
          answers.push({
            key: 'artist',
            label: 'Artiste',
            value: artist,
            aliases: [],
            points: 2,
            tolerance: 0.17,
            directBonus: 0
          });
        }

        return {
          kind: 'blindtest',
          title: item.title.slice(0, 200),
          category: request.body.category ?? null,
          date: null,
          answers,
          payload: { ...blindtest.defaultPayload, code: item.videoId },
          timing: null
        };
      });

      const created = await mediaService.createMany(inputs, request.currentUser);
      return reply.code(201).send({
        imported: created.length,
        notReady: created.filter((item) => !item.readiness.ready).length,
        items: created
      });
    }
  );
};

export default mediaRoutes;
