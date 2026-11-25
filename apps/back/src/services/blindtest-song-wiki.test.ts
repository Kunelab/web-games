import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  certificationLevel,
  mainChartCountry,
  parseEnwikiCertifications,
  parseEnwikiCharts,
  parseFrwikiCertifications,
  parseFrwikiCharts,
  songFactsFrom,
  type WikimediaGet
} from './blindtest-song-wiki.js';

/**
 * The song facts read from real Wikipedia and Wikidata answers, recorded once
 * into `__fixtures__/song-wiki` and trimmed to what is read: the article's
 * infobox and its chart, certification, cover and release sections, and the
 * Wikidata claims that pick the song's item. Nothing here reaches the network.
 */

const FIXTURES = new URL('./__fixtures__/song-wiki/', import.meta.url);

const wikitext = (file: string) => readFileSync(new URL(file, FIXTURES), 'utf8');

/** Recorded answers by request URL; an article's answer names its wikitext file. */
const recorded = JSON.parse(readFileSync(new URL('api.json', FIXTURES), 'utf8')) as Record<string, unknown>;

/** Wikimedia as recorded, logging what it was asked. A request it has no answer for fails. */
function recordedWikimedia(fail: (url: URL) => boolean = () => false) {
  const asked: URL[] = [];
  const get: WikimediaGet = async (url) => {
    asked.push(url);
    if (fail(url)) return undefined;
    const answer = recorded[url.toString()];
    const file = (answer as { wikitextFile?: unknown } | undefined)?.wikitextFile;
    return typeof file === 'string' ? { parse: { wikitext: wikitext(file) } } : answer;
  };
  return { get, asked };
}

describe('enwiki charts', () => {
  it('reads Hey Jude: chart templates, plain rows, and not the year-end rankings', () => {
    // UK from {{single chart|UK|1}}, the US from a plain "US Billboard Hot 100"
    // row (no template), France from the SNICOP row (2), not the 2012 re-entry (174).
    assert.deepEqual(parseEnwikiCharts(wikitext('hey-jude.en.wikitext')), {
      uk: { peak: 1 },
      us: { peak: 1 },
      fr: { peak: 2 }
    });
  });

  it('reads Somebody That I Used to Know', () => {
    assert.deepEqual(parseEnwikiCharts(wikitext('somebody-that-i-used-to-know.en.wikitext')), {
      fr: { peak: 1 },
      uk: { peak: 1 },
      us: { peak: 1 }
    });
  });

  it("leaves out the covers' chart runs", () => {
    // Walk Off the Earth's France 80, Glee's Hot 100 26 and UK 48.
    const article = wikitext('somebody-that-i-used-to-know.en.wikitext');
    const covers = article.slice(article.indexOf('== Covers and remixes =='));
    assert.ok(covers.includes('{{single chart|Billboardhot100|26'));
    assert.deepEqual(parseEnwikiCharts(covers), {});
    assert.deepEqual(parseEnwikiCertifications(covers), {});
  });

  it('reads Californication, airplay charts aside', () => {
    assert.deepEqual(parseEnwikiCharts(wikitext('californication-song.en.wikitext')), {
      uk: { peak: 16 },
      us: { peak: 69 }
    });
  });
});

describe('enwiki certifications', () => {
  it('reads Hey Jude: UK platinum, US 4× platinum, no level for a sales-only France row', () => {
    assert.deepEqual(parseEnwikiCertifications(wikitext('hey-jude.en.wikitext')), { uk: 2, us: 8 });
  });

  it('reads Somebody That I Used to Know, with spaces around a parameter name', () => {
    // `number =17` for the US.
    assert.deepEqual(parseEnwikiCertifications(wikitext('somebody-that-i-used-to-know.en.wikitext')), {
      uk: 12,
      us: 34
    });
  });

  it('reads Californication', () => {
    assert.deepEqual(parseEnwikiCertifications(wikitext('californication-song.en.wikitext')), { uk: 6, us: 12 });
  });
});

