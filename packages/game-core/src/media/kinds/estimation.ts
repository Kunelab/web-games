import { z } from 'zod';

import { defineKind } from '../kind-definition.js';

/**
 * A question whose answer is a number: everyone commits to one, closest wins.
 *
 * The Wits & Wagers mechanic, and the one kind where being wrong still scores.
 * Players can revise their number until the round closes, which is the point of the
 * format: an estimate is something you talk yourself into, not a buzzer race. Speed
 * pays nothing here; see `scoreEstimationRound`.
 *
 * The exact value lives in the answer field like any other kind, so the reveal and
 * the readiness checks need nothing special. The field's value must parse as a
 * number ("42", "1 234,5"); an unparseable one plays the round but scores nobody.
 */
export const estimationPayloadSchema = z.object({
  /** Empty is allowed so a draft saves; `missingForPlay` gates actual play. */
  question: z.string().max(500),
  /** Optional illustration shown alongside the question. */
  imageUrl: z.string().url('URL invalide').max(2000).optional().or(z.literal('')),
  /** Shown next to the input, e.g. "km", "habitants", "€". */
  unit: z.string().max(24).optional().or(z.literal(''))
});

export type EstimationPayload = z.infer<typeof estimationPayloadSchema>;

export const estimation = defineKind<EstimationPayload>({
  id: 'estimation',
  label: { fr: 'Estimation', en: 'Estimation' },
  description: {
    fr: 'Une question chiffrée : la réponse la plus proche gagne',
    en: 'A numeric question: the closest answer wins'
  },
  icon: '🎯',
  available: true,

  payloadSchema: estimationPayloadSchema,
  defaultPayload: { question: '', imageUrl: '', unit: '' },

  formFields: [
    {
      name: 'question',
      label: 'Question',
      control: 'textarea',
      placeholder: 'Combien de kilomètres sépare la Terre de la Lune ?',
      width: 'full'
    },
    {
      name: 'unit',
      label: 'Unité (optionnelle)',
      control: 'text',
      placeholder: 'km',
      help: 'Affichée à côté du champ de saisie des joueurs.',
      width: 'half'
    },
    {
      name: 'imageUrl',
      label: 'Image (optionnelle)',
      control: 'image',
      placeholder: 'https://…',
      help: 'Affichée à côté de la question.',
      width: 'full'
    }
  ],

  defaultAnswers: [
    {
      key: 'estimate',
      // No prompt: the question is the prompt, and the custom input the players get
      // never prints a field label.
      label: '',
      value: '',
      aliases: [],
      points: 3,
      tolerance: 0,
      directBonus: 0
    }
  ],
  answersEditable: true,

  // Room to think: the format rewards the estimate, not the reflex.
  defaultTiming: { answerMs: 30_000, revealMs: 10_000 },
  // Everyone can read the question, so it goes on every screen.
  presentedByHost: false,

  playerPresentation: (payload, context) => ({
    question: payload.question,
    unit: payload.unit || undefined,
    imageUrl: payload.imageUrl ? context.imageUrl(payload.imageUrl) : undefined
  }),

  missingForPlay: (payload) => (payload.question.trim() ? [] : ['la question'])
});
