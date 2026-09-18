/**
 * The square, read without a model.
 *
 * `asks.ts` reads the private rooms this way and says why: instant, always up,
 * small on purpose. The public square had no such floor. Every human sentence
 * said in the afternoon reached the board through the ear and the ear alone, so
 * a benched chain, a rate limit or a slow round trip meant the bots saw votes
 * and nothing else — the exact failure `ear.ts` was written to end, arriving by
 * a different door.
 *
 * It is also the wrong *tempo*. The ear debounces a few seconds behind the last
 * line typed and then waits on a network round trip, which is the right shape
 * for taking minutes and the wrong one for answering somebody. A person who
 * types "7 where were you" wants house 7 to turn round now, not in nine
 * seconds.
 *
 * So this runs on every human line, synchronously, before anything is awaited:
 * it files what it is sure of and wakes whoever was named. The ear still runs,
 * still reads the same lines, and still files what only a model can see. The
 * two cannot double-file, because `BotMinds.record` keys a claim by claimer,
 * target, kind, day and room, so whichever gets there first wins and the other
 * is swallowed.
 *
 * The discipline is `readHeard`'s, for the same reason: a wrong entry on the
 * board is worse than a missing one, because the board is what every bot
 * reasons from and what `contradicted` hangs people on. Everything here wants
 * an explicit cue. A sentence that merely mentions a house asserts nothing.
 */
import type { Claim, ClaimKind, RoleId } from 'mafia-core';

import { fold, roleNamed, seatHits, selfClaim } from './asks.js';

/** One assertion read off a line, in the shape `BotMinds.record` takes. */
export interface SquareClaim {
  kind: ClaimKind;
  /** The house it is about. For a self claim, the speaker's own. */
  targetSlot: number;
  account?: 'home' | 'visited';
  ailment?: Claim['ailment'];
  claimedRole?: RoleId;
  /** See `Claim` for these: they belong to the newer kinds. */
  urge?: Claim['urge'];
  deniedRole?: RoleId;
  promise?: Claim['promise'];
}

/** A seat at the table, as this reader needs it. */
export interface Seat {
  slot: number;
  name: string;
}

/**
 * How long a person may pause and still be finishing the same thought.
 *
 * People do not type paragraphs into a game chat. They type "7", then "where
 * were you", then "last night". Read as three lines that is three fragments,
 * two of which name nobody and one of which asserts nothing; read as one
 * utterance it is a question put to house 7, which is what the person meant and
 * what everybody else at the table read.
 */
export const SAME_BREATH_MS = 12_000;

/** At most this many fragments, and this many characters, make one utterance. */
const MAX_FRAGMENTS = 6;
const MAX_UTTERANCE = 320;

/**
 * The lines somebody has just typed, as the one sentence they add up to.
 *
 * Takes the run of consecutive lines by the same speaker in the same room,
 * newest last, and joins them. Bounded both ways: somebody who types twenty
 * lines is no longer finishing a thought, they are holding the floor, and the
 * newest fragments are the ones the room is reacting to.
 */
export function utterance(
  lines: readonly { authorId: string | null; text: string; at: number }[],
  speakerId: string,
  now: number
): string {
  const mine: string[] = [];
  for (let index = lines.length - 1; index >= 0 && mine.length < MAX_FRAGMENTS; index--) {
    const line = lines[index];
    if (line.authorId !== speakerId) break;
    if (now - line.at > SAME_BREATH_MS) break;
    mine.unshift(line.text.trim());
  }
  /**
   * Joined as separate sentences, because that is what they are.
   *
   * A space made one string out of three thoughts, and every rule that reads
   * backwards from a word then read straight through the seam: "Vote for Nami
   * not me" followed by "He is the bad guy" put a "not" eighteen characters in
   * front of "bad", and the accusation came out of the reader as a *clearing*
   * of the person being accused. Reported from a real table, where it happened
   * twice in one afternoon to the same seat.
   *
   * A full stop is a boundary every lookback below already knows how to stop
   * at, and it changes nothing else: no cue in this file is spelled with one.
   */
  const joined = mine.join('. ').replace(/\s+/g, ' ').trim();
  return joined.length > MAX_UTTERANCE ? joined.slice(joined.length - MAX_UTTERANCE) : joined;
}

/* ------------------------------- the cues -------------------------------- */

