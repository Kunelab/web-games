import { and, eq, isNull } from 'drizzle-orm';
import {
  blindtest,
  blindtestPayloadSchema,
  boundedLevenshtein,
  normalizeAnswer,
  VIDEO_REJECTED_MAX,
  videoInDoubt,
  videoProposalOf,
  type BlindtestVideoProposal
} from 'game-core';
import { z } from 'zod';

import { systemClock, type Clock } from '../clock.js';
import type { Db } from '../db/open.js';
import { media } from '../db/schema.js';
import { env } from '../env.js';
import {
  genreById,
  NOT_A_SINGLE_WORK,
  NOT_THE_ORIGINAL,
  profileFor,
  SECTIONS,
  type Genre
} from './blindtest-catalog.js';
import { annotateCandidates, sameWorks, type Annotation, type Candidate } from './blindtest-llm.js';
import { clipWindow, uploadKind, VOCAL_PROFILE } from './chorus-service.js';
import { chargeUnits, spendSearch } from './youtube-budget.js';
import { fetchVideoFacts, playbackBlockers, searchVideos, type VideoFacts } from './youtube-service.js';

/**
 * Finding the real video for a catalogue round whose video is in doubt.
 *
 * The audit (`cli/blindtest-video-audit.ts`) took a hundred and forty rounds out
 * of play: a film score played as a piano cover, an anime opening as an "epic
 * orchestral version", a series' name answered by another work's song. Each of
 * them is a right answer with the wrong clip, and putting the right clip in by
 * hand is a YouTube search an admin can do in a minute, a hundred and forty
 * times. So it is done here, and the admin only says yes or no.
 *
 * ## What is searched
 *
 * One or two searches per round (a hundred units each, through `spendSearch`):
 * the answer plus the words an official upload carries, "official" for a
 * song, "original soundtrack" or "opening" for a work, and the work's other
 * name for the second one. What comes back is screened by the same refusals
 * the catalogue applies when it is built (`NOT_THE_ORIGINAL`, the genre's own,
 * `NOT_A_SINGLE_WORK`), by length, by whether it plays here, and against every
 * video already refused for this round; then ranked, the official uploads first
 * (an artist's Topic channel, VEVO, the artist's own channel, a studio's).
 *
 * ## What is checked
 *
 * The ranking only orders. A work's candidates are read by the model, told
 * which work the round claims, exactly as the audit reads the current video:
 * one it takes for another work, or for a cover, is dropped, and a different
 * name is asked about once more (`sameWorks`) before it counts as another work.
 * A song's are read too, but a song's title can be checked as a string, so a
 * model that did not answer does not hold it back.
 *
 * ## What is written
 *
 * Only a proposal (`videoProposal`), never the video: the round stays out of
 * play until an admin accepts it, which is `acceptedPayload`.
 */

/* ---------------------------------------------------------------- the round */

/** A catalogue row as stored: the JSON columns still strings. */
export interface ReplaceRow {
  id: number;
  category: string | null;
  answers: string;
  payload: string;
}

/** What the search needs to know about a round, read from its row. */
export interface ReplaceRound {
  id: number;
  genre: Genre;
  /** The video in doubt. */
  code: string;
  /** For a song: its artist and title. */
  artist: string;
  title: string;
  /** For a work: every name it is accepted under, the main one first. */
  names: string[];
  /** Videos an admin refused for this round. */
  rejected: string[];
  difficulty: number | null;
}

const answersSchema = z.array(
  z.object({ key: z.string(), value: z.string(), aliases: z.array(z.string()).optional() }).loose()
);

