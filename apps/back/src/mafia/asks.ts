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
const CORRECTION =
  /\b(?:no wait|wait|actually|scratch that|forget (?:that|it)|non attends|attends|en fait|plutôt|plutot)\b/gi;

/** "I am the …", in the two languages the game ships. */
const FIRST_PERSON = /\b(?:i'?m|i am|im|me|myself|je suis|j'?suis|c'?est moi|moi)\b[^.!?]{0,16}$/i;

/**
 * Saying what you think somebody else is, which is not a claim about yourself.
 *
 * "I think the sheriff is 7" puts a first-person marker twelve characters in
 * front of a role name, which is all the test above looks for — so the reader
 * filed the speaker as the Sheriff on the strength of a sentence that named
 * somebody else. A reporting verb between the two is the tell, and it is worth
 * checking because a false role claim is the most expensive mistake either
 * reader can make: it is the one thing the whole table reasons from.
 */
/**
 * Saying what you are NOT, which is the opposite of a claim about yourself.
 *
 * "I'm not the serial killer" puts a first-person marker eight characters in
 * front of a role name, which is all the test above looks for, so the reader
 * filed the denial as a confession. It is the single most common sentence at a
 * Mafia table and it was read as the single most damning one.
 *
 * Harmless until it was not. A self-claimed evil role used to be worth nothing
 * in the arithmetic, so the misreading sat on the board doing no work; it is
 * now the heaviest term in the model, and the same sentence gets its speaker
 * jailed, convicted by every juror and shot by the Vigilante. Two rules
 * crossing is how the expensive bugs in this file happen: see the note on
 * `REPORTING`, which is the same mistake in the other direction.
 *
 * Checked on the run-up rather than on the line, so "I am the Doctor, I am not
 * a killer" still reads the badge it actually claimed.
 */
const NEGATED = /\b(?:not|never|ain'?t|aint|no|pas|jamais|aucun)\b/i;

const REPORTING =
  /\b(?:think|thinks|thought|believe|believes|guess|bet|say|says|said|suspect|suspects|reckon|wonder|hope|pense|crois|croit|dis|dit|suppose|parie|suspecte|imagine)\b/i;

/**
 * Accents off, case off.
 *
 * A person types "Geralt" for "Géralt" and "ELIAS" for "Elias", and a reader
 * that misses either is a reader the table has to type carefully for. Folding
 * happens once per line and once per name rather than per comparison.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Houses spelled out, for the people who type them that way.
 *
 * Deliberately short of `one`/`un`/`une`/`neuf`: those are articles and
 * adjectives far more often than they are houses, and a reader that turns
 * "there is one of them lying" into a request for house 1 is worse than a
 * reader that misses "take one". Everything here is only ever accepted behind
 * a cue word (see `NUMBER_CUE`), which is what keeps "two of us saw it" from
 * naming house 2.
 */
const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  sept: 7,
  huit: 8,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
  vingt: 20
};

/**
 * The words a spelled-out house is allowed to stand behind.
 *
 * A number word is only a house when somebody is doing something to it. This is
 * the short list of verbs that do things to houses, in both languages, and it
 * is read in the dozen characters before the word.
 */
const NUMBER_CUE =
  /\b(?:house|seat|vote|votes|voting|take|takes|kill|kills|hang|lynch|target|trust|spare|save|skip|check|it'?s|maison|siege|vote[rz]?|tue[rz]?|prend|prends|prenez|pendre|lynche[rz]?|cible|confiance|epargne|verifie|c'?est)\b[^.!?]{0,12}$/i;

/** Words too common to be read as a misspelt name. */
const NOT_A_NAME = new Set([
  'that',
  'this',
  'they',
  'them',
  'then',
  'than',
  'what',
  'when',
  'were',
  'where',
  'with',
  'your',
  'yeah',
  'well',
  'just',
  'like',
  'know',
  'said',
  'says',
  'sure',
  'stop',
  'dont',
  'cant',
  'wont',
  'mafia',
  'town',
  'vote',
  'night',
  'last',
  'home',
  'house',
  'been',
  'have',
  'here',
  'there',
  'dans',
  'chez',
  'avec',
  'pour',
  'mais',
  'donc',
  'quoi',
  'nuit',
  'jour',
  'vote',
  'tour',
  'bien',
  'alors',
  'etait',
  'etais',
  'suis',
  'sais',
  'dire',
  'fait',
  'fais',
  'tout',
  'tous',
  'plus'
]);

/**
 * One mistake apart, where a mistake includes two letters swapped.
 *
 * Plain edit distance calls "aragron" two mistakes away from "Aragorn" and
 * refuses it, which is exactly backwards: transposing two letters is the single
 * commonest thing a fast typist does, and it is the one this has to catch.
 */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;

  if (a.length === b.length) {
    // Two letters swapped, or one letter wrong.
    if (a[at] === b[at + 1] && a[at + 1] === b[at] && a.slice(at + 2) === b.slice(at + 2)) return true;
    return a.slice(at + 1) === b.slice(at + 1);
  }

  // One letter too many on one side.
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(at) === long.slice(at + 1);
}

