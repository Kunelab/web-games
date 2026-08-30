import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANSWER_TOLERANCE, type AnswerField } from '../media/answer-field.js';
import { matchAnswer, matchAnyField, typoBudget } from './match.js';
import { creditFromDescription, normalizeAnswer, splitArtistTitle } from './normalize.js';
import { phoneticFold } from './phonetic.js';

function field(overrides: Partial<AnswerField> = {}): AnswerField {
  return {
    key: 'title',
    label: 'Titre',
    value: 'Africa',
    aliases: [],
    points: 3,
    tolerance: 0.17,
    directBonus: 0,
    ...overrides
  };
}

describe('normalizeAnswer', () => {
  it('folds accents', () => {
    assert.equal(normalizeAnswer('Beyoncé'), 'beyonce');
    assert.equal(normalizeAnswer('Sinéad O’Connor'), 'sinead oconnor');
    assert.equal(normalizeAnswer('Mylène Farmer'), 'mylene farmer');
  });

  it('ignores case and punctuation', () => {
    assert.equal(normalizeAnswer("Don't Stop Me Now"), 'dont stop me now');
    assert.equal(normalizeAnswer('R.E.M.'), 'r e m');
  });

  it('spells out ampersands so both forms agree', () => {
    assert.equal(normalizeAnswer('Guns N& Roses'), normalizeAnswer('Guns N and Roses'));
    assert.equal(normalizeAnswer('Simon & Garfunkel'), 'simon and garfunkel');
  });

  it('drops a leading article but keeps interior ones', () => {
    assert.equal(normalizeAnswer('The Beatles'), 'beatles');
    assert.equal(normalizeAnswer('Les Rita Mitsouko'), 'rita mitsouko');
    assert.equal(normalizeAnswer('Rage Against The Machine'), 'rage against the machine');
  });

  it('strips YouTube title noise', () => {
    assert.equal(normalizeAnswer('Africa (Official Music Video)'), 'africa');
    assert.equal(normalizeAnswer('Africa [Official Video] (HD)'), 'africa');
  });

  it('returns empty for input with no content', () => {
    assert.equal(normalizeAnswer('   '), '');
    assert.equal(normalizeAnswer('!!!'), '');
  });

  it('spells out ligatures instead of splitting the word on them', () => {
    assert.equal(normalizeAnswer('Cœur de pirate'), 'coeur de pirate');
    assert.equal(normalizeAnswer('Cœur'), normalizeAnswer('coeur'));
    assert.equal(normalizeAnswer('Straße'), 'strasse');
  });
});

describe('phoneticFold', () => {
  it('agrees on the same sound written either way', () => {
    assert.equal(phoneticFold('rhapsody'), phoneticFold('rapsodie'));
    assert.equal(phoneticFold('physique'), phoneticFold('fizik'));
    assert.equal(phoneticFold('quoi'), phoneticFold('koi'));
    assert.equal(phoneticFold('adresse'), phoneticFold('address'));
  });

  it('keeps vowels, so similar answers stay distinct', () => {
    assert.notEqual(phoneticFold('titanic'), phoneticFold('totonic'));
    assert.notEqual(phoneticFold('africa'), phoneticFold('america'));
  });

  it('leaves numbers alone', () => {
    assert.equal(phoneticFold('1991'), '1991');
    assert.equal(phoneticFold('blade runner 2049'), phoneticFold('blade runer 2049'));
    assert.ok(phoneticFold('blade runner 2049').endsWith('2049'));
  });
});

