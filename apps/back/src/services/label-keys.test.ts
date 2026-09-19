import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { en } from 'i18n/locales/en';

/**
 * Every label key the code hands out has to exist in the catalogue.
 *
 * `render` deliberately falls through to printing the key itself when it cannot
 * find one, so a missing string is visible rather than blank — but visible only
 * to whoever happens to be looking at that screen. `field.work` was missing for
 * as long as the generated blind test has had anime, film, series and game
 * rounds in it: every one of those asked the room to name the work, and the
 * prompt above the answer box said `field.work`.
 *
 * Nothing caught it because the catalogue's own tests compare the two languages
 * against each other, and a key absent from both is absent consistently. This
 * compares the catalogue against the *code*, which is the direction that was
 * never checked.
 *
 * Scoped to the three prefixes `fieldText` treats as ours. Everything else a
 * screen renders goes through `msg()` at a call site the compiler can see, and
 * these are the keys that travel as plain strings inside data — which is why
 * they are the ones that can go missing quietly.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The trees where a label key can be written. */
const ROOTS = [join(HERE, '..'), join(HERE, '../../../../packages/game-core/src'), join(HERE, '../../../front/src')];

const KEY = /['"`]((?:field|ans|miss)\.[A-Za-z0-9_.]+)['"`]/g;

/**
 * Comments out, because this codebase quotes keys in them.
 *
 * `AnswersEditor` explains a past bug by naming the key that caused it, which
 * was never a real key and never will be. Reading it as one would make this
 * test fail over a sentence.
 *
 * Block comments go wholesale. A line comment is only cut when nothing on the
 * line is quoted, which is conservative on purpose: it can never swallow a
 * string, so it can never hide a key that is genuinely in use.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (/['"`]/.test(line) ? line : line.replace(/\/\/.*$/, '')))
    .join('\n');
}
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sources(path));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      found.push(path);
    }
  }
  return found;
}

describe('label keys', () => {
  it('all exist in the catalogue', () => {
    const used = new Map<string, string>();

    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const text = stripComments(readFileSync(file, 'utf8'));
        for (const match of text.matchAll(KEY)) {
          const key = match[1];
          if (key && !used.has(key)) used.set(key, file);
        }
      }
    }

    // A sanity floor: if the scan ever stops finding anything, this test would
    // otherwise pass by looking at nothing at all.
    assert.ok(used.size > 40, `expected to find plenty of label keys, found ${used.size}`);

    const missing = [...used].filter(([key]) => !(key in en));
    assert.deepEqual(
      missing.map(([key, file]) => `${key} (${file.replace(HERE, '')})`),
      []
    );
  });
});