/** The round a row describes, or null when it is not one this can search for. */
export function roundOf(row: ReplaceRow): ReplaceRound | null {
  const genre = row.category ? genreById.get(row.category) : undefined;
  if (!genre) return null;
  let payload: Record<string, unknown>;
  let answers: z.infer<typeof answersSchema>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
    answers = answersSchema.parse(JSON.parse(row.answers));
  } catch {
    return null;
  }
  const code = typeof payload.code === 'string' ? payload.code : '';
  if (!code) return null;
  const field = (key: string) => answers.find((answer) => answer.key === key);
  const rejected = Array.isArray(payload.videoRejected)
    ? payload.videoRejected.filter((one): one is string => typeof one === 'string')
    : [];
  const difficulty = typeof payload.difficulty === 'number' ? payload.difficulty : null;
  if (genre.answerShape === 'work') {
    const work = field('work');
    if (!work?.value) return null;
    const names = [work.value, ...(work.aliases ?? [])].filter(
      (name, index, all) => name && all.indexOf(name) === index
    );
    return { id: row.id, genre, code, artist: '', title: '', names, rejected, difficulty };
  }
  const artist = field('artist')?.value ?? '';
  const title = field('title')?.value ?? '';
  if (!artist || !title) return null;
  return { id: row.id, genre, code, artist, title, names: [], rejected, difficulty };
}

/* -------------------------------------------------------------- the queries */

/**
 * What each work genre's official music is called, in the words its uploads
 * use: the first for the round's main name, the second for its other name.
 */
const WORK_QUERY_WORDS: Record<string, [string, string]> = {
  'anime-op': ['opening official', 'OP creditless'],
  'anime-ed': ['ending official', 'ED creditless'],
  'films-musique': ['original soundtrack main theme', 'OST main theme'],
  'series-tv': ['opening theme official', 'main title theme'],
  'jeux-video': ['OST main theme', 'original soundtrack theme']
};

/**
 * The searches for a round, best first: at most two, and the second only
 * runs when the first found nothing convincing.
 *
 * A song is searched under its artist and title with "official", which brings
 * the Topic upload and the music video up together. A work is searched under
 * its main name with its genre's words, and the second search uses its other
 * name (often the original or English title, which is what the official
 * uploads are titled with) when it has one.
 */
export function replacementQueries(round: ReplaceRound): string[] {
  if (round.genre.answerShape === 'artist-title') {
    const name = `${round.artist} ${stripBrackets(round.title)}`;
    return [`${name} official`, `${name} official audio`];
  }
  const [first, second] = WORK_QUERY_WORDS[round.genre.id] ?? ['original soundtrack', 'main theme'];
  const main = round.names[0] ?? '';
  const other = round.names.find((name) => normalizeAnswer(name) !== normalizeAnswer(main));
  return [`${main} ${first}`, `${other ?? main} ${second}`];
}

/** "Song (feat. X)" searched as "Song": the brackets narrow the search to one upload's title. */
function stripBrackets(text: string): string {
  return text.replace(/\s*[([][^)\]]*[)\]]/g, '').trim() || text;
}

/* ------------------------------------------------------------ the screening */

/** Below this a video is a fragment, a TV-size opening excepted; above it, a suite or a compilation. */
const MIN_SECONDS = { 'artist-title': 90, work: 45 } as const;
const MAX_SECONDS = 12 * 60;

/** Neither a performance of the original recording nor its music: a stage, a trailer, a scene. */
const NOT_THE_RECORDING =
  /\b(live|concert|en direct|trailer|teaser|bande[- ]annonce|scene|full movie|film complet|shorts?)\b/i;

/**
 * A title with the work's own names taken out, so the refusals test what the
 * video says about itself: "Mix" is not a mix in "Mix: Meisei Story", nor is
 * "A Midi in Time" a MIDI.
 */