describe('matchAnswer', () => {
  it('accepts an exact answer with full confidence', () => {
    const result = matchAnswer('Africa', field());
    assert.equal(result.matched, true);
    assert.equal(result.confidence, 1);
  });

  it('accepts differences in case and accent', () => {
    assert.equal(matchAnswer('afrïca', field()).matched, true);
  });

  it('forgives a small typo', () => {
    assert.equal(matchAnswer('Afirca', field({ value: 'Africa' })).matched, true);
    assert.equal(matchAnswer('Schwarzeneger', field({ value: 'Schwarzenegger' })).matched, true);
  });

  it('rejects a different answer of similar length', () => {
    assert.equal(matchAnswer('America', field({ value: 'Africa' })).matched, false);
    assert.equal(matchAnswer('Madonna', field({ value: 'Rihanna' })).matched, false);
  });

  it('accepts an alias', () => {
    const result = matchAnswer('Aerzte', field({ value: 'Die Ärzte', aliases: ['Die Aerzte', 'Aerzte'] }));
    assert.equal(result.matched, true);
    assert.equal(result.confidence, 1);
    // Reports the first accepted spelling that matched exactly. "Die Aerzte" wins
    // over the bare "Aerzte" because the leading article is stripped from both.
    assert.equal(result.matchedAgainst, 'Die Aerzte');
  });

  it('credits the distinctive word of a multi-word answer', () => {
    const subject = field({ key: 'subject', value: 'Arnold Schwarzenegger' });
    assert.equal(matchAnswer('Schwarzenegger', subject).matched, true);
    // Partial credit must never outrank an exact match.
    assert.ok(matchAnswer('Schwarzenegger', subject).confidence < 1);
  });

  it('credits a surname but not a forename', () => {
    // Names put the identifying part last, so position decides rather than length:
    // "Willis" and "Arnold" are both six letters and only one of them identifies.
    assert.equal(matchAnswer('Willis', field({ value: 'Bruce Willis' })).matched, true);
    assert.equal(matchAnswer('Arnold', field({ value: 'Arnold Schwarzenegger' })).matched, false);
    assert.equal(matchAnswer('Bruce', field({ value: 'Bruce Willis' })).matched, false);
  });

  it('demands an exact pick on a choice field', () => {
    const choice = field({ value: 'Oulan-Bator', choices: ['Oulan-Bator', 'Astana', 'Bichkek', 'Douchanbé'] });
    assert.equal(matchAnswer('Oulan-Bator', choice).matched, true);
    // No typo tolerance when they are picking from a list.
    assert.equal(matchAnswer('Oulan-Batorr', choice).matched, false);
  });

  it('rejects empty input', () => {
    assert.equal(matchAnswer('   ', field()).matched, false);
  });

  it('rejects a truncated answer', () => {
    // A prefix is not a distinctive word, so it gets no partial credit.
    assert.equal(matchAnswer('Ramm', field({ value: 'Rammstein' })).matched, false);
    assert.equal(matchAnswer('Schwarz', field({ value: 'Schwarzenegger' })).matched, false);
  });

  it('gives partial credit inside a field that packs two facts together', () => {
    // "Rammstein" earns credit for "Rammstein - Sonne" because it is a distinctive
    // word of the answer. That is the cost of putting artist and title in one
    // field: the model wants them as two answer fields, which is also the only way
    // to score them separately.
    const packed = matchAnswer('Rammstein', field({ value: 'Rammstein - Sonne' }));
    assert.equal(packed.matched, true);
    assert.ok(packed.confidence < 1, 'partial credit must rank below an exact match');
  });

  describe('numbers', () => {
    const year = field({ key: 'year', label: 'Année', value: '1991' });

    it('accepts the right year', () => {
      assert.equal(matchAnswer('1991', year).matched, true);
      assert.equal(matchAnswer(' 1991 ', year).matched, true);
    });

    it('never accepts a neighbouring year', () => {
      // The whole point: a four-character answer is short enough that a one-edit
      // budget would cover 1891, 1981, 1990, 1992 and 9191.
      for (const wrong of ['1992', '1990', '1891', '1981', '9191', '199', '19911']) {
        assert.equal(matchAnswer(wrong, year).matched, false, `${wrong} must not count as 1991`);
      }
    });

    it('reads a number however it is punctuated', () => {
      const population = field({ value: '1000000' });
      assert.equal(matchAnswer('1 000 000', population).matched, true);
      assert.equal(matchAnswer('1.000.000', population).matched, true);
      assert.equal(matchAnswer('1000001', population).matched, false);
    });

    it('holds the digits exact inside a longer answer but still forgives the words', () => {
      const movie = field({ value: 'Blade Runner 2049' });
      assert.equal(matchAnswer('Blade Runer 2049', movie).matched, true);
      assert.equal(matchAnswer('Blade Runner 2048', movie).matched, false);
    });

    it('is generous with the loose preset and still exact about the year', () => {
      const loose = field({ value: '1991', tolerance: ANSWER_TOLERANCE.loose });
      assert.equal(matchAnswer('1992', loose).matched, false);
    });
  });

  describe('punctuation and spacing', () => {
    it('does not care whether a name is written open or closed up', () => {
      assert.equal(matchAnswer('ACDC', field({ value: 'AC/DC' })).matched, true);
      assert.equal(matchAnswer('REM', field({ value: 'R.E.M.' })).matched, true);
      assert.equal(matchAnswer('daftpunk', field({ value: 'Daft Punk' })).matched, true);
      assert.equal(matchAnswer('Sinead O Connor', field({ value: 'Sinéad O’Connor' })).matched, true);
    });

    it('treats a joining word as optional', () => {
      assert.equal(matchAnswer('Guns and Roses', field({ value: "Guns N' Roses" })).matched, true);
      assert.equal(matchAnswer('Simon Garfunkel', field({ value: 'Simon & Garfunkel' })).matched, true);
      assert.equal(matchAnswer('Rage Against Machine', field({ value: 'Rage Against The Machine' })).matched, true);
      assert.equal(matchAnswer('Beethoven Fifth', field({ value: "Beethoven's Fifth" })).matched, true);
    });

    it('does not let dropped words turn a partial answer into a whole one', () => {
      assert.equal(matchAnswer('Le Roi', field({ value: 'Le Roi Lion' })).matched, false);
      assert.equal(matchAnswer('Bruce', field({ value: 'Bruce Willis' })).matched, false);
    });

    it('reads punctuation that stands in for a letter', () => {
      assert.equal(matchAnswer('Pink', field({ value: 'P!nk' })).matched, true);
      assert.equal(matchAnswer('Kesha', field({ value: 'Ke$ha' })).matched, true);
      // But an exclamation mark that is really punctuation stays punctuation.
      assert.equal(matchAnswer('Wham', field({ value: 'Wham!' })).matched, true);
    });

    it('still demands the right pick on a choice field', () => {
      const choice = field({ value: 'Oulan-Bator', choices: ['Oulan-Bator', 'Astana', 'Bichkek'] });
      // Spacing and punctuation are free even here, since they are only writing.
      assert.equal(matchAnswer('oulanbator', choice).matched, true);
      // A wrong letter is not.
      assert.equal(matchAnswer('Oulan-Batorr', choice).matched, false);
    });
  });

  describe('phonetic spelling', () => {
    it('accepts an answer written as it sounds', () => {
      assert.equal(matchAnswer('Rapsodie', field({ value: 'Rhapsody' })).matched, true);
      assert.equal(matchAnswer('Bohemien Rapsodi', field({ value: 'Bohemian Rhapsody' })).matched, true);
      assert.equal(matchAnswer('Shwarzeneger', field({ value: 'Schwarzenegger' })).matched, true);
      assert.equal(matchAnswer('Fizik', field({ value: 'Physique' })).matched, true);
    });

    it('works below the typo budget, where a short answer gets no edits at all', () => {
      // "Koi" is four letters: no budget, and none needed, because it is the same
      // word written the way it sounds rather than a mistyping of it.
      assert.equal(matchAnswer('Koi', field({ value: 'Quoi' })).matched, true);
      assert.equal(matchAnswer('Kai', field({ value: 'Quoi' })).matched, false);
    });

    it('ranks below a typo, which ranks below an exact answer', () => {
      const target = field({ value: 'Rhapsody' });
      const exact = matchAnswer('Rhapsody', target).confidence;
      const typo = matchAnswer('Rhapsodyy', target).confidence;
      const sounded = matchAnswer('Rapsodie', target).confidence;
      assert.ok(exact > typo && typo > sounded, `${exact} > ${typo} > ${sounded}`);
    });
  });

  describe('tolerance', () => {
    it('forgives nothing but formatting when set to exact', () => {
      const strict = field({ value: 'Africa', tolerance: ANSWER_TOLERANCE.exact });
      assert.equal(matchAnswer('AFRICA', strict).matched, true);
      assert.equal(matchAnswer('Afirca', strict).matched, false);
      assert.equal(matchAnswer('Afrika', strict).matched, false);
    });

    it('gives a short answer no edits and a long one a few', () => {
      assert.equal(typoBudget('toto', ANSWER_TOLERANCE.normal), 0);
      assert.equal(typoBudget('queen', ANSWER_TOLERANCE.normal), 0, 'five letters is a different answer');
      assert.equal(typoBudget('africa', ANSWER_TOLERANCE.normal), 1);
      assert.equal(typoBudget('schwarzenegger', ANSWER_TOLERANCE.normal), 2);
      // Neither the spaces nor the year buy extra room.
      assert.equal(typoBudget('1991', ANSWER_TOLERANCE.normal), 0);
      assert.equal(typoBudget('bohemian rhapsody', ANSWER_TOLERANCE.normal), 2);
      // The loose preset lowers the threshold instead of exempting short answers.
      assert.equal(typoBudget('queen', ANSWER_TOLERANCE.loose), 1);
    });

    it('rejects a wrong letter in a short answer, whatever it costs', () => {
      // The case that made this worth rewriting: one edit on a five-letter answer
      // is a different answer four times out of five.
      assert.equal(matchAnswer('Maris', field({ value: 'Paris' })).matched, false);
      assert.equal(matchAnswer('Sonnet', field({ value: 'Sonne' })).matched, false);
      assert.equal(matchAnswer('Foto', field({ value: 'Toto' })).matched, false);
    });

    it('forgives two swapped letters at any length', () => {
      // A swap is the commonest slip and the commonest dyslexic error, and it
      // cannot turn one answer into another the way a wrong letter can.
      assert.equal(matchAnswer('Parsi', field({ value: 'Paris' })).matched, true);
      assert.equal(matchAnswer('Bowei', field({ value: 'Bowie' })).matched, true);
      assert.equal(matchAnswer('Rage Against Teh Machine', field({ value: 'Rage Against The Machine' })).matched, true);
      // But not on digits, where a swap is another year.
      assert.equal(matchAnswer('1919', field({ value: '1991' })).matched, false);
    });

    it('forgives one slip per word inside a long answer', () => {
      // A short word inside a long answer is not what tells two answers apart.
      assert.equal(matchAnswer('Sweet Child of Mine', field({ value: "Sweet Child O' Mine" })).matched, true);
      assert.equal(matchAnswer('Edith Piaff', field({ value: 'Édith Piaf' })).matched, true);
    });

    it('accepts one mistake per word of a long answer through the phonetic route', () => {
      // Two edits inside the budget, and a third that only the fold forgives.
      const long = field({ value: 'Rage Against The Machine' });
      assert.equal(matchAnswer('Rage Aganst The Machin', long).matched, true);
      assert.equal(matchAnswer('Rage Against The Machin', long).matched, true);
      assert.equal(matchAnswer('Rage Against The Vaccine', long).matched, false);
    });
  });
});