/** Anybody talking about themselves. Weak on its own, which is why it is never alone. */
const SELF = /\b(?:i|i'?m|im|i'?ve|me|my|myself|je|j'|m'|moi|mon|ma)\b/i;

/** "I never left the house." */
const HOME =
  /\b(?:i (?:stayed|slept|was) (?:at )?home|i did ?n'?t (?:move|go|leave)|i didnt (?:move|go|leave)|i never (?:left|moved|went)|stayed (?:at )?home|home all night|je suis reste|je reste chez moi|j'?ai pas bouge|je n'?ai pas bouge|j'?ai rien fait cette nuit|je suis pas sorti|je ne suis pas sorti|reste chez moi toute la nuit)\b/i;

/** "I went to 7." The house is whatever is named after it. */
const VISITED =
  /\b(?:i went (?:to|into|in)|i was (?:at|in|inside)|i visited|i checked|i watched|i healed|i saved|i followed|i tracked|i called on|je suis alle|j'?ai visite|j'?etais chez|j'?ai ete chez|j'?ai verifie|j'?ai surveille|j'?ai soigne|j'?ai suivi|je suis passe chez)\b/i;

/** "I saw somebody go in there." */
const SAW = /\b(?:i saw|i watched|i spotted|seen|witnessed|j'?ai vu|j'?ai apercu|j'?ai remarque|vu chez)\b/i;

/** "…had a visitor." Said about a house rather than by one. */
const VISITED_BY =
  /\b(?:had (?:a )?visitors?|was visited|got (?:a )?visitors?|someone went (?:to|into)|somebody went (?:to|into)|a eu (?:de la )?visite|quelqu'?un est alle|on est alle chez|il y avait quelqu'?un)\b/i;

/** The vocabulary of an accusation. */
const EVIL =
  /\b(?:sus|suspicious|suspect|suspecte|suspects|mafia|maf|scum|evil|wolf|liar|lying|lies|lied|guilty|shady|dodgy|fishy|bad|dirty|red|louche|chelou|menteur|menteuse|ment|mentait|coupable|bizarre|traitre|traite|rouge|mauvais|sk|serial killer|tueur en serie)\b/i;

/**
 * A house pulled out of the line of fire, immediately before it is named.
 *
 * Adjacency is the whole rule. "not 11" is a reprieve; "I am not sure about 11"
 * is a doubt, and the only thing that tells them apart is whether the refusal
 * is touching the house. The room parser reads a wider window because a private
 * room is nearly always issuing instructions; the square is not.
 */
const REFUSED =
  /\b(?:not|no|dont|don'?t|never|nope|leave|spare|skip|save|protect|keep|pas|jamais|laisse|laissez|epargne|garde)\b[\s,:;'-]{0,3}$/i;

/** The vocabulary of a defence offered on somebody else's behalf. */
/**
 * The vocabulary of a defence offered on somebody else's behalf.
 *
 * Three words have been taken out of it, and all three for the same reason:
 * they are far commoner as filler than as verdicts. "OK On Nami now" is a person
 * changing their vote *onto* Nami, and it was read as a clearing of Nami
 * because of the "ok"; "sur" is French for "on" as often as it is French for
 * "sure", and it loses its accent in `fold` either way. A reader that files the
 * opposite of what was said is worse than one that files nothing, because the
 * board is what every bot reasons from and a wrong entry never expires.
 *
 * "fine" stays, on the strength of "4 is fine" being the commonest clearing
 * anybody types: it is the one word here that is a verdict more often than it
 * is filler.
 */
const GOOD =
  /\b(?:town|townie|clean|fine|trust|trusted|trustworthy|innocent|legit|confirmed|vouch|safe|good|confirme|confiance|fiable|blanc|innocente|innocent|clean)\b/i;

/** Pushing a rope, in either language. */
const AGAINST =
  /\b(?:vote|votes|voting|voted|hang|hanging|lynch|lynching|eliminate|kill|rope|pend|pends|pendre|pendez|lynche|lynchez|lyncher|elimine|eliminez|contre|dehors|sortez)\b/i;

/** Pulling one back. */
const NEGATED =
  /\b(?:not|no|never|dont|don'?t|doesn'?t|isn'?t|ain'?t|stop|pas|jamais|plus|arrete|arretez|surtout pas)\b/i;

/** A question put to a house rather than about one. */
const ASKED =
  /\b(?:where were you|where was|what did you|who did you|explain|explains|answer me|why (?:did|are|were)|prove it|t'?etais ou|tu etais ou|ou etais tu|qu'?as tu fait|tu as fait quoi|explique|repond|reponds|pourquoi|prouve)\b/i;

/**
 * What a seat says was done to it in the night, and the word the board files it
 * under.
 *
 * Ordered, because a line can contain two of these words and only one of them
 * is what happened: "the doctor healed me, somebody tried to kill me" is a
 * heal. The specific beats the general, and the deadline beats both — see
 * `AILMENT_VALUE` in `bots.ts`, which ranks how urgently each one is worth
 * saying out loud.
 */
const AILMENTS: { ailment: NonNullable<Claim['ailment']>; cue: RegExp }[] = [
  { ailment: 'poison', cue: /\b(?:poisoned|poison|empoisonne|empoisonnee|du poison)\b/i },
  {
    ailment: 'silenced',
    cue: /\b(?:blackmail(?:ed)?|silenced|gagged|muted|can'?t speak|fait taire|baillonne|maitre chanteur|je peux pas parler)\b/i
  },
  {
    ailment: 'guarded',
    cue: /\b(?:bodyguard|guarded|a guard|protected me|garde du corps|protege par|on m'?a protege)\b/i
  },
  {
    ailment: 'healed',
    cue: /\b(?:healed|the doctor|doc saved|patched (?:me )?up|soigne|soignee|le medecin|le docteur|on m'?a soigne)\b/i
  },
  // Before `blocked`, which "couldn't act" also matches: a night in the cell is
  // the more specific reading, and the only one with a witness to check it by.
  {
    ailment: 'jailed',
    /**
     * Passive only, because the active verb belongs to somebody else entirely.
     *
     * "I am jailor, I jailed 8" is the man with the keys reporting his own
     * night, and the bare verb read it as him having *been* jailed — a false
     * ailment filed on the one seat whose word on this is worth anything, and
     * the accusation against 8 lost in the same breath. The jailor is also the
     * reason "the jailor" cannot be a cue on its own: every seat that mentions
     * him would be claiming his cell.
     */
    cue: /(?<!\bi )\b(?:jailed|in jail|in the cell|locked up|kidnapped|emprisonne|emprisonnee|en cellule|en prison|enferme|enfermee|kidnappe|kidnappee)\b|\bthe jail(?:or|er) (?:had|took|held|grabbed) me\b|\ble geolier m'?a (?:pris|garde)\b/i
  },
  {
    ailment: 'blocked',
    cue: /\b(?:roleblock(?:ed)?|role blocked|blocked|distracted|escorted|couldn'?t act|bloque|bloquee|empeche|distrait|j'?ai pas pu agir)\b/i
  },
  {
    ailment: 'controlled',
    cue: /\b(?:controlled|mind ?controlled|the witch|puppet|controle|controlee|la sorciere|manipule)\b/i
  },
  {
    ailment: 'bussed',
    cue: /\b(?:bus driver|bussed|bus'?d|swapped|switched houses|chauffeur de bus|echange de maison|on a echange)\b/i
  },
  { ailment: 'douse', cue: /\b(?:doused|petrol|gasoline|gas(?:oline)? on me|arrosoir|asperge|essence|arrose)\b/i },
  {
    ailment: 'survived',
    cue: /\b(?:survived|attacked|tried to kill me|attempt on me|i was attacked|survecu|attaque|on a essaye de me tuer|j'?ai failli mourir)\b/i
  }
];

/* ------------------------------ the reading ------------------------------ */

/**
 * "We need to vote." / "Let's skip today."
 *
 * Names nobody, so nothing above catches it, and it is the sentence that
 * decides whether a day happens at all: `steadyVote` ends a thin afternoon on
 * its own authority, and a person asking for a vote is the one thing that
 * should outweigh a machine's verdict that there is nothing to vote on.
 *
 * Deliberately demanding about the first person plural. "We" or an imperative,
 * because "he wants to skip" is a report about somebody else and "you should
 * vote him" is an accusation, and filing either as this seat's own push would
 * put a position in their mouth they never took.
 */
const URGE_VOTE =
  /\b(?:we (?:need|have|got) to vote|we must vote|let'?s vote|vote (?:now|today|someone|somebody)|can'?t (?:skip|pass) again|no more skipping|il faut voter|on doit voter|votons|on vote)\b/i;
const URGE_SKIP =
  /\b(?:let'?s skip|we should skip|skip (?:today|it|this day)|no vote today|nothing here today|not enough (?:to go on|evidence)|on passe|passons|on skip|rien aujourd'?hui|pas assez d'?(?:infos|elements))\b/i;

/**
 * "Why me?" — the accused asking an accuser to show its working.
 *
 * Aimed at whoever is pushing hardest when the line names nobody, which is the
 * ordinary case: somebody under a wagon rarely stops to name which of their
 * accusers they mean.
 */
const DEMAND =
  /\b(?:why me|why am i|on what (?:basis|grounds)|what did i (?:do|even do)|who (?:put my name|named me|started this)|based on what|pourquoi moi|sur quoi|qu'?est-ce que j'?ai fait|qui m'?a (?:nomme|accuse))\b/i;

/**
 * "He can't be the doctor." — denying a badge rather than calling somebody evil.
 *
 * Read apart from an accusation because the checkable part is *which* badge is
 * contested: the board can weigh that against everybody else standing up for
 * the same role, and it cannot do anything at all with "he is lying".
 */
const DENIES =
  /\b(?:can'?t be|is not|isn'?t|ain'?t|never was|n'?est pas|ne peut pas etre|c'?est pas)\s+(?:the |a |an |le |la |un |une )?/i;

/** "Spare me and I'll prove it tonight." A bet the next dawn settles. */
const PROMISE =
  /\b(?:i(?:'?ll| will) prove it|prove it tonight|wait (?:one|a) (?:more )?(?:night|day)|give me (?:one|a) night|i(?:'?ll| will) (?:name myself|say my name|speak tonight)|you'?ll (?:see|know) (?:tomorrow|at dawn)|je (?:le )?prouverai|attendez (?:une|cette) nuit|donnez-moi une nuit|demain vous saurez)\b/i;

/**
 * "He keeps saying we should skip." / "7 said he would prove it."
 *
 * Somebody reporting what another seat said, which reads exactly like the seat
 * saying it and means the opposite: filing it would put a position in this
 * speaker's mouth that they were quoting rather than taking. Only guards the
 * kinds where that confusion is possible — a push on the clock and a promise —
 * because those are the two that are about the speaker and carry no house.
 */
const REPORTED =
  /\b(?:he|she|they|him|her|them|\d{1,2}|il|elle|ils|elles|lui)\s+(?:said|says|keeps saying|kept saying|told|wants|wanted|claims|claimed|a dit|dit|disait|veut|voulait|pretend)\b/i;

/** The window a cue is looked for in, either side of a house. */
const NEAR = 44;

/**
 * Where one thing being said ends and the next begins.
 *
 * Distance alone is not enough to decide what a sentence is about. "I think the
 * sheriff is 4 and 99 is lying" puts "lying" twenty characters after house 4,
 * and reading those twenty characters as a window makes the reader accuse a
 * seat of something the speaker said about somebody else entirely — caught in
 * the flight recorder on the first line typed at it, which is what a recorder
 * is for.
 *
 * So a window stops at the clause boundary as well as at the character count.
 * What is left is the part of the sentence the house is actually in.
 *
 * A comma is deliberately not a boundary. "Checked 7, came back bad" is the
 * shape every sheriff's will is written in, and cutting it at the comma throws
 * away the half that says what was found. The case a comma usually marks —
 * "7 is sus, 4 is fine" — needs no rule of its own, because a second house is
 * already where the first house's window ends.
 */
const CLAUSE = /;|:|\. | and | but | or | so | then | et | mais | ou | donc | puis /i;

/**
 * The run-up to a house: from the previous clause boundary, at most `NEAR` back.
 *
 * A comma counts here and not in the run-out, which is the asymmetry the two
 * sentences ask for. "7 is sus, 4 is fine" reads backwards from 4 into a
 * verdict that was passed on 7, so the comma has to stop it; "checked 7, came
 * back bad" reads forwards from 7 into the rest of its own report, so it must
 * not. A comma ends what was being said about the house before it.
 */
const CLAUSE_BACK = new RegExp(`,|${CLAUSE.source}`, 'i');

function runUp(line: string, from: number, at: number): string {
  const window = line.slice(Math.max(from, at - NEAR), at);
  const parts = window.split(CLAUSE_BACK);
  return parts[parts.length - 1] ?? window;
}

/** And the run-out: up to the next clause boundary, at most `NEAR` on. */
function runOut(line: string, at: number, to: number): string {
  const window = line.slice(at, Math.min(to, at + NEAR));
  return window.split(CLAUSE)[0] ?? window;
}

/**
 * Everything one line asserts, as claims.
 *
 * Self claims first, because they need no house: a role, an alibi, a night
 * somebody had. Then the houses the line names, each read from the words
 * around it, nearest cue winning.
 */
export function readSquare(
  text: string,
  speakerSlot: number,
  seats: readonly Seat[],
  options: {
    /**
     * Whether an unattributed sentence is about the speaker.
     *
     * False for chat, where "stayed home" with no "I" in front of it is usually
     * somebody reporting what a *different* seat said, and filing it as an
     * alibi would put words in the speaker's mouth.
     *
     * True for a will, where every line is the author writing about their own
     * night and the pronoun is left out for the same reason a diary leaves it
     * out: "N1: stayed home. N2: checked 7, bad." Even then, a line that names
     * a house before it says anything is about that house and not about the
     * author.
     */
    implicitSelf?: boolean;
    /**
     * Who to read an unaddressed "why me?" as being put to.
     *
     * The seat currently pushing hardest against the speaker, which the caller
     * knows and this reader cannot. Absent, an unaddressed demand is dropped
     * rather than guessed at.
     */
    accuser?: number;
  } = {}
): SquareClaim[] {
  const line = fold(text);
  if (line.trim().length === 0) return [];

  const filed: SquareClaim[] = [];
  const add = (claim: SquareClaim): void => {
    const already = filed.some(
      (other) => other.kind === claim.kind && other.targetSlot === claim.targetSlot && other.ailment === claim.ailment
    );
    if (!already) filed.push(claim);
  };

  const hits = seatHits(text, seats).filter((hit) => hit.slot !== speakerSlot);

  /** Is what is being said at this point in the line about the speaker? */
  const explicit = SELF.test(line);
  const mine = (at: number): boolean => explicit || (options.implicitSelf === true && !hits.some((hit) => hit.at < at));

  // "I am the Sheriff." The room parser already knows how to read one.
  const role = selfClaim(text);
  if (role) add({ kind: 'role-claim', targetSlot: speakerSlot, claimedRole: role });

  /**
   * Pushing on the clock rather than on a person.
   *
   * Filed against the speaker's own house because it is about them and not
   * about anybody else, and checked before the per-house loop so that "we need
   * to vote 7" records both the push and the accusation.
   */
  const quoting = REPORTED.test(line);
  if (!quoting) {
    if (URGE_VOTE.test(line)) add({ kind: 'urge', targetSlot: speakerSlot, urge: 'vote' });
    else if (URGE_SKIP.test(line)) add({ kind: 'urge', targetSlot: speakerSlot, urge: 'skip' });
  }

  /** "Spare me and I will prove it tonight." */
  if (PROMISE.test(line) && !quoting && (explicit || options.implicitSelf === true)) {
    add({ kind: 'promise', targetSlot: speakerSlot, promise: 'night' });
  }

  /**
   * "Why me?", put to whoever the line names, or to the loudest accuser when
   * it names nobody.
   *
   * The unaddressed form is by far the commoner one — somebody under a wagon
   * rarely stops to pick which accuser they mean — and `options.accuser` is
   * how the caller says who that is. Without one the question is still worth
   * recording against the seat named, if any.
   */
  if (DEMAND.test(line)) {
    const at = line.search(DEMAND);
    const aimed = hits.find((hit) => hit.at >= at) ?? hits[0];
    const who = aimed?.slot ?? options.accuser;
    if (who !== undefined && who !== speakerSlot) add({ kind: 'demand', targetSlot: who });
  }

  // What was done to this seat in the night.
  for (const { ailment, cue } of AILMENTS) {
    const at = line.search(cue);
    if (at >= 0 && mine(at)) {
      add({ kind: 'ailing', targetSlot: speakerSlot, ailment });
      break;
    }
  }

  // "I never left." Only when the line is not busy saying where it went.
  const visitedAt = line.search(VISITED);
  const homeAt = line.search(HOME);
  if (homeAt >= 0 && visitedAt < 0 && mine(homeAt)) {
    add({ kind: 'account', targetSlot: speakerSlot, account: 'home' });
  }

  /**
   * "I went to 7." The house is the first one named after the cue, because
   * "I went to 7, unlike 4" admits one journey and not two.
   */
  if (visitedAt >= 0 && mine(visitedAt)) {
    const went = hits.find((hit) => hit.at >= visitedAt);
    if (went) add({ kind: 'account', targetSlot: went.slot, account: 'visited' });
  }

  const sawAt = SAW.test(line) ? line.search(SAW) : -1;

  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    const previous = hits[index - 1];
    const next = hits[index + 1];
    const before = runUp(line, previous?.end ?? 0, hit.at);
    const after = runOut(line, hit.end, next?.at ?? line.length);
    const near = `${before} ${after}`;

    // Already accounted for as the house this seat says it visited.
    if (filed.some((claim) => claim.kind === 'account' && claim.targetSlot === hit.slot)) continue;

    /**
     * A house somebody was seen at, or seen going to.
     *
     * The cue can sit anywhere before the house ("I saw 4 walk into 7") or
     * behind it ("7 had a visitor"), and either way the house named is the one
     * the sighting is about. A seat reporting its *own* journey has already
     * been filed as an account above and is skipped.
     */
    if ((sawAt >= 0 && hit.at > sawAt) || VISITED_BY.test(near)) {
      add({ kind: 'sighting', targetSlot: hit.slot });
      continue;
    }

    /**
     * A denial belongs to the word it denies, not to the house.
     *
     * "7 is not sus" and "not 7" are opposite claims and the negator sits in
     * the same place in both, so reading it from a fixed window either side of
     * the house gets one of them backwards every time. It is read from in front
     * of the *verdict* instead, wherever in the line that landed.
     */
    const denied = (at: number): boolean => {
      if (at < 0) return false;
      /**
       * And the denial has to be in the same breath as the word it denies.
       *
       * People type in fragments and `utterance` folds them together, so the
       * eighteen characters in front of a verdict routinely belonged to the
       * *previous* sentence. The window stops at the seam, which is what a
       * person reading the same three lines does without thinking about it.
       */
      const window = near.slice(Math.max(0, at - 18), at);
      const seam = Math.max(window.lastIndexOf('.'), window.lastIndexOf('!'), window.lastIndexOf('?'));
      return NEGATED.test(seam >= 0 ? window.slice(seam + 1) : window);
    };
    const refused = REFUSED.test(before);
    const evilAt = near.search(EVIL);
    const goodAt = near.search(GOOD);
    const rope = AGAINST.test(before.slice(-24)) || AGAINST.test(after.slice(0, 18));

    /**
     * "He cannot be the Doctor" — a denial of a badge, not of a person.
     *
     * Checked before the evil/good verdicts, because the words that carry it
     * ("is not", "can't be") are the same ones `NEGATED` uses, and read as a
     * verdict the sentence comes out as a *clearing* of the seat whose badge is
     * being torn up. Which is backwards, and was the reading until now.
     */
    const badge = roleNamed(after) ?? roleNamed(before);
    if (badge && DENIES.test(near)) {
      add({ kind: 'counter-claim', targetSlot: hit.slot, deniedRole: badge });
      continue;
    }

    // "not 11" is a reprieve whatever else the line is doing.
    if (refused) {
      add({ kind: 'clear', targetSlot: hit.slot });
      continue;
    }
    if (evilAt >= 0) {
      add({ kind: denied(evilAt) ? 'clear' : 'accuse', targetSlot: hit.slot });
      continue;
    }
    if (goodAt >= 0) {
      add({ kind: denied(goodAt) ? 'accuse' : 'clear', targetSlot: hit.slot });
      continue;
    }
    if (rope) {
      add({ kind: NEGATED.test(before.slice(-18)) ? 'clear' : 'accuse', targetSlot: hit.slot });
      continue;
    }

    /**
     * Put to the house rather than said about it.
     *
     * A question mark alone is enough when a house is named and nothing else in
     * the line is an assertion: "7?" is the whole of what most people type, and
     * it is unambiguously an approach to house 7.
     */
    if (ASKED.test(near) || (line.includes('?') && hits.length <= 2)) {
      add({ kind: 'question', targetSlot: hit.slot });
    }
  }

  return filed;
}