export function withoutNames(title: string, names: readonly string[]): string {
  let left = title;
  for (const name of names.flatMap((one) => [one, one.replace(/\s*&\s*/g, ' and ')])) {
    if (name.length >= 3) left = left.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  return left;
}

/**
 * Whether a name someone gave is the round's: any of its names against any the
 * round accepts, allowing a spelling apart ("Samourai", "Samurai") and a
 * subtitle added or dropped.
 */
export function sameWork(said: readonly string[], names: readonly string[]): boolean {
  const ours = names.map(normalizeAnswer).filter(Boolean);
  return said
    .map(normalizeAnswer)
    .filter(Boolean)
    .some((one) =>
      ours.some((known) => {
        if (known === one) return true;
        if (Math.min(known.length, one.length) >= 5 && (known.includes(one) || one.includes(known))) return true;
        const budget = Math.floor(Math.max(known.length, one.length) / 6);
        return boundedLevenshtein(known, one, budget) <= budget;
      })
    );
}

/** Whether a text names one of these, as whole words. */
export function titleNames(text: string, names: readonly string[]): boolean {
  const said = ` ${normalizeAnswer(text)} `;
  return names.map(normalizeAnswer).some((name) => name.length >= 2 && said.includes(` ${name} `));
}

/** Why a video cannot replace the round's, or null when it may be ranked. */
export function screenCandidate(facts: VideoFacts, round: ReplaceRound, region: string): string | null {
  if (facts.videoId === round.code) return 'the video in doubt';
  if (round.rejected.includes(facts.videoId)) return 'refused by an admin';
  if (playbackBlockers(facts.restriction, region).length > 0) return 'does not play here';
  const seconds = facts.durationSeconds;
  if (seconds === null) return 'length unknown';
  if (seconds < MIN_SECONDS[round.genre.answerShape]) return 'too short';
  if (seconds > MAX_SECONDS) return 'too long';

  const own = round.genre.answerShape === 'work' ? round.names : [round.artist, round.title];
  const title = withoutNames(facts.title, own);
  if (NOT_THE_ORIGINAL.test(title) || round.genre.reject?.test(title) || NOT_A_SINGLE_WORK.test(title)) {
    return 'a cover, a compilation or another take';
  }
  if (NOT_THE_RECORDING.test(title)) return 'not the recording';

  if (round.genre.answerShape === 'artist-title') {
    // A song's title is the one check a string can make for certain.
    const about = `${facts.title} ${facts.description.slice(0, 400)}`;
    if (!titleNames(about, [stripBrackets(round.title), round.title])) return 'another song';
    if (!titleNames(`${about} ${facts.channel}`, [round.artist])) return 'another artist';
  }
  return null;
}

/* --------------------------------------------------------------- the ranking */

/**
 * The channels whose upload of a work's music is the work's own: the studios,
 * distributors and publishers that hold the rights, plus the anime streamers
 * that post creditless openings under licence.
 */
const OFFICIAL_STUDIOS =
  /\b(crunchyroll|funimation|aniplex|toho( animation)?|muse asia|ani-?one|netflix|warner bros|sony (pictures|music)|universal (pictures|music)|disney|pixar|marvel|lucasfilm|paramount|20th century|dreamworks|hbo|amc|bbc|nintendo|playstation|xbox|square enix|capcom|bandai namco|sega|ubisoft|blizzard|bethesda|rockstar games|konami|atlus|kadokawa|king amusement|lantis|flying ?dog|sacra music|avex|pony canyon|studio ghibli|milan records|lakeshore records|watertower music|hollywood records|decca|varese sarabande)\b/i;

const OFFICIAL_UPLOAD =
  /\b(official (music )?(video|audio|visuali[sz]er|lyric video|mv)|clip officiel|audio officiel|official hd video)\b|\b(mv|m\/v)\b/i;

const SOUNDTRACK_WORDS =
  /\b(original (motion picture |video game |television |series )?soundtrack|ost|o\.s\.t|main (theme|title)|bande originale|soundtrack|opening|ending|g[eé]n[eé]rique|theme song|title theme)\b/i;

const CREDITLESS = /\b(creditless|non[- ]?credit|textless|clean (opening|ending)|nc ?op|nc ?ed|ncop\d*|nced\d*)\b/i;
const ANIME_OPENING = /\b(opening|op ?\d*)\b|オープニング/i;
const ANIME_ENDING = /\b(ending|ed ?\d*)\b|エンディング/i;

export interface Ranked {
  facts: VideoFacts;
  score: number;
  /** What the score came from, in a few words, for the admin. */
  reasons: string[];
}

/** Whether a channel is the artist's own: "Daft Punk", "DaftPunkVEVO", "Daft Punk Official". */
function artistChannel(channel: string, artist: string): boolean {
  const squash = (text: string) => normalizeAnswer(text).replace(/\s+/g, '');
  const own = squash(channel.replace(/vevo$|official|music|- topic$|officiel/gi, ''));
  const wanted = squash(artist);
  return own.length >= 2 && wanted.length >= 2 && (own === wanted || (wanted.length >= 4 && own.includes(wanted)));
}

/**
 * How likely a screened video is the original, as a score: the higher the
 * better, and only the order means anything.
 *
 * Who uploaded it weighs most, since an official channel rarely posts a
 * cover. Then the words official uploads use, whether it names the answer,
 * how watched it is (the original of a famous theme has the views, its covers
 * a fraction), and where the search put it.
 */
export function rankCandidate(facts: VideoFacts, round: ReplaceRound, position: number): Ranked {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };
  const channel = facts.channel.trim();
  const topic = / - Topic$/i.test(channel);

  if (round.genre.answerShape === 'artist-title') {
    if (topic) add(35, 'Topic upload');
    else if (/vevo$/i.test(channel)) add(30, 'VEVO');
    else if (artistChannel(channel, round.artist)) add(25, "artist's channel");
    if (OFFICIAL_UPLOAD.test(facts.title)) add(15, 'official upload');
    if (topic && artistChannel(channel, round.artist)) add(10, "artist's Topic");
  } else {
    const about = `${facts.title} ${facts.description.slice(0, 500)}`;
    if (titleNames(about, round.names)) add(25, 'names the work');
    if (topic) add(25, 'Topic upload');
    if (OFFICIAL_STUDIOS.test(channel)) add(25, 'official channel');
    else if (/\b(official|officiel)\b/i.test(channel)) add(15, 'official channel');
    if (SOUNDTRACK_WORDS.test(facts.title) || (topic && SOUNDTRACK_WORDS.test(about))) add(15, 'soundtrack');
    if (round.genre.id.startsWith('anime-') && CREDITLESS.test(facts.title)) add(10, 'creditless');
    if (round.genre.id === 'anime-op' && ANIME_ENDING.test(facts.title) && !ANIME_OPENING.test(facts.title)) {
      add(-30, 'an ending');
    }
    if (round.genre.id === 'anime-ed' && ANIME_OPENING.test(facts.title) && !ANIME_ENDING.test(facts.title)) {
      add(-30, 'an opening');
    }
  }
  if (/\blyrics?\b|paroles/i.test(facts.title)) add(-10, 'lyrics video');
  if (facts.views > 0)
    add(Math.min(30, Math.round(Math.log10(facts.views + 1) * 4)), `${compactViews(facts.views)} views`);
  if (position < 10) score += 10 - position;
  return { facts, score, reasons };
}

