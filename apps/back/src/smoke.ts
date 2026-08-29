/**
 * End-to-end check of the API and the game engine.
 *
 * Uses `app.inject()` so it never binds a port. It writes real rows, so it is
 * launched through `smoke-run.ts`, which hands it a throwaway database and
 * removes it afterwards. Run it with `pnpm test` or `pnpm smoke`; running this
 * file directly would write to whatever DATABASE_FILE points at.
 */
import assert from 'node:assert/strict';

import { answerFieldSchema, blindtest, defaultSessionConfig, quiz, sessionConfigSchema } from 'game-core';

import { buildApp } from './app.js';
import { closeDb } from './db/index.js';
import { clearAssets, resolveAsset } from './game/assets.js';
import {
  advance,
  closeAnswers,
  createSession,
  joinSession,
  openAnswers,
  submitAnswer,
  toRevealView,
  toRoundView,
  toSessionView
} from './game/session.js';
import type { MediaView } from './services/media-service.js';
import { resultsService } from './services/results-service.js';

const app = await buildApp();
await app.ready();

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function section(name: string) {
  console.log(`\n--- ${name} ---`);
}

const login = `smoke_${Date.now()}`;

/* ----------------------------- auth and access ---------------------------- */
section('auth');

const anon = await app.inject({ method: 'GET', url: '/api/user' });
check('anonymous /api/user is 200 null', anon.statusCode === 200 && anon.body === 'null', anon.body);

const guarded = await app.inject({ method: 'GET', url: '/api/media' });
check('media requires a session', guarded.statusCode === 401, guarded.statusCode);

const registered = await app.inject({
  method: 'POST',
  url: '/api/user/register',
  payload: { username: login, password: 'hunter2hunter2', email: `${login}@example.com` }
});
check('register is 201', registered.statusCode === 201, registered.body);

const cookie = registered.cookies.find((entry) => entry.name === 'kune.sid');
assert(cookie, 'register must set a session cookie');
const headers = { cookie: `${cookie.name}=${cookie.value}` };

const shortPassword = await app.inject({
  method: 'POST',
  url: '/api/user/register',
  payload: { username: `${login}_short`, password: 'court', email: `short${login}@example.com` }
});
check('a password under eight characters is rejected', shortPassword.statusCode === 400, shortPassword.statusCode);

/**
 * Eleven wrong passwords in a row. The limit is ten a minute, so the last one is
 * refused without ever reaching bcrypt, which is the point: guessing has to cost
 * the attacker something other than time.
 */
const attempts: number[] = [];
for (let attempt = 0; attempt < 11; attempt++) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/user/login',
    payload: { username: login, password: 'not-the-password' }
  });
  attempts.push(response.statusCode);
}
check(
  'wrong passwords are refused',
  attempts.slice(0, 10).every((status) => status === 400),
  attempts
);
check('and repeated attempts are rate limited', attempts[10] === 429, attempts[10]);

/* -------------------------------- kinds ----------------------------------- */
section('media kinds');

const kinds = await app.inject({ method: 'GET', url: '/api/media/kinds', headers });
const kindList = JSON.parse(kinds.body) as { id: string; formFields: unknown[] }[];
check(
  'kind registry is served',
  kindList.length >= 4,
  kindList.map((kind) => kind.id)
);
check(
  'kinds carry form metadata',
  kindList.every((kind) => Array.isArray(kind.formFields))
);

/* -------------------------------- media ----------------------------------- */
section('media CRUD');

const draft = await app.inject({
  method: 'POST',
  url: '/api/media',
  headers,
  payload: { kind: 'blindtest', title: 'Brouillon', answers: [], payload: blindtest.defaultPayload }
});
check('a draft with no video saves', draft.statusCode === 201, draft.body);
const draftItem = JSON.parse(draft.body) as MediaView;
check('the draft is reported not ready', draftItem.readiness.ready === false, draftItem.readiness);
check('and says what is missing', draftItem.readiness.missing.length > 0, draftItem.readiness.missing);

const complete = await app.inject({
  method: 'POST',
  url: '/api/media',
  headers,
  payload: {
    kind: 'blindtest',
    title: 'Dicke Titten',
    category: 'metal',
    date: '2022-04-29',
    answers: [
      { key: 'title', label: 'Titre', value: 'Dicke Titten', points: 3 },
      { key: 'artist', label: 'Artiste', value: 'Rammstein', points: 2 },
      { key: 'year', label: 'Année', value: '2022', points: 1 }
    ],
    payload: { code: 'thJgU9jkdU4', startGuess: 13, endGuess: 23, startReveal: 102, endReveal: 112 }
  }
});
check('a complete blindtest saves', complete.statusCode === 201, complete.body);
const blindItem = JSON.parse(complete.body) as MediaView;
check('and is ready', blindItem.readiness.ready === true, blindItem.readiness);
check('answer defaults are filled in', blindItem.answers[0]?.tolerance === 0.17, blindItem.answers[0]);
check('effective timing comes from the kind', blindItem.effectiveTiming.answerMs === 30_000, blindItem.effectiveTiming);