describe('frwiki charts', () => {
  it("reads L'idole des jeunes: a {{France}} row, and the 2017 re-entry's template", () => {
    assert.deepEqual(parseFrwikiCharts(wikitext('l-idole-des-jeunes-chanson.fr.wikitext')), { fr: { peak: 1 } });
  });

  it("reads Allumer le feu: 39 in 1998, 10 in 2017, not the prose's 63", () => {
    assert.deepEqual(parseFrwikiCharts(wikitext('allumer-le-feu.fr.wikitext')), { fr: { peak: 10 } });
  });

  it('reads Somebody That I Used to Know, and not the Walk off the Earth version after it', () => {
    assert.deepEqual(parseFrwikiCharts(wikitext('somebody-that-i-used-to-know.fr.wikitext')), {
      fr: { peak: 1 },
      uk: { peak: 1 },
      us: { peak: 1 }
    });
  });

  it("cuts at a second infobox, a cover's, even under a charts heading", () => {
    const article = wikitext('somebody-that-i-used-to-know.fr.wikitext');
    const cover = article.slice(article.indexOf('{{Infobox Musique', 10));
    assert.ok(cover.includes('{{singlechart|France|80'));
    assert.deepEqual(parseFrwikiCharts(`== Classements ==\n${cover}`), {});
  });

  it('finds nothing in an article with no chart table', () => {
    assert.deepEqual(parseFrwikiCharts(wikitext('hey-jude.fr.wikitext')), {});
  });
});

describe('frwiki certifications', () => {
  it('reads {{Certification|platine|n}} rows, a highlighted row among them', () => {
    // The UK row is a `!` row; Walk off the Earth's Canadian platinum is not read.
    assert.deepEqual(parseFrwikiCertifications(wikitext('somebody-that-i-used-to-know.fr.wikitext')), {
      uk: 4,
      us: 34
    });
  });

  it('finds none where there are none', () => {
    assert.deepEqual(parseFrwikiCertifications(wikitext('allumer-le-feu.fr.wikitext')), {});
  });

  it('reads awards written out', () => {
    const table = [
      '== Certifications ==',
      '{| class="wikitable"',
      '! Pays !! Certification',
      '|-',
      '| {{France}} ([[SNEP]]) || Double disque de platine',
      '|-',
      "| Royaume-Uni (BPI) || Disque d'argent",
      '|-',
      '| [[Belgique]] || Disque de diamant',
      '|}'
    ].join('\n');
    assert.deepEqual(parseFrwikiCertifications(table), { fr: 4, uk: 0.5 });
  });
});

describe('chart names', () => {
  it("takes each country's main singles chart and nothing else", () => {
    assert.equal(mainChartCountry("US [[Billboard Hot 100|''Billboard'' Hot 100]]"), 'us');
    assert.equal(mainChartCountry('UK Singles ([[Official Charts Company|OCC]])'), 'uk');
    assert.equal(mainChartCountry("{{France}} ([[Syndicat national de l'édition phonographique|SNEP]])"), 'fr');
    assert.equal(mainChartCountry('{{drapeau|France}}'), 'fr');
    assert.equal(
      mainChartCountry("{{États-Unis}} ''[[Billboard (magazine)|Billboard]]'' [[Billboard Hot 100|Hot 100]]"),
      'us'
    );
    assert.equal(mainChartCountry('US [[Billboard Hot 100|Billboard Hot 100 Recurrents]]'), null);
    assert.equal(mainChartCountry('US Bubbling Under Hot 100'), null);
    assert.equal(mainChartCountry('France Airplay (SNEP)'), null);
    assert.equal(mainChartCountry('UK Indie (OCC)'), null);
    assert.equal(mainChartCountry('Canada ([[Canadian Hot 100]])'), null);
    assert.equal(mainChartCountry('{{États-Unis}} [[Alternative Songs]]'), null);
  });
});

