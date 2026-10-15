import type { FastifyBaseLogger } from 'fastify';

import { apiSlots, env, type ApiSlot } from '../env.js';
import { trace } from '../trace.js';

/**
 * The brain chain: which model a bot asks, in what order, and what happens when
 * one is slow or says no.
 *
 * Everything here is about the free tiers' tail. The chain keeps each rung's
 * health, benches a rung that refused, hedges a slow one with a second, spreads
 * the work across a working set, and gives up on a deadline so the game goes on
 * with the played brain. How a question actually reaches an endpoint is the
 * `Transport`'s business: the HTTP one in production (`transport.ts`), an
 * in-memory one in the tests, so none of this needs a server or an environment
 * to be measured.
 */

/**
 * One rung of the brain chain.
 *
 * A string rather than a union, because the API rungs are no longer a fixed
 * four: a deployment can configure two dozen of them and the names come out of
 * the environment. The three fixed ones are still spelled out, and everything
 * that starts with `api` is a configured endpoint.
 */
export type Rung = string;
/** A configured endpoint: `api1`, `api2`… See `isApiRung`. */
type ApiRung = `api${string}`;

const FIXED_RUNGS: readonly Rung[] = ['anthropic', 'ollama', 'scripted'];

/** `openai` was the name when there was only one of them. */
const ALIASES: Record<string, Rung> = { openai: 'api1' };

/**
 * A chain, as configured.
 *
 * `api*` is the useful spelling once there are more than a handful: it expands
 * to every configured endpoint, in slot order, so adding a free tier is one
 * line of config and no change to the chain. Named rungs still work and still
 * mean exactly what they meant.
 */
function readChain(raw: string, slots: readonly ApiSlot[]): Rung[] {
  const chain: Rung[] = [];
  for (const part of raw.split(',').map((piece) => piece.trim().toLowerCase())) {
    const name = ALIASES[part] ?? part;
    if (name === 'api*' || name === 'apis') {
      for (const slot of slots) chain.push(slot.rung);
      continue;
    }
    if (FIXED_RUNGS.includes(name) || slots.some((slot) => slot.rung === name)) chain.push(name);
  }
  // An empty or unrecognisable setting is a configuration mistake, not a
  // reason to have no bots: the floor is always there.
  return chain.length > 0 ? [...new Set(chain)] : ['scripted'];
}

/**
 * Rungs that compete on measured speed rather than on their place in the chain.
 *
 * Every free endpoint, and the machine under the desk. What they have in common
 * is that they cost nothing and there is no reason to prefer one over another
 * except how fast it is answering tonight. The paid API is deliberately not one
 * of these: it is a fallback somebody chose to configure, and its position in
 * the chain is that choice.
 */
function poolable(rung: Rung): boolean {
  return isApiRung(rung) || rung === 'ollama';
}

export function isApiRung(rung: Rung): rung is ApiRung {
  return rung.startsWith('api');
}

/**
 * Which numbered slot an API rung is, or 0 for anything that is not one.
 *
 * `api1` is the unnumbered `MAFIA_API_*` block and every other slot carries its
 * number, so the name is the slot. Used by the working-set filter, which is
 * expressed in terms of "the first N" and therefore needs to know what N-th
 * means. The local model and the paid API answer 0 and are never in a working
 * set: both are there precisely because they are not interchangeable with a
 * free endpoint.
 */
function apiIndex(rung: Rung): number {
  // `api3b` is the second model on slot three, and slot three is what the working set counts.
  const match = /^api(\d+)[a-z]?$/.exec(rung);
  return match ? Number(match[1]) : 0;
}

/**
 * Refusals that a minute of waiting will not fix.
 *
 * The cooldown exists for 429s — free-tier contention, which clears on its own
 * and clears quickly. A 401, 402 or 403 is a different animal: the key is
 * wrong, or the account has no quota, or the model is not available to this
 * plan. None of those change while the process is running, so benching for a
 * minute and trying again just means asking the same dead endpoint sixty times
 * an hour for the rest of the evening.
 *
 * Found the honest way: a Cerebras key that answered two requests and then
 * returned `402 payment_required` to everything, forever.
 */
const PERMANENT_REFUSALS = new Set([401, 402, 403]);

/**
 * A refusal that still knows what the endpoint said.
 *
 * The status has to survive the throw. Reading it back out of the message with
 * a regex worked and was a trap waiting to spring: an upstream error body is
 * free text, and "403" appearing inside one would have retired a perfectly
 * healthy rung for the rest of the evening.
 */
export class RungError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'RungError';
  }
}