const badPayload = await app.inject({
  method: 'POST',
  url: '/api/media',
  headers,
  payload: { kind: 'blindtest', title: 'x', answers: [], payload: { ...blindtest.defaultPayload, code: 'short' } }
});
check('a malformed video id is rejected', badPayload.statusCode === 400, badPayload.statusCode);

const badKind = await app.inject({
  method: 'POST',
  url: '/api/media',
  headers,
  payload: { kind: 'not-a-kind', title: 'x', answers: [], payload: {} }
});
check('an unknown kind is rejected', badKind.statusCode === 400, badKind.statusCode);

const spoof = await app.inject({
  method: 'POST',
  url: '/api/media',
  headers,
  payload: {
    kind: 'quiz',
    title: 'spoof',
    answers: [],
    payload: quiz.defaultPayload,
    user_id: 99_999,
    id: 4242
  }
});
const spoofed = JSON.parse(spoof.body) as MediaView;
check('body cannot set user_id', spoofed.user_id === blindItem.user_id, spoofed.user_id);
check('body cannot set id', spoofed.id !== 4242, spoofed.id);

const quizItem = JSON.parse(
  (
    await app.inject({
      method: 'POST',
      url: '/api/media',
      headers,
      payload: {
        kind: 'quiz',
        title: 'Capitale de la Mongolie',
        answers: [
          {
            key: 'answer',
            label: 'Réponse',
            value: 'Oulan-Bator',
            points: 3,
            directBonus: 3,
            choices: ['Oulan-Bator', 'Astana', 'Bichkek', 'Douchanbé']
          }
        ],
        payload: { question: 'Quelle est la capitale de la Mongolie ?', imageUrl: '', explanation: 'Ulaanbaatar.' }
      }
    })
  ).body
) as MediaView;
check('a quiz with choices saves and is ready', quizItem.readiness.ready === true, quizItem.readiness);

const listed = await app.inject({ method: 'GET', url: '/api/media', headers });
check('media lists', (JSON.parse(listed.body) as unknown[]).length === 4, listed.body.length);

const filtered = await app.inject({ method: 'GET', url: '/api/media?kind=quiz', headers });
check('media filters by kind', (JSON.parse(filtered.body) as unknown[]).length === 2, filtered.body);

const searched = await app.inject({ method: 'GET', url: '/api/media?search=Dicke', headers });
check('media searches by title', (JSON.parse(searched.body) as unknown[]).length === 1, searched.body);

const categories = await app.inject({ method: 'GET', url: '/api/media/categories', headers });
check('categories are collected', (JSON.parse(categories.body) as string[]).includes('metal'), categories.body);

const patched = await app.inject({
  method: 'PATCH',
  url: `/api/media/${blindItem.id}`,
  headers,
  payload: {
    kind: 'blindtest',
    title: 'Dicke Titten (corrigé)',
    answers: blindItem.answers,
    payload: blindItem.payload
  }
});
check('media updates', (JSON.parse(patched.body) as MediaView).title === 'Dicke Titten (corrigé)', patched.body);

/* ------------------------------- duplicating ------------------------------ */
section('duplicating media');

const copied = await app.inject({ method: 'POST', url: `/api/media/${quizItem.id}/duplicate`, headers });
check('media duplicates', copied.statusCode === 201, copied.body);
const copy = JSON.parse(copied.body) as MediaView;
check('the copy is a new item', copy.id !== quizItem.id, { original: quizItem.id, copy: copy.id });
check('the copy is named as one', copy.title === `${quizItem.title} (copie)`, copy.title);
check('the content comes across', JSON.stringify(copy.payload) === JSON.stringify(quizItem.payload));
check('and so do the answers', copy.answers.length === quizItem.answers.length, copy.answers.length);
check('the copy is ready if the original was', copy.readiness.ready === quizItem.readiness.ready);

const copiedTwice = await app.inject({ method: 'POST', url: `/api/media/${quizItem.id}/duplicate`, headers });
const secondCopy = JSON.parse(copiedTwice.body) as MediaView;
check('a second copy is numbered', secondCopy.title === `${quizItem.title} (copie 2)`, secondCopy.title);

// Copying the copy must not stack suffixes.
const copiedCopy = await app.inject({ method: 'POST', url: `/api/media/${copy.id}/duplicate`, headers });
const thirdCopy = JSON.parse(copiedCopy.body) as MediaView;
check('copies of copies do not stack', thirdCopy.title === `${quizItem.title} (copie 3)`, thirdCopy.title);

for (const doomed of [copy.id, secondCopy.id, thirdCopy.id]) {
  await app.inject({ method: 'DELETE', url: `/api/media/${doomed}`, headers });
}

const missingCopy = await app.inject({ method: 'POST', url: '/api/media/999999/duplicate', headers });
check('duplicating something that does not exist is 404', missingCopy.statusCode === 404, missingCopy.statusCode);

