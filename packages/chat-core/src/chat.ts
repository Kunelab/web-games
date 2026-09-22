import type { Msg } from 'i18n';

/**
 * A chat is a flat log of messages tagged with a channel; who may read or write
 * a channel is the game's business, expressed as a `ChannelRules` object the
 * game passes in. The log itself knows nothing about roles, phases or factions,
 * which is what lets CoronaZ, Mafia and whatever comes next share it.
 *
 * Everything here is pure data-in data-out: the state is a plain serialisable
 * object living inside the game's own state, so it persists and restores with
 * the game for free. Transport (socket.io, REST, bots) is the caller's problem.
 */

export type ChatKind = 'text' | 'system' | 'emote';

export interface ChatMessage {
  id: number;
  channel: string;
  /** Null when the game itself speaks (deaths, verdicts, phase changes). */
  authorId: string | null;
  authorName: string;
  kind: ChatKind;
  /**
   * What a *person* typed. Empty for a system message, which carries `msg`
   * instead — the server never renders prose it would have to pick a language
   * for. See `i18n`'s header for why that decision runs this way round.
   */
  text: string;
  /**
   * The game's own voice, as a key and its parameters.
   *
   * Present exactly when `kind === 'system'`. Each client renders it in the
   * reader's language; the server renders it only for the two consumers that are
   * not a reader — LLM bot prompts and the headless simulator's transcript.
   */
  msg?: Msg;
  /** Epoch milliseconds, supplied by the caller so tests stay deterministic. */
  at: number;
  /**
   * This line gives away an identity.
   *
   * Set by the game on its own announcements — a dawn report, a verdict, a last
   * will, the closing roster. It exists so a *shared* surface (a television in
   * the room, a recording) can hold those lines back without any screen having to
   * pattern-match French prose to guess which ones matter. The game knows; it
   * says so here.
   */
  reveals?: boolean;
}

/**
 * How much of each channel survives.
 *
 * One global ring was the wrong shape. A deduction game's public square *is* its
 * evidence — the dawn reports, the verdicts, who turned out to be what — and it
 * was sharing a 500-message budget with two family rooms, a lodge, a graveyard,
 * a cell and one whisper thread per pair of players. Twenty-four phones at the
 * rate limit put twelve messages a second into that budget, so a single busy day
 * evicted the whole history of the game, and a family spamming its own private
 * channel could delete the town's record on purpose.
 *
 * Retention is therefore per channel, and *within* a channel the game's own
 * announcements are counted separately from the chatter. That second split is
 * the one that matters: table talk is meant to scroll away, a death notice is
 * not, and letting them compete for one allowance is what lost the record.
 */
export interface Retention {
  /** Kept per channel, for spoken messages and announcements separately. */
  perChannel: number;
  /** Channels that deserve a bigger allowance than the default — the square. */
  channels?: Record<string, number>;
  /** Backstop on the whole log: channel count is unbounded (one per whisper). */
  total: number;
}

export const DEFAULT_RETENTION: Retention = { perChannel: 60, total: 900 };

export interface ChatState {
  nextId: number;
  messages: ChatMessage[];
  /** Persisted with the game, so a restored table keeps its own policy. */
  retention?: Retention;
}

/**
 * Visibility is asked per member and per channel, never per message: a member
 * who may read a channel reads all of it. `ctx` is whatever the game needs to
 * answer (its own state, typically) — the chat never looks inside it.
 */
export interface ChannelRules<Ctx> {
  canRead(channel: string, memberId: string, ctx: Ctx): boolean;
  canWrite(channel: string, memberId: string, ctx: Ctx): boolean;
}

export interface PostLimits {
  /** Longest accepted message, in characters, after trimming. */
  maxLength: number;
  /** How many messages one author may post within `windowMs`. */
  burst: number;
  windowMs: number;
}

export const DEFAULT_LIMITS: PostLimits = { maxLength: 400, burst: 5, windowMs: 10_000 };

export function createChat(retention?: Partial<Retention>): ChatState {
  return {
    nextId: 1,
    messages: [],
    retention: retention ? { ...DEFAULT_RETENTION, ...retention } : undefined
  };
}

/**
 * Why a message did not go up, twice over: once as a French sentence for the
 * screens that still print it, once as a stable identifier for the ones that
 * localise. A caller that renders its own words reads `reason` and leaves
 * `error` alone.
 */
export type PostRefusal = 'empty' | 'tooLong' | 'flood';

export type PostResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; error: string; reason: PostRefusal };

export interface PostInput {
  channel: string;
  authorId: string;
  authorName: string;
  text: string;
  at: number;
  kind?: ChatKind;
  limits?: PostLimits;
}