function compactViews(views: number): string {
  if (views >= 1_000_000) return `${Math.round(views / 100_000) / 10}M`;
  if (views >= 1_000) return `${Math.round(views / 1_000)}k`;
  return String(views);
}

/** Below this nothing about a video says it is official: not proposed, however it reads. */
export const MIN_SCORE = 30;

/** At this the first search found something convincing, and the second is not spent. */
const CONVINCING = 70;

/** How many of the best the model reads. */
const VERIFY_TOP = 6;

/**
 * Screens and ranks a search's results, best first. Each video's place in the
 * search it came from is `positions`; a video found twice keeps its better one.
 */
export function rankCandidates(
  facts: Iterable<VideoFacts>,
  round: ReplaceRound,
  positions: ReadonlyMap<string, number>,
  region: string
): Ranked[] {
  const ranked: Ranked[] = [];
  for (const one of facts) {
    if (screenCandidate(one, round, region) !== null) continue;
    const scored = rankCandidate(one, round, positions.get(one.videoId) ?? 50);
    if (scored.score >= MIN_SCORE) ranked.push(scored);
  }
  return ranked.sort((left, right) => right.score - left.score);
}

/* -------------------------------------------------------------- the checking */

/**
 * Whether the model's reading of a candidate lets it through, or needs the
 * narrower "same work?" question first, or rules it out.
 */
export function judgeReading(
  ranked: Ranked,
  round: ReplaceRound,
  reading: Annotation | undefined
): 'ok' | 'ask' | 'no' | 'unread' {
  if (!reading) return 'unread';
  if (reading.kind === 'reject') return 'no';
  if (round.genre.answerShape === 'artist-title') {
    if (reading.kind !== 'music') return 'no';
    const titleOk = sameWork([reading.answer], [round.title, stripBrackets(round.title)]);
    const artistOk = !reading.artist || sameWork([reading.artist], [round.artist]);
    return titleOk && artistOk ? 'ok' : 'no';
  }
  if (reading.kind !== 'work' || reading.fromWork === false) return 'no';
  if (sameWork([reading.answer, ...reading.aliases], round.names)) return 'ok';
  return 'ask';
}