/* ------------------------------- playlists -------------------------------- */
section('playlists');

const playlist = await app.inject({
  method: 'POST',
  url: '/api/playlists',
  headers,
  payload: { name: 'Soirée test', public: true, mediaIds: [blindItem.id, quizItem.id, draftItem.id] }
});
check('playlist creates with contents', playlist.statusCode === 201, playlist.body);
const playlistView = JSON.parse(playlist.body) as {
  id: number;
  items: MediaView[];
  kindCounts: Record<string, number>;
  notReadyCount: number;
  owner: { login: string } | null;
};
check(
  'order is preserved',
  playlistView.items[0]?.id === blindItem.id,
  playlistView.items.map((i) => i.id)
);
check('owner is nested', playlistView.owner?.login === login, playlistView.owner);
check('kinds are counted', playlistView.kindCounts.blindtest === 2, playlistView.kindCounts);
check('the draft counts as not ready', playlistView.notReadyCount === 1, playlistView.notReadyCount);

const reordered = await app.inject({
  method: 'PATCH',
  url: `/api/playlists/${playlistView.id}`,
  headers,
  payload: { mediaIds: [quizItem.id, blindItem.id] }
});
const reorderedView = JSON.parse(reordered.body) as { items: MediaView[] };
check(
  'reordering works',
  reorderedView.items[0]?.id === quizItem.id,
  reorderedView.items.map((i) => i.id)
);
check('and dropping an item works', reorderedView.items.length === 2, reorderedView.items.length);

const renamed = await app.inject({
  method: 'PATCH',
  url: `/api/playlists/${playlistView.id}`,
  headers,
  payload: { name: 'Renommée' }
});
const renamedView = JSON.parse(renamed.body) as { name: string; items: unknown[] };
check('a metadata-only patch keeps contents', renamedView.items.length === 2, renamedView.items.length);

const clonedPlaylist = await app.inject({
  method: 'POST',
  url: `/api/playlists/${playlistView.id}/duplicate`,
  headers
});
check('playlist duplicates', clonedPlaylist.statusCode === 201, clonedPlaylist.body);
const clonedView = JSON.parse(clonedPlaylist.body) as {
  id: number;
  name: string;
  public: boolean | null;
  items: MediaView[];
  dropped: number;
};
check('the copy is a new playlist', clonedView.id !== playlistView.id, clonedView.id);
check('named as a copy', clonedView.name === 'Renommée (copie)', clonedView.name);
check(
  'contents and order come across',
  clonedView.items.map((item) => item.id).join() === [quizItem.id, blindItem.id].join(),
  clonedView.items.map((item) => item.id)
);
check('nothing was dropped', clonedView.dropped === 0, clonedView.dropped);
// Publishing is a decision, and copying something public is not making it.
check('the copy is private whatever the original was', clonedView.public === false, clonedView.public);

// The media itself is shared with the copy, not forked: a playlist is an
// arrangement, and duplicating one must not double the library.
const libraryAfterClone = await app.inject({ method: 'GET', url: '/api/media', headers });
check(
  'duplicating a playlist copies no media',
  (JSON.parse(libraryAfterClone.body) as unknown[]).length === 4,
  (JSON.parse(libraryAfterClone.body) as unknown[]).length
);

await app.inject({ method: 'DELETE', url: `/api/playlists/${clonedView.id}`, headers });

/* --------------------------- cross-user isolation ------------------------- */
section('isolation');

const other = await app.inject({
  method: 'POST',
  url: '/api/user/register',
  payload: { username: `${login}_b`, password: 'hunter2hunter2', email: `b${login}@example.com` }
});
const otherCookie = other.cookies.find((entry) => entry.name === 'kune.sid');
assert(otherCookie);
const otherHeaders = { cookie: `${otherCookie.name}=${otherCookie.value}` };

const otherMedia = await app.inject({ method: 'GET', url: '/api/media', headers: otherHeaders });
check(
  'a second user sees no media of the first',
  (JSON.parse(otherMedia.body) as unknown[]).length === 0,
  otherMedia.body
);

const crossDelete = await app.inject({
  method: 'DELETE',
  url: `/api/media/${blindItem.id}`,
  headers: otherHeaders
});
check('a second user cannot delete media', crossDelete.statusCode === 404, crossDelete.statusCode);

const crossEdit = await app.inject({
  method: 'PATCH',
  url: `/api/playlists/${playlistView.id}`,
  headers: otherHeaders,
  payload: { name: 'détournée' }
});
check('public does not mean editable', crossEdit.statusCode === 404, crossEdit.statusCode);

/**
 * A public playlist can be taken as a starting point, but the media in it belongs
 * to its author, so the arrangement arrives empty and says so. Without `dropped`
 * this would look like a copy that silently lost everything.
 */
