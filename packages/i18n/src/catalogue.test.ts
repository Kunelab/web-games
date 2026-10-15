import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  interpolate,
  isLocale,
  LOCALES,
  msg,
  msgOf,
  negotiate,
  render,
  translator,
  type Catalogue,
  type Locale
} from './index.js';
import { en } from './locales/en.js';
import { fr } from './locales/fr.js';

/*
  Widened to plain catalogues on purpose: these tests walk every key as a string,
  which is exactly what the literal-keyed types exist to stop everywhere else.

  What is *not* here any more is the key-parity test ("every locale matches the
  English reference exactly", over a runtime `catalogueDiff`). The compiler holds
  that now — `fr` is a `TranslationOf<typeof en>`, so a missing or an extra key
  does not build — and a test repeating it could only ever agree. What remains
  below is what a type cannot see: what is inside the strings.
*/
const CATALOGUES: Record<Locale, Catalogue> = { en, fr };

describe('the catalogues', () => {
  /**
   * A sentence whose parameters differ between languages is a crash waiting for
   * whichever reader has the other one loaded.
   */
  it('every locale uses the same parameters in the same sentence', () => {
    const slots = (pattern: string) => [...pattern.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      for (const [key, pattern] of Object.entries(en)) {
        assert.deepEqual(slots(CATALOGUES[locale][key] ?? ''), slots(pattern), `${locale}: ${key}`);
      }
    }
  });

  it('no catalogue entry is left empty', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        assert.ok(value.trim().length > 0, `${locale}: ${key} is blank`);
      }
    }
  });
});

describe('rendering', () => {
  it('substitutes named parameters', () => {
    assert.equal(interpolate('{name} was found dead: {cause}.', { name: 'Alice', cause: 'poison' }), 'Alice was found dead: poison.');
  });

  it('leaves an unknown placeholder visibly alone', () => {
    assert.equal(interpolate('hello {nobody}', { name: 'x' }), 'hello {nobody}');
  });

  it('falls back to English, then to the key itself', () => {
    // Keys from a made-up catalogue and one that is nowhere, so `msgOf`: these are
    // exactly the keys `msg` exists to refuse.
    const partial = { 'a.b': 'français' };
    assert.equal(render(msgOf('a.b'), partial, { 'a.b': 'english' }), 'français');
    assert.equal(render(msg('mafia.night.quiet'), partial, en), en['mafia.night.quiet']);
    // Broken loudly rather than silently blank: a missing string should be
    // obvious in a screenshot.
    assert.equal(render(msgOf('nope.missing'), partial, en), 'nope.missing');
  });

  it('binds a reader once and renders many', () => {
    const t = translator(fr, en);
    assert.equal(t(msg('mafia.day.header', { day: 3 })), 'Jour 3');
    assert.equal(t(msg('mafia.trial.nobody')), 'personne');
  });
});

describe('locale negotiation', () => {
  it('reads an Accept-Language header and drops the region', () => {
    assert.equal(negotiate('fr-CA,fr;q=0.9,en;q=0.8'), 'fr');
    assert.equal(negotiate('en-GB,en;q=0.9'), 'en');
  });

  it('reads a navigator.languages array', () => {
    assert.equal(negotiate(['fr-BE', 'en-US']), 'fr');
  });

  it('skips languages that are not shipped yet', () => {
    // Planned, not present: it must not resolve to a catalogue that does not exist.
    assert.equal(negotiate(['ja-JP', 'ko', 'fr']), 'fr');
    assert.equal(negotiate(['ja-JP']), 'en');
  });

  it('falls back to English on nothing useful', () => {
    assert.equal(negotiate(undefined), 'en');
    assert.equal(negotiate(''), 'en');
    assert.equal(negotiate(['', 'zz']), 'en');
  });

  it('knows which strings name a shipped locale', () => {
    assert.equal(isLocale('fr'), true);
    assert.equal(isLocale('ja'), false, 'planned is not shipped');
  });
});
