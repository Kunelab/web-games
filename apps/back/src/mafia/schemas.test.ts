// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DECIDE_FORMAT } from './bots.js';
import { HEARD_FORMAT, ROOM_FORMAT } from './ear.js';
import { JURY_FORMAT } from './jury.js';
import { MOUTH_FORMAT, readLine } from './mouth.js';

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
  });

  it('lets the mouth answer with nothing at all', () => {
    const line = MOUTH_FORMAT.properties.line;
    assert.deepEqual([...line.type], ['string', 'null'], 'the mouth must be able to decline');
  });
});
