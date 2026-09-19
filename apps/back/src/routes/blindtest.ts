import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sessionConfigSchema } from 'game-core';
import { z } from 'zod';

import { env } from '../env.js';
import { GENRES, SECTIONS, catalogAvailable, genreById, poolStatus } from '../services/blindtest-catalog.js';
import { countAvailable, drawRounds, emptyHistory } from '../services/blindtest-draw.js';

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
  app.post('/blindtest/count', { preHandler: app.requireAuth, schema: { body: settingsSchema } }, (request) => {
    const settings = ordered(request.body);
    const counted = countAvailable(settings);

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
          maxRounds: z.coerce.number().int().min(1).max(500).nullable().default(null)
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

      const history = emptyHistory();
      const items = await drawRounds(settings, history, INITIAL_ROUNDS);

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
          maxRounds: request.body.maxRounds
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
};

export default blindtestRoutes;