/**
 * What an endpoint nobody has called yet is assumed to cost.
 *
 * Optimistic on purpose: the only way to learn what a free tier is doing this
 * evening is to ask it, and one slow answer is a cheap price for finding a fast
 * provider. Set above what a good endpoint actually measures (roughly 200 to
 * 600 ms) and well below a bad one, so an untried rung competes with the known
 * good ones without displacing them.
 */
const UNTRIED_SCORE_MS = 700;

/**
 * The longest a rung is ever benched for a failure that might yet pass.
 *
 * Ten minutes is long enough that an exhausted free tier stops costing a call a
 * minute for the rest of the evening, and short enough that an endpoint which
 * recovers is back before the game is over. A refusal that will never pass — a
 * bad key, a spent quota, a plan that does not cover this — is benched for the
 * whole process by `PERMANENT_REFUSALS` and never reaches this.
 */
const MAX_COOLDOWN_MS = 10 * 60_000;

/** Asked for often enough to be worth not allocating. */
const EMPTY_RUNGS: ReadonlySet<Rung> = new Set();

/** A timer as a promise, for racing one against a request. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * The first of these that actually answered, or the last refusal.
 *
 * `Promise.any` is nearly this and not quite: these never reject, because a
 * refusal is a value here, so the race has to be run on the shape rather than
 * on the settlement. Losing attempts are left to finish on their own — they
 * release their own slot and bench their own rung.
 */
function firstUsable<T extends { ok: boolean }>(racing: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve) => {
    let left = racing.length;
    let refused: T | null = null;
    for (const entry of racing) {
      void entry.then((outcome) => {
        if (outcome.ok) resolve(outcome);
        else {
          refused ??= outcome;
          if (--left === 0) resolve(refused);
        }
      });
    }
  });
}

/**
 * Which rungs a given kind of question is allowed to use.
 *
 * Not every question deserves the best model on the chain. Writing one line of
 * chat is the easy job — the brain has already decided everything — and the
 * difference between a 120B and a 20B on it is a shade of phrasing, while the
 * difference in latency is 465ms against 181ms and the difference in tokens
 * comes straight out of the same per-minute allowance. Taking notes is the hard
 * job, because a misread claim goes on the board and stays there.
 *
 * So the mouth starts one rung down where there is a rung to start down from,
 * and the ear always gets the front of the chain. Both still walk the whole way
 * to the played brain: this is about where they *begin*.
 */
export type Errand = 'decide' | 'speak' | 'listen';

/**
 * One question for a model: what it is, what to answer about, and the shape.
 *
 * Split out because deciding a turn is no longer the only thing this driver asks
 * a model to do — the ear reads the square's human lines with a completely
 * different prompt and a completely different shape, and it has every right to
 * the same chain, the same benching and the same learned dialect. What varies is
 * these four fields; everything else about talking to these endpoints is
 * identical and now lives in one place.
 */
export interface Ask {
  /** The instructions. Kept byte-stable per kind of question, so it caches. */
  system: string;
  /** What to answer about. */
  user: string;
  /** JSON schema, for endpoints that honour one. */
  format: Record<string, unknown>;
  /**
   * What this question is called, for the endpoints that want the schema named
   * and for the dialect cache, which has to tell one question from another: a
   * slot can satisfy one of these schemas and not the next. Defaults to
   * `answer`, which is what a single unnamed question was always called.
   */
  formatName?: string;
  maxTokens: number;
  temperature?: number;
  /** How long one request may take, when the errand is in more of a hurry than the transport's default. */
  timeoutMs?: number;
}

/**
 * Everything the chain is configured by, read once from the environment in
 * production and written out by hand in a test.
 */
export interface ChainConfig {
  /** `MAFIA_BOT_PROVIDER`: the rungs, in order. */
  provider: string;
  /** `MAFIA_CHAIN_DECIDE` and friends: a chain of its own for an errand. */
  errands: Partial<Record<Errand, string>>;
  /** Every OpenAI-compatible endpoint this deployment can reach. */
  slots: readonly ApiSlot[];
  /** Whether the paid API has a key at all. */
  anthropic: boolean;
  /** How long a turn, and a spoken line, may wait on the chain. */
  turnMs: number;
  speakMs: number;
  /** The first bench after a refusal; it doubles per refusal in a row. */
  cooldownMs: number;
  /** How long a slow rung gets before a second one is asked too. Zero for never. */
  hedgeMs: number;
  /** Questions one rung may be answering at once. */
  apiParallel: number;
  localParallel: number;
  /** The working set: the first N slots share the work in turn. Zero ranks by speed instead. */
  spread: number;
}