const crossClone = await app.inject({
  method: 'POST',
  url: `/api/playlists/${playlistView.id}/duplicate`,
  headers: otherHeaders
});
check('a public playlist can be copied', crossClone.statusCode === 201, crossClone.statusCode);
const crossCloneView = JSON.parse(crossClone.body) as { id: number; items: unknown[]; dropped: number };
check("but not another user's media with it", crossCloneView.items.length === 0, crossCloneView.items.length);
check('and the copy reports what it could not take', crossCloneView.dropped === 2, crossCloneView.dropped);

await app.inject({ method: 'DELETE', url: `/api/playlists/${crossCloneView.id}`, headers: otherHeaders });

// A crafted request must not be able to pull another user's media into a playlist.
const otherPlaylist = await app.inject({
  method: 'POST',
  url: '/api/playlists',
  headers: otherHeaders,
  payload: { name: 'vol', mediaIds: [blindItem.id] }
});
const stolen = JSON.parse(otherPlaylist.body) as { items: unknown[] };
check("another user's media cannot be linked", stolen.items.length === 0, stolen.items);

/* ------------------------------ game session ------------------------------ */
section('game session');

const started = await app.inject({
  method: 'POST',
  url: '/api/play/sessions',
  headers,
  payload: { playlistId: playlistView.id }
});
check('a session starts', started.statusCode === 201, started.body);
const session = JSON.parse(started.body) as {
  code: string;
  hostToken: string;
  total: number;
  skipped: unknown[];
};
check('the join code is five characters', session.code.length === 5, session.code);
check('a host token is issued', typeof session.hostToken === 'string' && session.hostToken.length > 10);
check('only ready media is queued', session.total === 2, session.total);

const lookup = await app.inject({ method: 'GET', url: `/api/play/sessions/${session.code}` });
check('the code can be looked up without a login', lookup.statusCode === 200, lookup.statusCode);
check('the lookup leaks no media', !lookup.body.includes('Rammstein'), lookup.body);

const lowercase = await app.inject({ method: 'GET', url: `/api/play/sessions/${session.code.toLowerCase()}` });
check('codes are case-insensitive', lowercase.statusCode === 200, lowercase.statusCode);

const missing = await app.inject({ method: 'GET', url: '/api/play/sessions/ZZZZZ' });
check('an unknown code is 404', missing.statusCode === 404, missing.statusCode);

const emptyPlaylist = await app.inject({
  method: 'POST',
  url: '/api/playlists',
  headers,
  payload: { name: 'vide', mediaIds: [] }
});
const emptyStart = await app.inject({
  method: 'POST',
  url: '/api/play/sessions',
  headers,
  payload: { playlistId: (JSON.parse(emptyPlaylist.body) as { id: number }).id }
});
check('an empty playlist cannot start', emptyStart.statusCode === 400, emptyStart.statusCode);

const draftOnly = await app.inject({
  method: 'POST',
  url: '/api/playlists',
  headers,
  payload: { name: 'brouillons', mediaIds: [draftItem.id] }
});
const draftStart = await app.inject({
  method: 'POST',
  url: '/api/play/sessions',
  headers,
  payload: { playlistId: (JSON.parse(draftOnly.body) as { id: number }).id }
});
check('a playlist of drafts cannot start', draftStart.statusCode === 400, draftStart.statusCode);

/* ------------------------ engine: scoring and redaction ------------------- */
section('engine');

clearAssets();

const items = await app.inject({ method: 'GET', url: `/api/playlists/${playlistView.id}`, headers });
const playable = (JSON.parse(items.body) as { items: MediaView[] }).items;

const state = createSession({
  playlistName: 'test',
  playlistId: null,
  hostUserId: 1,
  items: playable,
  config: defaultSessionConfig,
  existingCodes: new Set()
});

const alice = joinSession(state, 'Alice', undefined).player;
const bob = joinSession(state, 'Bob', undefined).player;
const clash = joinSession(state, 'Alice', undefined).player;
check('duplicate names are disambiguated', clash.name !== alice.name, [alice.name, clash.name]);

const rejoin = joinSession(state, 'Alice', alice.token);
check('a token reclaims the same seat', rejoin.player.id === alice.id && rejoin.reconnected, rejoin.player.id);

// Simulate two very different connections.
alice.rttMs = 40;
bob.rttMs = 600;

advance(state, (id) => playable.find((item) => item.id === id));
check('the first round opens', state.round !== null && state.phase === 'playing', state.phase);

const round = state.round;
assert(round);

const context = { imageUrl: (source: string) => `/api/play/asset/token-for-${source}` };
const aliceView = toRoundView(state, alice.id, context);
assert(aliceView);

check('players never receive answer values', !JSON.stringify(aliceView).includes('Oulan-Bator'), aliceView.fields);
check('field prompts are sent', aliceView.fields.length > 0, aliceView.fields);
check(
  'choices are withheld until revealed',
  aliceView.fields.every((field) => field.choices === undefined),
  aliceView.fields
);
check(
  'but the player is told choices exist',
  aliceView.fields.some((field) => field.hasChoices),
  aliceView.fields
);

