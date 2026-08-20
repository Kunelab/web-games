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
  text: string;
  /** Epoch milliseconds, supplied by the caller so tests stay deterministic. */
  at: number;
}

export interface ChatState {
  nextId: number;
  messages: ChatMessage[];
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

/** Messages kept per chat; older ones fall off. Reconnection reads from here. */
const MAX_MESSAGES = 500;

export function createChat(): ChatState {
  return { nextId: 1, messages: [] };
}

export type PostResult = { ok: true; message: ChatMessage } | { ok: false; error: string };

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

  if (!text) return { ok: false, error: 'Message vide' };
  if (text.length > limits.maxLength) return { ok: false, error: 'Message trop long' };

  const windowStart = input.at - limits.windowMs;
  const recent = state.messages.filter(
    (message) => message.authorId === input.authorId && message.at >= windowStart
  ).length;
  if (recent >= limits.burst) return { ok: false, error: 'Doucement — trop de messages' };

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

/** The game's own voice: announcements, verdicts, dawn reports. Never rate limited. */
export function systemPost(state: ChatState, channel: string, text: string, at: number): ChatMessage {
  const message: ChatMessage = {
    id: state.nextId++,
    channel,
    authorId: null,
    authorName: '',
    kind: 'system',
    text,
    at
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

function trim(state: ChatState): void {
  if (state.messages.length > MAX_MESSAGES) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }
}
