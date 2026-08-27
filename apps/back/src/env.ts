import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import { z } from 'zod';

/**
 * This package's own root, whether we are running from `src/` via tsx or from
 * `dist/`. Both live one directory below it, so the same expression works for
 * either.
 */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The old code read `process.env` ad hoc in five different files and treated
 * `FRONT_PORT` as a string that already contained its leading colon. Both
 * forms are accepted here and normalised once.
 */
const portSuffix = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return '';
    const trimmed = value.trim().replace(/^:/, '');
    return trimmed ? `:${trimmed}` : '';
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  SECRET: z.string().min(32, 'SECRET must be at least 32 characters (used to sign session cookies)'),

  /**
   * Whether anyone can create an account. Existing accounts are unaffected when
   * this is off, so closing it is the way to leave a deployment reachable without
   * leaving it open.
   */
  REGISTRATION_OPEN: z
    .string()
    .optional()
    .transform((value) => value !== 'false'),

  DATABASE_FILE: z.string().default('./kune.db'),
  DEBUG: z
    .string()
    .optional()
    .transform((value) => value === 'true'),

  FRONT_PROTOCOL: z.enum(['http', 'https']).default('http'),
  FRONT_URL: z.string().default('localhost'),
  FRONT_PORT: portSuffix,

  /**
   * Extra origins allowed through CORS, comma separated. Needed whenever the
   * frontend is reachable at more than one address, which is the normal case on
   * a LAN box: `http://kune.local:5173` and `http://192.168.1.18:5173` are
   * different origins to the browser even though they are the same server.
   */
  FRONT_ORIGINS: z.string().optional(),

  /** Directory of the built frontend, served as static files. Optional in dev. */
  FRONT_DIR: z.string().optional(),
  FRONT_DIR_BUILD: z.string().optional(),

  GOOGLE_API_KEY: z.string().optional(),

  /**
   * Brains for the Mafia bots. 'ollama' talks to a local model over HTTP
   * (free, private, and a 4B model is plenty for table talk); 'anthropic'
   * uses the API with ANTHROPIC_API_KEY; 'scripted' never calls a model.
   * Whatever the setting, an unreachable brain degrades per-call to the
   * scripted one, so a table never stalls on an LLM.
   */
  MAFIA_BOT_PROVIDER: z.enum(['ollama', 'anthropic', 'scripted']).default('ollama'),
  /**
   * How much thinking a table can afford.
   *
   * `live` is a real game: the phase clock rules, bots get one shot inside a
   * fraction of it, the briefing is a pre-chewed summary and most of them stay
   * quiet. `deliberate` is the laboratory: each bot gets several rounds of
   * think-then-act per phase with the whole board in front of it and no clock
   * worth speaking of — slow, expensive, and the only way to see what these
   * personalities actually do when they are not rushed.
   */
  MAFIA_BOT_TEMPO: z.enum(['live', 'deliberate']).default('live'),
  /** Think-then-act rounds per phase in the deliberate tempo. */
  MAFIA_BOT_ROUNDS: z.coerce.number().int().min(1).max(6).default(3),
  /**
   * One model name per provider, because they do not share a namespace.
   *
   * They used to: a single `MAFIA_BOT_MODEL` defaulting to a local Ollama tag
   * meant that switching `MAFIA_BOT_PROVIDER=anthropic` and nothing else sent
   * `qwen3.5:4b` to the API, every call failed on an unknown model, the per-call
   * fallback quietly caught it, and the table filled with mute scripted bots that
   * looked exactly like working ones.
   */
  MAFIA_BOT_MODEL: z.string().default('qwen3.5:4b'),
  MAFIA_BOT_MODEL_ANTHROPIC: z.string().default('claude-haiku-4-5-20251001'),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  ANTHROPIC_API_KEY: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';

/**
 * The database file, as an absolute path.
 *
 * A relative `DATABASE_FILE` is resolved against this package rather than the
 * working directory. In a workspace the same command is run from two places —
 * `pnpm dev` from the repo root and `pnpm dev` from `apps/back` — and resolving
 * against the cwd made those two different databases. It also silently created
 * an `apps/back/apps/back/` directory the first time someone passed the path
 * they saw in a root-level script.
 */
export const databaseFile = isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : resolve(packageRoot, env.DATABASE_FILE);

/** The canonical frontend origin, used when a single value is needed. */
export const frontOrigin = `${env.FRONT_PROTOCOL}://${env.FRONT_URL}${env.FRONT_PORT}`;

/**
 * Every origin CORS and socket.io will accept.
 *
 * The browser treats `kune.local:5173`, `www.kune.local:5173`,
 * `localhost:5173` and `192.168.1.18:5173` as four distinct origins, so a single
 * configured value rejects the other three. The `www.` variant of the configured
 * host is included automatically, and in development so are the loopback names.
 *
 * Note this only opens up CORS. Session cookies are `SameSite=Lax`, so the page
 * and the API still have to share a registrable domain for the cookie to be
 * sent: browsing `www.kune.local:5173` while calling `localhost:3000` gets past
 * CORS and then silently fails to authenticate. Leave `VITE_API_URL` unset in the
 * frontend and it derives the API host from the page, which keeps them aligned.
 */
export const allowedOrigins: string[] = (() => {
  const origins = [frontOrigin];

  // `kune.local` and `www.kune.local` are different origins to the browser.
  if (!env.FRONT_URL.startsWith('www.')) {
    origins.push(`${env.FRONT_PROTOCOL}://www.${env.FRONT_URL}${env.FRONT_PORT}`);
  }

  for (const extra of (env.FRONT_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim().replace(/\/$/, '');
    if (trimmed) {
      origins.push(trimmed);
    }
  }

  if (!isProduction) {
    origins.push(
      `${env.FRONT_PROTOCOL}://localhost${env.FRONT_PORT}`,
      `${env.FRONT_PROTOCOL}://127.0.0.1${env.FRONT_PORT}`
    );
  }

  return [...new Set(origins)];
})();
