import { z } from 'zod';

import { defineKind } from '../kind-definition.js';

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
    endReveal: z.number().int().min(0).max(86_400)
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
    endReveal: 40
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
    { name: 'endReveal', label: 'field.end', control: 'seconds', group: 'field.revealClip', width: 'half' }
  ],

  // Title and artist carry most of the value; year and country are the bonuses.
  defaultAnswers: [
    { key: 'title', label: 'field.title', value: '', aliases: [], points: 3, tolerance: 0.17, directBonus: 0 },
    { key: 'artist', label: 'field.artist', value: '', aliases: [], points: 2, tolerance: 0.17, directBonus: 0 }
  ],
  answersEditable: true,

  defaultTiming: { answerMs: 30_000, revealMs: 12_000 },
  presentedByHost: true,

  // Players get nothing at all: the host screen plays the audio, and sending the
  // video id would let anyone open it on YouTube and read the title.
  playerPresentation: () => ({}),

  missingForPlay: (payload) => (payload.code ? [] : ['la vidéo YouTube'])
});