describe('matchAnyField', () => {
  const panel: AnswerField[] = [
    field({ key: 'a', value: 'Arnold Schwarzenegger', points: 1 }),
    field({ key: 'b', value: 'Sylvester Stallone', points: 1 }),
    field({ key: 'c', value: 'Bruce Willis', points: 1 })
  ];

  it('works out which item the player meant', () => {
    const hit = matchAnyField('Stallone', panel, new Set());
    assert.equal(hit?.field.key, 'b');
  });

  it('will not re-score an item already credited', () => {
    const hit = matchAnyField('Stallone', panel, new Set(['b']));
    assert.equal(hit, null);
  });

  it('returns null when nothing matches', () => {
    assert.equal(matchAnyField('Jean Dujardin', panel, new Set()), null);
  });

  it('answers whichever field the text fits, in any order', () => {
    // A film round: the player types what they know, not what they were asked.
    const film = [
      field({ key: 'subject', value: 'Terminator 2' }),
      field({ key: 'director', value: 'James Cameron' }),
      field({ key: 'year', value: '1991' })
    ];

    assert.equal(matchAnyField('1991', film, new Set())?.field.key, 'year');
    assert.equal(matchAnyField('james cameron', film, new Set())?.field.key, 'director');
    // And once it is credited, saying it again finds nothing left to credit.
    assert.equal(matchAnyField('1991', film, new Set(['year'])), null);
  });

  it('never answers a field that offers choices', () => {
    // That one is a pick from its own list, where the revealed-choices state and the
    // blind-answer bonus live, so it cannot be satisfied from another prompt.
    const mixed = [
      field({ key: 'subject', value: 'Terminator 2' }),
      field({ key: 'year', value: '1991', choices: ['1989', '1991', '1993'] })
    ];

    assert.equal(matchAnyField('1991', mixed, new Set()), null);
    assert.equal(matchAnyField('Terminator 2', mixed, new Set())?.field.key, 'subject');
  });
});

