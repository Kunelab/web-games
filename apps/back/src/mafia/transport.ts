import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';

import { apiSlots, env, type ApiSlot } from '../env.js';
import { isApiRung, RungError, type Ask, type Rung, type Transport } from './chain.js';

/**
 * How the brain chain reaches the real models, over HTTP.
 *
 * Three kinds of endpoint: OpenAI-compatible slots, a local Ollama daemon, and
 * the Claude API. "OpenAI-compatible" covers the message shape and stops
 * there, so most of this file is learning, once per slot and per question, the
 * request each one actually understands. The chain itself (which rung, when to
 * give up) is in `chain.ts` and never sees a request or a response.
 */

/**
 * Small chat models worth reaching for, best first.
 *
 * Ollama's list is whatever somebody happened to pull, and "smallest" alone
 * picks an embedding model or a code-completion stub over a model that can hold
 * a conversation. This is the preference order among *installed* tags: a recent
 * Qwen first because that family is the one this prompt was tuned against, then
 * the other small instruction-followers, and only then whatever else is there.
 */
const LOCAL_PREFERENCE = [
  'qwen3.5',
  'qwen3',
  'qwen2.5',
  'llama3.2',
  'llama3.1',
  'mistral',
  'phi4',
  'phi3',
  'gemma3',
  'gemma2'
];

/**
 * Ways of asking an endpoint not to think, in the order they are tried.
 *
 * "OpenAI-compatible" covers the message shape and stops there. Suppressing a
 * reasoning model's deliberation is where they all diverge, and it is not a
 * nicety — a reasoning model handed a 300-token budget spends the lot narrating
 * its plan and returns `content: ""`, which costs a request from a daily quota
 * to discover and looks exactly like a broken endpoint.
 *
 * Measured, one call each:
 *   OpenRouter          `reasoning: {enabled: false}`  ✓   (400s on Groq)
 *   Groq gpt-oss        `reasoning_effort: 'low'`      ✓   95 tokens, 577ms
 *   Groq qwen3.6        `reasoning_effort: 'none'`     ✓   ('low' is refused:
 *                                                          must be none|default)
 *   Groq compound-mini  nothing at all                 ✓   (refuses both keys)
 *
 * So there is no single right answer, only a right answer per endpoint — and
 * asking bare is not a safe default either: gpt-oss-20b and qwen3.6 both
 * answered `json_validate_failed` without a reasoning setting and answered
 * correctly with one.
 */
const QUIET_FORMS: Record<string, unknown>[] = [
  { reasoning: { enabled: false } },
  { reasoning_effort: 'low' },
  { reasoning_effort: 'none' },
  {}
];

/**
 * Every request shape worth trying, best first.
 *
 * Two axes, and they fail the same way — a 400 — so they are walked as one list
 * rather than as two nested searches.
 *
 * The first axis is how to ask a reasoning model to be quiet; see `QUIET_FORMS`.
 * The second is how hard to ask for the answer's shape, and it is the one that
 * was missing. `json_object` means "valid JSON" and stops there: asked that
 * loosely, gpt-oss-120b read four lines of a village square perfectly and
 * answered with a bare `[{"type": "accuse", "about": 5}, …]` — no wrapper, no
 * speaker, no `kind`. `extractJson` drops arrays on the floor, so every one of
 * those answers was binned unread and the ear filed nothing from the two
 * fastest rungs in the chain, on every pass, for the life of the deployment.
 *
 * `json_schema` with `strict` is the same question asked properly, and the
 * same three models went from nothing filed to every claim filed. Not every
 * endpoint supports it, which is what the fallback half of this list is for.
 */
const REQUEST_SHAPES: { schema: boolean; quiet: Record<string, unknown> }[] = [
  ...QUIET_FORMS.map((quiet) => ({ schema: true, quiet })),
  ...QUIET_FORMS.map((quiet) => ({ schema: false, quiet }))
];

/**
 * "I do not know what you just sent me", in the two dialects it is said in.
 *
 * Both mean the same thing and both mean try the next shape: Groq says 400 for
 * an unsupported `reasoning` key, Mistral says 422 for the same key under the
 * name `extra_forbidden`. Measured, on a live key for each.
 */
const UNDERSTOOD_NOTHING = new Set([400, 422]);

/** How long a local-brain probe is trusted before it is asked again. */
const PROBE_EVERY_MS = 3 * 60 * 1000;

/** What the HTTP transport needs to know: where the endpoints are and what to ask them for. */
export interface HttpConfig {
  slots: readonly ApiSlot[];
  ollamaUrl: string;
  /** The local model asked for, which may not be the one installed. */
  localModel: string;
  anthropicKey: string | undefined;
  anthropicModel: string;
}

