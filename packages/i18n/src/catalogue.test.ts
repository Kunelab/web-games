import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { catalogueDiff, interpolate, isLocale, LOCALES, msg, negotiate, render, translator } from './index.js';
import { en } from './locales/en.js';
import { fr } from './locales/fr.js';

const CATALOGUES = { en, fr };

describe('the catalogues', () => {
  /**
   * The check that keeps translation honest in both directions. A key missing
   * from `fr` shows English, which is survivable. A key only `fr` has means a
   * rename happened and the English fallback is now showing raw dotted text to
   * every reader who is not French — which is not.
   */
  it('every locale matches the English reference exactly', () => {
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      const { missing, extra } = catalogueDiff(en, CATALOGUES[locale]);
      assert.deepEqual(missing, [], `${locale} is missing keys`);
      assert.deepEqual(extra, [], `${locale} has keys English does not`);
    }
  });

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
    assert.equal(interpolate('{name} was found dead — {cause}.', { name: 'Alice', cause: 'poison' }), 'Alice was found dead — poison.');
  });

  it('leaves an unknown placeholder visibly alone', () => {
    assert.equal(interpolate('hello {nobody}', { name: 'x' }), 'hello {nobody}');
  });

  it('falls back to English, then to the key itself', () => {
    const partial = { 'a.b': 'français' };
    assert.equal(render(msg('a.b'), partial, { 'a.b': 'english' }), 'français');
    assert.equal(render(msg('mafia.night.quiet'), partial, en), en['mafia.night.quiet']);
    // Broken loudly rather than silently blank: a missing string should be
    // obvious in a screenshot.
    assert.equal(render(msg('nope.missing'), partial, en), 'nope.missing');
  });

  it('binds a reader once and renders many', () => {
    const t = translator(fr, en);
    assert.equal(t(msg('mafia.day.header', { day: 3 })), '— Jour 3 —');
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
