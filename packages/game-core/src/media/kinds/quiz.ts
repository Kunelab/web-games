import { z } from 'zod';

import { defineKind } from '../kind-definition.js';

/**
 * A question, optionally with an image, and optionally with choices.
 *
 * The choices live on the answer field rather than here, because that is what
 * makes "answer blind for more points" work: the field knows both its choices
 * and the bonus for skipping them, and the scoring path does not care which of
 * the two a player used.
 */
export const quizPayloadSchema = z.object({
  /** Empty is allowed so a draft saves; `missingForPlay` gates actual play. */
  question: z.string().max(500),
  /** Optional illustration shown alongside the question. */
  imageUrl: z.string().url('URL invalide').max(2000).optional().or(z.literal('')),
  /** Shown after the reveal, for the "ah, of course" moment. */
  explanation: z.string().max(1000).optional().or(z.literal(''))
});

export type QuizPayload = z.infer<typeof quizPayloadSchema>;

export const quiz = defineKind<QuizPayload>({
  id: 'quiz',
  label: { fr: 'Question', en: 'Question' },
  description: {
    fr: 'Une question, avec ou sans choix multiples',
    en: 'A question, with or without multiple choice'
  },
  icon: '❓',
  available: true,

  payloadSchema: quizPayloadSchema,
  defaultPayload: { question: '', imageUrl: '', explanation: '' },

  formFields: [
    {
      name: 'question',
      label: 'Question',
      control: 'textarea',
      placeholder: 'Quelle est la capitale de la Mongolie ?',
      width: 'full'
    },
    {
      name: 'imageUrl',
      label: 'Image (optionnelle)',
      control: 'image',
      placeholder: 'https://…',
      help: 'Affichée à côté de la question.',
      width: 'full'
    },
    {
      name: 'explanation',
      label: 'Explication (optionnelle)',
      control: 'textarea',
      placeholder: 'Affichée après la révélation',
      width: 'full'
    }
  ],

  defaultAnswers: [
    {
      key: 'answer',
      label: 'Réponse',
      value: '',
      aliases: [],
      points: 3,
      tolerance: 0.17,
      // Typing it without seeing the choices is worth roughly double.
      directBonus: 3
    }
  ],
  answersEditable: true,

  defaultTiming: { answerMs: 25_000, revealMs: 10_000 },
  // Everyone can read the question, so it goes on every screen.
  presentedByHost: false,

  // The explanation is deliberately absent: it usually contains the answer.
  playerPresentation: (payload, context) => ({
    question: payload.question,
    imageUrl: payload.imageUrl ? context.imageUrl(payload.imageUrl) : undefined
  }),

  missingForPlay: (payload) => (payload.question.trim() ? [] : ['la question'])
});
