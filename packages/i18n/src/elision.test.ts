import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interpolate, translator } from './index.js';
import { fr } from './locales/fr.js';
import { en } from './locales/en.js';

describe('french elision', () => {
  it('elides le and la before a vowel or mute h', () => {
    const t = translator(fr, en, 'fr');
    const line = t({ k: 'mafia.bot.roleClaim.3', p: { role: 'Hôtesse' } });
    assert.ok(!line.includes('le Hôtesse'), line);
    assert.ok(line.includes('l’Hôtesse') || line.includes("l'Hôtesse"), line);
  });
  it('leaves a consonant alone', () => {
    const t = translator(fr, en, 'fr');
    assert.ok(t({ k: 'mafia.bot.roleClaim.3', p: { role: 'Shérif' } }).includes('le Shérif'));
  });
  it('does not touch english', () => {
    const t = translator(en, en, 'en');
    const line = t({ k: 'mafia.bot.roleClaim.3', p: { role: 'Escort' } });
    assert.ok(!line.includes("l'"), line);
  });

  /**
   * The rule used to run over the finished sentence, where it rewrote prose no
   * substitution had been anywhere near: thirty-six lines of the French
   * catalogue, "la horde" through "le rôl’exact". Nothing without a `{hole}` in
   * it can change, and this is the test that says so for every line at once.
   */
  it('leaves every un-interpolated catalogue line exactly as written', () => {
    const t = translator(fr, en, 'fr');
    for (const [key, text] of Object.entries(fr)) {
      if (text.includes('{')) continue;
      assert.equal(t({ k: key }), text, key);
    }
  });

  it('does not elide inside a word that merely ends in le, la or de', () => {
    assert.equal(interpolate('le {x} exact', { x: 'rôle' }, true), 'le rôle exact');
    assert.equal(interpolate('contrôle {x}', { x: 'immédiat' }, true), 'contrôle immédiat');
    assert.equal(interpolate('rôle {x}', { x: 'exact' }, true), 'rôle exact');
  });

  it('keeps the article whole before an h aspiré', () => {
    assert.equal(interpolate('la {x}', { x: 'horde' }, true), 'la horde');
    assert.equal(interpolate('le {x}', { x: 'héros' }, true), 'le héros');
    assert.equal(interpolate('de {x}', { x: 'hasard' }, true), 'de hasard');
  });

  it('elides de, keeps the article capital, and handles a nested article', () => {
    assert.equal(interpolate('de {x}', { x: 'Alice' }, true), 'd’Alice');
    assert.equal(interpolate('La {x}', { x: 'Actrice' }, true), 'L’Actrice');
    assert.equal(interpolate('de la {x}', { x: 'Escorte' }, true), 'de l’Escorte');
  });

  it('leaves an unfilled hole and its article alone', () => {
    assert.equal(interpolate('le {missing}', { x: 'Actrice' }, true), 'le {missing}');
  });
});
