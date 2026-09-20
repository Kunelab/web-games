import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { roleNamed, seatHits, selfClaim } from './asks.js';
import { nightNamed, readSquare, type Seat } from './square.js';

/** A table with the awkward names on it: an accent, a two-worder, a short one. */
const SEATS: Seat[] = [
  { slot: 3, name: 'Aragorn' },
  { slot: 4, name: 'Galadriel' },
  { slot: 7, name: 'Géralt' },
  { slot: 10, name: 'Boba Fett' },
  { slot: 11, name: 'Loki' },
  { slot: 13, name: 'Neo' }
];

/** Every claim of a kind, as slots, so an assertion reads like the sentence did. */
function about(text: string, speaker: number, kind: string): number[] {
  return readSquare(text, speaker, SEATS)
    .filter((claim) => claim.kind === kind)
    .map((claim) => claim.targetSlot)
    .sort((left, right) => left - right);
}

describe('naming a house', () => {
  it('reads a bare number and an exact name', () => {
    assert.deepEqual(
      seatHits('7 and Aragorn were both out', SEATS).map((hit) => hit.slot),
      [7, 3]
    );
  });

  it('does not read a house out of a longer number', () => {
    assert.deepEqual(seatHits('131 votes', SEATS), []);
  });

  it('reads a name typed without its accent', () => {
    assert.deepEqual(
      seatHits('geralt is quiet', SEATS).map((hit) => hit.slot),
      [7]
    );
  });

  it('reads a shortened name and a mistyped one', () => {
    assert.deepEqual(
      seatHits('galad has not said a word', SEATS).map((hit) => hit.slot),
      [4]
    );
    assert.deepEqual(
      seatHits('aragron is lying', SEATS).map((hit) => hit.slot),
      [3]
    );
  });

  it('reads either word of a two-word name', () => {
    assert.deepEqual(
      seatHits('fett went out', SEATS).map((hit) => hit.slot),
      [10]
    );
  });

  it('refuses a guess at a short name', () => {
    // "Neo" is three letters: a typo of it is not recoverable, only exact.
    assert.deepEqual(seatHits('nio did something', SEATS), []);
    assert.deepEqual(
      seatHits('neo did something', SEATS).map((hit) => hit.slot),
      [13]
    );
  });

  it('reads a spelled-out house only behind a cue', () => {
    assert.deepEqual(
      seatHits('vote eleven', SEATS).map((hit) => hit.slot),
      [11]
    );
    assert.deepEqual(seatHits('eleven of us are still alive', SEATS), []);
  });

  it('prefers the exact reading where two overlap', () => {
    const hits = seatHits('Loki 11 again', SEATS);
    assert.deepEqual(
      hits.map((hit) => hit.slot),
      [11, 11]
    );
    assert.ok(hits.every((hit) => hit.exact));
  });
});

