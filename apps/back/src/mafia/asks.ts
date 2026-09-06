/**
 * What somebody asked for in a room only some of the table can hear.
 *
 * The ear (`ear.ts`) reads the square with a model and files claims on a board
 * every seat shares. Private rooms cannot be read that way and were not read at
 * all: a person in the family channel proposing tonight's house, a prisoner
 * bargaining through a cell door, somebody whispering "it is 7, trust me" — all
 * of it reached the bots as decoration and none of it as fact.
 *
 * This is the floor under that, and it is deliberately not a model:
 *
 *  - **Instant.** A night is forty seconds and a request typed at the end of one
 *    has to land before the knife does. A regex answers in microseconds; a model
 *    answers in a second on a good day and never on a bad one.
 *  - **Always up.** No provider, no rate limit, no bench. Whatever else is
 *    broken, a house named in a private room is heard.
 *  - **Small on purpose.** A house and a polarity is nearly all a private room
 *    contains, and it is exactly what the night policies can act on. Anything
 *    subtler than that is the ear's job, on top of this rather than instead of
 *    it.
 *
 * What it deliberately does not do is decide anything. It reads sentences into
 * requests; who grants them is the policy's business, and what the room is
 * allowed to know is `Claim.room`'s.
 */
import { ROLE, ROLES, type MafiaState, type RoleId } from 'mafia-core';

import { say } from './say.js';

/** One house named in a room, and what was wanted for it. */
export interface RoomAsk {
  /** `target`: do this house. `spare`: leave it alone. */
  kind: 'target' | 'spare';
  slot: number;
  /** The name on the door, for a line that answers by name. */
  who: string;
  /** Who asked. */
  fromSlot: number;
}

/** Everything one room has been told since a given moment. */
export interface RoomAsks {
  /** The house most recently asked for, or null when nobody named one. */
  ask: RoomAsk | null;
  /** Houses the room has been asked to leave alone. */
  spared: RoomAsk[];
  /** A role somebody claimed *for themselves*, which is the cell's currency. */
  claimed: { role: RoleId; fromSlot: number } | null;
}

const EMPTY: RoomAsks = { ask: null, spared: [], claimed: null };

/**
 * Words that turn a house named into a house spared.
 *
 * Read in the run-up to the mention and nowhere else, because "not 13, take 10"
 * is two requests and reading it as one is how a family knifes the seat it was
 * told to leave alone. The window is short for the same reason: "13 is quiet,
 * and we should not rush" must not turn into a reprieve for 13.
 */