const firstFieldKey = round.answers[0]?.key ?? '';
const correctValue = round.answers[0]?.value ?? '';

// Bob pressed first in real time but his packet arrives later.
const bobResult = submitAnswer({
  state,
  playerId: bob.id,
  roundId: round.id,
  fieldKey: firstFieldKey,
  value: correctValue,
  claimedAt: round.phaseStartAt + 1_000,
  receivedAt: round.phaseStartAt + 1_400
});
const aliceResult = submitAnswer({
  state,
  playerId: alice.id,
  roundId: round.id,
  fieldKey: firstFieldKey,
  value: correctValue,
  claimedAt: round.phaseStartAt + 1_200,
  receivedAt: round.phaseStartAt + 1_230
});
check('both answers accepted', bobResult.ok && aliceResult.ok, [bobResult, aliceResult]);
check('both judged correct', bobResult.correct === true && aliceResult.correct === true);

const wrong = submitAnswer({
  state,
  playerId: alice.id,
  roundId: round.id,
  fieldKey: firstFieldKey,
  value: 'totalement faux',
  claimedAt: round.phaseStartAt + 2_000,
  receivedAt: round.phaseStartAt + 2_000
});
check('a field already solved is refused', wrong.ok === false, wrong);

const typo = submitAnswer({
  state,
  playerId: clash.id,
  roundId: round.id,
  fieldKey: firstFieldKey,
  value: correctValue.slice(0, -1) + correctValue.slice(-1).toUpperCase(),
  claimedAt: round.phaseStartAt + 3_000,
  receivedAt: round.phaseStartAt + 3_000
});
check('case differences still match', typo.correct === true, typo);

closeAnswers(state);
check('the round moves to reveal', state.round?.phase === 'reveal', state.round?.phase);

const bobScore = state.players[bob.id]?.totalScore ?? 0;
const aliceScore = state.players[alice.id]?.totalScore ?? 0;
check('lag compensation puts Bob first despite arriving later', bobScore > aliceScore, { bobScore, aliceScore });

const revealed = toSessionView(state, alice.id, false, context);
check('the reveal carries the answers', revealed.reveal !== null && revealed.reveal.answers.length > 0);
check('reveal scores are attributed', (revealed.reveal?.roundScores.length ?? 0) >= 2, revealed.reveal?.roundScores);

const lateAnswer = submitAnswer({
  state,
  playerId: alice.id,
  roundId: round.id,
  fieldKey: firstFieldKey,
  value: correctValue,
  claimedAt: Date.now(),
  receivedAt: Date.now()
});
check('answers are refused once closed', lateAnswer.ok === false, lateAnswer);

advance(state, (id) => playable.find((item) => item.id === id));
check('the session advances to the next round', state.round?.index === 1, state.round?.index);

advance(state, (id) => playable.find((item) => item.id === id));
check('the session finishes after the last round', state.phase === 'finished', state.phase);

/* ------------------------- answers are not aimed -------------------------- */
section('pooled answers');

{
  // Three written answers on one item. A player types what they know, into whatever
  // box is in front of them, and each answer counts once.
  const film = [
    answerFieldSchema.parse({ key: 'subject', label: 'Film', value: 'Terminator 2', points: 3 }),
    answerFieldSchema.parse({ key: 'year', label: 'Année', value: '1991', points: 1 })
  ];
  const item: MediaView = {
    ...quizItem,
    id: 9_001,
    answers: film,
    payload: { question: 'Ce film ?', imageUrl: '', explanation: '' }
  };

  const pool = createSession({
    playlistName: 'pool',
    playlistId: null,
    hostUserId: 1,
    items: [item],
    config: sessionConfigSchema.parse({ attemptsPerField: 2 }),
    existingCodes: new Set()
  });
  const solo = joinSession(pool, 'Solo', undefined).player;
  advance(pool, () => item);

  const into = (value: string, fieldKey: string) =>
    submitAnswer({
      state: pool,
      playerId: solo.id,
      roundId: pool.round?.id ?? '',
      fieldKey,
      value,
      claimedAt: Date.now(),
      receivedAt: Date.now()
    });

  const year = into('1991', 'subject');
  check('the year counts when typed into the film box', year.correct === true, year);
  check(
    'and it is credited to the year',
    pool.round?.submissions.some((s) => s.fieldKey === 'year' && s.correct) === true
  );

  check('the film still counts afterwards', into('Terminator 2', 'subject').correct === true);
  check('but nobody scores the same answer twice', into('1991', 'subject').error === 'Déjà trouvé');

  // The wrong-guess allowance covers the round rather than one prompt: two tries on
  // each of two written answers is four, unpartitioned.
  const spam = createSession({
    playlistName: 'pool',
    playlistId: null,
    hostUserId: 1,
    items: [item],
    config: sessionConfigSchema.parse({ attemptsPerField: 2 }),
    existingCodes: new Set()
  });
  const waster = joinSession(spam, 'Waster', undefined).player;
  advance(spam, () => item);
  const guesses = [1, 2, 3, 4, 5].map((n) =>
    submitAnswer({
      state: spam,
      playerId: waster.id,
      roundId: spam.round?.id ?? '',
      fieldKey: 'subject',
      value: `bogus ${n}`,
      claimedAt: Date.now(),
      receivedAt: Date.now()
    })
  );
  check(
    'four wrong guesses are accepted',
    guesses.slice(0, 4).every((r) => r.ok)
  );
  check('the fifth is refused for the round', guesses[4]?.error === "Plus d'essais pour ce tour", guesses[4]);
  check(
    'and every written answer is then locked',
    (toRoundView(spam, waster.id, { imageUrl: () => '' })?.lockedFieldKeys.length ?? 0) === 2
  );
}

