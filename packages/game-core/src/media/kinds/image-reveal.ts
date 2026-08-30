import { z } from 'zod';

import { defineKind } from '../kind-definition.js';

/**
 * An image that starts unreadable and resolves over the round.
 *
 * Nothing about the progression is streamed: the server broadcasts the round's
 * start time and every client computes progress from its own synchronised clock,
 * so the image looks identical on every screen without a frame of network
 * traffic. `pixelate` and `blur` both work that way; `pixelate` reads better on
 * faces, `blur` on scenes.
 */
export const imageRevealPayloadSchema = z.object({
  /**
   * Empty is allowed so a draft saves, and because the old `Images` table had no
   * source column at all: rows migrated from it arrive here with nothing to show
   * and need the host to supply an image before they can be played.
   */
  src: z.string().max(2000),
  mode: z.enum(['pixelate', 'blur']),
  /**
   * Starting intensity: pixel block size, or blur radius in px. The effect eases
   * from here to zero across the answer phase.
   */
  intensity: z.number().int().min(2).max(120),
  /**
   * Scale the image up at the start so even the framing is unclear, easing back
   * to 1. Set to 1 to disable.
   */
  startZoom: z.number().min(1).max(4)
});

export type ImageRevealPayload = z.infer<typeof imageRevealPayloadSchema>;

export const imageReveal = defineKind<ImageRevealPayload>({
  id: 'image-reveal',
  label: { fr: 'Image qui se révèle', en: 'Image reveal' },
  description: {
    fr: 'Une image pixelisée qui devient nette peu à peu',
    en: 'A pixelated image that sharpens over time'
  },
  icon: '🖼️',
  available: true,

  payloadSchema: imageRevealPayloadSchema,
  defaultPayload: { src: '', mode: 'pixelate', intensity: 40, startZoom: 2 },

  formFields: [
    {
      name: 'src',
      label: 'field.image',
      control: 'image',
      placeholder: 'field.imageHint',
      width: 'full',
      // "tour eiffel" becomes a source image plus a prefilled answer.
      wikiSearch: true
    },
    {
      name: 'mode',
      label: 'field.effect',
      control: 'select',
      options: [
        { value: 'pixelate', label: 'field.pixelate' },
        { value: 'blur', label: 'field.blur' }
      ],
      width: 'half'
    },
    {
      name: 'intensity',
      label: 'field.startStrength',
      control: 'number',
      min: 2,
      max: 120,
      step: 1,
      help: 'field.strengthHelp',
      width: 'half'
    },
    {
      name: 'startZoom',
      label: 'field.startZoom',
      control: 'number',
      min: 1,
      max: 4,
      step: 0.25,
      help: 'field.oneToDisable',
      width: 'half'
    }
  ],

  defaultAnswers: [
    { key: 'subject', label: 'field.whoWhat', value: '', aliases: [], points: 3, tolerance: 0.17, directBonus: 0 }
  ],
  answersEditable: true,

  // Longer than a blind test: the whole point is the slow resolve.
  defaultTiming: { answerMs: 45_000, revealMs: 8_000 },
  presentedByHost: false,

  playerPresentation: (payload, context) => ({
    imageUrl: context.imageUrl(payload.src),
    mode: payload.mode,
    intensity: payload.intensity,
    startZoom: payload.startZoom
  }),

  missingForPlay: (payload) => (payload.src.trim() ? [] : ["l'image"])
});
