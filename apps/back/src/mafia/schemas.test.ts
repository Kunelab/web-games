// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DECIDE_FORMAT } from './bots.js';
import { HEARD_FORMAT, ROOM_FORMAT } from './ear.js';
import { JURY_FORMAT } from './jury.js';
import { MOUTH_FORMAT, readLine, SAY_CHARS } from './mouth.js';

/**
 * Every question the chain asks, and the shape it asks for.
 *
 * All five together, because the rule below is the kind that is obeyed four
 * times out of five and then quietly costs a deployment. `DECIDE_FORMAT` was
 * the fifth: it kept its `required` list and never got `additionalProperties`,
 * so strict structured output refused it — on the one question asked on every
 * bot turn, which is the worst possible one to have gone loose.
 */
const SCHEMAS: Record<string, unknown> = {
  decide: DECIDE_FORMAT,
  heard: HEARD_FORMAT,
  room: ROOM_FORMAT,
  jury: JURY_FORMAT,
  mouth: MOUTH_FORMAT
};

interface Node {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
}

/**
 * Walks a schema and reports every object in it that strict mode would refuse.
 *
 * Two rules, and they are the whole of what `strict: true` adds: an object must
 * close its door, and it must require every property it declares. A schema that
 * breaks either is not a slightly worse schema — it is a 400, and the endpoint
 * falls back to `json_object`, which asks only for valid JSON and gets bare
 * arrays that `extractJson` drops on the floor. See `REQUEST_SHAPES`.
 */
function strictViolations(node: unknown, path: string): string[] {
  if (node === null || typeof node !== 'object') return [];
  const found: string[] = [];
  const schema = node as Node;

  if (schema.properties) {
    const declared = Object.keys(schema.properties);
    if (schema.additionalProperties !== false) {
      found.push(`${path}: object does not set additionalProperties: false`);
    }
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const missing = declared.filter((key) => !required.includes(key));
    if (missing.length > 0) {
      found.push(`${path}: declared but not required: ${missing.join(', ')}`);
    }
    for (const key of declared) {
      found.push(...strictViolations(schema.properties[key], `${path}.${key}`));
    }
  }

  if (schema.items) found.push(...strictViolations(schema.items, `${path}[]`));
  return found;
}