describe('reading the square', () => {
  it('files an accusation with its house', () => {
    assert.deepEqual(about('7 is mafia, look at the votes', 3, 'accuse'), [7]);
    assert.deepEqual(about('geralt est louche depuis le debut', 3, 'accuse'), [7]);
    assert.deepEqual(about("i'm voting 11", 3, 'accuse'), [11]);
    assert.deepEqual(about('on pend 11', 3, 'accuse'), [11]);
  });

  it('files a clearing, and reads a refusal as one', () => {
    assert.deepEqual(about('4 is town, I trust her', 3, 'clear'), [4]);
    assert.deepEqual(about('not 11, please', 3, 'clear'), [11]);
    assert.deepEqual(about('7 is not sus at all', 3, 'clear'), [7]);
    assert.deepEqual(about("j'ai confiance en aragorn", 4, 'clear'), [3]);
  });

  it('files a question put to a house', () => {
    assert.deepEqual(about('7, where were you last night?', 3, 'question'), [7]);
    assert.deepEqual(about('11?', 3, 'question'), [11]);
    assert.deepEqual(about('geralt explique toi', 3, 'question'), [7]);
  });

  it('files an alibi and a journey', () => {
    assert.deepEqual(readSquare('I stayed home all night', 3, SEATS), [
      { kind: 'account', targetSlot: 3, account: 'home' }
    ]);
    assert.deepEqual(readSquare('i went to 7 last night', 3, SEATS), [
      { kind: 'account', targetSlot: 7, account: 'visited' }
    ]);
    assert.deepEqual(readSquare('je suis alle chez galadriel', 3, SEATS), [
      { kind: 'account', targetSlot: 4, account: 'visited' }
    ]);
  });

  it('files a sighting', () => {
    assert.deepEqual(about('i saw someone go into 4', 3, 'sighting'), [4]);
    assert.deepEqual(about('11 had a visitor last night', 3, 'sighting'), [11]);
    assert.deepEqual(about("j'ai vu quelqu'un chez geralt", 3, 'sighting'), [7]);
  });

  it('files what the night did to the speaker', () => {
    assert.deepEqual(readSquare('i was healed last night', 3, SEATS), [
      { kind: 'ailing', targetSlot: 3, ailment: 'healed' }
    ]);
    assert.deepEqual(readSquare("on m'a empoisonne, je meurs demain", 3, SEATS), [
      { kind: 'ailing', targetSlot: 3, ailment: 'poison' }
    ]);
    assert.deepEqual(readSquare('i was blackmailed, i cannot say more', 3, SEATS), [
      { kind: 'ailing', targetSlot: 3, ailment: 'silenced' }
    ]);
  });

  it('files a role claim', () => {
    const filed = readSquare('i am the sheriff and 7 came back bad', 3, SEATS);
    assert.deepEqual(
      filed.find((claim) => claim.kind === 'role-claim'),
      {
        kind: 'role-claim',
        targetSlot: 3,
        claimedRole: 'sheriff'
      }
    );
    assert.deepEqual(
      filed.filter((claim) => claim.kind === 'accuse').map((claim) => claim.targetSlot),
      [7]
    );
  });

  it('keeps a verdict with the house it was passed on', () => {
    /**
     * Both of these were read wrongly before the windows learned where a clause
     * ends, and the first was caught in a real trace on the first line typed at
     * it: "lying" is twenty characters from house 4 and belongs to a house that
     * is not at the table.
     */
    assert.deepEqual(readSquare('i think the sheriff is 4 and 99 is lying', 3, SEATS), []);

    const two = readSquare('7 is sus, 4 is fine', 3, SEATS);
    assert.deepEqual(
      two.filter((claim) => claim.kind === 'accuse').map((claim) => claim.targetSlot),
      [7]
    );
    assert.deepEqual(
      two.filter((claim) => claim.kind === 'clear').map((claim) => claim.targetSlot),
      [4]
    );

    // And a comma inside one report still belongs to it: the shape every
    // sheriff's will is written in.
    assert.deepEqual(about('N2: checked 7, came back bad', 3, 'accuse'), [7]);
  });

  /**
   * The three misreads a real afternoon produced, all on the same seat.
   *
   * A person under a wagon types in bursts, and every one of these came out of
   * the reader as the *opposite* of what was said: two clearings of the man
   * they were accusing, and a confession read as a question about somebody
   * else. The board is what every bot reasons from, so a wrong entry is worse
   * than no entry at all.
   */
  it('does not let a denial leak across the seam between two lines', () => {
    // Said as two fragments, a second apart, which `utterance` folds into one.
    const folded = readSquare('Vote for 10 not me. He is the bad guy', 3, SEATS);
    assert.deepEqual(
      folded.filter((claim) => claim.kind === 'clear').map((claim) => claim.targetSlot),
      [],
      'the "not" belongs to the sentence it was typed in'
    );
    assert.deepEqual(
      folded.filter((claim) => claim.kind === 'accuse').map((claim) => claim.targetSlot),
      [10],
      'and the accusation lands the right way round'
    );

    // The rule it must not break: a denial inside one breath still denies.
    assert.deepEqual(about('10 is not sus at all', 3, 'clear'), [10]);
  });

  it('does not read "ok" as a character reference', () => {
    assert.deepEqual(
      readSquare('OK On 10 now', 3, SEATS).filter((claim) => claim.kind === 'clear'),
      [],
      'a person moving their vote onto somebody is not vouching for them'
    );
  });

  it('does not read an opinion about somebody else as a role claim', () => {
    // The expensive false positive: a first-person marker a few characters in
    // front of a role name, in a sentence that is about another house.
    assert.deepEqual(
      readSquare('i think the sheriff is 7', 3, SEATS).filter((c) => c.kind === 'role-claim'),
      []
    );
    assert.deepEqual(
      readSquare('je crois que le sherif est 7', 3, SEATS).filter((c) => c.kind === 'role-claim'),
      []
    );
    assert.equal(readSquare('i am the sheriff', 3, SEATS)[0]?.claimedRole, 'sheriff');
  });

  it('never files a claim about the speaker from somebody else', () => {
    assert.deepEqual(about('3 is mafia', 3, 'accuse'), []);
  });

  it('says nothing about banter', () => {
    assert.deepEqual(readSquare('hello everyone', 3, SEATS), []);
    assert.deepEqual(readSquare('lol', 3, SEATS), []);
    assert.deepEqual(readSquare('good luck all, have fun', 3, SEATS), []);
  });

  it('reads a will one night at a time', () => {
    /**
     * A will is a list, not a sentence, so each line is read on its own: the
     * opposite of chat, where three lines in a row are one thought.
     */
    const will = [
      'N1: stayed home, nothing to report',
      'N2: checked 7, came back bad',
      'N3: I went to 4, they are clean',
      'I am the sheriff'
    ];
    const filed = will.flatMap((line) => readSquare(line, 3, SEATS, { implicitSelf: true }));

    assert.deepEqual(
      filed.filter((claim) => claim.kind === 'accuse').map((claim) => claim.targetSlot),
      [7]
    );
    assert.ok(filed.some((claim) => claim.kind === 'account' && claim.account === 'home'));
    assert.ok(filed.some((claim) => claim.kind === 'account' && claim.account === 'visited' && claim.targetSlot === 4));
    assert.ok(filed.some((claim) => claim.kind === 'role-claim' && claim.claimedRole === 'sheriff'));
  });

  it('does not put a will\'s implicit "I" in front of a named house', () => {
    // "7 stayed home" is a report about 7, even in a will, and filing it as the
    // author's own alibi would be the reader inventing an alibi.
    const filed = readSquare('7 stayed home all night, they said', 3, SEATS, { implicitSelf: true });
    assert.ok(!filed.some((claim) => claim.kind === 'account' && claim.targetSlot === 3));
  });

  it('reads two assertions out of one line', () => {
    const filed = readSquare('not 4, 11 is the liar here', 3, SEATS);
    assert.deepEqual(
      filed.filter((claim) => claim.kind === 'clear').map((claim) => claim.targetSlot),
      [4]
    );
    assert.deepEqual(
      filed.filter((claim) => claim.kind === 'accuse').map((claim) => claim.targetSlot),
      [11]
    );
  });
});

