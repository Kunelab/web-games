import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sessionConfigSchema } from 'game-core';
import { z } from 'zod';

import { env } from '../env.js';
import { GameManager } from '../game/manager.js';
import { GENRES, SECTIONS, catalogAvailable, genreById, poolStatus } from '../services/blindtest-catalog.js';
import { countAvailable, drawRounds, emptyHistory } from '../services/blindtest-draw.js';
import { countLibrary } from '../services/blindtest-library.js';
import { dismissDuplicateFlags, findLibraryDuplicates } from '../services/blindtest-duplicates.js';
import {
  dismissGenreFlag,
  findLibraryGenreFlags,
  fixLegacyLabels,
  setLibraryGenre
} from '../services/blindtest-genres.js';
import { takeOpener, warmOpener } from '../services/blindtest-opener.js';
import { harvestSeeds, seedStats } from '../services/blindtest-seeds.js';
import { isAdmin } from '../services/ownership.js';
import { searchesToday } from '../services/youtube-budget.js';

/**
 * The generated blind test: a room that never runs out.
 *
 * Nothing here writes to the library. A session built by these routes carries its
 * own rounds inside its state and leaves no `Media` rows behind, which is the
 * whole point of the mode: an evening of automatic rounds should not silt up
 * somebody's carefully kept collection.
 */

/**
 * The opening buffer: one song, and the rest found while that one is playing.
 *
 * Three meant the host waited for three draws before the lobby even opened, and
 * a draw is only cheap once its genre pool is warm — so the first game of the
 * day on a fresh set of genres spent that wait three times over, in front of a
 * room that had not been let in yet. Drawing during the lobby is the wrong place
 * for it: nothing is on screen, nobody is listening, and the session cannot be
 * joined until it exists.
 *
 * One is enough to open the room. `GameManager.LOOKAHEAD` keeps it one ahead
 * from then on, and every one of those draws happens inside a round that is
 * already playing, which is the whole design.
 */
const INITIAL_ROUNDS = 1;

const settingsSchema = z.object({
  genreIds: z.array(z.string().min(1).max(40)).min(1).max(40),
  difficultyMin: z.coerce.number().int().min(0).max(100).default(0),
  difficultyMax: z.coerce.number().int().min(0).max(100).default(100),
  /**
   * The host's country.
   *
   * The host screen is the stage, so its licence is the one that decides whether
   * a clip plays. Defaulted to the deployment's own region rather than guessed
   * from an IP: the host knows where they are, and a wrong guess here is a room
   * full of silent rounds.
   */
  region: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default(env.YOUTUBE_REGION)
});

/** Orders the window, so a slider dragged past itself still means something. */
function ordered(settings: z.infer<typeof settingsSchema>) {
  const min = Math.min(settings.difficultyMin, settings.difficultyMax);
  const max = Math.max(settings.difficultyMin, settings.difficultyMax);
  return { ...settings, difficultyMin: min, difficultyMax: max };
}

const blindtestRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * What can be played, and whether the machinery behind it is configured.
   *
   * Public and unauthenticated because it is a menu: it names genres and nothing
   * else. `available` false means there is no YouTube key, which is the one
   * failure the setup screen has to explain rather than retry.
   */
  app.get('/blindtest/catalog', async () => ({
    available: catalogAvailable(),
    region: env.YOUTUBE_REGION,
    sections: SECTIONS,
    genres: GENRES.map((genre) => ({
      id: genre.id,
      label: genre.label,
      section: genre.section,
      answerShape: genre.answerShape,
      /** True for an era filter over another genre, which the UI may want to mark. */
      facet: Boolean(genre.facetOf)
    }))
  }));

  /**
   * How many rounds these settings actually have behind them.
   *
   * The number that turns a set of checkboxes into a decision. It is also the
   * first thing that fills the pools, so it doubles as the warm-up: by the time
   * the host has finished choosing, the catalogue is usually already in memory
   * and the first draw is instant.
   */
  app.post('/blindtest/count', { preHandler: app.requireAuth, schema: { body: settingsSchema } }, async (request) => {
    const settings = ordered(request.body);
    const counted = countAvailable(settings);

    /**
     * Plus what the catalogue can replay.
     *
     * The pools hold only what the catalogue does not (see `buildEntries`), so
     * the two add up without counting a song twice. A genre whose pool is still
     * coming stays unknown on screen; its catalogue rows join the total.
     */
    const replayable = await countLibrary(settings.genreIds, {
      min: settings.difficultyMin,
      max: settings.difficultyMax
    }).catch(() => new Map<string, number>());
    let fromLibrary = 0;
    for (const entry of counted.perGenre) {
      const extra = replayable.get(entry.genreId) ?? 0;
      fromLibrary += extra;
      if (entry.available !== null) entry.available += extra;
    }
    counted.total += fromLibrary;

    /**
     * And one song put aside while the host reads the list.
     *
     * This endpoint is already the warm-up — it is what fills the pools — and
     * it is already polled every few seconds by a screen nobody is waiting
     * behind. Finding the opening round here is the difference between starting
     * instantly and starting with a draw the room watches happen; see
     * `warmOpener`, which draws exactly one and keeps it until its genre is
     * unticked.
     *
     * Not awaited. A count that waited on a cold pool would take a minute and
     * the number on screen is what this call is for.
     */
    warmOpener(request.currentUser.id, settings);

    return {
      region: settings.region,
      total: counted.total,
      /** Genres still being fetched. The screen keeps polling while this is above zero. */
      pending: counted.pending,
      perGenre: counted.perGenre
    };
  });

  /**
   * Starts a generated session.
   *
   * Refuses up front when the draw comes back empty rather than opening a lobby
   * that cannot deal a first round: a host who picked a genre with no playable
   * clips in their country deserves to be told now, with the reason, not after
   * everyone has joined.
   */
  app.post(
    '/blindtest/sessions',
    {
      preHandler: app.requireAuth,
      schema: {
        body: settingsSchema.extend({
          config: sessionConfigSchema.partial().optional(),
          /** Null, or absent, for genuinely endless. */
          maxRounds: z.coerce.number().int().min(1).max(500).nullable().default(null),
          /**
           * How much of the evening is replayed from the shared catalogue.
           *
           * 0 searches for every round, 1 plays only what other rooms have
           * already vetted, and the default splits it. See
           * `InfiniteState.replayShare`.
           */
          replayShare: z.coerce.number().min(0).max(1).default(GameManager.REPLAY_SHARE)
        })
      }
    },
    async (request, reply) => {
      if (!catalogAvailable()) {
        return reply.code(503).send({ message: "La recherche YouTube n'est pas configurée sur ce serveur" });
      }

      const settings = ordered(request.body);
      const unknown = settings.genreIds.filter((id) => !genreById.has(id));
      if (unknown.length > 0) {
        return reply.code(400).send({ message: `Genre inconnu : ${unknown.join(', ')}` });
      }

      /**
       * The song the setup screen already found, or one drawn now.
       *
       * On the ordinary path the host has had the genre list open for a few
       * seconds and the opener is sitting in hand, so starting costs nothing.
       * The draw below is the cold path: somebody who posted straight here, or
       * whose choice changed in the last moment before pressing start.
       */
      const reserved = takeOpener(request.currentUser.id, settings);
      const history = reserved?.history ?? emptyHistory();
      const items = reserved ? [reserved.item] : await drawRounds(settings, history, INITIAL_ROUNDS);

      if (items.length === 0) {
        return reply.code(409).send({
          message: 'Aucun extrait jouable avec ces réglages. Élargissez les genres, la difficulté, ou vérifiez le pays.'
        });
      }

      const state = await app.games.create({
        // No playlist: these rounds exist nowhere but in this session.
        playlistId: null,
        playlistName: 'Blind test infini',
        hostUserId: request.currentUser.id,
        items,
        config: {
          ...request.body.config,
          // Shuffling an order that is generated in draw order would only undo the
          // difficulty pacing the draw just applied.
          shuffle: false,
          chronological: false
        },
        infinite: {
          genreIds: settings.genreIds,
          difficultyMin: settings.difficultyMin,
          difficultyMax: settings.difficultyMax,
          region: settings.region,
          playedTracks: [...history.playedTracks],
          recentArtists: history.recentArtists,
          maxRounds: request.body.maxRounds,
          replayShare: request.body.replayShare
        }
      });

      return reply.code(201).send({
        code: state.code,
        hostToken: state.hostToken,
        total: state.order.length,
        infinite: request.body.maxRounds === null
      });
    }
  );

  /**
   * "Stop after this round".
   *
   * Stops the refill rather than ending the game, so the round on screen finishes
   * and the ceremony follows it. There is no other way out of an endless session,
   * short of the host destroying it, which would skip the podium.
   */
  app.post(
    '/blindtest/sessions/:code/stop',
    {
      preHandler: app.requireAuth,
      schema: { params: z.object({ code: z.string().min(1).max(16) }) }
    },
    async (request, reply) => {
      const code = request.params.code.trim().toUpperCase();
      const state = app.games.get(code);

      if (!state) throw app.httpErrors.notFound('Aucune partie avec ce code');
      if (state.hostUserId !== request.currentUser.id) {
        throw app.httpErrors.forbidden("Cette partie n'est pas la vôtre");
      }
      if (!app.games.stopRefilling(code)) {
        return reply.code(400).send({ message: "Cette partie n'est pas un blind test infini" });
      }

      return reply.send({ stoppingAfter: state.order.length });
    }
  );

  /** Pool diagnostics: sizes, ages, and any source that came back suspiciously thin. */
  app.get('/blindtest/pools', { preHandler: app.requireAuth }, async () => ({ pools: poolStatus() }));

  /**
   * Possible duplicates in the shared catalogue, for the admin's cleanup.
   *
   * Admin-only: the catalogue is public to play but only an admin may curate
   * it, and the flags are a curation aid rather than game data. Returns groups
   * of media ids that look like the same recording, strongest reason first,
   * and the direct pairs behind them — see `blindtest-duplicates` for what each
   * reason means.
   */
  app.get('/blindtest/library/duplicates', { preHandler: app.requireAuth }, async (request) => {
    if (!isAdmin(request.currentUser)) {
      throw app.httpErrors.forbidden('Réservé à un administrateur');
    }
    return findLibraryDuplicates();
  });

  /**
   * Settles every flag raised against one entry: "these are not duplicates".
   *
   * Stores the entry's current pairs rather than the entry, so a genuinely new
   * collision later still flags. Deleting the entry instead is the existing
   * `DELETE /media/:id`, which an admin may call on any row.
   */
  app.post(
    '/blindtest/library/duplicates/dismiss',
    {
      preHandler: app.requireAuth,
      schema: { body: z.object({ mediaId: z.coerce.number().int().positive() }) }
    },
    async (request) => {
      if (!isAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé à un administrateur');
      }
      return { dismissed: await dismissDuplicateFlags(request.body.mediaId) };
    }
  );

  /**
   * Entries that look filed under the wrong genre, and the ones still carrying
   * the old `field.work` prompt. Admin-only, like the duplicates, for the same
   * reason; see `blindtest-genres` for the rules.
   */
  app.get('/blindtest/library/genre-flags', { preHandler: app.requireAuth }, async (request) => {
    if (!isAdmin(request.currentUser)) {
      throw app.httpErrors.forbidden('Réservé à un administrateur');
    }
    return findLibraryGenreFlags();
  });

  /** "This genre is right", for as long as the entry keeps it. */
  app.post(
    '/blindtest/library/genre-flags/dismiss',
    {
      preHandler: app.requireAuth,
      schema: { body: z.object({ mediaId: z.coerce.number().int().positive() }) }
    },
    async (request) => {
      if (!isAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé à un administrateur');
      }
      return { dismissed: await dismissGenreFlag(request.body.mediaId) };
    }
  );

  /**
   * Files a catalogue entry under a genre, rewriting its work prompt to match.
   *
   * Sending the genre it already has is how an old `field.work` prompt is fixed
   * one entry at a time. Refused across answer shapes; see `setLibraryGenre`.
   */
  app.post(
    '/blindtest/library/genre',
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.object({
          mediaId: z.coerce.number().int().positive(),
          genreId: z.string().min(1).max(40)
        })
      }
    },
    async (request, reply) => {
      if (!isAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé à un administrateur');
      }
      const result = await setLibraryGenre(request.body.mediaId, request.body.genreId);
      if (result.ok) return { item: result.item };
      if (result.reason === 'not-found') throw app.httpErrors.notFound('Entrée du catalogue introuvable');
      if (result.reason === 'unknown-genre') {
        return reply.code(400).send({ message: `Genre inconnu : ${request.body.genreId}` });
      }
      return reply.code(400).send({ message: "Ce genre n'attend pas ce type de réponse" });
    }
  );

  /** Every old `field.work` prompt whose genre is known, rewritten at once. */
  app.post('/blindtest/library/fix-labels', { preHandler: app.requireAuth }, async (request) => {
    if (!isAdmin(request.currentUser)) {
      throw app.httpErrors.forbidden('Réservé à un administrateur');
    }
    return { fixed: await fixLegacyLabels() };
  });

  /**
   * The seed catalogues: how many per genre, how many never searched, when
   * each was harvested and whether it failed. And today's search spending.
   */
  app.get('/blindtest/seeds', { preHandler: app.requireAuth }, async (request) => {
    if (!isAdmin(request.currentUser)) {
      throw app.httpErrors.forbidden('Réservé à un administrateur');
    }
    return { genres: seedStats(), searches: searchesToday() };
  });

  /**
   * Harvests a genre's seeds now, or every seeded genre.
   *
   * Not awaited: a full harvest reads a few thousand Deezer tracks and two
   * thousand AniList entries at the pace those services ask for, which is
   * minutes. `GET /blindtest/seeds` shows it landing.
   */
  app.post(
    '/blindtest/seeds/harvest',
    {
      preHandler: app.requireAuth,
      schema: { body: z.object({ genreId: z.string().min(1).max(40).optional() }).default({}) }
    },
    async (request, reply) => {
      if (!isAdmin(request.currentUser)) {
        throw app.httpErrors.forbidden('Réservé à un administrateur');
      }
      const wanted = request.body.genreId;
      const genres = GENRES.filter(
        (genre) => genre.seeds && genre.seeds.length > 0 && (!wanted || genre.id === wanted)
      );
      if (genres.length === 0) return reply.code(400).send({ message: 'Aucun genre à moissonner' });

      void (async () => {
        for (const genre of genres) {
          await harvestSeeds(genre).catch((error: unknown) => {
            app.log.warn({ err: error, genre: genre.id }, 'seed harvest failed');
          });
        }
      })();
      return reply.code(202).send({ harvesting: genres.map((genre) => genre.id) });
    }
  );
};

export default blindtestRoutes;