describe('the shapes the chain asks for', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} is a schema strict structured output will accept`, () => {
      const violations = strictViolations(schema, name);
      assert.deepEqual(violations, [], violations.join('\n'));
    });
  }

  /**
   * Silence is a move, so the field the model says it in has to allow it.
   *
   * `readLine` has a branch for a seat that decides to keep quiet. Typed as a
   * bare string, that branch could never run under a strict schema — the model
   * is made to produce *a string* whatever it meant, and the one that meant
   * silence wrote the word "null" instead.
   */
  /**
   * The handwriting that gives a bot away.
   *
   * Counted on a real table: of seventy-one lines the bots said, five had an em
   * dash in them and six had markdown asterisks. Of the twelve a person typed,
   * none had either, and the six hundred line phrasebook does not contain one.
   * A player who notices it once can read the whole square at a glance, which
   * is a worse tell than anything a bot could say.
   */
  it('types its line rather than typesetting it', () => {
    const intent = { act: 'accuse', mood: 'blunt', fallback: 'FALLBACK' };
    const self = { name: 'Totoro', slot: 14 };
    const said = (line: string) => readLine({ line }, intent, self);

    assert.equal(said('Well, well, *Casper*—always the hero, eh?'), 'Well, well, Casper, always the hero, eh?');
    assert.equal(said('Casper has a *real* knack for disappearing.'), 'Casper has a real knack for disappearing.');
    assert.equal(said('The vote is locked, but **you**? You are a liar.'), 'The vote is locked, but you? You are a liar.');
    assert.equal(said('I saw them… and then nothing'), 'I saw them... and then nothing');

    /**
     * And the one mark that stays: the catalogue is full of curly apostrophes in
     * both languages and a phone puts one in by itself, so stripping it would
     * make the model's lines the odd ones out in the other direction.
     */
    assert.equal(said('Casper’s your role model?'), 'Casper’s your role model?');

    /**
     * A dash opening the line is the French dialogue dash, not an aside. Turned
     * into a comma like every other dash, it left the line starting on a comma
     * with nothing in front of it: ", Moi? J’etais chez moi."
     */
    assert.equal(said('— Moi ? J’etais chez moi.'), 'Moi? J’etais chez moi.');
    assert.equal(said('– Casper ment.'), 'Casper ment.');
  });

  /**
   * The calendar the game does not have.
   *
   * Both of these are real lines out of a benched game, said at a table on day 3.
   * They read as alibis and refer to nothing: there is no Saturday in Mafia and
   * there had been three nights, not twelve. A room cannot check either one, so
   * they are worse than saying nothing — they look like evidence.
   */
  it('refuses a weekday and a night that has not happened', () => {
    const intent = { act: 'defend', mood: 'blunt', fallback: 'FALLBACK' };
    const self = { name: 'Totoro', slot: 13 };
    const seats = new Set<string>();
    const said = (line: string, day = 3) => readLine({ line }, intent, self, seats, day);

    assert.equal(said("J'étais chez 6 samedi, personne ne m'a rien demandé."), 'FALLBACK');
    assert.equal(said('Nuit 12, maison 9, en plein bricolage.'), 'FALLBACK');
    assert.equal(said('I was home on Tuesday, ask anyone.'), 'FALLBACK');
    assert.equal(said('Rien fait du week-end.'), 'FALLBACK');
  });

  /**
   * A door that is not on the board, which is the same hallucination one step
   * sideways from a night that never happened.
   *
   * From a real table of fifteen: two seats said "17" in the same afternoon,
   * both while voting for house 10, and both copying word for word the example
   * that used to sit in `MOUTH_RULES`. The ballots were right and the square
   * watched two players name a door that does not exist.
   */
  it('refuses a house this table does not have', () => {
    const intent = { act: 'accuse', mood: 'blunt', fallback: 'FALLBACK' };
    const self = { name: 'Totoro', slot: 13 };
    const houses = new Set([1, 2, 10, 13, 15]);
    const said = (line: string) => readLine({ line }, intent, self, new Set<string>(), 9, houses);

    assert.equal(said("17, you're up to something."), 'FALLBACK', 'the line that started this');
    assert.equal(said('I was with 99 all night.'), 'FALLBACK');
    // Doors that exist are ordinary, and so are numbers that are not doors.
    assert.equal(said('10 has not answered anybody.'), '10 has not answered anybody.');
    assert.equal(said('Night 3 I was at 2.'), 'Night 3 I was at 2.');
    assert.equal(said('There are 3 of us left.'), 'There are 3 of us left.');
    // No roster given is the old behaviour: nothing to check against.
    assert.equal(readLine({ line: '17 is lying.' }, intent, self, new Set<string>(), 9), '17 is lying.');
  });

  /**
   * And a line that names a door other than the one the ballot went to.
   *
   * The engine votes from `decision.voteSlot` and the mouth only phrases it, so
   * a model that swaps the number leaves the seat saying one house and voting
   * another. `denies` deliberately only caught a flat refusal; this is the half
   * it left out.
   */
  it('mends a vote line that names the wrong door, and keeps the voice', () => {
    const intent = { act: 'vote', mood: 'blunt', fallback: 'FALLBACK', vote: { slot: 10, label: 'Ana' } };
    const self = { name: 'Totoro', slot: 13 };
    const houses = new Set([1, 2, 10, 13, 15]);
    const said = (line: string) => readLine({ line }, intent, self, new Set<string>(), 9, houses);

    // One wrong number and a decision that says what was meant: mend it.
    assert.equal(said('17, you are up to something.'), '10, you are up to something.');
    assert.equal(said('Voting 2, no debate.'), 'Voting 10, no debate.');
    // The seat's own number is a signature, not a target, and is left alone.
    assert.equal(said('13 here, and I am voting 10.'), '13 here, and I am voting 10.');
    // Two different wrong doors is not a slip, it is a different sentence.
    assert.equal(said('2 and 15 are both in this.'), 'FALLBACK');
  });

  /** A night that *has* happened is the whole point of asking where somebody was. */
  it('still lets a seat account for a night it actually lived', () => {
    const intent = { act: 'defend', mood: 'blunt', fallback: 'FALLBACK' };
    const self = { name: 'Totoro', slot: 13 };
    const seats = new Set<string>();
    const said = (line: string, day = 5) => readLine({ line }, intent, self, seats, day);

    assert.equal(said('Nuit 2 je suis resté chez moi.'), 'Nuit 2 je suis resté chez moi.');
    assert.equal(said('I watched 6 on night 5.'), 'I watched 6 on night 5.');
    // No day given at all is the old behaviour: nothing to check against.
    assert.equal(readLine({ line: 'Nuit 12, maison 9.' }, intent, self, seats), 'Nuit 12, maison 9.');
  });

  /**
   * One budget, not three.
   *
   * The mouth accepted 180 characters and the square clamped at 140, so a line in
   * between passed every check and was posted cut off mid-word with an ellipsis.
   * A line over budget is refused here, where there is still a phrasebook line to
   * fall back to; downstream there is only a knife.
   */
  it('refuses a line it would only have to cut', () => {
    const intent = { act: 'accuse', mood: 'blunt', fallback: 'FALLBACK' };
    const self = { name: 'Totoro', slot: 13 };
    const long = `${'mot '.repeat(40)}fin`;
    assert.ok(long.length > SAY_CHARS);
    assert.equal(readLine({ line: long }, intent, self), 'FALLBACK');

    const fits = 'a'.repeat(SAY_CHARS);
    assert.equal(readLine({ line: fits }, intent, self), fits);
  });

  it('lets the mouth answer with nothing at all', () => {
    const line = MOUTH_FORMAT.properties.line;
    assert.deepEqual([...line.type], ['string', 'null'], 'the mouth must be able to decline');
  });
});

/**
 * A stage direction the bracket test could not see.
 *
 * `readLine` throws away a line opening with a bracket or a star, because a
 * small model asked to be in character writes `*whispers*` or `(leaning back)`.
 * It writes the same thing in plain prose just as readily, and that walked
 * through: a Crier put `chuchote: " Le foot, parce qu'on marque des buts...`
 * into the square, attribution and quotation mark included. From a chaos run.
 */