describe('sentences from a real table', () => {
  /** Every claim of every kind, as `kind:slot`, so an assertion reads like the line did. */
  const read = (text: string, speaker = 1, options: { accuser?: number } = {}): string[] =>
    readSquare(text, speaker, SEATS, options)
      .map(
        (claim) =>
          claim.kind +
          (claim.claimedRole ? '(' + claim.claimedRole + ')' : '') +
          (claim.deniedRole ? '(' + claim.deniedRole + ')' : '') +
          (claim.ailment ? '(' + claim.ailment + ')' : '') +
          (claim.targetSlot === speaker ? '' : ':' + String(claim.targetSlot))
      )
      .sort();

  /**
   * The five kinds that existed as types and nothing else.
   *
   * Each is a sentence the user handed over by name, and until now the board
   * either lost it entirely or filed it as something it is not. The last one is
   * the worst of the four: "he cannot be the doctor" was read as a *clearing*
   * of the seat whose badge was being torn up, because the words that carry a
   * denial are the same words a reprieve is written with.
   */
  it('hears the room pushing on the clock', () => {
    assert.deepEqual(read('we need to vote'), ['urge']);
    assert.deepEqual(read('we have to vote because it is starting to be difficult for town'), ['urge']);
    assert.deepEqual(read("let's skip today"), ['urge']);
    assert.deepEqual(read('there is nothing here today'), ['urge']);
    assert.deepEqual(read('il faut voter'), ['urge']);
    // A push and a name in one breath is both things, not one of them.
    assert.deepEqual(read('we need to vote 7'), ['accuse:7', 'urge']);
    // Somebody else's position is not this seat's push.
    assert.deepEqual(read('he keeps saying we should skip'), []);
  });

  it('hears somebody ask what they are accused of', () => {
    assert.deepEqual(read('why me ?', 1), []);
    assert.deepEqual(read('why me ?', 1, { accuser: 7 }), ['demand:7']);
    assert.deepEqual(read('7 on what basis', 1), ['demand:7']);
    assert.deepEqual(read('who put my name up', 1, { accuser: 4 }), ['demand:4']);
    assert.deepEqual(read('pourquoi moi', 1, { accuser: 11 }), ['demand:11']);
  });

  it('hears a badge denied, and does not mistake it for a reprieve', () => {
    assert.deepEqual(read("7 can't be doctor"), ['counter-claim(doctor):7']);
    assert.deepEqual(read('4 is not the sheriff'), ['counter-claim(sheriff):4']);
    // The reading this replaces: 'is not' used to make it a clearing.
    assert.ok(!read("7 can't be doctor").includes('clear:7'), 'denying a badge is not vouching for the seat');
    // And a plain reprieve is still a reprieve.
    assert.deepEqual(read('not 7'), ['clear:7']);
  });

  it('hears a bet the next dawn settles', () => {
    assert.deepEqual(read("wait one night and I'll prove it"), ['promise']);
    assert.deepEqual(read('I will name myself tonight'), ['promise']);
    assert.deepEqual(read('je le prouverai'), ['promise']);
    /**
     * Somebody else's bet is not this seat's bet.
     *
     * The line still files a question against 7, and that is right: "prove it"
     * put to a house is an approach to that house whoever is relaying it. What
     * must not appear is a `promise` from the speaker, who has bet nothing.
     */
    assert.ok(!read('7 said he would prove it').includes('promise'), 'a reported promise is not this seat making one');
  });

  it('reads a blunt accusation, however it is worded', () => {
    assert.deepEqual(read('7 is evil'), ['accuse:7']);
    assert.deepEqual(read('4 is mafia'), ['accuse:4']);
    assert.deepEqual(read('Loki is suspicious'), ['accuse:11']);
    assert.deepEqual(read('13 might be the SK'), ['accuse:13']);
  });

  it('reads a defence offered for somebody else', () => {
    assert.deepEqual(read('4 is framed, he is innocent'), ['clear:4']);
  });

  /**
   * The jailor's own report, which the cell cue used to steal.
   *
   * "I am jailor, I jailed 8" is the man with the keys describing his night. The
   * bare verb read it as him having *been* jailed and filed the ailment on him —
   * on the one seat whose word about a cell is worth anything, and the seat
   * least able to have been in one.
   */
  it('does not read a jailor jailing somebody as the jailor being jailed', () => {
    const claims = read('I am jailor, I jailed 10 and there was no kill that night');
    assert.deepEqual(claims, ['role-claim(jailor)']);
    assert.ok(!claims.some((claim) => claim.includes('jailed)')), 'the jailor was filed as a prisoner');
  });

  it('still reads every way of saying you were the one in the cell', () => {
    for (const line of [
      'I was jailed last night',
      'Jailed last night, so I did nothing.',
      'the jailor had me last night',
      'I spent last night in jail'
    ]) {
      assert.ok(read(line).includes('ailing(jailed)'), line);
    }
  });

  /**
   * What people type instead of a role's name.
   *
   * Nobody writes "the Serial Killer" in a chat box. The table was built from
   * the catalogue's two languages, which is every word the game prints and none
   * of the words it is played in.
   */
  it('reads the abbreviations a table actually uses', () => {
    assert.equal(selfClaim('I am the vet'), 'veteran');
    assert.equal(selfClaim('im sk'), 'serial-killer');
    assert.equal(selfClaim('I am gf'), 'godfather');
    assert.equal(selfClaim('i am vigi'), 'vigilante');
    assert.equal(selfClaim('im the doc'), 'doctor');
    assert.equal(selfClaim('I am the medic'), 'doctor');
    assert.equal(selfClaim('I am the exec'), 'executioner');
    assert.equal(selfClaim('im arso'), 'arsonist');
    assert.equal(selfClaim('I am the jani'), 'janitor');
    assert.equal(selfClaim('im amne'), 'amnesiac');
    assert.equal(selfClaim('i am cult'), 'cultist');
    assert.equal(selfClaim('im electro'), 'electromaniac');
    assert.equal(selfClaim('I am coro'), 'coroner');
    assert.equal(selfClaim('im disg'), 'disguiser');
    assert.equal(selfClaim('I am detec'), 'detective');
  });

  /**
   * Jester has no abbreviation here on purpose.
   *
   * "jest" resolved it, and "you jest" and "in jest" are ordinary English — a
   * role nobody actually shortens is not worth the sentences it would swallow.
   * Kept as a test so it does not get added back on the reasoning that it looks
   * like it belongs in the list.
   */
  it('leaves alone the shortenings that are ordinary words', () => {
    assert.equal(selfClaim('you jest'), null);
    assert.equal(selfClaim('in jest'), null);
    for (const line of ['cultivate the garden', 'electronic', 'coronavirus', 'interrogation room', 'disguise']) {
      assert.equal(selfClaim(line), null, line);
    }
  });

  /**
   * And the reason those are matched on a word boundary rather than by
   * `indexOf`: two letters live inside a great many ordinary words.
   */
  it('does not find a role inside an ordinary word', () => {
    for (const line of ['I asked him already', 'that was risky', 'lets skip', 'execute him', 'medical attention']) {
      assert.equal(selfClaim(line), null, line);
    }
  });

  it('reads a role named without anybody claiming it', () => {
    assert.equal(roleNamed('who is the vet ?'), 'veteran');
    assert.equal(roleNamed('the gf is still alive'), 'godfather');
    assert.equal(roleNamed('nothing here'), null);
  });
});