/** The chain this deployment is configured for. */
export function chainConfig(): ChainConfig {
  return {
    provider: env.MAFIA_BOT_PROVIDER,
    errands: { decide: env.MAFIA_CHAIN_DECIDE, speak: env.MAFIA_CHAIN_SPEAK, listen: env.MAFIA_CHAIN_LISTEN },
    slots: apiSlots,
    anthropic: !!env.ANTHROPIC_API_KEY,
    turnMs: env.MAFIA_BOT_TURN_MS,
    speakMs: env.MAFIA_BOT_SPEAK_MS,
    cooldownMs: env.MAFIA_BOT_COOLDOWN_MS,
    hedgeMs: env.MAFIA_HEDGE_MS,
    apiParallel: env.MAFIA_API_PARALLEL,
    localParallel: env.MAFIA_LOCAL_PARALLEL,
    spread: env.MAFIA_API_SPREAD
  };
}

/**
 * How one question reaches one rung: the port at the edge of the chain.
 *
 * One adapter speaks HTTP to the real endpoints; another answers from memory in
 * the tests. A refusal is a rejection, carrying the endpoint's status when it
 * gave one (see `RungError`): that status is what tells a passing 429 from a
 * key that will never work.
 */
export interface Transport {
  ask(rung: Rung, request: Ask): Promise<Record<string, unknown>>;
  /** The model a rung calls, for the logs and the board. */
  model(rung: Rung): string;
  /** Whether a rung can be asked at all right now, such as a local daemon that is up. Absent means always. */
  ready?(rung: Rung): boolean;
}

export class BrainChain {
  /** The rungs, in order, as configured. */
  private readonly chain: Rung[];
  /** And the per-errand overrides, where any were configured. See `chainFor`. */
  private readonly chains: Partial<Record<Errand, Rung[]>> = {};
  /** How many questions each rung is answering right now. See `parallel`. */
  private readonly busyOn = new Map<Rung, number>();
  /**
   * When each rung was last asked anything, for the round-robin in `nextRung`.
   *
   * A counter rather than a clock: two calls in the same millisecond are
   * ordinary here, and `Date.now()` cannot tell them apart, so they would both
   * look equally stale and the rotation would stall on whichever sorted first.
   */
  private readonly usedAt = new Map<Rung, number>();
  private turn = 0;
  /** How each rung has actually behaved this run. See `score`. */
  private readonly health = new Map<Rung, { ms: number; ok: number; bad: number; streak: number }>();
  /**
   * A rung that refused, and the moment it may be asked again.
   *
   * A free tier that answers 429 will answer 429 to the next bot too, so one
   * refusal benches the rung rather than costing every remaining seat its own
   * round trip to find out.
   */
  private readonly benched = new Map<Rung, number>();
  /** Rungs that have answered at least once, so the log says so exactly once. */
  private readonly answered = new Set<Rung>();
  /**
   * The model behind the most recent successful call, for `noteBrain`.
   *
   * A single field rather than a per-seat map because the walk is synchronous
   * from the caller's point of view: whoever reads this immediately after
   * awaiting its own call reads its own answer. Good enough for a diagnostic,
   * and it costs nothing.
   */
  private lastAnswered = 'scripted';

  constructor(
    private readonly config: ChainConfig,
    private readonly transport: Transport,
    private readonly log: FastifyBaseLogger
  ) {
    /**
     * A rung with no credentials is not a rung.
     *
     * Dropped at startup rather than discovered per call, so the log line below
     * is the truth about what this server can actually do — an `openai` rung
     * with no key used to sit in the chain failing silently, which looks exactly
     * like a working one that never gets picked.
     */
    this.chain = readChain(config.provider, config.slots).filter((rung) => {
      if (rung === 'anthropic') {
        if (config.anthropic) return true;
        this.log.warn({ rung }, 'mafia bots: rung asked for but has no API key, dropped from the chain');
        return false;
      }
      /**
       * An API rung that reached this point is one `readChain` recognised, and
       * `readChain` only recognises endpoints that assembled — a slot missing
       * its key or its model never becomes a name at all. What is worth saying
       * out loud is the opposite case: a name in the setting that matched
       * nothing, which is the typo that silently costs a working endpoint.
       */
      if (isApiRung(rung)) return config.slots.some((slot) => slot.rung === rung);
      return true;
    });

    const asked = config.provider
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part && part !== 'api*' && part !== 'apis');
    for (const name of asked) {
      const rung = ALIASES[name] ?? name;
      if (FIXED_RUNGS.includes(rung) || config.slots.some((slot) => slot.rung === rung)) continue;
      this.log.warn(
        { rung: name, configured: config.slots.map((slot) => slot.rung).join(',') || 'none' },
        'mafia bots: chain names a rung that is not configured, dropped'
      );
    }