describe('a line that narrates itself', () => {
  const intent = { act: 'say something', mood: 'dry', fallback: 'FALLBACK' };
  const self = { name: 'Lugh', slot: 8 };
  const said = (line: string) => readLine({ line }, intent, self);

  it('strips a spoken attribution and keeps the line', () => {
    assert.equal(said('chuchote: " Le foot, parce qu’on marque des buts'), 'Le foot, parce qu’on marque des buts');
    assert.equal(said('whispers: 7 is lying'), '7 is lying');
    assert.equal(said('Il murmure : personne ne me croit'), 'personne ne me croit');
  });

  /**
   * And leaves a name alone. "Zenitsu: ta nuit" is how people address each
   * other, and a rule that read any word before a colon as an attribution would
   * eat the name off every one of those.
   */
  it('does not mistake a name for a verb', () => {
    assert.equal(said('Zenitsu: ta nuit ?'), 'Zenitsu: ta nuit?');
    assert.equal(said('7: explique-toi'), '7: explique-toi');
  });
});

/**
 * The seat's own number at the front of its line.
 *
 * The prompt opens with "You are Trinity, number 15" and a small model reads
 * that as a letterhead, so the number comes back at the front of the sentence
 * beside the one the chat prints anyway. Trimming it is right; trimming it
 * unconditionally is not, because the same number is sometimes the subject.
 */
describe('a line that opens with the speaker’s own number', () => {
  const intent = { act: 'say something', mood: 'dry', fallback: 'FALLBACK' };
  const self = { name: 'Arwen', slot: 3 };
  const said = (line: string) => readLine({ line }, intent, self);

  it('trims the letterhead', () => {
    assert.equal(said('3, je suis le vétéran'), 'je suis le vétéran');
    assert.equal(said('3 Arwen is the culprit'), 'Arwen is the culprit');
  });

  /**
   * And leaves the line alone when the number is the subject. From a chaos run:
   * the model wrote "3 n'a pas voté hier, donc je vote en aveugle" and the
   * square got a sentence with no subject in it at all.
   */
  it('does not eat the subject of the sentence', () => {
    assert.equal(
      said('3 n’a pas voté hier, donc je vote en aveugle'),
      '3 n’a pas voté hier, donc je vote en aveugle'
    );
    assert.equal(said('3 est resté muet toute la journée'), '3 est resté muet toute la journée');
  });
});

/**
 * The guard that was eating French.
 *
 * A lone letter is thrown away because a model handed a name sometimes writes
 * the initial instead, and the room cannot vote for "F". The test for "this
 * letter belongs to a longer word" was `\w`, which is `[A-Za-z0-9_]` and does
 * not include an accented letter — so in "vétéran" the `v` is followed by `é`,
 * the lookahead passed, and the whole line was replaced by the phrasebook.
 *
 * Every model line with a consonant before an accent went the same way:
 * vétéran, détective, légiste, témoin, réponds, vérifie, décide. On a French
 * table that is most of what there is to talk about.
 */
describe('a consonant in front of an accent', () => {
  const intent = { act: 'say something', mood: 'dry', fallback: 'FALLBACK' };
  const self = { name: 'Arwen', slot: 3 };
  const said = (line: string) => readLine({ line }, intent, self);

  it('keeps the French words it used to throw away', () => {
    assert.equal(said('je suis le vétéran'), 'je suis le vétéran');
    assert.equal(said('le détective a parlé hier'), 'le détective a parlé hier');
    assert.equal(said('je vérifie et je réponds demain'), 'je vérifie et je réponds demain');
  });

  /** And still refuses a name written as one letter, which is the whole point. */
  it('still refuses a lone initial', () => {
    assert.equal(said('je vote pour F'), 'FALLBACK');
    assert.equal(said('F'), 'FALLBACK');
  });
});