/** A replacement found for a round, before it is written. */
export interface Proposal {
  code: string;
  title: string;
  channel: string;
  durationSeconds: number;
  score: number;
  reason: string;
}

/** What the search reaches the outside world through, so the decisions can be tested without it. */
export interface ReplaceDeps {
  /** Takes one search from the day's budget; false when it is spent. */
  spendSearch(): boolean;
  search(query: string, options: { musicOnly: boolean }): Promise<string[]>;
  videoFacts(ids: string[]): Promise<Map<string, VideoFacts>>;
  annotate(
    candidates: Candidate[],
    shape: 'artist-title' | 'work',
    genreLabel: string,
    note?: string
  ): Promise<Map<string, Annotation>>;
  sameWorks(pairs: { id: string; claimed: string; read: string; title: string }[]): Promise<Map<string, boolean>>;
  /** Where the clip has to play. */
  region: string;
}

/** The outcome when nothing could be asked: no budget, or YouTube refused. Try again later. */
const LATER = undefined;

/**
 * Finds the video a round should have.
 *
 * A proposal when one was found; null when the searches ran and nothing good
 * came back (or the model ruled every candidate out); undefined when it could
 * not be decided now — no search budget left, a request that failed, or a
 * model that did not answer for a work — so the round is tried again later.
 */
export async function proposeReplacement(row: ReplaceRow, deps: ReplaceDeps): Promise<Proposal | null | undefined> {
  const round = roundOf(row);
  if (!round) return null;

  const queries = replacementQueries(round);
  const positions = new Map<string, number>();
  const facts = new Map<string, VideoFacts>();
  let searched = 0;
  let ranked: Ranked[] = [];

  for (const query of queries) {
    if (searched > 0 && (ranked[0]?.score ?? 0) >= CONVINCING) break;
    if (!deps.spendSearch()) break;
    let ids: string[];
    try {
      ids = await deps.search(query, { musicOnly: round.genre.answerShape === 'artist-title' });
      const fresh = ids.filter((id) => !facts.has(id));
      for (const [id, one] of await deps.videoFacts(fresh)) facts.set(id, one);
    } catch {
      // Whatever an earlier search found still stands; with nothing, try another day.
      if (searched === 0) return LATER;
      break;
    }
    searched += 1;
    ids.forEach((id, index) => {
      if (!positions.has(id)) positions.set(id, index);
    });
    ranked = rankCandidates(facts.values(), round, positions, deps.region);
  }
  if (searched === 0) return LATER;
  if (ranked.length === 0) return null;

  const top = ranked.slice(0, VERIFY_TOP);
  const section = SECTIONS.find((one) => one.id === round.genre.section)?.label ?? round.genre.section;
  const readings = await deps.annotate(
    top.map((one) => ({
      videoId: one.facts.videoId,
      title: one.facts.title,
      channel: one.facts.channel,
      // The round's own answer, so the model judges the claim rather than guessing afresh.
      hint: round.genre.answerShape === 'work' ? (round.names[0] ?? '') : `${round.artist} - ${round.title}`,
      ...(one.facts.description ? { description: one.facts.description } : {})
    })),
    round.genre.answerShape,
    `${section} / ${round.genre.label}`,
    round.genre.modelNote
  );
  // A work cannot be told from its covers by its title alone: unread is undecided.
  if (readings.size === 0 && round.genre.answerShape === 'work') return LATER;

  const verdicts = top.map((one) => judgeReading(one, round, readings.get(one.facts.videoId)));
  const toAsk = top.filter((_, index) => verdicts[index] === 'ask');
  const same = toAsk.length
    ? await deps.sameWorks(
        toAsk.map((one) => ({
          id: one.facts.videoId,
          claimed: round.names.join(' / '),
          read: readings.get(one.facts.videoId)?.answer ?? '',
          title: one.facts.title
        }))
      )
    : new Map<string, boolean>();

  for (const [index, one] of top.entries()) {
    const verdict = verdicts[index];
    const passes =
      verdict === 'ok' ||
      (verdict === 'ask' && same.get(one.facts.videoId) === true) ||
      // A song's title was already checked as a string; the model only gets to refuse it.
      (verdict === 'unread' && round.genre.answerShape === 'artist-title');
    if (!passes) continue;
    return {
      code: one.facts.videoId,
      title: one.facts.title,
      channel: one.facts.channel,
      durationSeconds: one.facts.durationSeconds ?? 0,
      score: one.score,
      reason: one.reasons.join(', ').slice(0, 300)
    };
  }
  return null;
}

