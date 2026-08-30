import { z } from 'zod';

import { defineKind } from '../kind-definition.js';

/**
 * A panel of many things shown briefly, then recalled from memory.
 *
 * This is the kind that justifies scoring per answer field rather than per round:
 * every item to recall is its own field, so a player who names seven of twenty
 * faces scores seven times, and being first to name a given face still earns the
 * position bonus on it. No special-casing anywhere in the scoring path.
 *
 * It is also the only kind with a study phase, where the image is up but answers
 * are closed.
 */
export const imageMemoryPayloadSchema = z.object({
  /** Empty is allowed so a draft saves; `missingForPlay` gates actual play. */
  src: z.string().max(2000),
  /**
   * A panel assembled from one image per item, laid out as a grid on the player's
   * screen. The alternative to `src`, not an addition to it: either the host has a
   * single picture of a whole panel, or they have the cells and the grid is drawn
   * for them. Kept as a separate field rather than replacing `src` so that panels
   * authored as one image keep working.
   */
  cells: z.array(z.string().min(1).max(2000)).max(40).default([]),
  /** How long the panel stays visible before answering opens, in ms. */
  studyMs: z.number().int().min(3_000).max(180_000),
  /** Whether the panel remains on screen while answering. Off is much harder. */
  keepVisible: z.boolean()
});

export type ImageMemoryPayload = z.infer<typeof imageMemoryPayloadSchema>;

export const imageMemory = defineKind<ImageMemoryPayload>({
  id: 'image-memory',
  label: { fr: 'Le panel', en: 'Memory panel' },
  description: {
    fr: 'Un panel à mémoriser, puis citez-en le plus possible',
    en: 'Memorise a panel, then name as many as you can'
  },
  icon: '🧠',
  available: true,

  payloadSchema: imageMemoryPayloadSchema,
  defaultPayload: { src: '', cells: [], studyMs: 20_000, keepVisible: false },

  formFields: [
    {
      name: 'cells',
      label: 'field.grid',
      control: 'panel',
      help: 'field.gridHelp',
      width: 'full'
    },
    {
      name: 'src',
      label: 'field.singlePanel',
      control: 'image',
      placeholder: 'field.urlHint',
      help: 'field.singlePanelHelp',
      width: 'full'
    },
    {
      name: 'studyMs',
      label: 'field.studyTime',
      control: 'duration',
      min: 3_000,
      max: 180_000,
      step: 1_000,
      width: 'half'
    },
    {
      name: 'keepVisible',
      label: 'field.keepVisible',
      control: 'switch',
      help: 'field.keepVisibleHelp',
      width: 'half'
    }
  ],

  // Authored one field per person or object in the panel.
  defaultAnswers: [],
  answersEditable: true,

  defaultTiming: { answerMs: 90_000, studyMs: 20_000, revealMs: 15_000 },

  // The memorisation time is edited beside the panel, because it is the difficulty of
  // that panel rather than a setting of the game. This is what makes the field count.
  timingFromPayload: (payload) => ({ studyMs: payload.studyMs }),
  presentedByHost: false,

  playerPresentation: (payload, context) => ({
    imageUrl: context.imageUrl(payload.src),
    // Every cell goes through the same indirection as any other image: forty
    // filenames in a network tab would be forty answers.
    cellUrls: payload.cells.map((cell) => context.imageUrl(cell)),
    keepVisible: payload.keepVisible
  }),

  missingForPlay: (payload) =>
    payload.cells.length > 0 || payload.src.trim() ? [] : ['la grille ou une image de panel']
});
