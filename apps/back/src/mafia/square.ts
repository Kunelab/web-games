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
import { isEvilRole, type Claim, type ClaimKind, type MafiaState, type RoleId } from 'mafia-core';

import { fold, roleNamedAt, seatHits, selfClaim, type SeatHit } from './asks.js';

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
  let length = 0;
  for (let index = lines.length - 1; index >= 0 && mine.length < MAX_FRAGMENTS; index--) {
    const line = lines[index];
    if (line.authorId !== speakerId) break;
    if (now - line.at > SAME_BREATH_MS) break;
    const text = line.text.trim();
    /**
     * Whole fragments, and the newest one always whole.
     *
     * The bound used to be a slice off the front of the joined text, which cut
     * through whatever sat there: a Private Investigator typed his entire will
     * as one line, opening "I am Private Investigator. N1 visit 15…", and the
     * reader got "stigator. N1 visit 15…" and never heard the claim (`P6TJ9`,
     * 990s). An older fragment that does not fit is dropped as a whole; the
     * line just typed is what the person is saying now, and is never cut.
     */
    if (mine.length > 0 && length + text.length + 2 > MAX_UTTERANCE) break;
    mine.unshift(text);
    length += text.length + 2;
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
  return mine.join('. ').replace(/\s+/g, ' ').trim();
}

/**
 * The night one line of a will is about, when it says.
 *
 * A will is a list and every entry of it opens with its night: "N1 stayed
 * home", "night 3, checked 7, bad". The claims read out of those lines used to
 * reach the board dated to *last* night whatever they said, because nothing
 * filled in `Claim.night` and `record` falls back to the day it was filed on.
 * So a Sheriff's night-two check, read out of its will on day six, was offered
 * to the room as a night-five check, which is a sentence the room can go and
 * disprove: the one source that was telling the truth, caught out by the
 * driver's own arithmetic.
 *
 * The first marker in the line wins, because a will entry is about one night
 * and names it first. Null when the line names none, and then the old guess is
 * still the best available.
 */
export function nightNamed(text: string): number | null {
  const found = /\b(?:n|nights?|nuits?)\s*[°º]?\s*(\d{1,2})\b/i.exec(fold(text));
  if (!found) return null;
  const night = Number(found[1]);
  return Number.isInteger(night) && night >= 1 ? night : null;
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
/**
 * A verdict that puts a house on the wrong side.
 *
 * The camps belong here as much as the insults do, and they were missing. A
 * Sheriff in this game does not report "suspicious", it reports what it found —
 * "came back Cult", "came back Triad" — and the reader had words for every way
 * of calling somebody shady and none for the three sides they might actually
 * be on. "Came back mafia" was read; "came back Cult" was dropped, so the one
 * finding in the game that names a *confirmed* member of a growing faction was
 * the one finding the board never heard.
 *
 * The solo killers are here on the same argument. Nothing in either language
 * calls somebody an arsonist as a figure of speech.
 *
 * And "weird", which is how a person who has nothing checkable says they have a
 * feeling: "I still think 21 is weird" (`9RVWV`, 564s) was read as nothing.
 * French already had its "bizarre" and "chelou".
 */
const EVIL =
  /\b(?:weird|sketchy|strange|sus|suspicious|suspect|suspecte|suspects|mafia|maf|scum|evil|wolf|liar|lying|lies|lied|guilty|shady|dodgy|fishy|bad|dirty|red|louche|chelou|menteur|menteuse|ment|mentait|coupable|bizarre|traitre|traite|rouge|mauvais|sk|serial killer|tueur en serie|cult|cultist|culte|secte|sectateur|triad|triade|arsonist|incendiaire|witch|sorciere)\b/i;

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
 *
 * And "town" only when "crier" does not follow it. The Town Crier is the one
 * badge whose name starts with a verdict, and "Fantasio claimed town crier. And
 * he can't be town crier" was filed as a *clearing* of the seat whose claim was
 * being contested (`WJBJK`, 742s).
 */
const GOOD =
  /\b(?:town(?! ?crier)|townie|clean|fine|trust|trusted|trustworthy|innocent|legit|confirmed|vouch|safe|good|confirme|confiance|fiable|blanc|innocente|innocent|clean)\b/i;

/**
 * Pushing a rope, in either language.
 *
 * With the French imperatives: "votez 7" was read as nothing while "vote 7"
 * was an accusation.
 */
const AGAINST =
  /\b(?:vote|votes|voting|voted|votez|voter|votons|hang|hanging|lynch|lynching|eliminate|kill|rope|pend|pends|pendre|pendez|lynche|lynchez|lyncher|elimine|eliminez|contre|dehors|sortez)\b/i;

/** Pulling one back. */
const NEGATED =
  /\b(?:not|no|never|dont|don'?t|doesn'?t|isn'?t|ain'?t|stop|pas|jamais|plus|arrete|arretez|surtout pas)\b/i;

/**
 * A sentence that offers two answers and picks neither.
 *
 * "Pinhead and Loki are either town power or evil" is a piece of reasoning, and
 * it asserts nothing at all about either house: the whole point of it is that
 * the speaker does not know which half is true. Read as a verdict it comes out
 * as a *clearing* of both, because "town" is the first word either side of the
 * house that this reader recognises — which is how a human working through the
 * conversion rules out loud ended up vouching for two seats he was in the
 * middle of suspecting. From a real table, and both readers made the same
 * mistake on the same sentence.
 *
 * So a disjunction files nothing. Missing a claim costs the board one reading;
 * inventing one costs somebody the rope, and this reader's whole discipline is
 * that a wrong entry is worse than a missing one.
 */
/**
 * And "between 7 and 12, one is lying", which is the same sentence with the
 * alternatives spelled out. It mattered less while " and " cut every window in
 * two; now that "7 and 12 are mafia" hands both houses the verdict (see
 * `CONJOINED`), it would accuse two seats of what the speaker pinned on one.
 */
const EITHER =
  /\b(?:either|soit|ou bien|between|entre|one of (?:them|those|these|the two|you)|l'?un (?:d'?eux|des deux)|un des deux)\b/i;