/* ------------------------------- estimation ------------------------------- */
section('estimation');

{
  // One number each, closest wins. Every submission is a commitment, not an attempt.
  const item: MediaView = {
    ...quizItem,
    id: 9_002,
    kind: 'estimation',
    answers: [answerFieldSchema.parse({ key: 'estimate', value: '100', points: 3 })],
    payload: { question: 'Combien de km ?', imageUrl: '', unit: 'km' }
  };

  const est = createSession({
    playlistName: 'estimation',
    playlistId: null,
    hostUserId: 1,
    items: [item],
    config: defaultSessionConfig,
    existingCodes: new Set()
  });
  const near = joinSession(est, 'Near', undefined).player;
  const far = joinSession(est, 'Far', undefined).player;
  const exact = joinSession(est, 'Exact', undefined).player;
  advance(est, () => item);
  const roundId = est.round?.id ?? '';

  const send = (playerId: string, value: string) =>
    submitAnswer({
      state: est,
      playerId,
      roundId,
      fieldKey: 'estimate',
      value,
      claimedAt: Date.now(),
      receivedAt: Date.now()
    });

  check('a non-number is refused', send(near.id, 'beaucoup').error === 'Entre un nombre');
  check('a number is accepted', send(near.id, '150').ok === true);
  send(near.id, '110');
  check(
    'a revision replaces the previous number',
    est.round?.submissions.filter((s) => s.playerId === near.id).length === 1,
    est.round?.submissions
  );
  send(far.id, '1 000');
  send(exact.id, '100');

  closeAnswers(est);
  const scored = est.round?.scored ?? {};
  check(
    'closer numbers score higher',
    (scored[exact.id] ?? 0) > (scored[near.id] ?? 0) && (scored[near.id] ?? 0) > (scored[far.id] ?? 0),
    scored
  );
  check('the exact value earns its bonus', scored[exact.id] === 4.5, scored);

  const reveal = toRevealView(est);
  check(
    'the reveal lists every guess, closest first',
    reveal?.guesses?.map((guess) => guess.name).join(',') === 'Exact,Near,Far',
    reveal?.guesses
  );
  check('deltas are signed', reveal?.guesses?.some((guess) => guess.delta === 10) === true, reveal?.guesses);

  // Finish the game: the ceremony appears, and the history row is written.
  advance(est, () => item);
  check('the estimation session finishes', est.phase === 'finished', est.phase);

  const finalView = toSessionView(est, null, true, { imageUrl: () => '' });
  check('the ceremony hands out awards', (finalView.final?.awards.length ?? 0) > 0, finalView.final);

  await resultsService.record(est);

  const history = await app.inject({ method: 'GET', url: '/api/play/results', headers });
  check(
    'history lists the recorded game',
    history.statusCode === 200 && (JSON.parse(history.body) as unknown[]).length === 1,
    history.body
  );

  const careers = await app.inject({ method: 'GET', url: '/api/play/careers', headers });
  const careerRows = JSON.parse(careers.body) as { name: string; wins: number }[];
  check('careers aggregate by nickname', careerRows.find((row) => row.name === 'Exact')?.wins === 1, careerRows);

  const anonymousHistory = await app.inject({ method: 'GET', url: '/api/play/results' });
  check('history requires a login', anonymousHistory.statusCode === 401, anonymousHistory.statusCode);
}

/* ------------------------------- oral mode -------------------------------- */
section('oral mode');

