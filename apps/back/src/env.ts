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

  GOOGLE_API_KEY: blankIsUnset(),

  /**
   * The country a blind test is played in, as an ISO 3166-1 alpha-2 code.
   *
   * Licensing on YouTube is per territory, and the failure it causes is silent:
   * a video can be public, embeddable, and still refuse to play here because its
   * `regionRestriction.allowed` list names twelve countries and none of them is
   * this one. Nothing about the video looks wrong until the room is sitting in
   * front of a black rectangle — which is exactly how "In Da Club" reached a
   * playlist, passed every check that existed, and played nowhere in France.
   *
   * So the deployment states where it is, once, and the checks below can answer
   * "will this play *here*" instead of the weaker "does this exist".
   */
  YOUTUBE_REGION: z
    .string()
    .regex(/^[A-Z]{2}$/, 'YOUTUBE_REGION must be a two-letter country code, e.g. FR')
    .default('FR'),

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
   *
   * Slots beyond the fourth are not declared here, because declaring
   * twenty-four of them three times over is seventy-two lines of schema to say
   * one thing. They are read straight out of the environment by `apiSlots`
   * below, under exactly the same names: `MAFIA_API_7_MODEL` and so on, up to
   * `MAFIA_API_24_*`. These four stay declared so a typo in the common case
   * still fails loudly at boot.
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
   * Several models on one endpoint, in one line.
   *
   * The useful axis is usually the model rather than the vendor: one Groq key
   * serves a dozen free models that contend for different pools and therefore
   * fail at different moments. Listing each as its own numbered slot means
   * repeating the URL and the key a dozen times, so a slot may name several
   * models instead and each becomes a rung of its own.
   *
   *   MAFIA_API_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.6-27b
   *
   * The slot's own `_MODEL` stays first when both are given.
   */
  MAFIA_API_MODELS: blankIsUnset(),
  MAFIA_API_2_MODELS: blankIsUnset(),
  MAFIA_API_3_MODELS: blankIsUnset(),
  MAFIA_API_4_MODELS: blankIsUnset(),

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
  MAFIA_BOT_TURN_MS: z.coerce.number().int().min(1000).max(120_000).default(25_000),

  /**
   * How long the mouth may take over one sentence before the phrasebook says it.
   *
   * Shorter than a turn on purpose. The move has already landed when this call
   * starts: the vote is on the tally and the claim is on the board, so the only
   * thing a slow answer can do is arrive after the moment it was about, and a
   * line landing twenty seconds behind its own vote reads as a non sequitur.
   * The default leaves room for a small local model with thinking off, which
   * reads the mouth's three hundred tokens in a few seconds; an API answers in
   * one.
   */
  MAFIA_BOT_SPEAK_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  /**
   * A chain of its own for each kind of question, when the endpoints differ in
   * what they are good at.
   *
   * Same syntax as `MAFIA_BOT_PROVIDER`, and the rungs must be ones that chain
   * already contains — this picks an order among what exists, it does not add
   * credentials. Unset means "use the main chain", which is what every
   * deployment did before these existed.
   *
   *   MAFIA_CHAIN_LISTEN=api1,api2      the notes: a mistake here is permanent
   *   MAFIA_CHAIN_SPEAK=api3,api4       one line of chat: take the fastest
   *   MAFIA_CHAIN_DECIDE=api2,api1
   *
   * Written out, the three of them spread one table's questions across four
   * endpoints instead of queueing them all on the first.
   */
  MAFIA_CHAIN_DECIDE: blankIsUnset(),
  MAFIA_CHAIN_SPEAK: blankIsUnset(),
  MAFIA_CHAIN_LISTEN: blankIsUnset(),

  /**
   * How many questions one endpoint may be answering at once.
   *
   * One, and the concurrency comes from having many endpoints rather than from
   * leaning on any of them. Twenty-two free tiers with one call each in flight
   * is twenty-two answers being written at the same moment, none of which looks
   * like a burst to the provider receiving it; four calls at once to the same
   * free tier is the thing that earns a 429, and a 429 costs the rung a minute
   * on the bench for every seat still waiting.
   *
   * Raise it only for an endpoint that is actually yours — a paid tier, or a
   * vLLM you host. The local default is one for a different reason: a single
   * GPU serialises the work whatever is asked of it, so queueing more only
   * converts answers into timeouts.
   */
  MAFIA_API_PARALLEL: z.coerce.number().int().min(1).max(32).default(1),
  MAFIA_LOCAL_PARALLEL: z.coerce.number().int().min(1).max(8).default(1),

  /**
   * How many of the leading API slots to actually keep in rotation.
   *
   * The pool picker prefers endpoints "within striking distance of the
   * fastest", which sounds like load balancing and behaves like a winner takes
   * all. Measured on the deployment box with ten live endpoints: the fastest
   * answered in 183ms, the window works out at 433ms, and exactly four slots
   * fell inside it. The other six — all reachable, all authorised, all
   * answering in under a second and a quarter — were only ever reached on the
   * rare afternoon when all four of the leaders were busy at once, which with
   * one call in flight per endpoint means four simultaneous callers.
   *
   * That is the wrong trade for a free tier. Every one of those endpoints has
   * its own daily allowance, and an allowance nobody spends is not saved for
   * later, it expires. The point of configuring ten is to have ten.
   *
   * So: the first N slots are a working set, and work goes round them by turn
   * rather than to whoever is quickest. Anything past N stays a reserve and is
   * reached the way everything was reached before, when the working set is
   * busy. `0` keeps the old behaviour for anybody who wants the fastest answer
   * above all else.
   */
  MAFIA_API_SPREAD: z.coerce.number().int().min(0).max(24).default(0),

  /**
   * How long to wait for an endpoint before asking a second one the same thing.
   *
   * Free tiers are not slow on average, they are slow *sometimes*: a few hundred
   * milliseconds at the median and ten seconds in the tail. The tail is what a
   * person at the table experiences, because an answer that arrives late arrives
   * after the moment it was about.
   *
   * With twenty endpoints configured, waiting out a bad draw is the one thing
   * there is no reason to do. The extra request is spent only on the tail, which
   * is exactly where the spare capacity is. `0` turns it off; note-taking gets
   * twice this, being a bigger question whose answer is worth more.
   */
  MAFIA_HEDGE_MS: z.coerce.number().int().min(0).max(30_000).default(1200),

  /**
   * The flight recorder: how much of a game is written down as it is played.
   *
   * `off` writes nothing at all. `on` is the default and records every move,
   * every model call and every reading of what a person typed, with the long
   * strings clipped. `full` clips nothing, which is what you want when the
   * question is "what exactly was in that prompt".
   *
   * It exists because everything interesting about these bots happens in the
   * half second between a person pressing enter and a seat answering, and that
   * half second leaves no trace anywhere: the chat shows the answer, the log
   * shows a rung, and nothing shows the draft the policy wrote, the claim the
   * parser filed, the prompt the model got or the sentence it sent back.
   */
  GAME_TRACE: z.enum(['off', 'on', 'full']).default('on'),

  /** Where the traces go. Relative paths resolve against the API package. */
  GAME_TRACE_DIR: z.string().default('./traces'),

  /** How many finished games are kept per game, newest first. */
  GAME_TRACE_KEEP: z.coerce.number().int().min(1).max(200).default(10)
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

