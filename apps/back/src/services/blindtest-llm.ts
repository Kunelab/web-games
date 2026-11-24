/**
 * Turning YouTube titles into blind test answers, in batches, at pool-fill time.
 *
 * The one job in this pipeline a regular expression cannot do. "Artist - Title" is
 * a convention that mostly holds for music and does not exist at all for anything
 * else: the answer to `【MAD】進撃の巨人 OP1 紅蓮の弓矢 FULL` is "L'Attaque des
 * Titans", which appears nowhere in that string in any form a pattern could find.
 *
 * ## Never while a room is waiting
 *
 * Every call here happens when a pool is filled, over twenty to fifty titles at a
 * time, and the results are cached on the pooled entries for the pool's lifetime.
 * A round is drawn from those entries without touching a model.
 *
 * That is a correctness rule rather than a performance one. Measured on this
 * deployment's own endpoints, asking a model to name a video id produced roughly
 * nine fabrications in every ten, each indistinguishable from a real one. Anything
 * a model emits has to be verifiable against something authoritative before a
 * player sees it, and the only place there is time to verify is here.
 *
 * ## What is taken, and what is thrown away
 *
 * The `answer` is taken: the model reads a title and says what it names, which is
 * exactly the judgement wanted and which was correct on every one of fifteen hand
 * checked titles.
 *
 * The `aliases` are asked for and then almost entirely discarded, because in the
 * same trial the same model offered "L'Arc de l'Écarlate" and "Red Line" as other
 * names for Attack on Titan, and "Can You Feel the Love Tonight" for a clip of
 * "L'histoire de la vie". A wrong alias silently marks a wrong answer correct,
 * which is the one failure a blind test cannot survive, so only aliases that are
 * a substring relationship away from the answer survive `plausibleAliases` — the
 * kind a player actually types, like dropping a subtitle. Real alternative titles
 * come from catalogues that cannot hallucinate; see `blindtest-aliases.ts`.
 */
import { z } from 'zod';

import { apiSlots, type ApiSlot } from '../env.js';
import { normalizeAnswer } from 'game-core';

export interface Candidate {
  videoId: string;
  title: string;
  channel: string;
  /**
   * What the search that found it was for, when it was aimed at a catalogue
   * entry: "Naruto, Bleach", "Booba, Nekfeu". A hint and nothing more; the
   * search returns neighbours as well, and the model is told so.
   */
  hint?: string;
  /** The start of the video's description, where a cover or a fan upload usually says so. */
  description?: string;
}

export interface Annotation {
  kind: 'music' | 'work' | 'reject';
  artist: string;
  answer: string;
  aliases: string[];
  /**
   * 0 easy to 100 obscure, for a player who picked this genre on purpose. Null
   * when the model gave none, which is not the same as a middling 50.
   */
  difficulty: number | null;
  /** False when the model does not know the artist or the work at all. */
  recognised: boolean;
  confidence: number;
  /**
   * Roughly where the recognisable part sits, as a fraction of the track.
   *
   * Only used for instrumentals, where there are no lyrics to measure against and
   * the alternative is a blind per-genre convention. A fraction rather than a
   * timestamp deliberately: asked for seconds a model invents plausible numbers
   * unrelated to the track, while a proportion is merely approximate, can be
   * clamped, and cannot point past the end. Null when the model had no opinion.
   */
  hookFraction: number | null;
  /** False when the model judges this outside the genre it was drawn for. */
  fitsGenre: boolean;
  /**
   * For a work, the song the clip plays when the title names it: an anime
   * opening's song and its singer, a series' theme. Empty otherwise. It is what
   * lets a sung theme have its chorus found from the lyrics like any song.
   */
  song: string;
  songArtist: string;
  /**
   * For a work: whether the clip is the work's own music, not a cover of it or a
   * song that shares its name. Absent from a cached or older annotation.
   */
  fromWork?: boolean;
}

/**
 * Below this the model is guessing, and a guessed answer is an unwinnable round.
 *
 * Same stance the memory panel takes on a doubtful picture: drop the candidate.
 * A pool is hundreds of entries deep and a session plays a few dozen, so refusing
 * the doubtful ones costs nothing that matters.
 */
const MIN_CONFIDENCE = 0.75;

/**
 * Below this a theme position is a guess about a track the model has never
 * heard, and a guess placed the window as confidently as a measurement would.
 */
const MIN_HOOK_CONFIDENCE = 0.9;