/* ------------------------------------------------------------- the payloads */

/** A row's payload as an object, or null when it is not one. */
function payloadOf(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The payload with a proposal waiting on it, or null when the round no longer
 * wants one: its video changed or its doubt was lifted since the search began.
 */
export function proposedPayload(
  payload: Record<string, unknown>,
  proposal: Proposal,
  forCode: string,
  now: Date
): Record<string, unknown> | null {
  if (payload.code !== forCode || !videoInDoubt(payload)) return null;
  const videoProposal: BlindtestVideoProposal = {
    code: proposal.code,
    title: proposal.title.slice(0, 300),
    channel: proposal.channel.slice(0, 200),
    for: forCode,
    foundAt: now.toISOString(),
    reason: proposal.reason.slice(0, 300),
    durationSeconds: proposal.durationSeconds
  };
  const { videoSearched: _searched, ...rest } = payload;
  return { ...rest, videoProposal };
}

/**
 * The payload of a round whose proposal was accepted, or null when it has no
 * live one.
 *
 * The video becomes the proposal's and the doubt and the proposal go. The clip
 * is placed again, because the old windows were cut for the old video's clock:
 * a cover's chorus at 1:10 says nothing about where the original's is. It is
 * placed the way the draw places a fresh round's from what is known without
 * asking anything more (`clipWindow` over the new video's length, the genre's
 * profile, the round's difficulty and the kind of upload) and marked
 * automatic, so a rescoring with the lyrics at hand may place it better later
 * and a person's later edit still wins. A proposal from before lengths were
 * kept gets the kind's default windows.
 */
export function acceptedPayload(
  payload: Record<string, unknown>,
  genre: Genre | undefined,
  random: () => number = Math.random
): Record<string, unknown> | null {
  const proposal = videoProposalOf(payload);
  if (!proposal) return null;
  const { videoDoubt: _doubt, videoProposal: _proposal, videoSearched: _searched, angle: _angle, ...rest } = payload;
  const difficulty = typeof payload.difficulty === 'number' ? payload.difficulty : 50;
  const clip = proposal.durationSeconds
    ? clipWindow(proposal.durationSeconds, {
        profile: genre ? profileFor(genre) : VOCAL_PROFILE,
        difficulty,
        upload: uploadKind(proposal.channel, proposal.title),
        random
      })
    : null;
  const defaults = blindtest.defaultPayload;
  return {
    ...rest,
    code: proposal.code,
    startGuess: clip?.startGuess ?? defaults.startGuess,
    endGuess: clip?.endGuess ?? defaults.endGuess,
    startReveal: clip?.startReveal ?? defaults.startReveal,
    endReveal: clip?.endReveal ?? defaults.endReveal,
    ...(clip ? { angle: clip.angle } : {}),
    timingBy: 'auto'
  };
}

/**
 * The payload of a round whose proposal was refused, or null when it has no
 * live one: the proposal goes and its video joins the refused, never offered
 * for this round again. The doubt stays, so the round is searched once more.
 */
export function rejectedPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const proposal = videoProposalOf(payload);
  if (!proposal) return null;
  const { videoProposal: _proposal, videoSearched: _searched, ...rest } = payload;
  const before = Array.isArray(payload.videoRejected)
    ? payload.videoRejected.filter((one): one is string => typeof one === 'string' && one !== proposal.code)
    : [];
  return { ...rest, videoRejected: [...before, proposal.code].slice(-VIDEO_REJECTED_MAX) };
}

/* -------------------------------------------------------------- the database */