/**
 * A question about somebody, put to somebody else.
 *
 * "James Bond??? why do you vote guilty on sardine?" is Keeper asking James Bond
 * to explain his ballot, and the reader filed it as Keeper accusing *both* of
 * them, because "guilty" sat between the two names (`55USN`, 1590s). "What are
 * the reasons for Big boss to be mafia ?" is a person asking the room for a
 * case, and it was filed as that person making one (`P6TJ9`, 653s). The verdict
 * words in both sentences belong to the question, not to the speaker.
 *
 * So a house named *inside* one of these frames is the subject of a question
 * and gets nothing, and a house named just *before* one is the person being
 * asked and gets a `question`. Deliberately narrow: "why is 7 lying?" is an
 * accusation with a question mark on it and still reads as one. Only the frames
 * that ask about somebody's reasons, or ask why they would *be* something.
 *
 * And "who did you vote", which asks for a ballot: "who did you vote Hulk?"
 * was an accusation of Hulk, "vote" being the nearest word the reader knew.
 */
const WONDERING =
  /\b(?:who (?:did|do|will|are|were) (?:you|u) (?:vote|voting)|pour qui (?:tu as|t'?as|as[- ]tu|tu votes|vous avez) ?(?:vote)?|why (?:do|did|does|are|were|would|should|have) (?:you|u|they|he|she|people|everyone|y'?all)|why (?:would|should|could|is|was) \S+ (?:be|been)|what (?:are|is|were) (?:the |your |his |her )?reasons?|reasons? (?:for|why)|what makes (?:you|u) (?:think|say)|how (?:is|can|could|would) \S+ be|pourquoi (?:tu|vous|il|elle|ils|on)|pourquoi \S+ serait|quelles? (?:sont|est) (?:les |la |tes |vos |ses )?raisons?|qu'?est-ce qui (?:te|vous) fait (?:dire|penser))\b/i;

/**
 * "And he can't be town crier." A badge denied to somebody named a breath ago.
 *
 * The denial and the house are in different sentences, so the per-house window
 * never sees them together. Resolved only when the line names exactly one
 * house, in front of the pronoun: that is the only reading a person at the
 * table would make of it, and with two houses in play it is a guess.
 */
const PRONOUN_DENIES =
  /\b(?:he|she|they|il|elle)\s+(?:can'?t be|cannot be|could ?n'?t be|is not|isn'?t|ain'?t|never was|ne peut pas etre|n'?est pas)\s+(?:the |a |an |le |la |un |une )?/gi;

/**
 * "Before turning into a citizen." A badge that changed, said out loud.
 *
 * Roles change in this game: the Auditor turns a Sheriff into a Citizen, the
 * lodge initiates, the Cult converts, an Amnesiac remembers. (The Mason in the
 * example below has since been put out of the Auditor's reach.) A person
 * explaining that is telling the room
 * their *current* badge and how they came by it, and the reader filed the old
 * one: "Aragon I was mason with you before turning into a citizen" went on the
 * board as a Mason claim (`9RVWV`, 957s), and the lodge spent the rest of the
 * game counter-claiming the Citizen he actually was.
 *
 * Without one of these words a past tense is still a confession, "I was the
 * poisoner", and is read the way it always was.
 */
const BECAME =
  /\b(?:now|turned into|turning into|turns? into|turned me into|changed me|changed into|made me|converted|became|become|devenu|devenue|maintenant|transforme|transformee)\b/gi;

/**
 * What may sit between a change-of-role marker and the role, and nothing else.
 *
 * "now I am citizen", "changed me to citizen", "converted me into a mason".
 * Anything longer is a different sentence: "now I think the doctor is lying"
 * is not a claim to be the doctor.
 */
const BECAME_GAP =
  /^[\s,]*(?:(?:and|et|so|now|maintenant|i'?m|im|i am|i was|je suis|j'?suis|me|to|into|in|en|a|an|the|le|la|un|une|just|officially|actually)\s+)*$/i;

/** A change of role denied: "were not converted", "jamais devenu". */
const NOT_BECAME = /\b(?:not|never|n'?t|pas|jamais)\s+(?:\S+\s+)?$/i;

/**
 * A question put to a house rather than about one.
 *
 * "I want to hear jon snow defence" (`55USN`, 996s) and "I want to hear
 * Hypnos" (`P6TJ9`, 705s) are a person handing the floor to a seat, which is
 * exactly what a `question` makes a bot do, and both were read as nothing.
 */
const ASKED =
  /\b(?:want to hear|wanna hear|let'?s hear|veux entendre|voudrais entendre|aimerais entendre|where were you|where was|what did you|who did you|explain|explains|answer me|why (?:did|are|were)|prove it|t'?etais ou|tu etais ou|ou etais tu|qu'?as tu fait|tu as fait quoi|explique|repond|reponds|pourquoi|prouve)\b/i;

/**
 * A question about somebody's badge.
 *
 * The commonest question at the table after "where were you", and the one a
 * seat has to answer *differently*: a bot asked for its role and answering with
 * its night has dodged. "10 your role ?", "what is your role jon ?" (`9RVWV`,
 * 1580s and 1566s), "Hypnos I want to know your role" (`P6TJ9`, 662s), the
 * last with no question mark at all, so the plain question rule never saw it.
 *
 * Second person, or "role?" hung on a house: "what was his role" is somebody
 * wondering about a corpse. "what are you" stops short of "what are you
 * doing", which asks for something else entirely.
 */
const ROLE_ASKED =
  /(?:\b(?:your|ur|ton|votre)\s+(?:role|badge)\b|\bwhat(?:'?s| is| was)? (?:your|ur) claim\b|\bwhat (?:role\b|are (?:you|u)\b(?!\s+(?:doing|saying|talking|on|thinking|hiding|waiting|going|trying|voting|playing|up|accusing)))|\bwhich role\b|\brole\s*\?|\b(?:role ?)?claim (?:please|pls|plz|now)\b|\bquel (?:est )?role\b|\bt'?es quoi\b|\btu es quoi\b|\bvous etes quoi\b|\bt'?es qui\b|\btu es qui\b|\btu claim quoi\b)/i;

/** Talking to somebody: what makes an unaddressed question one put to the seat on the stand. */
const SECOND_PERSON = /\b(?:you|u|your|ur|tu|t'|toi|ton|ta|tes|vous|votre)\b/i;

/**
 * Asking for somebody to be put on the stand, without the word "vote".
 *
 * "Let's bring Hulk to trial and see what he have to say" (`9RVWV`, 1125s),
 * "let's get 11 now please" (`55USN`, 1757s), "Obviously just try 11 now"
 * (1798s): three calls for a rope and none of them read, because `AGAINST`
 * is a list of *verbs for hanging* and nobody here used one.
 *
 * Narrow on purpose. "try" only as a call ("just try", "let's try"), because
 * "you tried Keeper and you were wrong" is history. "trial" only as where the
 * house is being sent, because "Hulk is on trial" is a fact about the clock.
 */
const CALL_BEFORE =
  /\b(?:(?:let'?s|lets|we should|we must|should|just|now)\s+(?:get|try|trial)|go (?:for|after)|get rid of)\s*$/i;
const CALL_SEND = /\b(?:put|bring|send|get|take)\s*$/i;
const CALL_WHERE = /^\s*(?:(?:to|on|up for|up to|in) (?:trial|the stand)\b|up\b(?! to\b))/i;

/**
 * A house named as the one a killer went for, which is the opposite of a verdict.
 *
 * "N2 Mafia attacked 3" is a Spy's notes and it was filed as an accusation of
 * house 3, the seat the same notes went on to call clean (`55USN`, 1435s),
 * because "mafia" was the nearest word the reader knew. "N5 Mafia want to kill
 * 11" was an accusation twice over, "kill" being a word for hanging as well.
 * And a house that "survived" or "was attacked" is being reported on, not
 * judged: "3 and 11 survived mafia twice" (1279s) accused 11 of being the
 * mafia that attacked it.
 */
const VICTIM_BEFORE =
  /\b(?:mafia|maf|mafieux|sk|serial killer|killers?|arsonist|cult|triad|witch|tueur)\s+(?:\S+\s+){0,2}?(?:attacked|attacks?|attacking|killed|kills?|tried to kill|wants? to kill|wanted to kill|targeted|targets?|hit|shot|went (?:after|to|for)|visited|a attaque|attaque|a tue|tue|veut tuer|voulait tuer|a vise|vise)\s*$/i;
const VICTIM_AFTER =
  /^\s*(?:\S+\s+){0,2}?(?:survived|was attacked|got attacked|was targeted|was target|got targeted|has been attacked|a survecu|a ete attaque|a ete vise)\b/i;

/**
 * "I can confirm Keeper is Mason." A vouch, said the way a Mason says it.
 *
 * `55USN`, 1645s, typed as "cofirm" by a Mason standing up for his brother on
 * the stand, and read as nothing. First person only: "can you confirm 7?" is
 * a question.
 */
const CONFIRMS =
  /\b(?:(?:i|we)\s+(?:can\s+)?(?:confirm|cofirm|comfirm|vouch for)|je (?:peux )?confirmer?)\s*(?:that\s+|que\s+)?$/i;

/**
 * "Donald Duck and Dumbledore are the two last mafia."
 *
 * One verdict, two houses, and the reader gave it to the second only (`BQ75Z`,
 * 938s), because " and " ends a clause and the first house's half of the
 * sentence was empty. Houses joined by nothing but "and" share the words
 * around the pair: the verb in front ("vote 12 and 13") and the verdict
 * behind ("12 and 13 are mafia"). Only for a house that has no reading of its
 * own, so "vote 12, 13 is town" stays two different things. Not a bare comma,
 * which is as often somebody being addressed: "Hulk, Remy is lying".
 */
const CONJOINED = /^[\s,]*(?:and|et|&)[\s,]*$/i;

/**
 * "He is evil." A verdict passed on a pronoun, a sentence after the house.
 *
 * "11 survived 2 attack. He didn't even role claim. He is evil" (`55USN`,
 * 1456s) and "I can cofirm Keeper is Mason. He is town" (1648s): people type
 * the house, then the case, then the verdict, and the verdict names nobody.
 * Resolved only when the utterance names exactly one house, in front of the
 * pronoun, and that house has no verdict yet; anything else is a guess.
 */
const PRONOUN_IS =
  /\b(?:he|she|il|elle)\s*(?:'s|is|was|isn'?t|wasn'?t|n'?est|est|etait|n'?etait)\b|\b(?:he|she|il|elle)\s+(?=(?:lies|lied|is lying|'s lying|was lying|ment|mentait|a menti)\b)/gi;
/** Between the pronoun and its verdict: adverbs and articles, nothing that says anything. */
const PRONOUN_FILLER =
  /^\s*(?:(?:so|really|definitely|def|clearly|obviously|probably|surely|totally|very|also|too|100%|deja|vraiment|clairement|surement|forcement|bien|tellement|completement|aussi|not|pas|the|a|an|un|une|le|la)\s+)*/i;
/**
 * And the same reported speech in front of a house: "Remy said Hulk is mafia".
 *
 * The verdict is Remy's, relayed, and it was filed as the speaker's own. Only
 * a reporting verb with nothing but a house or a pronoun in front of it, so
 * "I said Hulk is mafia" is still the speaker standing by their word. The ear
 * files relays as relays; this reader has no kind for one and files nothing.
 */
const RELAYED =
  /^\s*(?:(?:he|she|they|il|elle|ils|elles)\s+)?(?:said|says|claims?|claimed|thinks|told (?:us|me) that|wrote|a dit|dit|disait|pense|croit)\s+(?:that\s+|que\s+|qu')?$/i;

/** "Hulk or Remy is mafia": two houses offered as alternatives, which is a guess at either. See `EITHER`. */
const ALTERNATIVE = /^[\s,]*(?:or|ou)[\s,]*$/i;

/** Reported speech straight after a house: what follows is that house's claim. See `QUOTED`. */
const QUOTED_AFTER =
  /^\s*(?:said|says|keeps saying|claims?|claimed|told (?:us|me|you)|tells (?:us|me|you)|thinks|wrote|a dit|dit|disait|pretend|pense|croit)\b/i;
/** Somebody else's words: "Hulk said he is town" is Hulk's claim, not the speaker's. */
const QUOTED =
  /\b(?:said|says|say|claims?|claimed|thinks?|thought|told|tells|wrote|dit|disait|pense|croit|pretend|a ecrit)\b/i;

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
    /**
     * "The doctor" only when nobody is claiming to be one: "I am the doctor,
     * Hulk is town" was filed as the self-proclaimed Doctor having been healed.
     */
    cue: /\b(?:healed|(?<!\b(?:i am|i'?m|im|i was|je suis|j'?etais) )(?:the doctor|le medecin|le docteur)|doc saved|patched (?:me )?up|soigne|soignee|on m'?a soigne)\b/i
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
 *
 * A colon is not a boundary *forwards*, for exactly the same reason and on
 * exactly the same sentence. "Night 1, Robin: clean" is the other shape every
 * sheriff's will is written in — the will generator in this codebase produces
 * it — and the colon there does not end what is being said about Robin, it
 * introduces it. Cutting there threw away every check written that way: a dead
 * Sheriff's four findings reached the board as one, and the town went on
 * hanging people for having "never given an account".
 *
 * Backwards it still is a boundary, which is the same asymmetry the comma has
 * and for the same reason: reading back from a house into somebody else's
 * verdict is how a reader files the opposite of what was said.
 */
const CLAUSE = /;| and | but | or | so | then | et | mais | ou | donc | puis /i;

/** The run-out's boundaries plus the two that only end a sentence looking back. */
const CLAUSE_END = new RegExp(`:|\\. |${CLAUSE.source}`, 'i');

/**
 * The run-up to a house: from the previous clause boundary, at most `NEAR` back.
 *
 * A comma counts here and not in the run-out, which is the asymmetry the two
 * sentences ask for. "7 is sus, 4 is fine" reads backwards from 4 into a
 * verdict that was passed on 7, so the comma has to stop it; "checked 7, came
 * back bad" reads forwards from 7 into the rest of its own report, so it must
 * not. A comma ends what was being said about the house before it.
 */
const CLAUSE_BACK = new RegExp(`,|${CLAUSE_END.source}`, 'i');

function runUp(line: string, from: number, at: number): string {
  const window = line.slice(Math.max(from, at - NEAR), at);
  const parts = window.split(CLAUSE_BACK);
  return parts[parts.length - 1] ?? window;
}

/** And the run-out: up to the next clause boundary, at most `NEAR` on. */
function runOut(line: string, at: number, to: number): string {
  const window = line.slice(at, Math.min(to, at + NEAR));
  // A full stop still ends a report; a colon introduces one. See `CLAUSE`.
  return window.split(new RegExp(`\\. |${CLAUSE.source}`, 'i'))[0] ?? window;
}

/** The seat on the stand, which an unaddressed question in the square is put to. See `onTrial`. */
export function standSlot(state: MafiaState): number | null {
  return state.trial ? (state.players[state.trial.accusedId]?.slot ?? null) : null;
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
    /**
     * The seat on the stand, which is who a question naming nobody is put to.
     *
     * "your role ?" typed during a trial (`9RVWV`, 2023s) is a question to the
     * accused, and every person in the room read it that way; the reader saw
     * no house and filed nothing. Absent, an unaddressed question is dropped
     * as before. Never applied to the accused's own lines.
     */
    onTrial?: number;
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
  /**
   * And not when the sentence has already named whose night it is.
   *
   * "I" anywhere in the line used to be enough, so a person reasoning about
   * somebody *else's* night was filed as having had it: "I am Spy. 3 and 11
   * survived mafia twice" put a survived attack on the Spy, "I don't know what
   * 11 is but if nobody healed him..." a heal (`55USN`, 1279s and 1311s). A
   * house named earlier in the same sentence is the subject of what follows
   * it, unless a first person comes back between them or in the cue's own
   * words: "11 tried to kill me" is still the speaker's night.
   */
  const mine = (at: number, length = 0): boolean => {
    if (!explicit && options.implicitSelf !== true) return false;
    const start = sentenceStart(line, at);
    const subject = hits.filter((hit) => hit.at >= start && hit.end <= at).pop();
    if (subject && !SELF.test(line.slice(subject.end, at + length + 4))) return false;
    return explicit || !hits.some((hit) => hit.at < at);
  };

  // "I am the Sheriff." The room parser already knows how to read one.
  const role = selfClaim(text);
  const became = explicit || options.implicitSelf === true ? becameRole(line, hits) : null;
  if (became) {
    // The badge the line says it holds *now*. See `BECAME`.
    add({ kind: 'role-claim', targetSlot: speakerSlot, claimedRole: became.role });
  } else if (role) {
    add({ kind: 'role-claim', targetSlot: speakerSlot, claimedRole: role });
  }

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
    const found = cue.exec(line);
    if (found && mine(found.index, found[0].length)) {
      add({ kind: 'ailing', targetSlot: speakerSlot, ailment });
      break;
    }
  }

  // "I never left." Only when the line is not busy saying where it went.
  const visitedAt = line.search(VISITED);
  const home = HOME.exec(line);
  if (home && visitedAt < 0 && mine(home.index, home[0].length)) {
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

  /**
   * "what is your role jon ?" A question about a badge, put to the house the
   * sentence names, nearest the words that ask it; to the seat on the stand
   * when it names none. See `ROLE_ASKED`.
   *
   * Before the houses are read one at a time, so the question reaches the board
   * carrying what it asks about: the plain question rule below would file the
   * same question without it, and the board keeps whichever came first.
   */
  for (const match of line.matchAll(new RegExp(ROLE_ASKED.source, 'gi'))) {
    const at = match.index ?? 0;
    const to = addressee(line, hits, at, at + match[0].length) ?? options.onTrial;
    if (to !== undefined && to !== speakerSlot) add({ kind: 'question', targetSlot: to });
  }

  /** What the words either side of one house say about it, before anything is filed. */
  const judge = (hit: SeatHit, before: string, after: string, guess = false): SquareClaim[] => {
    const near = `${before} ${after}`;

    /**
     * Asked, rather than asked about. See `WONDERING`: the subject of one of
     * those questions has already been passed over by the caller.
     */
    if (WONDERING.test(after)) return [{ kind: 'question', targetSlot: hit.slot }];

    /**
     * The house as the one doing the saying. "Hulk said he is town" is Hulk's
     * claim reported, and it was filed as the speaker clearing Hulk on the
     * strength of the word "town" in somebody else's mouth.
     */
    if (QUOTED_AFTER.test(after)) return [];
    // And the house as what somebody else said something about. See `RELAYED`.
    if (RELAYED.test(before)) return [];

    /**
     * A house somebody was seen at, or seen going to.
     *
     * The cue can sit anywhere before the house ("I saw 4 walk into 7") or
     * behind it ("7 had a visitor"), and either way the house named is the one
     * the sighting is about. A seat reporting its *own* journey has already
     * been filed as an account above and is skipped.
     */
    if ((sawAt >= 0 && hit.at > sawAt) || VISITED_BY.test(near)) {
      return [{ kind: 'sighting', targetSlot: hit.slot }];
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
    // The house a killer went for is being reported on, not judged. See `VICTIM_BEFORE`.
    const victim = VICTIM_BEFORE.test(before) || VICTIM_AFTER.test(after);
    const evilAt = victim ? -1 : near.search(EVIL);
    const goodAt = near.search(GOOD);
    // A call for the stand counts as a rope. See `CALL_BEFORE`.
    const called = CALL_BEFORE.test(before) || (CALL_SEND.test(before) && CALL_WHERE.test(after));
    const rope = !victim && (AGAINST.test(before.slice(-24)) || AGAINST.test(after.slice(0, 18)) || called);

    /**
     * "He cannot be the Doctor" — a denial of a badge, not of a person.
     *
     * Checked before the evil/good verdicts, because the words that carry it
     * ("is not", "can't be") are the same ones `NEGATED` uses, and read as a
     * verdict the sentence comes out as a *clearing* of the seat whose badge is
     * being torn up. Which is backwards, and was the reading until now.
     */
    const badge = roleNamedAt(after, 'first')?.role ?? roleNamedAt(before, 'last')?.role;
    if (badge && DENIES.test(near)) {
      const denial: SquareClaim[] = [{ kind: 'counter-claim', targetSlot: hit.slot, deniedRole: badge }];
      /**
       * And the rope, when the same breath asks for one.
       *
       * "vote for athena she is not jester" is two claims and this read one of
       * them: the badge branch filed the denial and went straight to the next
       * house, so the only part of the sentence the room acted on was the part
       * that moves no suspicion. A person who types a house number after the
       * word "vote" has named somebody to hang, whatever else the line does,
       * and that is the half the afternoon runs on. From a real table, where
       * the human said it twice and the board recorded neither vote.
       *
       * Deliberately only the rope, and not the evil/good verdicts below: those
       * read the same negation this branch has already consumed, and letting
       * them run would file the denial twice over with the sign flipped.
       */
      if (AGAINST.test(before.slice(-24)) && !NEGATED.test(before.slice(-18))) {
        denial.push({ kind: 'accuse', targetSlot: hit.slot });
      }
      return denial;
    }

    /**
     * "Susanoo is Electromaniac" — naming the badge instead of the camp.
     *
     * The commonest way a person accuses somebody, and the reader had no way to
     * hear it. `EVIL` is a vocabulary of *words for being bad*: mafia, scum,
     * liar, cult, arsonist. A player who has worked out which killer they are
     * looking at does not say any of those, they say the role, and there are
     * sixty-three of those in this game. "Susanoo is Electromaniac" was read as
     * nothing three times in one afternoon, and the fourth time — "town trust
     * me I am with you! Susanoo is the Electromaniac" — it was read as a
     * *clearing* of Susanoo, because "trust" was the nearest word the reader
     * knew. From a real table, and the accusation the board recorded was the
     * exact opposite of the one the man made.
     *
     * Read off the role catalogue rather than off a word list, so it covers
     * every killer in the game in both languages and cannot drift from the
     * roles themselves. Only the killers: a Jester or an Executioner named at
     * somebody is a suspicion and not an accusation of murder, and the words
     * the room actually uses for those are in `EVIL` already.
     *
     * After the denial branch, which has first claim on the same sentence
     * shape and has already consumed "7 is not the arsonist", and before the
     * verdicts, which is the bug this fixes.
     *
     * The badge has to be named *after* the house, which is the shape people
     * type and is the one that cannot be confused with attribution. "The
     * consigliere said 3 is clean" names a killer in front of a house and
     * accuses nobody of anything, and reading it the other way would hang the
     * seat somebody was vouching for.
     */
    const named = victim ? undefined : roleNamedAt(after, 'first')?.role;
    if (named && isEvilRole(named)) return [{ kind: 'accuse', targetSlot: hit.slot }];

    // "I can confirm Keeper is Mason." See `CONFIRMS`.
    if (CONFIRMS.test(before)) return [{ kind: 'clear', targetSlot: hit.slot }];

    // "not 11" is a reprieve whatever else the line is doing.
    if (refused) return [{ kind: 'clear', targetSlot: hit.slot }];
    // A verdict offered as one of two possibilities is not a verdict. See `EITHER`.
    const guessing = guess || EITHER.test(near);
    if (evilAt >= 0 && !guessing) return [{ kind: denied(evilAt) ? 'clear' : 'accuse', targetSlot: hit.slot }];
    if (goodAt >= 0 && !guessing) return [{ kind: denied(goodAt) ? 'accuse' : 'clear', targetSlot: hit.slot }];
    if (rope) return [{ kind: NEGATED.test(before.slice(-18)) ? 'clear' : 'accuse', targetSlot: hit.slot }];

    /**
     * Put to the house rather than said about it.
     *
     * A question mark alone is enough when a house is named and nothing else in
     * the line is an assertion: "7?" is the whole of what most people type, and
     * it is unambiguously an approach to house 7.
     */
    if (ASKED.test(near) || (line.includes('?') && hits.length <= 2)) {
      return [{ kind: 'question', targetSlot: hit.slot }];
    }
    return [];
  };

  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    const previous = hits[index - 1];
    const next = hits[index + 1];

    // Already accounted for as the house this seat says it visited.
    if (filed.some((claim) => claim.kind === 'account' && claim.targetSlot === hit.slot)) continue;

    /**
     * Asked about. See `WONDERING`.
     *
     * The subject of a question gets nothing, whatever verdict words the
     * question carries. Checked before every verdict, because every verdict
     * would otherwise read the question's own words as the speaker's.
     */
    if (insideQuestion(line, hit.at)) continue;

    /**
     * "Donald Duck and Dumbledore are the two last mafia." See `CONJOINED`.
     *
     * The run of houses this one is joined to by "and", and the words around
     * the whole run. A house with nothing said about it on its own is read
     * again with those. Only the verdicts and the question carry across: a
     * denied badge or a sighting is about the house it was said next to.
     */
    const joined = (left: SeatHit, right: SeatHit): boolean => CONJOINED.test(line.slice(left.end, right.at));
    let first = index;
    while (first > 0 && joined(hits[first - 1], hits[first])) first--;
    let last = index;
    while (last < hits.length - 1 && joined(hits[last], hits[last + 1])) last++;
    const runBefore = runUp(line, hits[first - 1]?.end ?? 0, hits[first].at);
    const runAfter = runOut(line, hits[last].end, hits[last + 1]?.at ?? line.length);

    // "between 12 and 13, one is lying" is a guess at either, read from either. See `EITHER`.
    if (first !== last && EITHER.test(`${runBefore} ${runAfter}`)) continue;

    // Offered as one of two. See `ALTERNATIVE`.
    const offered =
      (previous !== undefined && ALTERNATIVE.test(line.slice(previous.end, hit.at))) ||
      (next !== undefined && ALTERNATIVE.test(line.slice(hit.end, next.at)));

    let claims = judge(
      hit,
      runUp(line, previous?.end ?? 0, hit.at),
      runOut(line, hit.end, next?.at ?? line.length),
      offered
    );
    if (claims.length === 0 && first !== last) {
      claims = judge(hit, runBefore, runAfter).filter(
        (claim) => claim.kind === 'accuse' || claim.kind === 'clear' || claim.kind === 'question'
      );
    }
    for (const claim of claims) add(claim);
  }

  /** "…Fantasio claimed town crier. And he can't be town crier." See `PRONOUN_DENIES`. */
  if (hits.length === 1) {
    const [only] = hits;
    for (const match of line.matchAll(PRONOUN_DENIES)) {
      if (match.index === undefined || match.index < only.end) continue;
      const badge = roleNamedAt(line.slice(match.index + match[0].length), 'first');
      if (!badge || badge.at !== 0) continue;
      add({ kind: 'counter-claim', targetSlot: only.slot, deniedRole: badge.role });
      break;
    }
  }

  /** "11 survived 2 attack. He didn't even role claim. He is evil." See `PRONOUN_IS`. */
  const only = hits[0];
  const last = hits[hits.length - 1];
  const judged = (slot: number): boolean =>
    filed.some((claim) => (claim.kind === 'accuse' || claim.kind === 'clear') && claim.targetSlot === slot);
  if (only && hits.every((hit) => hit.slot === only.slot) && !judged(only.slot)) {
    for (const match of line.matchAll(PRONOUN_IS)) {
      if (match.index === undefined || match.index < last.end) continue;
      // Somebody else's words, in the pronoun's own sentence: "Hulk said he is town".
      if (QUOTED.test(line.slice(Math.max(last.end, sentenceStart(line, match.index)), match.index))) break;
      const rest = runOut(line, match.index + match[0].length, line.length);
      const filler = PRONOUN_FILLER.exec(rest)?.[0] ?? '';
      const word = rest.slice(filler.length);
      const negated = /n'?t\b|\bn'|\bnot\b|\bpas\b/.test(`${match[0]} ${filler}`);
      const killer = roleNamedAt(word, 'first');
      let verdict: 'accuse' | 'clear' | null = null;
      if (/^(?:lies|lied|is lying|'s lying|was lying|ment|mentait|a menti)\b/.test(word)) verdict = 'accuse';
      else if (killer?.at === 0 && isEvilRole(killer.role) && !negated) verdict = 'accuse';
      else if (word.search(EVIL) === 0) verdict = negated ? 'clear' : 'accuse';
      else if (word.search(GOOD) === 0) verdict = negated ? 'accuse' : 'clear';
      if (verdict) {
        add({ kind: verdict, targetSlot: only.slot });
        break;
      }
    }
  }

  /**
   * "who else did you jail ?" Naming nobody, typed during a trial: put to the
   * accused. See `onTrial`. Only a line that is talking *to* somebody and asks
   * something; "did someone heal him ?" is a question to the room.
   */
  const accused = options.onTrial;
  if (hits.length === 0 && accused !== undefined && accused !== speakerSlot) {
    if (SECOND_PERSON.test(line) && (line.includes('?') || ASKED.test(line))) {
      add({ kind: 'question', targetSlot: accused });
    }
  }

  return filed;
}

/** Whether a house sits inside a `WONDERING` frame, in the same sentence. */
function insideQuestion(line: string, at: number): boolean {
  for (const match of line.matchAll(new RegExp(WONDERING.source, 'gi'))) {
    if (match.index === undefined || match.index >= at) break;
    if (!/[.!?](?:\s|$)/.test(line.slice(match.index, at))) return true;
  }
  return false;
}

/**
 * The role a line says the speaker holds now, and where its marker sits.
 *
 * The first marker followed, after nothing but filler, by a role and with no
 * house in between. See `BECAME`.
 */
function becameRole(line: string, hits: readonly { at: number }[]): { role: RoleId } | null {
  for (const match of line.matchAll(BECAME)) {
    if (match.index === undefined) continue;
    if (NOT_BECAME.test(line.slice(Math.max(0, match.index - 14), match.index))) continue;
    const from = match.index + match[0].length;
    const found = roleNamedAt(line.slice(from), 'first');
    if (!found || !BECAME_GAP.test(line.slice(from, from + found.at))) continue;
    if (hits.some((hit) => hit.at >= from && hit.at < from + found.at)) continue;
    return { role: found.role };
  }
  return null;
}

/**
 * Whether a line asks somebody what role they hold.
 *
 * The one reading of it, shared with the seat that decides whether to answer
 * (see `roleAnswer` in seat.ts), which had its own looser copy and heard "who
 * are you voting for?" and "your claim is fake" as the question.
 */
export function asksRole(text: string): boolean {
  return ROLE_ASKED.test(fold(text));
}

/** Where the sentence holding `at` begins: just after the last full stop, "!" or "?" in front of it. */
function sentenceStart(line: string, at: number): number {
  let start = 0;
  for (const match of line.slice(0, at).matchAll(/[.!?]+\s+/g)) start = (match.index ?? 0) + match[0].length;
  return start;
}

/**
 * The house a question between `from` and `to` is put to.
 *
 * The one named in the same sentence, nearest the question: "Minie what is your
 * role? you claimed…", "what is your role jon ?". Or, when the sentence before
 * is nothing but a house, that house: "10" and then "your role ?" typed as two
 * lines, which `utterance` joins into "10. your role ?". Null otherwise.
 */
function addressee(line: string, hits: readonly SeatHit[], from: number, to: number): number | null {
  const start = sentenceStart(line, from);
  const rest = line.slice(to).search(/[.!?]+(?:\s|$)/);
  const end = rest < 0 ? line.length : to + rest;
  let best: SeatHit | null = null;
  let gap = Infinity;
  for (const hit of hits) {
    if (hit.at < start || hit.end > end) continue;
    const distance = hit.at >= to ? hit.at - to : Math.max(0, from - hit.end);
    if (distance < gap) {
      best = hit;
      gap = distance;
    }
  }
  if (best) return best.slot;
  const previous = hits.filter((hit) => hit.end <= start).pop();
  if (!previous) return null;
  const alone =
    /^[\s,]*$/.test(line.slice(sentenceStart(line, previous.at), previous.at)) &&
    /^[\s,.!?]*$/.test(line.slice(previous.end, start));
  return alone ? previous.slot : null;
}