/**
 * Some videos are not about their music.
 *
 * An AMV, a montage, a fan edit: the title describes the *video*, and no amount
 * of splitting on dashes recovers the song because the song is not in the
 * string. It is in the description, written by hand, in a shape people have
 * converged on — and a credit somebody bothered to type is worth more than
 * anything this code can infer from a title.
 */
describe('creditFromDescription', () => {
  it('reads a one-line credit', () => {
    const description = ['Premiered: 2010-07-03', 'Anime: Bakemonogatari', 'Music: Yuksek – Tonight', 'DDL: http://x'].join(
      '\n'
    );
    assert.deepEqual(creditFromDescription(description), { artist: 'Yuksek', title: 'Tonight' });
  });

  it('keeps a remix credit, which names a different track', () => {
    assert.deepEqual(
      creditFromDescription('Music: D.I.M. – Is You (Le Castle Vania Remix)'),
      { artist: 'D.I.M.', title: 'Is You (Le Castle Vania Remix)' }
    );
  });

  it('reads a credit split across two lines', () => {
    assert.deepEqual(creditFromDescription(['Artist: Yuksek', 'Song: Tonight'].join('\n')), {
      artist: 'Yuksek',
      title: 'Tonight'
    });
  });

  /**
   * Silence is the right answer far more often than a guess is. A description
   * with no labelled credit must produce nothing, or every ordinary video would
   * have its title overruled by the first stray line in its blurb.
   */
  it('says nothing when nothing is credited', () => {
    assert.equal(creditFromDescription('The official video for Never Gonna Give You Up.'), null);
    assert.equal(creditFromDescription(''), null);
  });

  it('will not take half a credit', () => {
    assert.equal(creditFromDescription('Music: Tonight'), null);
  });
});

