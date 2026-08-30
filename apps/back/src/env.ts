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

/**
 * An optional setting where "" means absent.
 *
 * Docker Compose has no way to express "leave this variable unset". A line like
 * `MAFIA_API_2_URL: ${MAFIA_API_2_URL:-}` injects an *empty string* into the
 * container, and an empty string is not `undefined` — so `??` sails straight
 * past it and hands the caller "".
 *
 * That is not hypothetical: it silently dropped a working Groq rung out of the
 * live chain, because slot 2 inherited "" for its URL and key instead of slot
 * one's, failed its own credential check and was filtered out at startup. The
 * boot log said `api1 → api3 → api4 → ollama` and nothing anywhere said why.
 *
 * So the coercion belongs here, at the boundary, once — not at each of the
 * dozen places that read one of these.
 */
const blankIsUnset = () =>
  z
    .string()
    .optional()
    .transform((value) => (value === '' ? undefined : value));

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
   * Brains for the Mafia bots, in the order they are tried.
   *
   * A comma-separated chain rather than one name: `openai,ollama` means "a free
   * API while it will have us, the box under the desk when it will not, and the
   * simulator's own brain when neither answers". Every rung falls through to the
   * next on a rate limit or an error, and the last fall is always to the played
   * brain — which is a real player, not a stub, so a table never stalls and
   * never goes quiet.
   *
   * Recognised rungs:
   *   `api1`..`api4` — OpenAI-compatible endpoints. That is most of the free
   *                 tiers going (Groq, Cerebras, OpenRouter, a vLLM you host),
   *                 so one client covers them all. `api1` reads MAFIA_API_URL /
   *                 _KEY / _MODEL; `api2` reads MAFIA_API_2_*, and so on, with
   *                 URL and key inherited from `api1` when left unset.
   *                 `openai` is an old name for `api1` and still works.
   *   `anthropic` — the Claude API, with `ANTHROPIC_API_KEY`.
   *   `ollama`    — a local daemon at `OLLAMA_URL`. That URL does not have to be
   *                 local: an SSH tunnel to a Debian box running a tiny model is
   *                 just a different host here, and nothing else changes.
   *   `scripted`  — go straight to the played brain and call nothing.
   *
   * Order is preference, not fallback quality: put the fastest good answer
   * first. A live table would rather have a 70B on somebody else's hardware
   * than a 1B on its own, right up until the free tier says no.
   */
  MAFIA_BOT_PROVIDER: z.string().default('ollama'),
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

  /**
   * Who decides a bot's turn, and who only phrases it.
   *
   *   `policy` — the deterministic brain decides everything and a model, when
   *              one is reachable, rewrites the resulting line in its own voice.
   *              Roughly a sixth of the tokens, and a model that cannot decide
   *              anything cannot decide anything wrong.
   *   `model`  — the model decides the whole turn from a full briefing. The
   *              original arrangement, kept because letting a model *plan* is
   *              worth revisiting once there is a way to tell a good plan from a
   *              confidently invented one.
   *
   * Either way the played brain is underneath: `policy` uses it always, `model`
   * falls back to it whenever nothing answers.
   */
  MAFIA_BOT_MIND: z.enum(['policy', 'model']).default('policy'),
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
  /**
   * The local tag to prefer — a preference, not a requirement.
   *
   * Which is the important part. A tag that is not pulled on this particular
   * box used to 404 on every single call; the per-call fallback swallowed it,
   * and the table filled with silent bots that looked exactly like a machine
   * with no Ollama at all. The driver now asks Ollama what is actually
   * installed and prefers this tag if it is there, the best small chat model
   * present if it is not, and says which in the log either way.
   */
  MAFIA_BOT_MODEL: z.string().default('qwen3.5:4b'),
  MAFIA_BOT_MODEL_ANTHROPIC: z.string().default('claude-haiku-4-5-20251001'),
  /**
   * Where the local daemon lives.
   *
   * Not necessarily this machine. `ssh -N -L 11434:127.0.0.1:11434 debian-box`
   * and the default value already points at the other box — which is the whole
   * of "run the tiny model on the Debian machine", and needs no code that knows
   * what SSH is.
   */
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  ANTHROPIC_API_KEY: blankIsUnset(),

  /**
   * An OpenAI-compatible endpoint and its key, for the `openai` rung.
   *
   * Compatible is the point: Groq, Cerebras, OpenRouter, Together and a locally
   * hosted vLLM all speak `/chat/completions`, so the free tier of the week is a
   * URL change rather than a new client. Defaults to Groq, whose free tier is
   * the fastest of them by a distance.
   */
  MAFIA_API_URL: z.string().default('https://api.groq.com/openai/v1'),
  MAFIA_API_KEY: blankIsUnset(),
  MAFIA_API_MODEL: z.string().default('openai/gpt-oss-120b'),

  /**
   * Three more of the same, for the chain to walk.
   *
   * One slot was not enough, and the reason is specific to how free tiers
   * actually behave: they do not fail by running out at the end of the day,
   * they fail by answering 429 *right now* because somebody else is using the
   * same shared pool. Measured against OpenRouter's free models, better than
   * half of the calls to any single one came back 429 on the first try while a
   * sibling model answered in a second and a half. A chain of one has nowhere
   * to go when that happens; a chain of four barely notices.
   *
   * URL and key fall back to slot one, so three free models on the same
   * provider cost three lines of config rather than nine — which is the common
   * case, because the useful axis is usually the model and not the vendor.
   */
  MAFIA_API_2_URL: blankIsUnset(),
  MAFIA_API_2_KEY: blankIsUnset(),
  MAFIA_API_2_MODEL: blankIsUnset(),
  MAFIA_API_3_URL: blankIsUnset(),
  MAFIA_API_3_KEY: blankIsUnset(),
  MAFIA_API_3_MODEL: blankIsUnset(),
  MAFIA_API_4_URL: blankIsUnset(),
  MAFIA_API_4_KEY: blankIsUnset(),
  MAFIA_API_4_MODEL: blankIsUnset(),

  /**
   * How long a rung sits out after it refuses.
   *
   * A free tier that says 429 will keep saying it, and asking again on the next
   * bot turn spends a whole table's day phase discovering that. One refusal
   * benches the rung for this long and the chain moves down.
   */
  MAFIA_BOT_COOLDOWN_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),

  /**
   * How long one bot's turn may spend walking the chain before it gives up.
   *
   * The walk is cheap when it fails — a rate-limited endpoint answers 429 in a
   * couple of hundred milliseconds, so four dead APIs cost under two seconds
   * between them. It is the *local* model at the bottom that is slow, and a
   * turn that starts near the end of a phase must not still be thinking when
   * the next one begins. Past this, the played brain takes the turn, which it
   * does instantly and competently.
   */
  MAFIA_BOT_TURN_MS: z.coerce.number().int().min(1000).max(120_000).default(25_000)
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
