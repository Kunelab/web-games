import { z } from 'zod';

import { defineKind } from '../kind-definition.js';

/**
 * What an automatic difficulty was worked out from.
 *
 * Kept on the item so the number can be worked out again, by a later version
 * of the scoring or for a genre whose calibration moved, without asking every
 * outside service a second time. Every figure is the raw one, on the source's
 * own scale, and nullable: null is "not known", which the scoring treats very
 * differently from a zero ("looked, and there is nothing").
 */
export const blindtestFameSchema = z.object({
  /** YouTube views of this upload, and what kind of upload it is. */
  views: z.number().nullish(),
  upload: z.enum(['topic', 'audio', 'video']).nullish(),
  /** Deezer's own popularity figure for the track, 0 to a million. */
  deezerRank: z.number().nullish(),
  /** Fans of the artist on Deezer. */
  deezerFans: z.number().nullish(),
  /** Listeners of the track on Last.fm. */
  lastfmListeners: z.number().nullish(),
  /** How many Wikipedia languages have an article on the artist or the work. */
  wikiLanguages: z.number().nullish(),
  /** Views of the French and English articles over the last sixty days. */
  frPageviews: z.number().nullish(),
  enPageviews: z.number().nullish(),
  /** AniList users with the anime on their list. */
  anilistMembers: z.number().nullish(),
  /** Votes on TMDB, for a film or a series. */
  tmdbVotes: z.number().nullish(),
  /** 0 to 1 within the genre's seed harvest, 1 the most famous. */
  seedFame: z.number().nullish(),
  /** The language model's own difficulty, and whether it knew the answer at all. */
  model: z.number().nullish(),
  recognised: z.boolean().nullish(),
  /** Whether the outside catalogues were asked, so a missing figure means "nothing there". */
  looked: z.boolean().optional(),
  /** The catalogues' ids for what was found, so a later lookup need not search again. */
  ids: z.record(z.string(), z.string()).optional()
});

export type BlindtestFame = z.infer<typeof blindtestFameSchema>;

/**
 * The original game: a clip plays, players name it.
 *
 * YouTube hosts the media, so nothing here is stored except the id and the two
 * windows: the guess window is the excerpt players hear, the reveal window is
 * what plays once the answer is shown (usually the chorus).
 */
export const blindtestPayloadSchema = z
  .object({
    /**
     * YouTube video id, 11 characters. Empty is allowed so a draft can be saved;
     * `missingForPlay` is what stops an empty one reaching a game.
     */
    code: z.string().regex(/^([A-Za-z0-9_-]{11})?$/, "Ce n'est pas un identifiant YouTube valide"),
    startGuess: z.number().int().min(0).max(86_400),
    endGuess: z.number().int().min(0).max(86_400),
    startReveal: z.number().int().min(0).max(86_400),
    endReveal: z.number().int().min(0).max(86_400),
    /**
     * Playback volume for this clip, as a percentage.
     *
     * The embed API offers no loudness normalisation — there is no figure to read
     * and nothing to feed a compressor, because the audio lives inside a
     * cross-origin iframe the page cannot touch. So the levelling is authored:
     * a clip mastered ten decibels hotter than the rest of the playlist gets
     * turned down once, here, beside the clip it belongs to, instead of the room
     * reaching for the television remote every third round.
     *
     * Defaulted rather than required, so every row saved before this existed
     * parses and plays at full volume.
     */
    volume: z.number().int().min(10).max(100).default(100),
    /**
     * How hard this clip is to name, 0 to 100.
     *
     * Written by the draw, which reads it off the pool the entry came from, and
     * editable afterwards by anybody who may edit the item — the pool's number is
     * a rank among search results and is wrong often enough to be worth a second
     * opinion from the room that just heard it.
     *
     * Optional rather than defaulted, because the two states are genuinely
     * different: 50 means somebody judged this middling, absent means nobody has
     * judged it at all, and a default would quietly turn every row saved before
     * this existed into the former.
     */
    /*
     * Nullish rather than merely optional: the editor's number box writes null
     * when it is cleared, and clearing it is the one way to say "withdraw the
     * judgement". Every reader tests for a number, so the two empties behave
     * alike.
     */
    difficulty: z.number().int().min(0).max(100).nullish(),
    /**
     * Who set the difficulty and who set the clip window: the automatic scoring,
     * or a person.
     *
     * A person's number is never overwritten by a later rescoring. Absent on
     * rows saved before this existed, which a rescoring treats as automatic.
     */
    difficultyBy: z.enum(['auto', 'human']).optional(),
    timingBy: z.enum(['auto', 'human']).optional(),
    /** The evidence an automatic difficulty came from. See `blindtestFameSchema`. */
    fame: blindtestFameSchema.optional()
  })
  .refine((payload) => payload.endGuess > payload.startGuess, {
    message: 'La fin du extrait doit être après le début',
    path: ['endGuess']
  })
  .refine((payload) => payload.endReveal > payload.startReveal, {
    message: 'La fin de la révélation doit être après le début',
    path: ['endReveal']
  });

export type BlindtestPayload = z.infer<typeof blindtestPayloadSchema>;

const CLIP_KEYS = ['startGuess', 'endGuess', 'startReveal', 'endReveal'] as const;