describe('splitArtistTitle', () => {
  it('splits the common convention', () => {
    assert.deepEqual(splitArtistTitle('Toto - Africa'), { artist: 'Toto', title: 'Africa' });
  });

  it('handles an en dash and a vertical bar', () => {
    assert.deepEqual(splitArtistTitle('Rammstein – Sonne'), { artist: 'Rammstein', title: 'Sonne' });
    assert.deepEqual(splitArtistTitle('Daft Punk | Around the World'), {
      artist: 'Daft Punk',
      title: 'Around the World'
    });
  });

  it('strips noise before splitting', () => {
    assert.deepEqual(splitArtistTitle('Toto - Africa (Official Music Video)'), {
      artist: 'Toto',
      title: 'Africa'
    });
  });

  it('leaves the whole string as the title when there is no separator', () => {
    assert.deepEqual(splitArtistTitle('Africa'), { artist: '', title: 'Africa' });
  });

  /**
   * The featured-artist cases, both ways round.
   *
   * The old pattern left "Despacito . Daddy Yankee" in the title field of every
   * imported track with a guest on it — a stray full stop the host then had to
   * find and delete by hand, on an answer the matcher would otherwise have
   * scored against.
   */
  it('drops a featured artist from the title', () => {
    assert.deepEqual(splitArtistTitle('Luis Fonsi - Despacito ft. Daddy Yankee'), {
      artist: 'Luis Fonsi',
      title: 'Despacito'
    });
    assert.deepEqual(splitArtistTitle('Eminem - Stan feat. Dido'), {
      artist: 'Eminem',
      title: 'Stan'
    });
  });

  it('keeps the song when the credit sits on the artist side', () => {
    assert.deepEqual(splitArtistTitle('Calvin Harris ft. Rihanna - This Is What You Came For'), {
      artist: 'Calvin Harris',
      title: 'This Is What You Came For'
    });
  });

  /**
   * The distributor label goes; the band keeps its name.
   *
   * The guards matter more than the case being fixed: a looser pattern would
   * have deleted Clean Bandit from their own song, and that failure would have
   * looked like a bad import rather than a bad regex.
   */
  it('drops a content label but never a band name', () => {
    assert.deepEqual(splitArtistTitle('Bloodhound Gang - The Bad Touch (Explicit)'), {
      artist: 'Bloodhound Gang',
      title: 'The Bad Touch'
    });
    assert.deepEqual(splitArtistTitle('Justice - D.A.N.C.E. (Radio Edit)'), {
      artist: 'Justice',
      title: 'D.A.N.C.E.'
    });
    assert.deepEqual(splitArtistTitle('Clean Bandit - Rather Be'), {
      artist: 'Clean Bandit',
      title: 'Rather Be'
    });
    assert.deepEqual(splitArtistTitle('Extended Play - Some Band'), {
      artist: 'Extended Play',
      title: 'Some Band'
    });
  });

  it('strips the music-video marker', () => {
    assert.deepEqual(splitArtistTitle('PSY - GANGNAM STYLE M/V'), {
      artist: 'PSY',
      title: 'GANGNAM STYLE'
    });
  });

  it('does not split on a hyphen inside a word', () => {
    assert.deepEqual(splitArtistTitle('Jean-Jacques Goldman'), { artist: '', title: 'Jean-Jacques Goldman' });
  });
});
