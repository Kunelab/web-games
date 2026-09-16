import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fumble } from './typos.js';

/** Every seed once, so a rate is a count rather than a coin flip. */
function sweep(text: string, tongue: 'en' | 'fr', names = new Set<string>()): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4000; i++) out.push(fumble(text, tongue, `seat-${i}`, names));
  return out;
}

describe('typing mistakes', () => {
  it('leaves the overwhelming majority of lines alone', () => {
    const line = 'Somebody went into the house last night and nobody has explained it';
    const wrong = sweep(line, 'en').filter((said) => said !== line).length;
    // Two independent 5% draws, so a shade under one line in ten.
    assert.ok(wrong / 4000 > 0.04, `too few mistakes: ${wrong}/4000`);
    assert.ok(wrong / 4000 < 0.16, `too many mistakes: ${wrong}/4000`);
  });

  it('never puts more than one mistake in a line', () => {
    const line = 'I will answer anything about their night, so somebody please ask me something';
    for (const said of sweep(line, 'en')) {
      if (said === line) continue;
      const before = line.split(/\s+/);
      const after = said.split(/\s+/);
      assert.equal(before.length, after.length, said);
      const differ = before.filter((word, index) => word !== after[index]).length;
      assert.equal(differ, 1, said);
    }
  });

  it('is deterministic in its seed', () => {
    const line = 'Whoever started this, explain it to the room before anybody votes';
    for (let i = 0; i < 200; i++) {
      assert.equal(fumble(line, 'en', `seat-${i}`), fumble(line, 'en', `seat-${i}`));
    }
  });

  /**
   * The one thing that would make this worse than no typos at all: a name or a
   * house number is what a reader checks an alibi against, and a slipped digit
   * is a different alibi rather than a typo.
   */
  it('never touches a protected name or a number', () => {
    const names = new Set(['baloo', 'magneto']);
    const line = 'Baloo went to Magneto on night 14, and house 7 has not answered that';
    for (const said of sweep(line, 'en', names)) {
      assert.ok(said.includes('Baloo'), said);
      assert.ok(said.includes('Magneto'), said);
      assert.ok(said.includes('night 14'), said);
      assert.ok(said.includes('house 7'), said);
    }
  });

  it('makes the mistakes a French speaker makes, in French', () => {
    const line = 'Il a dit ou il est allé cette nuit, et personne ne la contredit sur ce point';
    const said = new Set(sweep(line, 'fr').filter((text) => text !== line));
    assert.ok(said.size > 1, 'french lines should fumble in more than one way');
    // No English homophone leaks into a French table.
    for (const text of said) assert.ok(!/\b(their|there|you’re)\b/.test(text), text);
  });

  it('leaves a very short line alone entirely', () => {
    for (const short of ['…', 'Nothing.', 'Hey.', 'Morning.']) {
      assert.equal(new Set(sweep(short, 'en')).size, 1);
    }
  });

  it('keeps the case of a word it swaps', () => {
    const line = 'Their account of the night does not hold up at all, and they know it';
    for (const said of sweep(line, 'en')) {
      assert.ok(!said.startsWith('there ') && !said.startsWith('their '), said);
    }
  });

  /**
   * An apostrophe is a deliberate keystroke, not a run of letters the hand can
   * fumble: "q'uest-ce" reads as corrupted text rather than as haste.
   */
  it('never moves an apostrophe', () => {
    const line = 'Il a dit qu’est-ce qu’il a fait, et personne ne l’a contredit sur ce point';
    for (const said of sweep(line, 'fr')) {
      assert.ok(!/q[’']u/.test(said), said);
      assert.equal((said.match(/[’']/g) ?? []).length, (line.match(/[’']/g) ?? []).length, said);
    }
  });
});
