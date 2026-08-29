import { z } from 'zod';

/**
 * Schemas shared between route files. Anything used by exactly one resource
 * lives beside it: the playlist body is in playlist-service, the media body is
 * game-core's own `validateMedia`.
 */

/** Route params of the form `/:id`. */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

export const credentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200)
});

/**
 * Registration is stricter than login on the password.
 *
 * Login has to accept whatever is already stored, including passwords set before
 * this rule existed, so the minimum belongs here rather than on the shared shape.
 */
export const registerSchema = credentialsSchema.extend({
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères').max(200),
  email: z.email().max(254)
});

/**
 * Changing a password proves the old one.
 *
 * The new one is held to the same minimum as registration; the current one is
 * not, because it may predate that rule and refusing it here would lock out
 * exactly the person trying to fix it.
 */
export const changePasswordSchema = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères').max(200)
});