    /**
     * A chain per errand, for the operator who has told us which endpoint is
     * good at what.
     *
     * Filtered through the same credential check as the main chain, and against
     * it: a slot that was dropped for having no key must not come back through
     * a per-errand setting. An override that survives nothing falls back to the
     * main chain rather than to silence.
     */
    const usable = new Set(this.chain);
    for (const errand of ['decide', 'speak', 'listen'] as const) {
      const raw = config.errands[errand];
      if (!raw) continue;
      const wanted = readChain(raw, config.slots).filter((rung) => rung === 'scripted' || usable.has(rung));
      if (wanted.length > 0 && wanted.some((rung) => rung !== 'scripted')) this.chains[errand] = wanted;
      else this.log.warn({ errand, raw }, 'mafia bots: per-errand chain has no usable rung, using the main chain');
    }

    // Asked at once rather than on the first turn, so the log says which brain
    // a table is about to get before anybody sits down at one.
    if (this.chain.includes('ollama')) this.transport.ready?.('ollama');
  }

  /** The chain, as a log line: each rung and the model it calls. */
  describe(): string {
    return this.chain.map((rung) => `${rung}(${this.transport.model(rung)})`).join(' → ') || 'scripted';
  }

  /** The rung a chain starts on, before anything has been measured. */
  head(): Rung {
    return this.chain[0] ?? 'scripted';
  }

  /** The model behind the most recent answer, whichever walk it came from. */
  lastModel(): string {
    return this.lastAnswered;
  }

  /** The rung this errand would go to right now, or null for the played brain. */
  next(errand: Errand): Rung | null {
    return this.nextRung(0, errand);
  }

  /**
   * The first rung willing to take a turn right now.
   *
   * Never blocks and never throws: the answer is read from what is already
   * known — a benched rung is skipped until its cooldown expires, and a local
   * daemon is skipped until a probe says it is there. `null` means the played
   * brain, which is a perfectly good answer.
   */
  private nextRung(
    from = 0,
    errand: Errand = 'decide',
    exclude: ReadonlySet<Rung> = EMPTY_RUNGS,
    /** What is left of the caller's clock, when it has one. */
    remainingMs?: number
  ): Rung | null {
    const chain = this.chainFor(errand);
    /**
     * A rung that cannot finish in the time left is not a rung.
     *
     * Measured, not assumed: a local model that answers in twelve seconds is a
     * perfectly good instance when a night has forty seconds left in it and a
     * waste of a turn when a mouth has three. Untried rungs are never refused
     * on this basis — their prior is a guess, and the only way to improve it is
     * to ask them.
     */
    const inTime = (rung: Rung): boolean =>
      remainingMs === undefined || (this.health.get(rung)?.ok ?? 0) === 0 || this.score(rung) < remainingMs;

    for (let index = from; index < chain.length; index++) {
      const rung = chain[index];
      if (rung === 'scripted') return null;
      if (exclude.has(rung) || !this.up(rung) || !inTime(rung)) continue;

      /**
       * Among the endpoints, the best one available rather than the first.
       *
       * A chain of four was an order of preference and could be walked as one.
       * A chain of twenty-two is not: the operator has no way of knowing which
       * free tier is fast this evening, the answer changes hour by hour, and
       * hammering whichever name happens to be first burns that one provider's
       * daily allowance while twenty-one others sit idle.
       *
       * So a run of consecutive API rungs is a *pool*, and the pick inside it
       * is by measured behaviour: everything within striking distance of the
       * fastest is a candidate, and among the candidates the least busy wins,
       * ties broken at random. Fast endpoints therefore get most of the work
       * without any single one getting all of it, and a provider that starts
       * answering slowly loses share before it ever has to refuse.
       *
       * The local model is in the pool too, when the chain puts it there, and
       * it needs no special case to stay out of the way: it measures at ten
       * seconds where an endpoint measures at four hundred milliseconds, so it
       * is never within striking distance of the best while any endpoint is
       * free — and the moment they are all busy it is simply the next instance,
       * which is what a machine under the desk is for. The clock check above
       * keeps it from taking a turn it cannot finish.
       *
       * The paid API stays out. It is a deliberate fallback rather than one
       * more free instance, and the chain saying so is the only way to say it.
       */
      if (!poolable(rung)) return rung;

      const pool: Rung[] = [];
      for (let ahead = index; ahead < chain.length && poolable(chain[ahead]); ahead++) {
        if (!exclude.has(chain[ahead]) && this.up(chain[ahead]) && inTime(chain[ahead])) pool.push(chain[ahead]);
      }
      if (pool.length <= 1) return rung;

      /**
       * Take it in turns, when the operator has asked for that.
       *
       * Opt-in, and deliberately so: the ranking below is the right default for
       * somebody with three endpoints who wants the quickest answer, and the
       * wrong one for somebody with ten free tiers who wants all ten spent. See
       * `MAFIA_API_SPREAD` for the measurement that made the difference obvious
       * — ten live endpoints on the deployment box, four of them ever asked.
       *
       * The first N slots are the working set and everything past them is
       * reserve, reached only when the working set is saturated. Within the set:
       * least busy first, because an endpoint already working is the one real
       * reason not to ask it; then **least recently used**, which is the part
       * that actually spreads the load, since with one call in flight per
       * endpoint every idle one ties on busyness and rotation is the only
       * tie-break that reaches all of them; then speed, for the cold start,
       * where nothing has a turn yet and the quick one may as well go first.
       */
      const spread = this.config.spread;
      if (spread > 0) {
        const working = pool.filter((entry) => {
          const slot = apiIndex(entry);
          return slot > 0 && slot <= spread;
        });
        const field = working.length > 0 ? working : pool;
        const leastBusy = Math.min(...field.map((entry) => this.busyOn.get(entry) ?? 0));
        const free = field.filter((entry) => (this.busyOn.get(entry) ?? 0) === leastBusy);
        const longestAgo = Math.min(...free.map((entry) => this.usedAt.get(entry) ?? 0));
        const due = free.filter((entry) => (this.usedAt.get(entry) ?? 0) === longestAgo);
        return due.sort((left, right) => this.score(left) - this.score(right))[0] ?? rung;
      }

      /**
       * Who is close enough to the best to be worth asking.
       *
       * Two rules, and both matter. **An endpoint nobody has tried yet is
       * always a candidate**, or the first one to answer quickly takes every
       * call for the rest of the evening and the other twenty-one are never
       * measured — which is not a preference for the fast, it is a refusal to
       * look. And the window is absolute as well as proportional: a hundred
       * milliseconds between two endpoints is nothing to a table, so everything
       * within a quarter second of the best shares the work. Only an endpoint
       * that is genuinely slower falls out, and even then only while a better
       * one has room.
       */
      const best = Math.min(...pool.map((entry) => this.score(entry)));
      /**
       * Wide enough that "fast enough" means what it says.
       *
       * This was a quarter of a second past the best, which is a tighter tolerance
       * than a table can perceive and it collapsed the whole chain onto one
       * endpoint. Measured over fourteen games on ten configured slots: the
       * quickest healthy endpoint answered 252 of the 372 successful calls, and
       * the next one down — 280ms slower, well inside what anybody would call
       * fast — took 87. Eight other endpoints, each with its own free daily
       * allowance, shared the remainder.
       *
       * An allowance nobody spends is not saved, it expires, and the reason to
       * configure ten endpoints is to have ten. So the window is what a person
       * would accept rather than what a stopwatch prefers, and the *ordering*
       * inside it is still least-busy-first: when the quickest is free it takes
       * the call, and the only time a slower one is asked is when there is
       * genuinely more work in flight than the quick ones can hold. That is the
       * "when it makes sense" part — the spread follows the concurrency rather
       * than being imposed on it.
       */
      const window = Math.max(best * 2.5, best + 1200);
      const close = pool.filter((entry) => (this.health.get(entry)?.ok ?? 0) === 0 || this.score(entry) <= window);
      const quietest = Math.min(...close.map((entry) => this.busyOn.get(entry) ?? 0));
      const idle = close.filter((entry) => (this.busyOn.get(entry) ?? 0) === quietest);
      /**
       * And among the idle, the quickest — not the one that has waited longest.
       *
       * Rotating here was tried and is wrong, which a test caught immediately:
       * with nothing in flight every endpoint ties on busyness, so least
       * recently used walks the whole field and the ranking stops being a
       * ranking. That is what `MAFIA_API_SPREAD` is for, and it is opt-in
       * precisely because it is not the right default.
       *
       * The spread comes from the two rules above instead, and it comes from
       * the table's own shape: a dozen seats think at once, one call in flight
       * per endpoint, so the quick ones are busy most of the time and the work
       * reaches the rest of the field by itself. When there is a single call to
       * make there is no reason to ask anybody but the best, and a widened
       * window must not turn that into a lottery.
       */
      return idle.sort((left, right) => this.score(left) - this.score(right))[0] ?? rung;
    }
    return null;
  }

  /** Is this rung reachable, not benched, and not already full? */
  private up(rung: Rung): boolean {
    if (rung === 'scripted') return false;
    if ((this.benched.get(rung) ?? 0) > Date.now()) return false;
    // The local daemon is there and has a model, or the endpoint can be asked at all.
    if (this.transport.ready && !this.transport.ready(rung)) return false;
    /**
     * A rung already answering as many questions as it can take is not up.
     *
     * This was one counter for the whole driver, sized off whichever rung
     * happened to be first, which is the wrong shape as soon as there is more
     * than one endpoint: four calls in flight to Groq left three other
     * configured providers idle and sent every other seat to the phrasebook.
     */
    return (this.busyOn.get(rung) ?? 0) < this.parallel(rung);
  }

  /**
   * What one call to this rung is expected to cost, in milliseconds.
   *
   * A moving average of the calls that worked, multiplied by how badly it has
   * been behaving lately. An endpoint nobody has tried yet gets an optimistic
   * prior, because the only way to find out is to ask it, and one slow answer
   * is a cheap way to learn.
   */
  private score(rung: Rung): number {
    const seen = this.health.get(rung);
    if (!seen || seen.ok === 0) return UNTRIED_SCORE_MS;
    return seen.ms * (1 + seen.streak);
  }

  /** One call's worth of evidence about a rung. */
  private note(rung: Rung, ms: number, ok: boolean): void {
    const seen = this.health.get(rung) ?? { ms: UNTRIED_SCORE_MS, ok: 0, bad: 0, streak: 0 };
    if (ok) {
      // Weighted towards the recent, because a free tier's mood changes hourly.
      seen.ms = seen.ok === 0 ? ms : seen.ms * 0.7 + ms * 0.3;
      seen.ok++;
      seen.streak = 0;
    } else {
      seen.bad++;
      seen.streak = Math.min(seen.streak + 1, 4);
    }
    this.health.set(rung, seen);
  }

  /** What each rung has done for this process, for the log and the recorder. */
  /** How each rung has behaved this run, in chain order. Diagnostics. */
  scoreboard(): { rung: string; model: string; ms: number; ok: number; bad: number; busy: number }[] {
    return this.chain.map((rung) => {
      const seen = this.health.get(rung);
      return {
        rung,
        model: this.transport.model(rung),
        ms: Math.round(seen?.ms ?? 0),
        ok: seen?.ok ?? 0,
        bad: seen?.bad ?? 0,
        busy: this.busyOn.get(rung) ?? 0
      };
    });
  }

  /** How many questions one rung may be answering at once. */
  private parallel(rung: Rung): number {
    // One local GPU serialises anyway; queueing more only manufactures timeouts.
    if (rung === 'ollama') return this.config.localParallel;
    return this.config.apiParallel;
  }

  /**
   * The chain this kind of question walks.
   *
   * Not every question wants the same endpoint. Taking notes is the job where a
   * mistake is permanent — a misread claim goes on the board and stays there —
   * and it wants the strongest model on the list. Writing one line of chat is
   * the easy job and wants the fastest. Deciding sits between them. With one
   * shared chain those three compete for the same slot on the same endpoint,
   * and the only differentiation available was for the mouth to start one rung
   * down.
   *
   * Configured per errand when the operator cares, and derived from the single
   * chain when they do not, so the default behaviour is exactly what it was.
   */
  private chainFor(errand: Errand): Rung[] {
    return this.chains[errand] ?? this.chain;
  }

  /**
   * Sits a rung down, and says so once.
   *
   * For a minute, normally. Permanently when the endpoint has told us something
   * that a minute will not change — see `PERMANENT_REFUSALS` — because a chain
   * that keeps asking a dead slot is a chain that spends a table's afternoon
   * discovering the same 402 over and over.
   */
  private bench(rung: Rung, error: unknown): void {
    /**
     * Read structurally, not with `instanceof`.
     *
     * The error crosses a promise chain and a catch before it lands here, and
     * an identity check on a class is the kind of thing that passes in one
     * module and quietly fails once anything bundles, re-exports or duplicates
     * it — failing *open*, which here means never retiring a dead endpoint.
     * A number on a property is a number on a property wherever it came from.
     */
    const carried: unknown = (error as { status?: unknown } | undefined)?.status;
    const status = typeof carried === 'number' ? carried : undefined;
    const permanent = status !== undefined && PERMANENT_REFUSALS.has(status);
    /**
     * And a rung that keeps failing waits longer each time.
     *
     * A flat minute is the right answer for an endpoint having a bad moment and
     * the wrong one for an endpoint that is out of allowance for the evening.
     * The two are indistinguishable at the first 429 and obvious by the fifth,
     * and the cooldown was not looking: measured over fourteen games, two slots
     * answered zero calls successfully and were asked twenty-one and twenty-two
     * times, once a minute each, every one of them a round trip spent in front
     * of a seat waiting to speak.
     *
     * Doubling per consecutive failure, capped, and reset by a single success —
     * `note` already zeroes the streak when a call lands, so a tier that comes
     * back at midnight is back in the rotation on its first good answer. The
     * streak is the same one the score uses, so a rung on its way out is being
     * ranked down and backed off by the same evidence.
     */
    const streak = this.health.get(rung)?.streak ?? 0;
    const backoff = Math.min(this.config.cooldownMs * 2 ** Math.max(0, streak - 1), MAX_COOLDOWN_MS);
    const forMs = permanent ? Number.POSITIVE_INFINITY : backoff;

    if ((this.benched.get(rung) ?? 0) < Date.now()) {
      this.log.warn(
        { rung, err: error, forMs, permanent },
        permanent
          ? 'mafia bots: brain refused for good (key, quota or plan), dropping it for this run'
          : 'mafia bots: brain refused, dropping to the next one in the chain'
      );
    }
    this.benched.set(rung, permanent ? Number.POSITIVE_INFINITY : Date.now() + forMs);
  }

  /**
   * Down the chain, for any question at all.
   *
   * `attempt` is the generic version of what the bot turn needed: try the first
   * willing rung, and on a refusal bench it — which is what advances the chain,
   * because `nextRung` then returns the one below without this loop needing to
   * know the order — and try again. The ear uses the same walk with a completely
   * different question in it.
   */
  async walk<T>(
    attempt: (rung: Rung) => Promise<T>,
    context: Record<string, unknown>,
    errand: Errand = 'decide'
  ): Promise<{ value: T; model: string } | null> {
    // The mouth is on a shorter clock than a turn: see `MAFIA_BOT_SPEAK_MS`.
    const deadline = Date.now() + (errand === 'speak' ? this.config.speakMs : this.config.turnMs);
    /**
     * Where this errand starts its walk.
     *
     * One rung down for the mouth, but only while there is more than one API in
     * front of the local model — on a chain of `api1,ollama` skipping the API
     * would send every line to a twelve-second local call to save nothing.
     */
    const chain = this.chainFor(errand);
    const apis = chain.filter(isApiRung).length;
    // A chain written for this errand is already the operator's answer to where
    // it should start; only the derived one is second-guessed.
    const start = errand === 'speak' && apis >= 2 && !this.chains.speak ? 1 : 0;

    const forCode = typeof context.code === 'string' ? context.code : null;

    for (let round = 0; round < chain.length; round++) {
      const rung = this.nextRung(round === 0 ? start : 0, errand, EMPTY_RUNGS, deadline - Date.now());
      if (rung === null) {
        if (forCode)
          trace('mafia', forCode).event('chain', { ...context, errand, rung: 'scripted', reason: 'no rung up' });
        return null;
      }
      if (Date.now() >= deadline) {
        this.log.warn({ ...context, rung }, 'mafia bots: ran out of time, falling back');
        if (forCode) trace('mafia', forCode).event('chain', { ...context, errand, rung, reason: 'out of time' });
        return null;
      }

      /**
       * A second endpoint, when the first is taking too long.
       *
       * Free tiers are not slow on average, they are slow *sometimes*: the
       * median is a few hundred milliseconds and the tail is ten seconds, and
       * the tail is what a person at the table actually experiences, because it
       * lands after the moment it was about. Waiting out a bad draw is the one
       * thing there is no need to do when twenty other endpoints are idle.
       *
       * So if the first has not answered within the hedge, a second is asked
       * the same question in parallel and the first usable answer wins. It
       * costs one extra request on the slow tail only, which is exactly where
       * the spare capacity is. Never onto the local model: a second question to
       * one GPU queues behind the first and arrives later than doing nothing.
       */
      const hedgeMs = this.hedgeFor(errand, rung, deadline);
      const second = hedgeMs > 0 ? this.nextRung(0, errand, new Set([rung]), deadline - Date.now() - hedgeMs) : null;
      const hedged = second !== null && isApiRung(second);

      const first = this.attemptOn(rung, attempt, { ...context, errand, round }, forCode);
      let outcome = hedged ? await Promise.race([first, sleep(hedgeMs).then(() => 'waited' as const)]) : await first;

      if (outcome === 'waited' && second) {
        if (forCode) trace('mafia', forCode).event('hedge', { ...context, errand, slow: rung, alsoAsking: second });
        outcome = await firstUsable([
          first,
          this.attemptOn(second, attempt, { ...context, errand, round, hedge: true }, forCode)
        ]);
      }

      if (outcome !== 'waited' && outcome.ok) {
        /**
         * Which brain actually answered, said once per rung.
         *
         * Not vanity logging. The played brain and the model are deliberately
         * hard to tell apart from the outside — that is the point of the
         * fallback — which also means a silently benched API and a working one
         * look identical in the chat, and the only way to know a table is
         * running on the phrasebook is to recognise its lines. One line in the
         * log at first contact settles it.
         */
        this.lastAnswered = this.transport.model(outcome.rung);
        if (!this.answered.has(outcome.rung)) {
          this.answered.add(outcome.rung);
          this.log.info({ rung: outcome.rung, model: this.lastAnswered }, 'mafia bots: this brain is answering');
        }
        return { value: outcome.value, model: this.lastAnswered };
      }
    }

    return null;
  }

  /**
   * One question to one rung: the slot, the stopwatch, the bench.
   *
   * Never rejects. A refusal is an outcome like any other, because with a
   * hedge in flight there are two of these racing and a rejection from the
   * loser must not become the walk's answer — nor an unhandled rejection.
   *
   * The slot is taken here rather than inside the transport, because this is
   * the scope that matches the endpoint's own idea of a request: one attempt,
   * one slot, released whatever happens. `nextRung` reads the same counter, so
   * the walk moves to a different provider rather than queueing on a busy one,
   * which is the whole of "several endpoints at once".
   */
  private attemptOn<T>(
    rung: Rung,
    attempt: (rung: Rung) => Promise<T>,
    context: Record<string, unknown>,
    code: string | null
  ): Promise<{ ok: true; rung: Rung; value: T } | { ok: false; rung: Rung }> {
    this.busyOn.set(rung, (this.busyOn.get(rung) ?? 0) + 1);
    this.usedAt.set(rung, ++this.turn);
    const started = Date.now();
    return attempt(rung)
      .then((value) => {
        this.note(rung, Date.now() - started, true);
        return { ok: true as const, rung, value };
      })
      .catch((error: unknown) => {
        this.note(rung, Date.now() - started, false);
        // Benching is the step: `nextRung` skips this one on the way round.
        if (code) {
          trace('mafia', code).event('chain', {
            ...context,
            rung,
            benched: true,
            ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.bench(rung, error);
        return { ok: false as const, rung };
      })
      .finally(() => {
        this.busyOn.set(rung, Math.max(0, (this.busyOn.get(rung) ?? 1) - 1));
      });
  }

  /**
   * How long to wait before asking somebody else the same question.
   *
   * Zero when there is nothing to gain: hedging off, the local model (one GPU,
   * so a second question queues), or a deadline too close to fit two answers.
   *
   * The same wait for every errand, including note-taking. It is tempting to
   * let the ear take its time on the grounds that it is the bigger question,
   * and it is exactly backwards: the ear is what turns a person's sentence into
   * something the table can act on, so it is the one call a person is actually
   * waiting for, and an answer that arrives after the argument moved on is
   * worth no more than no answer at all.
   */
  private hedgeFor(_errand: Errand, rung: Rung, deadline: number): number {
    const hedge = this.config.hedgeMs;
    if (hedge === 0 || !isApiRung(rung)) return 0;
    return deadline - Date.now() > hedge + 1500 ? hedge : 0;
  }

  /**
   * One question to one rung, whatever the question is, written down either way.
   *
   * The recorder sits here rather than in each transport because this is the
   * one place that sees the request, the rung and the answer together. What it
   * writes is the whole of a call: which brain, which model, how long it took,
   * what it was asked and what came back — or, when nothing came back, the
   * status that explains why. Without that, a table that reads as sullen and a
   * table whose chain is quietly 429ing look the same from the outside, which
   * is exactly the confusion this driver's own fallback is designed to create.
   */
  async askOn(rung: Rung, request: Ask, context: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const started = Date.now();
    const code = typeof context.code === 'string' ? context.code : null;
    const log = code ? trace('mafia', code) : null;
    try {
      const answer = await this.transport.ask(rung, request);
      log?.event('llm', {
        ...context,
        rung,
        model: this.transport.model(rung),
        ms: Date.now() - started,
        ok: true,
        maxTokens: request.maxTokens,
        systemBytes: request.system.length,
        prompt: request.user,
        answer
      });
      return answer;
    } catch (error) {
      log?.event('llm', {
        ...context,
        rung,
        model: this.transport.model(rung),
        ms: Date.now() - started,
        ok: false,
        status: (error as { status?: number } | undefined)?.status ?? null,
        error: error instanceof Error ? error.message : String(error),
        prompt: request.user
      });
      throw error;
    }
  }

  /**
   * Asks the chain one question and hands back whatever JSON came out.
   *
   * The public seam for everything that is not a bot turn. `null` means nothing
   * answered, which every caller has to have a plan for — the whole design of
   * this driver is that the game continues perfectly well when it does.
   */
  async ask(
    request: Ask,
    context: Record<string, unknown>,
    errand: Errand = 'decide'
  ): Promise<{ value: Record<string, unknown>; model: string } | null> {
    return this.walk((rung) => this.askOn(rung, request, { ...context, errand }), context, errand);
  }
}
