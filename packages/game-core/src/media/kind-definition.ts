import type { z } from 'zod';

import type { AnswerField } from './answer-field.js';

/**
 * Metadata that lets a form be generated from a kind's schema.
 *
 * The point of pairing this with the Zod schema is that a media kind is declared
 * exactly once: the server validates with the schema, the editor renders from
 * this metadata, and the two cannot disagree.
 */
export interface FieldMeta {
  /** Key within the payload object. */
  name: string;
  label: string;
  control:
    | 'text'
    | 'textarea'
    | 'number'
    /** mm:ss input, stored as seconds. */
    | 'seconds'
    | 'switch'
    | 'select'
    /** YouTube URL or bare id; offers metadata lookup. */
    | 'youtube'
    /** Image URL with a preview. */
    | 'image'
    /** Editable list of strings. */
    | 'list'
    /**
     * A grid of images, built by theme rather than typed. The only control that
     * writes answer fields as well as its own payload key, because a generated
     * panel is a set of pictures and the set of answers that goes with them.
     */
    | 'panel'
    /** Milliseconds, shown as seconds. */
    | 'duration';
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  width?: 'full' | 'half';
  /** Fields sharing a group are rendered under one heading. */
  group?: string;
  /**
   * `image` controls only: offer a Wikipedia lookup that fills the URL and hands
   * the subject (title, description) back to the editor for answer prefill.
   */
  wikiSearch?: boolean;
}

/** Phases a round goes through, which differ by kind. */
export interface KindTiming {
  /** How long players have to answer, in ms. */
  answerMs: number;
  /**
   * Optional study phase before answering opens, in ms. Used by the memory
   * panel, which shows the image first and only then asks for the items.
   */
  studyMs?: number;
  /** How long the answer stays on screen before advancing, in ms. */
  revealMs: number;
}

export interface KindDefinition<Payload> {
  id: string;
  label: { fr: string; en: string };
  description: { fr: string; en: string };
  /** Shown in the "add media" picker. */
  icon: string;
  /** False while a kind is still being built; hidden from the picker. */
  available: boolean;

  payloadSchema: z.ZodType<Payload>;
  defaultPayload: Payload;
  formFields: FieldMeta[];

  /** Answer fields a newly created item of this kind starts with. */
  defaultAnswers: AnswerField[];
  /**
   * False when the answer fields are fixed by the kind rather than authored,
   * which hides the answer editor.
   */
  answersEditable: boolean;

  defaultTiming: KindTiming;

  /**
   * Timing this kind reads out of its own payload.
   *
   * Some durations are content rather than configuration: how long a memory panel
   * stays up is the difficulty of that panel, so it is edited beside the panel and not
   * in a timing section. Without this the field was authored, saved, and then ignored,
   * because the engine only ever looked at `defaultTiming` and the item's overrides,
   * so every panel ran on the default twenty seconds whatever the host chose.
   *
   * An explicit override on the item still wins over this.
   */
  timingFromPayload?: (payload: Payload) => Partial<KindTiming>;

  /**
   * Whether the host screen is the one presenting the media. True for a blind
   * test, where players only see prompts on their phones; false for a quiz,
   * where the question can be shown on every device.
   */
  presentedByHost: boolean;

  /**
   * Exactly what players receive for a live round. Anything omitted here cannot
   * leak, so this is the security boundary of the whole game: never return an
   * answer value, an explanation, or a raw asset path.
   */
  playerPresentation: (payload: Payload, context: PresentationContext) => unknown;

  /**
   * Human-readable list of what is still missing before this item can be played.
   *
   * The payload schemas deliberately accept drafts: refusing to save a
   * half-finished item is what makes a CRUD form miserable to use. Content
   * presence is checked here instead, so the editor can save freely while the
   * game engine still refuses to present something unplayable.
   */
  missingForPlay: (payload: Payload) => string[];
}

/**
 * Helpers a kind may use when building what players receive.
 *
 * `imageUrl` maps a stored source to an opaque per-round URL. A filename like
 * `/guess_img/Arnold.jpg` in the payload would hand the answer to anyone who
 * opens the network tab, so image sources are never sent to players verbatim.
 */
export interface PresentationContext {
  imageUrl: (source: string) => string;
}

/** A kind definition with its payload type erased, for storing in the registry. */
export type AnyKindDefinition = Omit<
  KindDefinition<never>,
  'payloadSchema' | 'defaultPayload' | 'playerPresentation' | 'missingForPlay' | 'timingFromPayload'
> & {
  payloadSchema: z.ZodType<unknown>;
  defaultPayload: unknown;
  playerPresentation: (payload: unknown, context: PresentationContext) => unknown;
  missingForPlay: (payload: unknown) => string[];
  timingFromPayload?: (payload: unknown) => Partial<KindTiming>;
};

export function defineKind<Payload>(definition: KindDefinition<Payload>): KindDefinition<Payload> {
  return definition;
}