{
  const oral = createSession({
    playlistName: 'oral',
    playlistId: null,
    hostUserId: 1,
    items: playable,
    // Two separate things: `oral` takes the clock off the answers, `autoAdvance`
    // decides whether the reveal moves on by itself. The launch form turns the
    // second one off when you pick the first, but the engine keeps them apart so a
    // hands-off run through a playlist stays possible.
    config: sessionConfigSchema.parse({ oral: true, autoAdvance: false }),
    existingCodes: new Set()
  });

  // The whole point of the mode: nobody is here, and it starts anyway.
  check('starts with nobody in the room', Object.keys(oral.players).length === 0);

  advance(oral, (id) => playable.find((item) => item.id === id));
  check('a round opens with no players', oral.round !== null && oral.phase === 'playing', oral.phase);

  const phase = oral.round?.phase;
  if (phase === 'study') {
    // A study timer survives: "twenty seconds to look at the panel" is the game.
    check('a study phase keeps its deadline', oral.round?.phaseEndsAt !== null);
    openAnswers(oral);
  }
  check('answering has no deadline', oral.round?.phaseEndsAt === null, oral.round?.phaseEndsAt);

  const view = toSessionView(oral, null, true, { imageUrl: () => '' });
  check('the view says it is oral', view.oral === true);
  check('the host still sees the answers', (view.hostRound?.answers.length ?? 0) > 0);

  closeAnswers(oral);
  check('closing scores nobody', Object.keys(oral.round?.scored ?? {}).length === 0);
  check('the reveal waits for the host', oral.round?.phaseEndsAt === null);
  check('the reveal still carries the answers', (toRevealView(oral)?.answers.length ?? 0) > 0);

  // The other half of that split: an oral game left on auto still advances itself,
  // because taking the clock off the answers is not the same as taking it off the
  // reveal.
  const auto = createSession({
    playlistName: 'oral auto',
    playlistId: null,
    hostUserId: 1,
    items: playable,
    config: sessionConfigSchema.parse({ oral: true, autoAdvance: true }),
    existingCodes: new Set()
  });
  advance(auto, (id) => playable.find((item) => item.id === id));
  if (auto.round?.phase === 'study') openAnswers(auto);
  closeAnswers(auto);
  check('but auto-advance still governs the reveal', auto.round?.phaseEndsAt !== null);
}

/* --------------------------------- CoronaZ -------------------------------- */
section('coronaz');

{
  const started = await app.inject({
    method: 'POST',
    url: '/api/zombie/sessions',
    headers,
    payload: { config: { mode: 'gm', scenario: 'purge', width: 6, height: 4 } }
  });
  check('a raid session starts', started.statusCode === 201, started.body);
  const raid = JSON.parse(started.body) as { code: string; hostToken: string; gmToken?: string };
  check('a host token is issued', typeof raid.hostToken === 'string' && raid.hostToken.length > 10);
  check('a gm token is issued in gm mode', typeof raid.gmToken === 'string');

  const lookup = await app.inject({ method: 'GET', url: `/api/zombie/sessions/${raid.code}` });
  check('the raid code can be looked up without a login', lookup.statusCode === 200);
  check('the lookup leaks no tokens', !lookup.body.includes(raid.hostToken), lookup.body);

  const anonymous = await app.inject({ method: 'POST', url: '/api/zombie/sessions', payload: {} });
  check('creating a raid needs a login', anonymous.statusCode === 401, anonymous.statusCode);

  const mine = await app.inject({ method: 'GET', url: '/api/zombie/mine', headers });
  check(
    'the host finds their live raid',
    (JSON.parse(mine.body) as { code: string }[]).some((entry) => entry.code === raid.code)
  );

  const deleted = await app.inject({ method: 'DELETE', url: `/api/zombie/sessions/${raid.code}`, headers });
  check('the host can end the raid', deleted.statusCode === 204, deleted.statusCode);
}

/* --------------------------- asset token opacity -------------------------- */
section('assets');

clearAssets();
const { assetUrlFor } = await import('./game/assets.js');
const secretPath = '/guess_img/Arnold.jpg';
const assetUrl = assetUrlFor('round-1', secretPath);
const token = assetUrl.split('/').pop() ?? '';

check('the asset URL hides the filename', !assetUrl.includes('Arnold'), assetUrl);
check('the token is fixed length', token.length === 32, token.length);
check('the token resolves back on the server', resolveAsset(token) === secretPath);
check('the same source yields a stable URL', assetUrlFor('round-1', secretPath) === assetUrl);
check('a different round yields a different token', assetUrlFor('round-2', secretPath) !== assetUrl);
check('an unknown token resolves to nothing', resolveAsset('0'.repeat(32)) === null);

const badToken = await app.inject({ method: 'GET', url: '/api/play/asset/tooshort' });
check('a malformed asset token is rejected', badToken.statusCode === 400, badToken.statusCode);

const unknownToken = await app.inject({ method: 'GET', url: `/api/play/asset/${'a'.repeat(32)}` });
check('an unknown asset token is 404', unknownToken.statusCode === 404, unknownToken.statusCode);

/* ------------------------------- cleanup ---------------------------------- */
/* ------------------------------ the public board -------------------------- */
section('lobby board');

const boardAnon = await app.inject({ method: 'GET', url: '/api/lobbies' });
check('the board is readable without a login', boardAnon.statusCode === 200, boardAnon.statusCode);

/**
 * The private/public distinction, end to end. `session` above was started with no
 * config at all, so it is private by default — and staying off this list is the
 * whole meaning of that default.
 */
const privateBoard = JSON.parse(boardAnon.body) as { code: string; game: string }[];
check(
  'a private game is not listed',
  !privateBoard.some((card) => card.code === session.code),
  privateBoard
);

