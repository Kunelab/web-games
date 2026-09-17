import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCALES } from './index.js';
import { en } from './locales/en.js';
import { fr } from './locales/fr.js';

const CATALOGUES = { en, fr };

/**
 * A bot may lie. A bot may not lie by accident.
 *
 * Everything under `mafia.bot.` is one of several phrasings of a move the bot
 * code has already decided on, picked by a hash. The code knows what it has
 * checked; the variant does not. So a variant that carries a fact of its own —
 * "I never left my house", "not a word from them all game" — asserts it every
 * time it comes up, on seats it happens to be false about, and the board files
 * it and the other seats reason from it. A player who is misled by that has
 * been beaten by the decoration rather than by an opponent, which is the one
 * kind of defeat this game must never hand out.
 *
 * These two lists are the shapes that went wrong, kept as a tripwire: a
 * self-alibi in a family that is said under pressure (where the code has not
 * looked at the speaker's night), and a claim about somebody else's whole
 * record in a family whose target is chosen without reading it.
 *
 * Adding a phrasing that trips one of these is not necessarily wrong — it is a
 * signal that the fact belongs in a `why.*` fragment instead, where the caller
 * gates it on the board before passing it in.
 */

/** Said about itself by a seat whose night the caller has not looked at. */
const UNDER_PRESSURE = [
  'mafia.bot.deny.',
  'mafia.bot.pressure.',
  'mafia.bot.plead.',
  'mafia.bot.defend.nothing.',
  'mafia.bot.defend.accuser.',
  'mafia.bot.jail.plead.home.',
  'mafia.bot.watch.'
];

/** Said about somebody picked without reading their record. */
const ABOUT_A_STRANGER = [
  'mafia.bot.taunt.',
  'mafia.bot.accuse.',
  'mafia.bot.clear.',
  'mafia.bot.question.',
  'mafia.bot.hint.',
  'mafia.bot.hello.'
];

const SELF_ALIBI: Record<string, RegExp[]> = {
  en: [
    /\bI (?:never|did not|didn’t|don’t) (?:leave|left|move|go out)\b/i,
    /\bI (?:was|have been|stayed|stay) (?:in|at )?home\b/i,
    /\bI (?:was|have been) (?:in|inside)\b/i,
    /\bmy (?:house|door|step)\b/i,
    /\bnobody (?:has )?put me\b/i,
    /\bno (?:witness|sighting|lookout)\b/i
  ],
  fr: [
    /\bje n[’']ai jamais (?:quitté|bougé)\b/i,
    /\bj[’']étais chez moi\b/i,
    /\bje (?:suis|serais) resté(?:e)? (?:chez moi|dedans)\b/i,
    /\bma (?:maison|porte)\b/i,
    /\bpersonne ne m[’']a (?:situé|mis)\b/i,
    /\baucun (?:témoin|guetteur)\b/i
  ]
};

const WHOLE_RECORD: Record<string, RegExp[]> = {
  en: [
    /\ball game\b/i,
    /\bevery (?:day|time)\b/i,
    /\bnot a word\b/i,
    /\b(?:has|have) not said\b/i,
    /\bnever explains?\b/i,
    /\bsince day one\b/i,
    /\btwo days\b/i,
    /\banswered everything\b/i,
    /**
     * And the shapes that got past the list above, because a report of
     * somebody's record does not have to say "always" to be one. A taunt's mark
     * is drawn out of a hat — see `decideDay` — so "Not much from 14" and
     * "Anyone heard 14 today?" landed on the loudest seat at the table as
     * readily as on the quietest, and the board filed the loud one as quiet.
     */
    /\b(?:not much|nothing|barely a word) (?:from|out of)\b/i,
    /\banyone heard\b/i,
    /\b(?:has|have) been (?:quiet|silent)\b/i
  ],
  fr: [
    /\bpas grand-chose (?:de|d[’'])\b/i,
    /\bquelqu[’']un a entendu\b/i,
    /\b(?:est|sont) rest[ée]s? (?:muet|silencieu)/i,
    /\btoute la partie\b/i,
    /\btous les jours\b/i,
    /\bà chaque fois\b/i,
    /\bpas un mot\b/i,
    /\bn[’']a (?:rien dit|pas dit)\b/i,
    /\bn[’']explique jamais\b/i,
    /\bdepuis le (?:premier jour|début)\b/i,
    /\bdeux jours\b/i,
    /\ba répondu à tout\b/i
  ]
};

function scan(families: string[], banned: Record<string, RegExp[]>): string[] {
  const caught: string[] = [];
  for (const locale of LOCALES) {
    const catalogue = CATALOGUES[locale];
    for (const [key, value] of Object.entries(catalogue)) {
      if (!families.some((family) => key.startsWith(family))) continue;
      for (const pattern of banned[locale] ?? []) {
        if (pattern.test(value)) caught.push(`${locale}: ${key} — ${value}`);
      }
    }
  }
  return caught;
}

describe('what a bot is allowed to assert', () => {
  it('never invents an alibi for a seat under pressure', () => {
    assert.deepEqual(scan(UNDER_PRESSURE, SELF_ALIBI), []);
  });

  it('never reports a whole record it was not handed', () => {
    assert.deepEqual(scan(ABOUT_A_STRANGER, WHOLE_RECORD), []);
  });

  /**
   * A `why.*` fragment is a sentence fragment: it is dropped into the middle of
   * another sentence, so it starts lower case and ends without punctuation.
   * One that starts with a capital reads as two half sentences glued together.
   *
   * English's first person is the exception and is spelt with a capital
   * wherever it falls, so "I checked them myself" is a fragment doing exactly
   * what it should.
   */
  it('keeps every reason a fragment rather than a sentence', () => {
    const bad: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        if (!/^mafia\.bot\.(why|whyClear|denyWhy|family\.why)\./.test(key)) continue;
        if (/^[A-ZÀ-Þ]/.test(value) && !/^I(?:[’' ]|$)/.test(value)) {
          bad.push(`${locale}: ${key} starts with a capital`);
        }
        if (/[.!?]$/.test(value)) bad.push(`${locale}: ${key} ends with punctuation`);
      }
    }
    assert.deepEqual(bad, []);
  });

  /**
   * And the sentences those fragments go into must not put one where a capital
   * belongs: "17. they said home, and Nami says otherwise." is the fragment
   * doing its job in a frame that is not doing its own.
   */
  it('never starts a sentence with a reason', () => {
    const bad: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        if (!key.startsWith('mafia.bot.')) continue;
        const at = value.indexOf('{why}');
        if (at < 0) continue;
        const before = value.slice(0, at).trimEnd();
        if (before === '' || /[.!?]$/.test(before)) bad.push(`${locale}: ${key} — ${value}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});