const SPARED =
  /\b(?:not|no|dont|don'?t|never|nope|leave|spare|skip|save|protect|keep|pas|jamais|laisse|laissez|épargne|epargne|garde|surtout)\b[^.!?]{0,12}$/i;

/**
 * A gap that carries the last instruction across to the next house.
 *
 * "not 13 or 10" is one refusal covering two houses, and re-reading the second
 * from scratch would turn it into a request for exactly the house being
 * refused. Only a connector does this: put a verb in the gap and the sentence
 * has started saying something else.
 */
const CONNECTOR = /^[\s,;:]*(?:and|or|nor|plus|then|ou|et|ni|puis)?[\s,;:]*$/i;

/**
 * Somebody changing their mind, which cancels what came before it.
 *
 * "10 then, no wait, 13" is not a reprieve for 13: it is a correction, and the
 * "no" in it belongs to the sentence being withdrawn. Everything up to and
 * including the correction is dropped before the run-up is read.
 */
const CORRECTION = /\b(?:no wait|wait|actually|scratch that|forget (?:that|it)|non attends|attends|en fait|plutôt|plutot)\b/gi;

/** "I am the …", in the two languages the game ships. */
const FIRST_PERSON = /\b(?:i'?m|i am|im|me|myself|je suis|j'?suis|c'?est moi|moi)\b[^.!?]{0,16}$/i;

/**
 * Every house a line names, in the order it names them, and what was wanted.
 *
 * By number and by name, because a table calls people both ways in the same
 * breath. A number has to stand alone (131 is not house 13 and not house 1) and
 * a name has to sit on word boundaries, so "Al" does not answer for "Aloy".
 *
 * Polarity is decided from the gap since the *previous* house rather than from
 * a fixed window, which is the whole difference between reading "not 13, take
 * 10" as one instruction and reading it as the two it is.
 */
export function mentions(
  text: string,
  seats: readonly { slot: number; name: string }[]
): { slot: number; who: string; kind: RoomAsk['kind']; at: number }[] {
  const line = text.toLowerCase();
  const hits: { slot: number; who: string; at: number; end: number }[] = [];

  for (const seat of seats) {
    const digits = String(seat.slot);
    for (const match of line.matchAll(new RegExp(`(?<![0-9])${digits}(?![0-9])`, 'g'))) {
      if (match.index !== undefined) {
        hits.push({ slot: seat.slot, who: seat.name, at: match.index, end: match.index + digits.length });
      }
    }
    const name = seat.name.toLowerCase();
    for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
      const before = line[at - 1];
      const after = line[at + name.length];
      if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
      hits.push({ slot: seat.slot, who: seat.name, at, end: at + name.length });
    }
  }

  hits.sort((left, right) => left.at - right.at);

  const found: { slot: number; who: string; kind: RoomAsk['kind']; at: number }[] = [];
  let previous: { end: number; kind: RoomAsk['kind'] } | null = null;

  for (const hit of hits) {
    // Overlapping readings of the same stretch of text: "13" inside "Geralt 13".
    if (previous && hit.at < previous.end) continue;

    const gap = line.slice(previous?.end ?? 0, hit.at);
    let kind: RoomAsk['kind'];
    if (previous && CONNECTOR.test(gap)) {
      kind = previous.kind;
    } else {
      CORRECTION.lastIndex = 0;
      let fresh = gap;
      for (let hit2 = CORRECTION.exec(gap); hit2; hit2 = CORRECTION.exec(gap)) {
        fresh = gap.slice(hit2.index + hit2[0].length);
      }
      kind = SPARED.test(fresh.slice(-24)) ? 'spare' : 'target';
    }

    found.push({ slot: hit.slot, who: hit.who, kind, at: hit.at });
    previous = { end: hit.end, kind };
  }

  return found;
}

/**
 * The roles by the names they are actually called, in both catalogues.
 *
 * Built once and longest first, so "chef de famille" is not read as "chef" and
 * a two-word role beats the one-word role hiding inside it.
 */
let ROLE_NAMES: { name: string; role: RoleId }[] | null = null;
function roleNames(): { name: string; role: RoleId }[] {
  if (ROLE_NAMES) return ROLE_NAMES;
  const seen = new Map<string, RoleId>();
  for (const id of Object.keys(ROLES) as RoleId[]) {
    for (const locale of ['en', 'fr'] as const) {
      const rendered = say(locale)(ROLE.name(id)).toLowerCase().trim();
      if (rendered) seen.set(rendered, id);
    }
    seen.set(id.replace(/-/g, ' '), id);
  }
  ROLE_NAMES = [...seen].map(([name, role]) => ({ name, role })).sort((left, right) => right.name.length - left.name.length);
  return ROLE_NAMES;
}

/** The role somebody claims for themselves in one line, if they claim one. */
export function selfClaim(text: string): RoleId | null {
  const line = text.toLowerCase();
  for (const { name, role } of roleNames()) {
    const at = line.indexOf(name);
    if (at < 0) continue;
    if (FIRST_PERSON.test(line.slice(Math.max(0, at - 20), at))) return role;
  }
  return null;
}

/**
 * One room, read: what it wants done, what it wants left alone, who it says it
 * is.
 *
 * People only. A bot's line is a phrasebook entry or a paraphrase of something
 * the board already holds, so reading one back in is a bot agreeing with itself
 * in a circle — the same reason `answering` takes human lines only.
 *
 * Newest first, and only since the moment the caller names: yesterday's
 * argument was settled by yesterday's corpse.
 */
export function readRoom(
  state: MafiaState,
  room: string,
  since: number,
  exclude: ReadonlySet<number> = new Set()
): RoomAsks {
  const lines = state.chat.messages.filter((message) => {
    if (message.channel !== room || message.at < since || !message.authorId) return false;
    const author = state.players[message.authorId];
    return !!author && !author.isBot && message.text.trim().length > 0;
  });
  if (lines.length === 0) return EMPTY;

  const seats = Object.values(state.players)
    .filter((player) => player.alive && !exclude.has(player.slot))
    .map((player) => ({ slot: player.slot, name: player.name }));

  const said: RoomAsk[] = [];
  let claimed: RoomAsks['claimed'] = null;

  for (const message of lines) {
    const from = message.authorId ? state.players[message.authorId] : null;
    if (!from) continue;
    const role = selfClaim(message.text);
    if (role) claimed = { role, fromSlot: from.slot };
    for (const mention of mentions(message.text, seats)) {
      said.push({ kind: mention.kind, slot: mention.slot, who: mention.who, fromSlot: from.slot });
    }
  }

  /**
   * The last house asked for that nobody has since taken back.
   *
   * Both halves matter. An argument that changes its mind mid-sentence ends
   * where it stops, so the newest request wins; and "take 10 … actually no,
   * leave 10" is a reprieve rather than an order, so a later spare cancels the
   * request it refers to.
   */
  let ask: RoomAsk | null = null;
  for (let index = said.length - 1; index >= 0 && ask === null; index--) {
    const entry = said[index];
    if (entry.kind !== 'target') continue;
    const revoked = said.slice(index + 1).some((later) => later.kind === 'spare' && later.slot === entry.slot);
    if (!revoked) ask = entry;
  }

  return { ask, spared: said.filter((entry) => entry.kind === 'spare'), claimed };
}