describe('certification levels', () => {
  it('counts in golds', () => {
    assert.equal(certificationLevel('Silver'), 0.5);
    assert.equal(certificationLevel('Gold'), 1);
    assert.equal(certificationLevel('Platinum'), 2);
    assert.equal(certificationLevel('Platinum', 2), 4);
    assert.equal(certificationLevel('Diamond'), 10);
    assert.equal(certificationLevel("Disque d'or"), 1);
    assert.equal(certificationLevel('Disque de platine'), 2);
    assert.equal(certificationLevel('Disque de diamant'), 10);
    assert.equal(certificationLevel('Million'), null);
  });
});

describe('wikipediaSongFacts', () => {
  it('reads Hey Jude from its item and its articles', async () => {
    const { get } = recordedWikimedia();
    assert.deepEqual(await songFactsFrom(get, 'The Beatles', 'Hey Jude', 'Q1299'), {
      wikidata: 'Q607742',
      songWikiLanguages: 43,
      year: 1968,
      yearSource: 'wikidata',
      charts: { uk: { peak: 1 }, fr: { peak: 2 }, us: { peak: 1 } },
      certifications: { uk: 2, us: 8 }
    });
  });

  it("finds Gotye's song by the performer's name, its English and French articles merged", async () => {
    const { get } = recordedWikimedia();
    assert.deepEqual(await songFactsFrom(get, 'Gotye', 'Somebody That I Used to Know'), {
      wikidata: 'Q1995194',
      songWikiLanguages: 27,
      year: 2011,
      yearSource: 'wikidata',
      charts: { fr: { peak: 1 }, uk: { peak: 1 }, us: { peak: 1 } },
      certifications: { uk: 12, us: 34 }
    });
  });

  it("keeps the song's item over its single's, and Road Trippin' out", async () => {
    // The search for Californication also finds the album, its tour and the
    // "Road Trippin'" single (Q2292015); only the song is the song.
    const { get } = recordedWikimedia();
    const facts = await songFactsFrom(get, 'Red Hot Chili Peppers', 'Californication', 'Q10708');
    assert.equal(facts?.wikidata, 'Q2087371');
    assert.deepEqual(facts?.charts, { uk: { peak: 16 }, us: { peak: 69 } });
  });

  it("does not read Ricky Nelson's chart run into L'idole des jeunes", async () => {
    // One item for both songs; its English article is "Teen Age Idol".
    const { get, asked } = recordedWikimedia();
    assert.deepEqual(await songFactsFrom(get, 'Johnny Hallyday', "L'idole des jeunes", 'Q212015'), {
      wikidata: 'Q25066787',
      songWikiLanguages: 2,
      year: 1962,
      yearSource: 'wikidata',
      charts: { fr: { peak: 1 } }
    });
    assert.ok(!asked.some((url) => url.hostname === 'en.wikipedia.org'));
  });

  it('reads a French-only song from its one article', async () => {
    const { get } = recordedWikimedia();
    assert.deepEqual(await songFactsFrom(get, 'Johnny Hallyday', 'Allumer le feu', 'Q212015'), {
      wikidata: 'Q2838711',
      songWikiLanguages: 1,
      year: 1998,
      yearSource: 'wikidata',
      charts: { fr: { peak: 10 } }
    });
  });

  it('says nothing of an album track no Wikipedia covers', async () => {
    const { get, asked } = recordedWikimedia();
    assert.deepEqual(await songFactsFrom(get, 'Red Hot Chili Peppers', 'Veronica', 'Q10708'), {});
    assert.ok(!asked.some((url) => url.hostname.endsWith('wikipedia.org')));
  });

  it('is undefined when the search fails, so the song is asked about again', async () => {
    const { get } = recordedWikimedia(() => true);
    assert.equal(await songFactsFrom(get, 'The Beatles', 'Hey Jude', 'Q1299'), undefined);
  });

  it('is undefined when an article cannot be read, not a song without charts', async () => {
    const { get } = recordedWikimedia((url) => url.hostname === 'fr.wikipedia.org');
    assert.equal(await songFactsFrom(get, 'The Beatles', 'Hey Jude', 'Q1299'), undefined);
  });
});
