import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { translator } from './index.js';
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
});