/** Titles per request. Large enough to be cheap, small enough to stay coherent. */
const BATCH_SIZE = 25;

const annotationSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      id: z.string().default(''),
      kind: z.enum(['music', 'work', 'reject']),
      artist: z.string().default(''),
      answer: z.string().default(''),
      aliases: z.array(z.string()).default([]),
      difficulty: z.number().min(0).max(100).nullable().default(null),
      recognised: z.boolean().default(true),
      confidence: z.number().min(0).max(1).default(0),
      hookFraction: z.number().nullable().default(null),
      fitsGenre: z.boolean().default(true),
      song: z.string().default(''),
      songArtist: z.string().default(''),
      fromWork: z.boolean().default(true)
    })
  )
});

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          id: { type: 'string' },
          kind: { type: 'string', enum: ['music', 'work', 'reject'] },
          artist: { type: 'string' },
          answer: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          difficulty: { type: 'number' },
          recognised: { type: 'boolean' },
          confidence: { type: 'number' },
          hookFraction: { type: 'number' },
          fitsGenre: { type: 'boolean' },
          song: { type: 'string' },
          songArtist: { type: 'string' },
          fromWork: { type: 'boolean' }
        },
        required: [
          'index',
          'id',
          'kind',
          'artist',
          'answer',
          'aliases',
          'difficulty',
          'recognised',
          'confidence',
          'hookFraction',
          'fitsGenre',
          'song',
          'songArtist',
          'fromWork'
        ]
      }
    }
  },
  required: ['items']
};

const SYSTEM = `You turn YouTube video titles into rounds for a blind test party game.

For each numbered title, copy its id back exactly as given in "id", and decide:
- kind: "music" when the answer is an artist and a track; "work" when the answer is the film, series, anime or game the music or dialogue belongs to; "reject" otherwise.
- reject a compilation, a top-N list, a reaction, a full album, a mix, a remix, a cover, a live version, a karaoke or instrumental version, or anything with no single unambiguous answer.
- for "work", the answer is the WORK, never the song title. An anime opening is answered with the anime it opens, NOT the band or the song. If you cannot tell which work it belongs to, use kind "reject" rather than answering with the song.
- artist: only for "music". Empty otherwise. Do NOT repeat the artist inside the answer: the artist and the track are separate fields.
- aliases: other names a player might reasonably type. Leave empty rather than invent one.
- difficulty: how hard it is for a French player who picked this genre on purpose. 0 when every fan of the genre names it at once (Bob Marley in reggae, "Enter Sandman" in metal), 100 when only a specialist would. A hit known only in its own country is hard for a French room. Judge the ANSWER's fame, not the video's view count.
- recognised: false when you do not know this artist or this work at all. Then difficulty is at least 80.
- confidence: 0 to 1, how sure you are the answer is right.
- fitsGenre: false when the track does not belong to the genre named below. A search for one genre returns neighbours, and a pop hit in a rap round is a bug.
- hookFraction: for INSTRUMENTAL pieces only, and only when you know the piece well, roughly where its recognisable theme sits as a fraction of the track (0 = the very start, 0.5 = halfway). Use 0 when you are not sure, and for anything sung.
- song and songArtist: for "work" only, the song the clip plays and who sings it, when the title names them (an anime opening's song, a series' theme song). Empty otherwise, and empty rather than guessed.
- fromWork: for "work" only. True ONLY when the clip is the work's own music as heard in it: its score or theme by its composer, or a song from its soundtrack by its original performer. False for a cover, a piano or orchestral arrangement, a fan remake, a tribute, a music box or 8-bit version, and for a song that merely shares the work's name ("THE SIXTH SENSE" by a J-pop singer is not the film The Sixth Sense). Use the channel and the description to tell. When unsure, false. Always true for "music".
- some lines say what the search was for. That is a hint, never a fact: a search also returns other videos. Answer with what the title actually names, and use the hint only to settle a title that could name several things.

Answer in French where the work has a well-known French name. Reply with json.`;

/**
 * The endpoints, from the one place that assembles them.
 *
 * Deliberately thin next to the Mafia driver's chain: pool filling has no clock,
 * nobody is waiting on it, and a failed batch simply leaves those entries to
 * their fallbacks. Hedging, health scoring and refusal benching all exist to
 * protect a live table, and there is no table here.
 *
 * This used to read the environment itself and got it quietly and completely
 * wrong: the numbered slots are not on the parsed `env` object at all, they are
 * read from `process.env` by `readApiSlots`, so the hand-rolled version found
 * exactly one endpoint — slot one — which on this deployment is the HuggingFace
 * router, which returns empty content for this task.
 *
 * The symptom was not an error. Annotation silently produced nothing, every
 * candidate fell back to title parsing, and a pool of anime openings came out
 * with answers like "YOASOBI Official Music Video／TVアニメ オープニングテーマ":
 * unwinnable rounds, generated confidently, with nothing in any log to say why.
 */