/** The most numbered API slots that will ever be read. One per seat at a full table. */
export const MAX_API_SLOTS = 24;

/** One OpenAI-compatible endpoint, assembled and ready to call. */
export interface ApiSlot {
  /** `api1`, `api7`… the name it is known by in a chain. */
  rung: string;
  url: string;
  key: string;
  model: string;
}

/**
 * Every endpoint this deployment can actually reach, in slot order.
 *
 * Read from the environment rather than declared, because the useful number of
 * these turned out to be "as many as there are free tiers", and twenty-four
 * declarations of three fields each is seventy-two lines of schema that say one
 * thing. The names are the ones that were always used: `MAFIA_API_URL`,
 * `MAFIA_API_KEY`, `MAFIA_API_MODEL` for the first, and `MAFIA_API_<n>_*` after
 * it.
 *
 * Two shorthands, because the config is otherwise mostly repetition:
 *
 *  - **URL and key fall back to slot one.** Twelve free models behind one Groq
 *    key cost one line each.
 *  - **A slot may name several models** through `_MODELS`, and each becomes a
 *    rung of its own: `api3`, `api3b`, `api3c`. That is how a handful of
 *    providers becomes twenty-two rungs without twenty-two blocks of config.
 *
 * A slot with no model or no key does not exist. That is checked here rather
 * than at the call site so the boot line is the truth about what the server can
 * do.
 */
function readApiSlots(): ApiSlot[] {
  const raw = (name: string): string | undefined => {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : undefined;
  };
  const firstUrl = env.MAFIA_API_URL;
  const firstKey = env.MAFIA_API_KEY;

  const slots: ApiSlot[] = [];
  for (let index = 1; index <= MAX_API_SLOTS; index++) {
    const suffix = index === 1 ? '' : `_${index}`;
    const url = raw(`MAFIA_API${suffix}_URL`) ?? firstUrl;
    const key = raw(`MAFIA_API${suffix}_KEY`) ?? firstKey;
    const models = [raw(`MAFIA_API${suffix}_MODEL`), ...(raw(`MAFIA_API${suffix}_MODELS`)?.split(',') ?? [])]
      .map((model) => model?.trim())
      .filter((model): model is string => !!model);

    if (!key || models.length === 0) continue;
    // One rung per model, the first keeping the plain slot name so existing
    // chains ("api1,api2,ollama") mean exactly what they always meant.
    const seen = new Set<string>();
    for (const [offset, model] of models.entries()) {
      if (seen.has(model)) continue;
      seen.add(model);
      slots.push({
        rung: offset === 0 ? `api${index}` : `api${index}${String.fromCharCode(97 + offset)}`,
        url,
        key,
        model
      });
    }
  }
  return slots;
}

export const apiSlots: ApiSlot[] = readApiSlots();

/** Where the flight recorder writes, as an absolute path. Same rule as the database. */
export const traceDir = isAbsolute(env.GAME_TRACE_DIR) ? env.GAME_TRACE_DIR : resolve(packageRoot, env.GAME_TRACE_DIR);

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