/**
 * Appends a member's message after the cheap universal checks. Whether this
 * author may write to this channel right now is checked by the caller against
 * its own rules — the game knows, the log does not.
 */
export function post(state: ChatState, input: PostInput): PostResult {
  const limits = input.limits ?? DEFAULT_LIMITS;
  // Collapse whitespace runs so one key held down is not a wall of text.
  const text = input.text.replace(/\s+/g, ' ').trim();

  if (!text) return { ok: false, error: 'Message vide', reason: 'empty' };
  if (text.length > limits.maxLength) return { ok: false, error: 'Message trop long', reason: 'tooLong' };

  const windowStart = input.at - limits.windowMs;
  const recent = state.messages.filter(
    (message) => message.authorId === input.authorId && message.at >= windowStart
  ).length;
  if (recent >= limits.burst) return { ok: false, error: 'Doucement — trop de messages', reason: 'flood' };

  const message: ChatMessage = {
    id: state.nextId++,
    channel: input.channel,
    authorId: input.authorId,
    authorName: input.authorName,
    kind: input.kind ?? 'text',
    text,
    at: input.at
  };
  state.messages.push(message);
  trim(state);
  return { ok: true, message };
}

/**
 * The game's own voice: announcements, verdicts, dawn reports. Never rate limited.
 *
 * Takes a `Msg`, not a string. That is the whole localisation contract in one
 * signature — there is no way to put an untranslatable sentence into the log,
 * because the parameter will not accept one.
 */
/**
 * A line the game says *in somebody's voice*, rather than in its own.
 *
 * Almost everything the engine writes is the square talking: no author, grey,
 * italic. This is the exception, and there is one of it — the sentence a gagged
 * seat gets said for it when it is dragged to the stand. That is not the game
 * narrating, it is the accused answering, and it read as narration because it
 * was posted as narration: a system line, in quotation marks, with the name
 * folded into the sentence.
 *
 * Carries a `Msg` rather than text, like the system lines do, because the
 * words still belong to the reader's language; it simply carries an author
 * with them. Renderers show `text` first and fall back to the key, so a line
 * with an author and no text comes out looking exactly like somebody typed it.
 */
export function voicePost(
  state: ChatState,
  channel: string,
  author: { id: string; name: string },
  message_: Msg,
  at: number
): ChatMessage {
  const message: ChatMessage = {
    id: state.nextId++,
    channel,
    authorId: author.id,
    authorName: author.name,
    kind: 'text',
    text: '',
    msg: message_,
    at
  };
  state.messages.push(message);
  trim(state);
  return message;
}

export function systemPost(
  state: ChatState,
  channel: string,
  message_: Msg,
  at: number,
  options?: { reveals?: boolean }
): ChatMessage {
  const message: ChatMessage = {
    id: state.nextId++,
    channel,
    authorId: null,
    authorName: '',
    kind: 'system',
    text: '',
    msg: message_,
    at,
    ...(options?.reveals ? { reveals: true as const } : {})
  };
  state.messages.push(message);
  trim(state);
  return message;
}

/** Everything this member may read, in posting order. */
export function visibleTo<Ctx>(
  state: ChatState,
  memberId: string,
  ctx: Ctx,
  rules: ChannelRules<Ctx>
): ChatMessage[] {
  const readable = new Map<string, boolean>();
  return state.messages.filter((message) => {
    let allowed = readable.get(message.channel);
    if (allowed === undefined) {
      allowed = rules.canRead(message.channel, memberId, ctx);
      readable.set(message.channel, allowed);
    }
    return allowed;
  });
}

/**
 * Drops the oldest of whatever is over its allowance, bucket by bucket.
 *
 * A bucket is one channel's spoken messages or one channel's announcements —
 * never both together, so chatter cannot push the record out. Counted from the
 * newest backwards, which is the only direction that answers "is this message
 * still within the last N of its kind" in one pass.
 */
function trim(state: ChatState): void {
  const policy = state.retention ?? DEFAULT_RETENTION;
  const kept = new Set<number>();
  const seen = new Map<string, number>();

  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (!message) continue;
    const cap = policy.channels?.[message.channel] ?? policy.perChannel;
    const bucket = `${message.channel} ${message.kind === 'system' ? 'said-by-the-game' : 'said'}`;
    const count = seen.get(bucket) ?? 0;
    if (count < cap) {
      seen.set(bucket, count + 1);
      kept.add(index);
    }
  }

  if (kept.size < state.messages.length) {
    state.messages = state.messages.filter((_, index) => kept.has(index));
  }

  // The backstop, in case a table opens more channels than the policy imagined.
  if (state.messages.length > policy.total) {
    state.messages.splice(0, state.messages.length - policy.total);
  }
}