const publicStart = await app.inject({
  method: 'POST',
  url: '/api/play/sessions',
  headers,
  payload: { playlistId: playlistView.id, config: { public: true } }
});
const publicSession = JSON.parse(publicStart.body) as { code: string };

const boardWithPublic = JSON.parse((await app.inject({ method: 'GET', url: '/api/lobbies' })).body) as {
  code: string;
  game: string;
  host: string | null;
}[];
const publicCard = boardWithPublic.find((card) => card.code === publicSession.code);
check('a public game is listed', Boolean(publicCard), boardWithPublic);
check('the card names its game', publicCard?.game === 'quiz', publicCard);
check('the card names its host', publicCard?.host === login, publicCard);

const mafiaOnly = JSON.parse((await app.inject({ method: 'GET', url: '/api/lobbies?game=mafia' })).body) as {
  code: string;
}[];
check(
  'filtering by game excludes the others',
  !mafiaOnly.some((card) => card.code === publicSession.code),
  mafiaOnly
);

const badFilter = await app.inject({ method: 'GET', url: '/api/lobbies?game=echecs' });
check('an unknown game is rejected', badFilter.statusCode === 400, badFilter.statusCode);

await app.inject({ method: 'DELETE', url: `/api/play/sessions/${publicSession.code}`, headers });

/* --------------------------------- the shop ------------------------------- */
section('shop and locker');

const catalogue = await app.inject({ method: 'GET', url: '/api/shop/coronaz' });
check('the catalogue is public', catalogue.statusCode === 200, catalogue.statusCode);
const shop = JSON.parse(catalogue.body) as {
  items: { id: string; price: number; game: string }[];
  currency: { name: string };
};
check('it only lists that game', shop.items.every((item) => item.game === 'coronaz'), shop.items);
check('it names the currency', shop.currency.name === 'rations', shop.currency);

const lockerAnon = await app.inject({ method: 'GET', url: '/api/locker/coronaz' });
check('a locker needs a login', lockerAnon.statusCode === 401, lockerAnon.statusCode);

const myLocker = await app.inject({ method: 'GET', url: '/api/locker/coronaz', headers });
const lockerView = JSON.parse(myLocker.body) as { owned: string[]; balance: number };
check('a fresh locker is empty', myLocker.statusCode === 200 && lockerView.owned.length === 0, myLocker.body);
check('a fresh wallet is empty', lockerView.balance === 0, lockerView.balance);

/**
 * The one thing a shop must never do. A brand-new account has no rations, so
 * every purchase has to be refused — and refused by the server's own price
 * rather than by whatever the client believed the price was.
 */
const brokePurchase = await app.inject({
  method: 'POST',
  url: '/api/locker/coronaz/buy',
  headers,
  payload: { itemId: shop.items[0]?.id ?? 'cz-pompier' }
});
check('an empty wallet cannot buy', brokePurchase.statusCode === 400, brokePurchase.body);

const wrongGame = await app.inject({
  method: 'POST',
  url: '/api/locker/coronaz/buy',
  headers,
  payload: { itemId: 'mafia-fedora' }
});
check("another game's item cannot be bought here", wrongGame.statusCode === 400, wrongGame.body);

const unowned = await app.inject({
  method: 'POST',
  url: '/api/locker/coronaz/wear',
  headers,
  payload: { slot: 'avatar', itemId: 'cz-hazmat' }
});
check('an unowned item cannot be worn', unowned.statusCode === 400, unowned.body);

/* ------------------------------- quick match ------------------------------ */
section('quick match');

/**
 * The room itself is a socket conversation and is exercised by lobby-core's unit
 * tests; what is worth checking from here is that the manager is wired into the
 * app at all, and that an empty house yields an empty board rather than an error.
 */
const quickCards = app.quick.cards();
check('the quick manager is mounted', Array.isArray(quickCards), typeof quickCards);
check('no rooms exist before anyone asks', quickCards.length === 0, quickCards);

section('cleanup');

const removed = await app.inject({ method: 'DELETE', url: `/api/media/${quizItem.id}`, headers });
check('media deletes', removed.statusCode === 204, removed.statusCode);

const afterDelete = await app.inject({ method: 'GET', url: `/api/playlists/${playlistView.id}`, headers });
const afterView = JSON.parse(afterDelete.body) as { items: unknown[] };
// The foreign key cascades, unlike the old polymorphic join table.
check('deleting media removes it from playlists', afterView.items.length === 1, afterView.items.length);

const deletedPlaylist = await app.inject({
  method: 'DELETE',
  url: `/api/playlists/${playlistView.id}`,
  headers
});
check('playlist deletes', deletedPlaylist.statusCode === 204, deletedPlaylist.statusCode);

await app.close();
// Same order as the real shutdown in server.ts. Closing the database matters
// here too: on Windows the file stays locked while the handle is open, so the
// runner cannot delete the throwaway copy it made.
closeDb();

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);