/**
 * A dead investigator's will, read the way the will generator writes one.
 *
 * The most reliable evidence in the game — a corpse has nothing left to gain by
 * lying about a check — and three quarters of it was being dropped on the floor.
 * Of the four findings a real Sheriff left behind, the board heard one: the
 * colon shape was cut at the colon, and "came back Cult" had no word for the
 * side it named. The town hanged the Sheriff that wrote it for having said
 * nothing about its nights.
 */
describe("a sheriff's will", () => {
  const seats = [
    { slot: 24, name: 'Baloo' },
    { slot: 12, name: 'Robin' },
    { slot: 9, name: 'Demogorgon' },
    { slot: 8, name: 'Optimus Prime' },
    { slot: 5, name: 'Ursula' }
  ];

  const read = (line: string) => readSquare(line, 24, seats, { implicitSelf: true });

  it('reads a check written with a colon', () => {
    assert.deepEqual(read('Night 1, Robin: clean.'), [{ kind: 'clear', targetSlot: 12 }]);
    assert.deepEqual(read('Ursula: clean'), [{ kind: 'clear', targetSlot: 5 }]);
  });

  it('and one written with a verb, as it always did', () => {
    assert.deepEqual(read('Optimus Prime came back clean on night 3.'), [{ kind: 'clear', targetSlot: 8 }]);
  });

  /** The finding that matters most: a confirmed member of a growing faction. */
  it('reads a camp as a verdict, not only an insult', () => {
    assert.deepEqual(read('Demogorgon came back Cult on night 2.'), [{ kind: 'accuse', targetSlot: 9 }]);
    assert.deepEqual(read('Demogorgon came back Triad on night 2.'), [{ kind: 'accuse', targetSlot: 9 }]);
  });

  /**
   * And the asymmetry the colon change rests on: forwards it introduces a
   * report, backwards it still separates one seat's verdict from another's.
   */
  it('still does not read backwards across a colon', () => {
    assert.deepEqual(read('Robin is scum: Ursula'), [{ kind: 'accuse', targetSlot: 12 }]);
  });
});

