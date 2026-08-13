import { z } from 'zod';

/**
 * One independently scorable thing a player can get right.
 *
 * This is the single abstraction the whole scoring system rests on. A blind test
 * round has several (title, artist, year, country), each worth different points;
 * a quiz round has exactly one; a memory panel has one per item to recall. Every
 * kind therefore scores through the same path, and "bonus points for the year"
 * is not a special case but simply another field.
 */
export const answerFieldSchema = z.object({
  /** Stable identifier, unique within a media item. */
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, digits, dashes or underscores'),

  /**
   * Shown to players as the prompt for this field, when there is one to show.
   *
   * Empty is normal and is the default for anything generated. A blind test asks for
   * the title and the artist, so naming those fields tells the player what is wanted;
   * a panel of twenty faces asks for the twenty faces, and labelling them "Élément 1"
   * to "Élément 20" invents twenty questions that were never asked. Every screen
   * treats an empty label as "no prompt" rather than printing a blank.
   */
  label: z.string().max(80).default(''),

  /** The canonical accepted answer. */
  value: z.string().min(1).max(200),

  /**
   * Further accepted spellings. The matcher already tolerates accents, case,
   * punctuation and small typos, so this is for genuinely different names:
   * "Die Ärzte" / "Die Aerzte", "USA" / "United States".
   */
  aliases: z.array(z.string().min(1).max(200)).max(20).default([]),

  /** Base points before the position multiplier and speed bonus. */
  points: z.number().int().min(0).max(100).default(1),

  /**
   * How much of a badly written answer is forgiven, as a share of the answer's
   * length in letters. See `matchAnswer` for what this does and does not cover:
   * digits always have to be written exactly whatever this is set to, and 0 turns
   * off everything except formatting. Use the `ANSWER_TOLERANCE` presets.
   */
  tolerance: z.number().min(0).max(0.5).default(0.17),

  /** When set, the player picks from these instead of typing. */
  choices: z.array(z.string().min(1).max(200)).max(8).optional(),

  /**
   * Extra points for answering a choice-based field without revealing the
   * choices. This is the "direct response for more points" mechanic: the player
   * decides per round whether to gamble on typing it blind.
   */
  directBonus: z.number().int().min(0).max(100).default(0)
});

export type AnswerField = z.infer<typeof answerFieldSchema>;

/**
 * The three settings worth offering a host.
 *
 * A continuous slider would be a worse question than it looks: nobody knows what
 * 0.23 means, and the interesting decisions are only "is this a spelling test or
 * not" and "are my players in a hurry". Named here rather than in the editor so
 * the kinds' defaults and the form cannot drift apart.
 */
export const ANSWER_TOLERANCE = {
  /** Exactly right, give or take case, accents and punctuation. */
  exact: 0,
  /** One typo per short answer, a little more room on a long one. */
  normal: 0.17,
  /** Generous: for a crowd typing on phones, or players who find spelling hard. */
  loose: 0.3
} as const;

export type AnswerToleranceName = keyof typeof ANSWER_TOLERANCE;

/** The preset a stored value came from, for a form that has to show it back. */
export function toleranceName(value: number): AnswerToleranceName {
  if (value <= 0) return 'exact';
  return value >= (ANSWER_TOLERANCE.normal + ANSWER_TOLERANCE.loose) / 2 ? 'loose' : 'normal';
}

/** What a player is shown: the prompt, never the answer. */
export interface RedactedAnswerField {
  key: string;
  label: string;
  points: number;
  /** Present only once the player has chosen to reveal them. */
  choices?: string[];
  hasChoices: boolean;
  directBonus: number;
}

export function redactAnswerField(field: AnswerField, revealChoices: boolean): RedactedAnswerField {
  const redacted: RedactedAnswerField = {
    key: field.key,
    label: field.label,
    points: field.points,
    hasChoices: Boolean(field.choices?.length),
    directBonus: field.directBonus
  };

  if (revealChoices && field.choices?.length) {
    redacted.choices = field.choices;
  }

  return redacted;
}

/**
 * The fields a freely typed answer is allowed to land on.
 *
 * A round with several written answers has no order to it. Shown a picture of
 * Terminator 2 with the film, the director and the year all worth points, a player
 * who types "1991" has answered the year, whichever box they happened to type it
 * into, and they have answered it whenever they type it. Requiring them to aim at
 * the right prompt first tests the interface rather than what they know.
 *
 * A field offering choices is the exception, and it is the one case where the prompt
 * genuinely binds: the player is picking from that field's own list, the list itself
 * was revealed for that field, and the bonus for answering it blind is recorded
 * against it. So those are excluded here and answered on their own.
 */
export function pooledFields(fields: AnswerField[]): AnswerField[] {
  return fields.filter((field) => !field.choices?.length);
}

/** Total points on offer for a media item, ignoring position and speed. */
export function maxFieldPoints(fields: AnswerField[]): number {
  return fields.reduce((total, field) => total + field.points + field.directBonus, 0);
}