/** This deployment's endpoints. */
export function httpConfig(): HttpConfig {
  return {
    slots: apiSlots,
    ollamaUrl: env.OLLAMA_URL,
    localModel: env.MAFIA_BOT_MODEL,
    anthropicKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.MAFIA_BOT_MODEL_ANTHROPIC
  };
}

export class HttpTransport implements Transport {
  /**
   * Which `REQUEST_SHAPES` entry this slot accepts, once we have found out.
   *
   * Learned on first contact and kept for the life of the process: the cascade
   * costs a few wasted requests exactly once, and one request per decision
   * thereafter. Not configuration, because getting it wrong is silent and the
   * endpoint already knows the answer.
   *
   * Keyed by the question as well as the slot, because the answer differs by
   * question. Measured on Groq: `gpt-oss-20b` satisfies the ear's schema and
   * `gpt-oss-120b` does not — it answers, and the endpoint rejects its own
   * model's output with "Generated JSON does not match the expected schema".
   * The same 120b handles the mouth's one-string schema without complaint. One
   * verdict per slot would have the ear teach the mouth to stop asking
   * properly, and the mouth teach the ear to start again, for as long as the
   * process lived.
   */
  private readonly dialect = new Map<string, number>();
  /**
   * Whether the local brain is actually there, and which tag it answers to.
   *
   * `null` while the first probe is in flight, `false` once we know there is
   * nothing listening. A machine with no Ollama on it used to fail one HTTP
   * call per bot turn — every seat waiting out a connection refusal before
   * falling back — so a table of eight bots spent its day phase timing out.
   * Asked once, remembered, re-asked occasionally in case somebody starts the
   * daemon mid-evening.
   */
  private localModel: string | null | false = null;
  private probedAt = 0;
  private readonly anthropic: Anthropic | null;
  private readonly slots: ReadonlyMap<Rung, ApiSlot>;
  private readonly ollamaUrl: string;
  private readonly localWanted: string;
  private readonly anthropicModel: string;

  constructor(
    config: HttpConfig,
    private readonly log: FastifyBaseLogger
  ) {
    this.slots = new Map(config.slots.map((slot) => [slot.rung, slot]));
    this.ollamaUrl = config.ollamaUrl;
    this.localWanted = config.localModel;
    this.anthropicModel = config.anthropicModel;
    this.anthropic = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;
  }

  /**
   * Whether a rung can be asked right now. Only the local daemon can be absent:
   * a stale probe is refreshed in the background and this answers from what it
   * already knows, so it never blocks.
   */
  ready(rung: Rung): boolean {
    if (rung !== 'ollama') return true;
    if (Date.now() - this.probedAt > PROBE_EVERY_MS) void this.probe();
    return typeof this.localModel === 'string';
  }

  ask(rung: Rung, request: Ask): Promise<Record<string, unknown>> {
    if (rung === 'ollama') return this.ollamaAsk(request);
    if (isApiRung(rung)) return this.openAiAsk(request, rung);
    return this.anthropicAsk(request);
  }

  /** Which model a rung actually calls, so a misconfiguration is audible. */
  model(rung: Rung): string {
    if (rung === 'anthropic') return this.anthropicModel;
    if (isApiRung(rung)) return this.slots.get(rung)?.model ?? 'unconfigured';
    if (rung === 'ollama') return typeof this.localModel === 'string' ? this.localModel : this.localWanted;
    return 'none';
  }

  /**
   * Is there a local model on this machine, and what is it called?
   *
   * Ollama lists what it has pulled, so the configured tag is a *preference*
   * rather than a requirement: a mini PC that pulled `qwen3:1.7b` instead of
   * the default should still get talking bots, and a machine with
   * nothing pulled at all should fall through to the played brain instantly
   * rather than discovering the fact eight times a minute.
   *
   * Re-probed every few minutes and never awaited on a decision path: a turn
   * that arrives before the first answer plays the sim brain, which is exactly
   * what it would have done anyway.
   */
  private async probe(): Promise<void> {
    this.probedAt = Date.now();
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) throw new Error(`ollama ${response.status}`);

      const body = (await response.json()) as { models?: { name?: string; size?: number }[] };
      const installed = (body.models ?? [])
        .map((entry) => ({ name: entry.name ?? '', size: entry.size ?? Number.MAX_SAFE_INTEGER }))
        .filter((entry) => entry.name.length > 0);