/** Whether a save moved the difficulty, and whether it moved the clip window. */
export function changedByHand(previous: unknown, next: unknown): { difficulty: boolean; timing: boolean } {
  const before = (previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>;
  const after = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>;
  return {
    difficulty: (after.difficulty ?? null) !== (before.difficulty ?? null),
    timing: CLIP_KEYS.some((key) => after[key] !== before[key])
  };
}

/**
 * A payload a person saved, with what they changed marked as theirs.
 *
 * The draw and the rescoring write the difficulty and the clip window as
 * automatic, and a rescoring never overwrites a person's. So a save that moves
 * either marks it `human`, and one that leaves it alone keeps whatever it was.
 * The evidence the difficulty was scored from is kept too, since an editor
 * that does not show it would otherwise drop it on every save.
 */
export function withHandEdits(previous: unknown, next: BlindtestPayload): BlindtestPayload {
  const before = (previous && typeof previous === 'object' ? previous : {}) as Partial<BlindtestPayload>;
  const merged: BlindtestPayload = { ...next };
  if (merged.fame === undefined && before.fame !== undefined) merged.fame = before.fame;

  const changed = changedByHand(previous, next);
  const difficultyBy = changed.difficulty ? 'human' : (next.difficultyBy ?? before.difficultyBy);
  const timingBy = changed.timing ? 'human' : (next.timingBy ?? before.timingBy);
  if (difficultyBy) merged.difficultyBy = difficultyBy;
  if (timingBy) merged.timingBy = timingBy;
  return merged;
}

/** The timing schema's own bounds, so a derived duration cannot fall outside them. */
const MIN_ANSWER_MS = 3_000;
const MAX_ANSWER_MS = 600_000;

/**
 * How long the excerpt runs, in milliseconds, clamped to something playable.
 *
 * The payload guarantees the window is at least one second wide and at most a
 * day, neither of which is a round: a one second clip needs a moment to answer
 * in even after it has stopped, and nobody is playing a six hour round.
 */
function guessWindowMs(payload: BlindtestPayload): number {
  const seconds = payload.endGuess - payload.startGuess;
  return Math.min(MAX_ANSWER_MS, Math.max(MIN_ANSWER_MS, Math.round(seconds * 1000)));
}

export const blindtest = defineKind<BlindtestPayload>({
  id: 'blindtest',
  label: { fr: 'Blind test', en: 'Blind test' },
  description: {
    fr: 'Un extrait audio à reconnaître',
    en: 'An audio excerpt to identify'
  },
  icon: '🎵',
  available: true,

  payloadSchema: blindtestPayloadSchema,
  defaultPayload: {
    code: '',
    startGuess: 0,
    endGuess: 20,
    startReveal: 20,
    endReveal: 40,
    volume: 100
  },

  formFields: [
    {
      name: 'code',
      label: 'field.youtube',
      control: 'youtube',
      placeholder: 'field.youtubeHint',
      help: 'field.youtubeHelp',
      width: 'full'
    },
    {
      name: 'startGuess',
      label: 'field.start',
      control: 'seconds',
      group: 'field.guessClip',
      width: 'half'
    },
    { name: 'endGuess', label: 'field.end', control: 'seconds', group: 'field.guessClip', width: 'half' },
    {
      name: 'startReveal',
      label: 'field.start',
      control: 'seconds',
      group: 'field.revealClip',
      width: 'half'
    },
    { name: 'endReveal', label: 'field.end', control: 'seconds', group: 'field.revealClip', width: 'half' },
    {
      name: 'volume',
      label: 'field.volume',
      control: 'number',
      min: 10,
      max: 100,
      step: 5,
      help: 'field.volumeHelp',
      width: 'half'
    },
    {
      name: 'difficulty',
      label: 'field.difficulty',
      control: 'number',
      min: 0,
      max: 100,
      step: 1,
      help: 'field.difficultyHelp',
      width: 'half'
    }
  ],

  // Title and artist carry most of the value; year and country are the bonuses.
  defaultAnswers: [
    { key: 'title', label: 'field.title', value: '', aliases: [], points: 3, tolerance: 0.17, directBonus: 0 },
    { key: 'artist', label: 'field.artist', value: '', aliases: [], points: 2, tolerance: 0.17, directBonus: 0 }
  ],
  answersEditable: true,

  defaultTiming: { answerMs: 30_000, revealMs: 12_000 },

  /**
   * The round lasts as long as the clip, not thirty seconds regardless.
   *
   * The guess window is authored second by second, and it is the question. A
   * fixed answer time meant the two disagreed in whichever direction the author
   * chose: the twenty second default left the room sitting in ten seconds of
   * silence with a countdown still running, and a forty second window was cut
   * off at thirty with the clip mid phrase.
   *
   * So the window sets the clock. It is the same mechanism the memory panel uses
   * for its memorisation time, and for the same reason: this is a duration that
   * belongs to the content rather than to the game's settings.
   *
   * An explicit timing on the item still wins, per `resolveTiming`, so a host who
   * genuinely wants thinking time after the music stops can still ask for it. It
   * is no longer what happens by accident.
   */
  timingFromPayload: (payload) => ({ answerMs: guessWindowMs(payload) }),

  presentedByHost: true,

  // Nothing through this channel: the clip reaches whichever devices are stages
  // as a `stageRound`, and sending the video id to every phone regardless would
  // let anyone open it on YouTube and read the title.
  playerPresentation: () => ({}),

  missingForPlay: (payload) => (payload.code ? [] : ['miss.youtube'])
});