/**
 * Which night a line of a will is about.
 *
 * Nothing ever filled in `Claim.night`, so every claim read out of a six-night
 * will was dated to the night before it was read: a Sheriff's night-two check,
 * offered to the room on day six, came out as a night-five check. The room can
 * check that and find it false, which hangs the one source that was telling the
 * truth.
 */
describe('the night a will line names', () => {
  it('reads the marker a record is written with', () => {
    assert.equal(nightNamed('N3: checked Robin, clean'), 3);
    assert.equal(nightNamed('night 1 stayed home'), 1);
    assert.equal(nightNamed('Nuit 12, personne'), 12);
    assert.equal(nightNamed('n2 watched 7'), 2);
  });

  it('and says nothing about a line that names none', () => {
    assert.equal(nightNamed('stayed home'), null);
    assert.equal(nightNamed('I told you what I knew while I could'), null);
    // A bare house number is not a night: that is the whole of the confusion.
    assert.equal(nightNamed('7 is lying'), null);
  });
});

/**
 * An afternoon from a real table, read back.
 *
 * Every line below was typed by a person in game 9NBF3 and every reading below
 * is what this parser made of it at the time. Three of them were wrong, and
 * they were wrong in the three ways that cost the most: a badge denial that
 * named the wrong badge, a vote that was never filed because the same sentence
 * also denied a badge, and a piece of open reasoning read as a vouch for the
 * two seats it was reasoning *about*.
 *
 * Kept as a corpus rather than as three invented sentences, because the value
 * is that a person actually typed these and the next regression will be found
 * the same way.
 */