      if (installed.length === 0) {
        if (this.localModel !== false) this.log.info({}, 'mafia bots: ollama is up but has no model pulled');
        this.localModel = false;
        return;
      }

      /**
       * The configured tag if it is there; otherwise the best small chat model
       * that is; otherwise the smallest thing on the box.
       *
       * "Smallest" alone was too blunt — it would happily pick an embedding
       * model over a Qwen. So a known family wins first (see `LOCAL_PREFERENCE`,
       * which leads with the Qwen line this prompt was tuned against), and
       * within a family the smaller tag wins, because on a box with no GPU a
       * seat that answers in four seconds is worth more to a live table than a
       * cleverer one that answers in forty.
       */
      const wanted = this.localWanted;
      const exact = installed.find(
        (entry) => entry.name === wanted || entry.name.startsWith(`${wanted}:`) || `${entry.name}:latest` === wanted
      );

      const bySize = [...installed].sort((left, right) => left.size - right.size);
      const preferred = LOCAL_PREFERENCE.flatMap((family) =>
        bySize.filter((entry) => entry.name.toLowerCase().startsWith(family))
      )[0];

      const chosen = (exact ?? preferred ?? bySize[0]).name;

      if (this.localModel !== chosen) {
        this.log.info(
          { model: chosen, wanted, installed: installed.length, fallback: !exact },
          exact
            ? 'mafia bots: local model ready'
            : 'mafia bots: configured model is not pulled, using the smallest installed one'
        );
      }
      this.localModel = chosen;
    } catch {
      if (this.localModel !== false) {
        this.log.info({ url: this.ollamaUrl }, 'mafia bots: no local model reachable, playing the simulator brain');
      }
      this.localModel = false;
    }
  }

  private async ollamaAsk(request: Ask): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 45_000);

    const send = async (extras: Record<string, unknown>): Promise<Response> =>
      fetch(`${this.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model('ollama'),
          stream: false,
          // No thinking to leave room for, so this only has to hold one answer.
          options: { temperature: request.temperature ?? 0.8, num_predict: request.maxTokens + 100 },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user }
          ],
          ...extras
        })
      });

    try {
      /**
       * Asked twice at most, and the second time asks for less.
       *
       * `think` and `format` are both recent additions, and an Ollama that
       * predates either rejects the whole request rather than ignoring the key
       * it does not know — which failed every call on an otherwise perfectly
       * good local install, indistinguishably from having no Ollama at all.
       * The shape is restated in words in the system prompt anyway, so the
       * bare request still produces a usable answer.
       */
      let response = await send({ format: request.format, think: false });
      if (response.status === 400) response = await send({});
      if (!response.ok) throw new Error(`ollama ${response.status}`);

      const payload = (await response.json()) as { message?: { content?: string } };
      return orRefuse('ollama', extractJson(payload.message?.content ?? ''));
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Anything that speaks `/chat/completions`.
   *
   * One client for Groq, Cerebras, OpenRouter, Together and a vLLM you host
   * yourself, because they all agreed on the same shape years ago. The free
   * tiers differ only in how soon they say 429 — which the chain handles by
   * benching the rung and moving down, rather than by knowing anything about
   * any particular one of them.
   *
   * The answer's shape is asked for as strictly as the endpoint will allow —
   * `json_schema` where it is understood, `json_object` where it is not — and
   * `extractJson` still copes with what comes back. It used to ask only the
   * loose way, and being relaxed about the shape cost every answer from the
   * models that took the invitation; see `REQUEST_SHAPES`.
   */
  private async openAiAsk(request: Ask, rung: Rung): Promise<Record<string, unknown>> {
    const slot = this.slots.get(rung);
    if (!slot) throw new RungError(`${rung} unconfigured`);

    const send = async (shape: (typeof REQUEST_SHAPES)[number]): Promise<Response> =>
      fetch(`${slot.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${slot.key}` },
        signal: AbortSignal.timeout(request.timeoutMs ?? 20_000),
        body: JSON.stringify({
          model: slot.model,
          temperature: request.temperature ?? 0.8,
          max_tokens: request.maxTokens,
          response_format: shape.schema
            ? {
                type: 'json_schema',
                json_schema: { name: request.formatName ?? 'answer', strict: true, schema: request.format }
              }
            : { type: 'json_object' },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user }
          ],
          ...shape.quiet
        })
      });

    /**
     * Find the dialect this slot speaks for this question, then keep speaking it.
     *
     * A shape that is not understood comes back 400 or 422 — an unsupported
     * reasoning key and an unsatisfiable schema alike — so walking forward on
     * either is the whole search. It runs once per slot per question; from then
     * on `dialect` sends the request that worked and a call costs one round
     * trip like any other.
     *
     * 422 is in there because Mistral answers `422 extra_forbidden` where Groq
     * answers 400, for the identical complaint: a body key it does not know.
     * Walking forward on 400 alone, the search read that as a real failure and
     * gave up on the whole endpoint at the first quiet form — so a working key
     * with a perfectly good model behind it looked like a dead rung.
     */
    const asked = `${rung}:${request.formatName ?? 'answer'}`;
    /**
     * The remembered shape first, then the whole list from the top.
     *
     * The search used to resume at the shape *after* the remembered one, which
     * is the right order only for the first walk. A slot whose model has been
     * swapped under us starts refusing what it used to accept, and everything
     * better than that shape sits in front of it in the list: the strict schema
     * forms are the front half of `REQUEST_SHAPES` precisely because they are
     * the ones worth asking for. Resuming past them meant a slot that once
     * settled on a loose `json_object` could never be asked properly again, for
     * the life of the process, even after the endpoint had learned how.
     */
    const remembered = this.dialect.get(asked);
    const order =
      remembered === undefined
        ? REQUEST_SHAPES.map((_, index) => index)
        : [remembered, ...REQUEST_SHAPES.map((_, index) => index).filter((index) => index !== remembered)];

    let response: Response | null = null;
    for (const form of order) {
      response = await send(REQUEST_SHAPES[form]);
      if (!UNDERSTOOD_NOTHING.has(response.status)) {
        if (this.dialect.get(asked) !== form) {
          this.dialect.set(asked, form);
          this.log.info(
            { rung, model: slot.model, schema: REQUEST_SHAPES[form].schema, quiet: REQUEST_SHAPES[form].quiet },
            'mafia bots: endpoint dialect learned'
          );
        }
        break;
      }
      // A remembered form that has started refusing is no longer remembered:
      // the model behind a slot can be changed under us.
      if (form === remembered) this.dialect.delete(asked);
    }

    if (!response) throw new RungError(`${rung} no usable request shape`);
    if (!response.ok) throw new RungError(`${rung} ${response.status}`, response.status);

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    // OpenRouter reports upstream failures as a 200 with an error body, so the
    // status here is deliberately absent: it is a transient provider problem,
    // not a verdict on the key.
    if (payload.error) throw new RungError(`${rung}: ${payload.error.message ?? 'upstream error'}`);
    return orRefuse(rung, extractJson(payload.choices?.[0]?.message?.content ?? ''));
  }

  private async anthropicAsk(request: Ask): Promise<Record<string, unknown>> {
    if (!this.anthropic) return {};
    const response = await this.anthropic.messages.create(
      {
        model: this.anthropicModel,
        max_tokens: request.maxTokens,
        // The whole system message is stable per kind of question, so the cache
        // marker goes on all of it rather than on a hand-picked prefix of it.
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: request.user }],
        tools: [{ name: 'answer', description: 'Your answer.', input_schema: request.format as never }],
        tool_choice: { type: 'tool', name: 'answer' }
      },
      request.timeoutMs ? { timeout: request.timeoutMs } : undefined
    );
    const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    return (toolUse?.input ?? {}) as Record<string, unknown>;
  }
}

/**
 * An answer, or a refusal — never silence dressed as an answer.
 *
 * `attemptOn` calls a rung successful on any promise that *resolves*; it never
 * looks at the value. So a rung that answers 200 with a shape `extractJson`
 * cannot read returns `{}`, the walk counts that as the answer, and the rungs
 * below it are never asked at all. One endpoint returning bare arrays turns
 * into the whole chain filing nothing, which is exactly what it looked like
 * when `json_object` was the only shape ever requested: the ear "worked",
 * every pass, and produced no claims.
 *
 * `{}` is never a real answer here. Every schema this file asks for has a
 * required property, so an empty object means the extraction failed, not that
 * the model had nothing to say — "nobody asserted anything" is `{claims: []}`,
 * which has a key and passes.
 */
function orRefuse(rung: Rung, parsed: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(parsed).length === 0) throw new RungError(`${rung} unreadable answer`);
  return parsed;
}

/**
 * Reads a decision out of whatever a small model actually produced: clean
 * JSON, a ```json fence, or JSON buried in chatter. Anything else is an empty
 * decision — the scripted brain covers it.
 */
function extractJson(content: string): Record<string, unknown> {
  const candidates = [content, /```(?:json)?\s*([\s\S]*?)```/.exec(content)?.[1], /\{[\s\S]*\}/.exec(content)?.[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next shape.
    }
  }
  return {};
}