/** The outcome of acting on a round's proposal. */
export type ProposalAction = { ok: true } | { ok: false; reason: 'not-found' | 'no-proposal' };

/**
 * Applies an admin's answer to a catalogue round's proposal, in one
 * transaction so a proposal replaced meanwhile is not acted on blind.
 *
 * `last_modified` is not stamped, for the reason `blindtest-refile` gives: it
 * is how a rescoring tells a person's numbers from the machine's, and neither
 * the difficulty nor the new clip (marked `auto`) is a person's.
 */
export function answerProposal(db: Db, mediaId: number, answer: 'accept' | 'reject'): ProposalAction {
  return db.transaction((tx) => {
    const [row] = tx
      .select({ category: media.category, payload: media.payload })
      .from(media)
      .where(and(eq(media.id, mediaId), isNull(media.user_id), eq(media.kind, 'blindtest')))
      .limit(1)
      .all();
    if (!row) return { ok: false, reason: 'not-found' } as const;
    const payload = payloadOf(row.payload);
    if (!payload) return { ok: false, reason: 'no-proposal' } as const;
    const next =
      answer === 'accept'
        ? acceptedPayload(payload, row.category ? genreById.get(row.category) : undefined)
        : rejectedPayload(payload);
    if (!next) return { ok: false, reason: 'no-proposal' } as const;
    // What a game reads must still parse: refuse rather than write a round that cannot play.
    if (!blindtestPayloadSchema.safeParse(next).success) return { ok: false, reason: 'no-proposal' } as const;
    tx.update(media)
      .set({ payload: JSON.stringify(next) })
      .where(eq(media.id, mediaId))
      .run();
    return { ok: true } as const;
  });
}

/**
 * How long a round searched without result is left alone. The catalogue of
 * official uploads does change (a studio posts its openings, a label its back
 * catalogue), but not by the day, and a search is a hundredth of the day.
 */
const SEARCHED_AGAIN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const searchedSchema = z.object({ for: z.string(), at: z.string() });

/** Whether a round was searched for this very video recently and nothing was found. */
function searchedLately(payload: Record<string, unknown>, now: number): boolean {
  const parsed = searchedSchema.safeParse(payload.videoSearched);
  if (!parsed.success || parsed.data.for !== payload.code) return false;
  const at = Date.parse(parsed.data.at);
  return Number.isFinite(at) && now - at < SEARCHED_AGAIN_AFTER_MS;
}

/** The catalogue rounds in doubt with no live proposal, and not searched in vain lately. */
export function flaggedRows(db: Db, now: number): ReplaceRow[] {
  return db
    .select({ id: media.id, category: media.category, answers: media.answers, payload: media.payload })
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')))
    .all()
    .filter((row) => {
      const payload = payloadOf(row.payload);
      return payload !== null && videoInDoubt(payload) && !videoProposalOf(payload) && !searchedLately(payload, now);
    });
}

/**
 * Writes what a search found on a round: its proposal, or, with nothing found,
 * when it was searched (`videoSearched`), so the next walk does not spend
 * another search on it for a month. Nothing when the round changed meanwhile.
 */
export function recordSearch(db: Db, row: ReplaceRow, found: Proposal | null, now: Date): boolean {
  const forCode = payloadOf(row.payload)?.code;
  if (typeof forCode !== 'string') return false;
  return db.transaction((tx) => {
    const [current] = tx.select({ payload: media.payload }).from(media).where(eq(media.id, row.id)).limit(1).all();
    const payload = current ? payloadOf(current.payload) : null;
    if (!payload) return false;
    const next = found
      ? proposedPayload(payload, found, forCode, now)
      : payload.code === forCode && videoInDoubt(payload)
        ? { ...payload, videoSearched: { for: forCode, at: now.toISOString() } }
        : null;
    if (!next) return false;
    tx.update(media)
      .set({ payload: JSON.stringify(next) })
      .where(eq(media.id, row.id))
      .run();
    return true;
  });
}

/** Searches left unspent for a game started while this runs. The prefill keeps as many. */
const KEEP_FOR_GAMES = 3;