describe('an afternoon somebody really typed', () => {
  const TABLE: Seat[] = [
    { slot: 1, name: 'Tonton' },
    { slot: 2, name: 'Xavier' },
    { slot: 6, name: 'Athena' },
    { slot: 8, name: 'Blade' },
    { slot: 10, name: 'Loki' },
    { slot: 19, name: 'Saul Goodman' },
    { slot: 20, name: 'Pinhead' }
  ];
  const said = (text: string, speaker: number) => readSquare(text, speaker, TABLE);

  it('denies the badge the denial names, not the next role in the sentence', () => {
    assert.deepEqual(said("Athena can't be jester, any role was enforcer and a jester is already dead", 1), [
      { kind: 'counter-claim', targetSlot: 6, deniedRole: 'jester' }
    ]);
  });

  it('files the vote as well as the denial when one breath carries both', () => {
    assert.deepEqual(said('vote for athena she is not jester', 2), [
      { kind: 'counter-claim', targetSlot: 6, deniedRole: 'jester' },
      { kind: 'accuse', targetSlot: 6 }
    ]);
  });

  it('files nothing for a sentence that offers two answers and picks neither', () => {
    assert.deepEqual(said('Pinhead and loki were not converted They are either town power or evil', 2), []);
  });

  it('still reads the plain ones it always read', () => {
    assert.deepEqual(said('Blade is not crier', 2), [{ kind: 'counter-claim', targetSlot: 8, deniedRole: 'crier' }]);
    assert.deepEqual(said('go vote for 6', 1), [{ kind: 'accuse', targetSlot: 6 }]);
    assert.deepEqual(said('pinhead is not town for sure', 2), [{ kind: 'accuse', targetSlot: 20 }]);
    assert.deepEqual(said('I am mason', 2), [{ kind: 'role-claim', targetSlot: 2, claimedRole: 'mason' }]);
  });

  it('and says nothing about greetings and asides', () => {
    assert.deepEqual(said('Hi', 1), []);
    assert.deepEqual(said('It can be confirmed by my friend', 2), []);
    assert.deepEqual(said('same for Saul Goodman.', 2), []);
  });
});

