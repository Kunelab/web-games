import { z } from 'zod';

import { answerFieldSchema, type AnswerField } from './answer-field.js';
import type { AnyKindDefinition, KindTiming } from './kind-definition.js';
import { blindtest } from './kinds/blindtest.js';
import { estimation } from './kinds/estimation.js';
import { imageMemory } from './kinds/image-memory.js';
import { imageReveal } from './kinds/image-reveal.js';
import { quiz } from './kinds/quiz.js';

/**
 * Every media kind the app knows about.
 *
 * Adding a kind means adding a file under `kinds/` and one entry here. Nothing
 * else changes: no migration, because payloads are stored as JSON validated by
 * the kind's own schema; no new form, because the editor is generated from
 * `formFields`; no new scoring branch, because scoring works off answer fields.
 */
const definitions = [blindtest, quiz, estimation, imageReveal, imageMemory] as unknown as AnyKindDefinition[];

export const mediaKinds: Record<string, AnyKindDefinition> = Object.fromEntries(
  definitions.map((definition) => [definition.id, definition])
);

export const mediaKindIds = definitions.map((definition) => definition.id);

/** Kinds offered in the UI. */
export const availableMediaKinds = definitions.filter((definition) => definition.available);

export function getMediaKind(kind: string): AnyKindDefinition {
  const definition = mediaKinds[kind];
  if (!definition) {
    throw new Error(`Unknown media kind: ${kind}`);
  }
  return definition;
}

export function isMediaKind(kind: string): boolean {
  return kind in mediaKinds;
}

/** Zod enum over the registered kind ids, for route schemas. */
export const mediaKindSchema = z.string().refine(isMediaKind, {
  message: 'Type de média inconnu'
});

/**
 * A stored media item. `payload` is validated against the kind's schema rather
 * than being typed here, which is what lets one table hold every kind.
 */
export interface MediaItem {
  id: number;
  user_id: number | null;
  kind: string;
  /** Librarian-facing name, used for searching and listing. */
  title: string;
  /** Free-form grouping the host chooses, e.g. "années 80", "cinéma". */
  category: string | null;
  /** `YYYY-MM-DD`, used for chronological ordering. */
  date: string | null;
  answers: AnswerField[];
  payload: unknown;
  timing: KindTiming | null;
  created_at: string | null;
  last_modified: string | null;
}

/** Validates a payload against its kind and returns it typed as unknown-but-valid. */
export function parsePayload(kind: string, payload: unknown): unknown {
  return getMediaKind(kind).payloadSchema.parse(payload);
}

export function safeParsePayload(kind: string, payload: unknown) {
  return getMediaKind(kind).payloadSchema.safeParse(payload);
}

/**
 * Effective timing for an item, in increasing order of authority.
 *
 * The kind's defaults, then anything the kind reads out of the item's own payload,
 * then the item's explicit overrides. The middle layer is what makes a form field like
 * a panel's memorisation time actually govern the round: it is a duration that belongs
 * with the content rather than in a timing section, and before this it was written and
 * then ignored.
 */
export function resolveTiming(item: Pick<MediaItem, 'kind' | 'timing' | 'payload'>): KindTiming {
  const definition = getMediaKind(item.kind);

  return {
    ...definition.defaultTiming,
    ...definition.timingFromPayload?.(item.payload),
    ...(item.timing ?? {})
  };
}

export const timingSchema = z.object({
  answerMs: z.number().int().min(3_000).max(600_000),
  studyMs: z.number().int().min(0).max(600_000).optional(),
  revealMs: z.number().int().min(0).max(120_000)
});

/** Body accepted when creating or updating a media item. */
export const mediaInputSchema = z.object({
  kind: mediaKindSchema,
  title: z.string().min(1, 'Le titre est requis').max(200),
  category: z.string().max(80).nullable().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ')
    .nullable()
    .optional(),
  answers: z.array(answerFieldSchema).max(60),
  payload: z.unknown(),
  timing: timingSchema.nullable().optional()
});

export type MediaInput = z.infer<typeof mediaInputSchema>;

/**
 * Full validation of a media item: the generic envelope, then the payload against
 * its kind, then the invariant that answer keys are unique.
 */
export function validateMedia(input: unknown) {
  const envelope = mediaInputSchema.safeParse(input);
  if (!envelope.success) {
    return { success: false as const, error: envelope.error };
  }

  const payload = safeParsePayload(envelope.data.kind, envelope.data.payload);
  if (!payload.success) {
    return { success: false as const, error: payload.error };
  }

  const keys = new Set<string>();
  for (const field of envelope.data.answers) {
    if (keys.has(field.key)) {
      return {
        success: false as const,
        error: new z.ZodError([
          {
            code: 'custom',
            path: ['answers'],
            message: `Clé de réponse en double : ${field.key}`
          }
        ])
      };
    }
    keys.add(field.key);
  }

  return { success: true as const, data: { ...envelope.data, payload: payload.data } };
}