type Slot = ApiSlot;

async function askOnce(
  slot: Slot,
  user: string,
  system: string = SYSTEM,
  schema: object = RESPONSE_SCHEMA
): Promise<unknown> {
  const response = await fetch(`${slot.url}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(slot.key ? { authorization: `Bearer ${slot.key}` } : {})
    },
    body: JSON.stringify({
      model: slot.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: 'json_schema', json_schema: { name: 'parsed', strict: true, schema } }
    }),
    signal: AbortSignal.timeout(120_000)
  }).catch(() => null);

  if (!response?.ok) return null;

  const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  const content = body?.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    // Some endpoints wrap the object in prose despite being asked not to.
    const match = /\{[\s\S]*\}/.exec(content);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Aliases worth keeping: the ones that are a rewording of the answer rather than
 * a fact claimed about it.
 *
 * "Frieren" for "Frieren: Beyond Journey's End" is a player typing less, and it is
 * safe because it is visibly derived from the answer. "Red Line" for "L'Attaque
 * des Titans" is a claim about the world, and this module has already been shown
 * to make those up. Anything that is not a substring either way is dropped.
 */
function plausibleAliases(answer: string, aliases: string[]): string[] {
  const target = normalizeAnswer(answer);
  if (!target) return [];

  const kept: string[] = [];
  for (const alias of aliases) {
    const candidate = normalizeAnswer(alias);
    if (!candidate || candidate === target) continue;
    if (candidate.length < 3) continue;
    if (target.includes(candidate) || candidate.includes(target)) {
      kept.push(alias.trim());
    }
  }
  return kept.slice(0, 6);
}

async function annotateBatch(
  batch: Candidate[],
  shape: 'artist-title' | 'work',
  genreLabel: string,
  note?: string
): Promise<Map<string, Annotation>> {
  const result = new Map<string, Annotation>();
  const available = apiSlots;
  if (available.length === 0) return result;

  const wanted =
    shape === 'work'
      ? 'This genre asks WHICH WORK each clip is from. Answer with the film, series, anime or game. Never answer with the song or the band. If you do not know the work, reject the entry. fitsGenre is false for a clip that is not the kind of music the genre names: a scene, a trailer, an episode extract or dialogue, or an ending in an openings genre.'
      : 'This genre asks for the ARTIST and the TRACK.';
  /**
   * The genre is named, so `fitsGenre` has something to judge against.
   *
   * YouTube search has no notion of genre finer than its Music category, so a
   * query for one returns its neighbours: the first real pool for "rap US"
   * arrived holding Martin Garrix, Dua Lipa and Bruno Mars. Nothing cheap
   * separates them, but a model reading the artist and the title knows at once,
   * and it is already reading every one of these titles for other reasons.
   */
  const user = [
    `Genre: ${genreLabel}.`,
    wanted,
    ...(note ? [note] : []),
    '',
    batch
      .map(
        (item, index) =>
          `${index}. [id: ${item.videoId}] ${item.title}   [channel: ${item.channel}]${item.hint ? `   [searched for: ${item.hint}]` : ''}${
            item.description ? `   [description: ${item.description.replace(/\s+/g, ' ').slice(0, 160)}]` : ''
          }`
      )
      .join('\n')
  ].join('\n');

  for (const slot of available) {
    const raw = await askOnce(slot, user);
    if (!raw) continue;

    const parsed = annotationSchema.safeParse(raw);
    if (!parsed.success) continue;

    for (const item of parsed.data.items) {
      /**
       * By the id the line carries, which the model copies back, and never by the
       * index alone: a model that skipped a line or counted from 1 shifted every
       * answer after it onto the next video ("Top Gun" read as Up, Up as Star
       * Trek), and those were filed. An index whose id disagrees is dropped.
       */
      const byId = item.id ? batch.find((entry) => entry.videoId === item.id.trim()) : undefined;
      const atIndex = batch[item.index];
      const candidate = item.id ? byId : atIndex;
      if (!candidate) continue;
      if (item.kind !== 'reject' && item.confidence < MIN_CONFIDENCE) continue;

      result.set(candidate.videoId, {
        kind: item.kind,
        artist: item.artist,
        answer: item.answer,
        aliases: plausibleAliases(item.answer, item.aliases),
        difficulty: item.difficulty,
        recognised: item.recognised,
        confidence: item.confidence,
        hookFraction:
          item.hookFraction !== null &&
          item.hookFraction > 0 &&
          item.confidence >= MIN_HOOK_CONFIDENCE &&
          item.recognised
            ? item.hookFraction
            : null,
        fitsGenre: item.fitsGenre,
        song: item.kind === 'work' ? item.song.trim() : '',
        songArtist: item.kind === 'work' ? item.songArtist.trim() : '',
        fromWork: item.kind === 'work' ? item.fromWork : true
      });
    }

    // One endpoint that answered the whole batch is enough.
    if (result.size > 0) return result;
  }

  return result;
}

/**
 * Annotates a whole pool.
 *
 * Batches run one after another rather than in parallel: free tiers rate-limit per
 * organisation, and a pool fill that trips the limit gets nothing annotated, which
 * is strictly worse than one that takes a minute longer. An empty result is a
 * normal outcome and means the caller falls back to title parsing.
 *
 * Serial is also what makes this the longest-running thing in the deployment, and
 * therefore the thing most worth being able to stop: a few hundred survivors is a
 * dozen requests of up to two minutes each, and until `checkpoint` existed nothing
 * could interrupt them. A blind test whose players quit left the whole remaining
 * run to finish, building a pool for a game that was over.
 *
 * @param checkpoint Called between batches, never during one. Throw from it to
 * abandon the run — the tokens already spent on the batch in flight are spent
 * either way, so the cut is made where it costs nothing.
 * @param note What this genre's answers need beyond the general rules, such as
 * the composer being the artist in a classical round.
 */
export async function annotateCandidates(
  candidates: Candidate[],
  shape: 'artist-title' | 'work',
  genreLabel: string,
  checkpoint?: () => void,
  note?: string
): Promise<Map<string, Annotation>> {
  const all = new Map<string, Annotation>();

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    checkpoint?.();
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const annotated = await annotateBatch(batch, shape, genreLabel, note);
    for (const [videoId, annotation] of annotated) {
      all.set(videoId, annotation);
    }
  }

  return all;
}

const SAME_WORK_SYSTEM = `Each line gives a YouTube video, the work a blind test round says it is from (CLAIMED), and the work a reader took it for (READ). Say whether CLAIMED and READ are the same work under different names: a translation, the original title, a romanization, a subtitle added or dropped, a re-release or remaster of the same game. Answer false when they are different works, even related ones: a sequel, a prequel, another season with its own title, a spin-off, a remake with another story, another film of the same franchise. Copy each id back exactly. Reply with json.`;

const SAME_WORK_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, same: { type: 'boolean' } },
        required: ['id', 'same'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
} as const;

const sameWorkSchema = z.object({ items: z.array(z.object({ id: z.string(), same: z.boolean() })) });

/**
 * Whether two names are one work: the second look an audit takes before it calls
 * a round's video misfiled. A reader asked "which film is this" answers in French,
 * or in the original language, so "The Fresh Prince of Bel-Air" against a round's
 * "Le Prince de Bel-Air" is no mismatch, while "Star Trek Beyond" against "Star
 * Trek Into Darkness" is. Ids missing from the result were not answered.
 */
export async function sameWorks(
  pairs: { id: string; claimed: string; read: string; title: string }[]
): Promise<Map<string, boolean>> {
  const all = new Map<string, boolean>();
  for (let offset = 0; offset < pairs.length; offset += BATCH_SIZE) {
    const batch = pairs.slice(offset, offset + BATCH_SIZE);
    const user = batch
      .map((pair) => `[id: ${pair.id}] video: ${pair.title}   CLAIMED: ${pair.claimed}   READ: ${pair.read}`)
      .join('\n');
    for (const slot of apiSlots) {
      const parsed = sameWorkSchema.safeParse(await askOnce(slot, user, SAME_WORK_SYSTEM, SAME_WORK_SCHEMA));
      if (!parsed.success) continue;
      const known = new Set(batch.map((pair) => pair.id));
      for (const item of parsed.data.items) if (known.has(item.id)) all.set(item.id, item.same);
      break;
    }
  }
  return all;
}