/**
 * Three readings off one real afternoon on the mini PC, two of them backwards.
 *
 * A person spent a game telling the room, four times, which killer he had
 * worked out. The board recorded it once, as the opposite. The trace is
 * `mafia-2026-09-20T16-29-53-KYKY2`, and these are his sentences.
 */
describe('the afternoon the reader got backwards', () => {
  const TABLE: Seat[] = [
    { slot: 4, name: 'Eevee' },
    { slot: 5, name: 'BradStallion' },
    { slot: 20, name: 'Susanoo' }
  ];

  const filed = (text: string, speaker: number): { kind: string; targetSlot: number }[] =>
    readSquare(text, speaker, TABLE).map((claim) => ({ kind: claim.kind, targetSlot: claim.targetSlot }));

  /**
   * The commonest accusation a person makes, and the reader had no word for it.
   * `EVIL` knows "scum" and "liar" and every insult in two languages; it did not
   * know the sixty-three role names the game is actually played with.
   */
  it('hears a killer named by its badge', () => {
    assert.deepEqual(filed('Susanoo is Electromaniac', 5), [{ kind: 'accuse', targetSlot: 20 }]);
  });

  /**
   * And the sentence that cost him the game: the same accusation with a
   * friendly word in front of it came out as a clearing, because "trust" was
   * the nearest verdict the reader recognised.
   */
  it('no longer clears the seat it is accusing', () => {
    const read = filed('town trust me I am with you! Susanoo is the Electromaniac', 5);
    assert.ok(
      read.some((claim) => claim.kind === 'accuse' && claim.targetSlot === 20),
      `expected an accusation on 20, got ${JSON.stringify(read)}`
    );
    assert.ok(!read.some((claim) => claim.kind === 'clear' && claim.targetSlot === 20));
  });

  /** A denial of the same badge is still a denial and must not become a rope. */
  it('still reads a denial as a denial', () => {
    const read = filed('Susanoo is not the Electromaniac', 5);
    assert.ok(!read.some((claim) => claim.kind === 'accuse'));
  });

  /**
   * A killer named in front of a house is somebody being quoted, not accused.
   * Reading it the other way would hang the seat being vouched for.
   */
  it('does not accuse a house somebody else was quoted about', () => {
    const read = filed('the consigliere said Eevee is clean', 5);
    assert.ok(!read.some((claim) => claim.kind === 'accuse' && claim.targetSlot === 4));
  });

  /**
   * And the third reading: a man counting the roster out loud, filed as a
   * verdict on house 4 because "4" was a number and "town" was nearby.
   */
  it('knows a tally from a house', () => {
    assert.deepEqual(filed('Lookout is possible, there is 4 random town slot', 5), []);
  });

  it('still reads a house that is only a number', () => {
    assert.deepEqual(filed('4 is town', 5), [{ kind: 'clear', targetSlot: 4 }]);
  });
});