/** One house named in a line, and where in the line it was named. */
export interface SeatHit {
  slot: number;
  who: string;
  at: number;
  end: number;
  /** A digit or the name as written. A fuzzy hit is a guess and loses ties. */
  exact: boolean;
}

/**
 * Every house a line names, by number, by name, by a misspelt name, or spelled
 * out in words.
 *
 * The strict pass came first and is still what answers nearly every line: a
 * bare number that is not part of a longer one, or the name exactly as the
 * roster spells it. What it missed is everything a person actually types —
 * "galadriel" without the accent, "Galad", "Gandlaf", "take ten" — and each of
 * those misses is a house named in a room that the game then acts as though
 * nobody named.
 *
 * So there are four passes, and they are ranked. An exact hit always beats a
 * guess over the same stretch of text, a guess is only made on a token long
 * enough for the guess to mean something, and a spelled-out number is only a
 * house when a verb in front of it is doing something to a house.
 */
export function seatHits(text: string, seats: readonly { slot: number; name: string }[]): SeatHit[] {
  const line = fold(text);
  const hits: SeatHit[] = [];

  for (const seat of seats) {
    const digits = String(seat.slot);
    for (const match of line.matchAll(new RegExp(`(?<![0-9])${digits}(?![0-9])`, 'g'))) {
      if (match.index !== undefined) {
        hits.push({ slot: seat.slot, who: seat.name, at: match.index, end: match.index + digits.length, exact: true });
      }
    }
    const name = fold(seat.name);
    for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
      const before = line[at - 1];
      const after = line[at + name.length];
      if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
      hits.push({ slot: seat.slot, who: seat.name, at, end: at + name.length, exact: true });
    }
  }

  /**
   * The guesses, over the line's own words.
   *
   * A token is read against every seat's full name and against each word of it
   * that is long enough to stand alone, so "Boba", "Fett" and "Boba Fett" all
   * answer for the same seat. Four characters is the floor for a shortening and
   * five for a typo, because below that the guess is noise: "Neo" and "Loki"
   * are only ever matched exactly.
   */
  for (const token of line.matchAll(/[\p{L}\p{N}]{4,}/gu)) {
    const word = token[0];
    const at = token.index;
    if (at === undefined || NOT_A_NAME.has(word)) continue;
    if (hits.some((hit) => at < hit.end && hit.at < at + word.length)) continue;

    for (const seat of seats) {
      const keys = [fold(seat.name), ...fold(seat.name).split(/[^\p{L}\p{N}]+/u)].filter((key) => key.length >= 4);
      /**
       * A shortening or a typo, and deliberately not the other direction.
       *
       * "Galad" for Galadriel is a person being quick; a word that merely
       * *starts* with a name is a different word, and reading it as the name is
       * how "that is baloonish" becomes a contract on house 3. The name has to
       * contain what was typed, or be one mistake away from it.
       */
      const matched = keys.some(
        (key) =>
          (key.startsWith(word) && word.length >= 4) || (Math.min(key.length, word.length) >= 5 && within1(key, word))
      );
      if (matched) {
        hits.push({ slot: seat.slot, who: seat.name, at, end: at + word.length, exact: false });
        break;
      }
    }
  }

  // Spelled-out houses, behind a cue.
  for (const token of line.matchAll(/[\p{L}]{3,}/gu)) {
    const word = token[0];
    const at = token.index;
    const slot = NUMBER_WORDS[word];
    if (at === undefined || slot === undefined) continue;
    if (!seats.some((seat) => seat.slot === slot)) continue;
    if (hits.some((hit) => at < hit.end && hit.at < at + word.length)) continue;
    if (!NUMBER_CUE.test(line.slice(Math.max(0, at - 16), at))) continue;
    const seat = seats.find((entry) => entry.slot === slot);
    if (seat) hits.push({ slot, who: seat.name, at, end: at + word.length, exact: false });
  }

  hits.sort((left, right) => left.at - right.at || Number(right.exact) - Number(left.exact));

  const kept: SeatHit[] = [];
  for (const hit of hits) {
    // Overlapping readings of the same stretch of text: "13" inside "Geralt 13".
    const last = kept[kept.length - 1];
    if (last && hit.at < last.end) continue;
    kept.push(hit);
  }
  return kept;
}

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
  const line = fold(text);
  const hits = seatHits(text, seats);

  const found: { slot: number; who: string; kind: RoomAsk['kind']; at: number }[] = [];
  let previous: { end: number; kind: RoomAsk['kind'] } | null = null;

  for (const hit of hits) {
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
/**
 * A role the ear or a player named, whatever they called it.
 *
 * The ear used to test the model's answer with `role in ROLES`, so it only ever
 * accepted a canonical id like `mason-leader`. But the prompt hands the model
 * the roster in the table's own language ("Médecin, Hôtesse, Détective privé"),
 * so the model answers in those words, and every role claim the ear heard was
 * dropped as "role not in this game". It cost a Mason Leader his Mason: he
 * stood up mid-trial, said "I am mason leader", and the board never heard it.
 *
 * The deterministic reader has resolved names this way since it was written.
 * There was never a reason for the two to disagree.
 */
export function roleFromName(said: string): RoleId | null {
  const folded = fold(said).trim();
  if (!folded) return null;
  /**
   * `Object.hasOwn`, not `in`, because `in` walks the prototype.
   *
   * `ROLES` is an object literal, so `'constructor' in ROLES` is true and this
   * function handed back `"constructor"` typed as a `RoleId`. Today the only
   * caller re-checks the answer against the roles this table was dealt and
   * throws it away, which is the only reason nothing has blown up. The next
   * caller to pass the result straight to `roleDef` gets `undefined.faction`.
   */
  if (Object.hasOwn(ROLES, folded)) return folded as RoleId;
  // `\s`, not `s`: the first spelling of this replaced the letter and turned
  // "mason leader" into "ma-on leader". It only ever looked like it worked
  // because `roleNames` separately registers every id with its hyphens spaced.
  const hyphenated = folded.replace(/\s+/g, '-');
  if (Object.hasOwn(ROLES, hyphenated)) return hyphenated as RoleId;
  return roleNames().find((entry) => entry.name === folded)?.role ?? null;
}

function roleNames(): { name: string; role: RoleId }[] {
  if (ROLE_NAMES) return ROLE_NAMES;
  const seen = new Map<string, RoleId>();
  for (const id of Object.keys(ROLES) as RoleId[]) {
    for (const locale of ['en', 'fr'] as const) {
      // Folded, like the lines they are looked for in: nobody types "Médecin"
      // with the accent when they are arguing for their life.
      const rendered = fold(say(locale)(ROLE.name(id))).trim();
      if (rendered) seen.set(rendered, id);
    }
    seen.set(id.replace(/-/g, ' '), id);
  }
  ROLE_NAMES = [...seen]
    .map(([name, role]) => ({ name, role }))
    .sort((left, right) => right.name.length - left.name.length);
  return ROLE_NAMES;
}

/** The abbreviations a table actually types, per role. */
const ROLE_NICKNAMES: Partial<Record<RoleId, string[]>> = {
  'serial-killer': ['sk'],
  godfather: ['gf'],
  veteran: ['vet'],
  vigilante: ['vig', 'vigi'],
  doctor: ['doc', 'medic'],
  bodyguard: ['bg'],
  executioner: ['exe', 'exec'],
  consigliere: ['consig'],
  lookout: ['lo'],
  'bus-driver': ['bd'],
  investigator: ['invest'],
  'mass-murderer': ['mm'],
  blackmailer: ['bm'],
  survivor: ['surv'],
  'mason-leader': ['mason leader'],
  escort: ['esc'],
  arsonist: ['arso'],
  janitor: ['jani'],
  amnesiac: ['amne'],
  cultist: ['cult'],
  electromaniac: ['electro'],
  coroner: ['coro'],
  marshall: ['marshal', 'marsh'],
  disguiser: ['disg'],
  interrogator: ['interro'],
  detective: ['detec']
};

/**
 * A nickname found as a whole word.
 *
 * Separate from the name table because the names are matched with `indexOf`,
 * which is right for "serial killer" and catastrophic for "sk": it would fire
 * inside "asked", "risky" and "skip". Two-letter abbreviations only work with a
 * boundary on both sides.
 */
function nicknameAt(line: string): { at: number; role: RoleId } | null {
  let best: { at: number; role: RoleId } | null = null;
  for (const [role, words] of Object.entries(ROLE_NICKNAMES) as [RoleId, string[]][]) {
    for (const word of words) {
      const found = new RegExp(`\\b${word}\\b`, 'i').exec(line);
      if (found && (best === null || found.index < best.at)) best = { at: found.index, role };
    }
  }
  return best;
}

/**
 * The last clause of a run-up, which is as far as a denial can reach.
 *
 * `NEGATED` and `REPORTING` used to be tested against the whole twenty-character
 * window, so a denial in the clause *before* the claim killed the claim:
 * "I'm not lying, I'm the Doctor" and "I never lie, I'm the Doctor" both read as
 * no claim at all, which is the opposite of what either sentence says and a
 * sentence a cornered player types constantly. A comma ends the reach of a
 * "not" in both shipped languages.
 *
 * `FIRST_PERSON` keeps the full run-up on purpose: "Moi, le Docteur" puts the
 * marker on the other side of the comma and is still a claim.
 */
function lastClause(runUp: string): string {
  const cut = runUp.search(/[,;:][^,;:]*$/);
  return cut < 0 ? runUp : runUp.slice(cut + 1);
}

/** The role somebody claims for themselves in one line, if they claim one. */
export function selfClaim(text: string): RoleId | null {
  const line = fold(text);
  for (const { name, role } of roleNames()) {
    const at = line.indexOf(name);
    if (at < 0) continue;
    const runUp = line.slice(Math.max(0, at - 20), at);
    const clause = lastClause(runUp);
    if (FIRST_PERSON.test(runUp) && !REPORTING.test(clause) && !NEGATED.test(clause)) return role;
  }
  // And the same test against what people type instead of the name.
  const nick = nicknameAt(line);
  if (nick) {
    const runUp = line.slice(Math.max(0, nick.at - 20), nick.at);
    const clause = lastClause(runUp);
    if (FIRST_PERSON.test(runUp) && !REPORTING.test(clause) && !NEGATED.test(clause)) return nick.role;
  }
  return null;
}

/**
 * The role a line *names*, whoever it belongs to — "the gf", "who is the vet".
 *
 * Distinct from `selfClaim`, which asks whether the speaker claimed it. This
 * asks only whether a role was mentioned, which is what resolving "veteran,
 * where were you" into a house needs.
 */
export function roleNamed(text: string): RoleId | null {
  const line = fold(text);
  for (const { name, role } of roleNames()) if (line.includes(name)) return role;
  return nicknameAt(line)?.role ?? null;
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