/** The real services: YouTube through the day's budget, the model through its slots. */
export function liveReplaceDeps(db: Db, clock: Pick<Clock, 'now'> = systemClock): ReplaceDeps {
  const budget = Math.max(0, env.BLINDTEST_SEARCH_BUDGET - KEEP_FOR_GAMES);
  return {
    spendSearch: () => spendSearch(db, budget, clock),
    search: (query, options) => searchVideos(query, { musicOnly: options.musicOnly, limit: 25 }),
    videoFacts: async (ids) => {
      if (ids.length === 0) return new Map();
      // A unit for every fifty, out of the same day as the searches.
      chargeUnits(db, Math.ceil(ids.length / 50), clock);
      return fetchVideoFacts(ids);
    },
    annotate: (candidates, shape, genreLabel, note) =>
      annotateCandidates(candidates, shape, genreLabel, undefined, note),
    sameWorks,
    region: env.YOUTUBE_REGION
  };
}

export interface ProposeLog {
  info(message: string): void;
}

export interface ProposeReport {
  /** Rounds searched for, whatever came of it. */
  tried: number;
  /** A proposal found. */
  proposed: number;
  /** Searched, nothing good. */
  none: number;
  /** Not decided: the budget ran out, or a request failed. Tried again on a later walk. */
  deferred: number;
  /** What was found or not, round by round, for a report. */
  results: { id: number; code: string; outcome: 'proposed' | 'none' | 'deferred'; proposal?: Proposal }[];
}

/**
 * Walks the rounds in doubt over a given database and services. See `proposeForFlagged`.
 */
export async function proposeForFlaggedIn(
  db: Db,
  deps: ReplaceDeps,
  options: { limit: number; write: boolean; log?: ProposeLog; clock?: Pick<Clock, 'now'> }
): Promise<ProposeReport> {
  const clock = options.clock ?? systemClock;
  const report: ProposeReport = { tried: 0, proposed: 0, none: 0, deferred: 0, results: [] };
  let budgetSpent = false;
  const counted: ReplaceDeps = {
    ...deps,
    spendSearch: () => {
      const ok = deps.spendSearch();
      if (!ok) budgetSpent = true;
      return ok;
    }
  };

  for (const row of flaggedRows(db, clock.now()).slice(0, Math.max(0, options.limit))) {
    const stored = payloadOf(row.payload)?.code;
    const code = typeof stored === 'string' ? stored : '';
    let found: Proposal | null | undefined;
    try {
      found = await proposeReplacement(row, counted);
    } catch {
      found = undefined;
    }
    report.tried += 1;
    if (found === undefined) {
      report.deferred += 1;
      report.results.push({ id: row.id, code, outcome: 'deferred' });
      if (budgetSpent) {
        options.log?.info('video replacement: the daily YouTube search budget is spent');
        break;
      }
      continue;
    }
    if (found) {
      report.proposed += 1;
      report.results.push({ id: row.id, code, outcome: 'proposed', proposal: found });
      options.log?.info(`video replacement: #${row.id} ${code} -> ${found.code} "${found.title}" [${found.channel}]`);
    } else {
      report.none += 1;
      report.results.push({ id: row.id, code, outcome: 'none' });
      options.log?.info(`video replacement: #${row.id} ${code}: nothing better found`);
    }
    if (options.write) recordSearch(db, row, found, new Date(clock.now()));
  }
  return report;
}

/**
 * Looks for the real video of up to `limit` catalogue rounds in doubt that
 * have no proposal yet, and, with `write`, files what it finds on each round
 * for an admin to accept or refuse.
 *
 * Every search is paid for out of the day's YouTube budget (two at most per
 * round, less a few kept for games), and the walk stops when it is spent: the
 * rounds not reached are found again by the next walk. So is a round whose
 * search failed. One searched in vain is left alone for a month.
 *
 * Over the app's own database, opened when first called so that importing
 * this module (as the tests do) opens nothing.
 */
export async function proposeForFlagged(options: {
  limit: number;
  write: boolean;
  log?: ProposeLog;
}): Promise<{ tried: number; proposed: number; none: number; deferred: number }> {
  const { db } = await import('../db/index.js');
  const { tried, proposed, none, deferred } = await proposeForFlaggedIn(db, liveReplaceDeps(db), options);
  return { tried, proposed, none, deferred };
}
