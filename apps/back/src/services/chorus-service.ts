/**
 * Which seconds of a track to play, and why those.
 *
 * A blind test is won or lost on the choice of window. Authoring it by hand solves
 * the problem and is exactly the work an automatic mode exists to avoid, so this
 * module picks it, from the best evidence available for each track.
 *
 * ## Three angles on the same song, not one
 *
 * The chorus is the obvious answer and it is often the wrong one. Plenty of songs
 * are recognised from their first four bars and nothing else: the opening riff of
 * "Smells Like Teen Spirit" or "Sweet Child O' Mine" is the question, and a room
 * that gets handed the chorus instead has been given a harder and duller version
 * of it. Others have no famous intro at all, and their verses are anonymous.
 *
 * So a round picks an *angle*:
 *
 *   intro   the opening. Frequently the most iconic thing in the track.
 *   chorus  the hook, from the lyrics when they are known.
 *   verse   a stretch that is demonstrably neither, found in the gaps between
 *           chorus occurrences. The hard version of the same song.
 *
 * Which angle is drawn depends on the round's difficulty target, which is what
 * makes the difficulty slider mean something beyond track selection: the same
 * track is an easy round from its intro and a hard one from its second verse.
 *
 * ## Where the evidence comes from
 *
 * LRCLIB publishes LRC lyrics with a timestamp per line, free and without a key,
 * and the chorus is simply the line that repeats most. That is a measurement.
 *
 * Instrumental music has no lyrics and never will: a film cue, a game theme, an
 * anime OST track. For those the window comes from a per-genre `ClipProfile`,
 * optionally nudged by a model's estimate. Both are guesses, and they are allowed
 * to be, because being wrong here makes a round duller rather than unanswerable.
 * That is the line this pipeline draws everywhere: a model may influence *quality*,
 * never *correctness*.
 *
 * ## The clock the timestamps belong to
 *
 * Lyric timestamps are relative to the track. A music video is not the track: it
 * has a cold open, a skit, a long outro, and its clock drifts from the recording's
 * by up to a minute. An auto-generated "Art Track" — the uploads on a
 * "<Artist> - Topic" channel — is the recording and nothing else. `alignsWith`
 * decides by comparing durations rather than trusting the channel name, because a
 * Topic upload of a different master is a real thing that would otherwise pass.
 */
import { normalizeAnswer } from 'game-core';
import { z } from 'zod';

/** LRCLIB asks callers to identify themselves. */
const USER_AGENT = 'KuneLabWebGames/0.3 (blind test clip finder; https://github.com/Kunelab)';

const LRCLIB_URL = 'https://lrclib.net/api/get';

/**
 * How far the video and the track may disagree before the lyrics are useless.
 *
 * Measured: the four aligned tracks in the first trial differed by 0, 0, 1 and 2
 * seconds; the four rejects differed by 22, 45, 54 and 64. Ten is comfortably
 * between them.
 */
const MAX_DRIFT_SECONDS = 10;

/**
 * Lines shorter than this are discarded before looking for repeats.
 *
 * "Yeah", "uh" and an empty ad-lib repeat more often than the chorus does and
 * carry none of its meaning, so without this the most repeated line in half the
 * catalogue is a grunt.
 */
const MIN_LINE_LENGTH = 10;

/** A track with fewer usable lines than this has lyrics too sparse to trust. */
const MIN_LINES = 8;

const lrclibSchema = z.object({
  duration: z.number().nullable().optional(),
  instrumental: z.boolean().optional(),
  syncedLyrics: z.string().nullable().optional()
});

export interface ChorusInfo {
  /** Every occurrence of the hook, in seconds, ascending. */
  hits: number[];
  /** The hook itself, normalised. Kept for logging and for the editor to show. */
  line: string;
  /** Track length according to the lyrics source, for the alignment check. */
  trackDuration: number | null;
}

/**
 * Whether a video's clock may be treated as the track's.
 *
 * Exported because the decision belongs to the caller, which is the only thing
 * that knows the video's duration, and because it is the whole safety argument
 * for using these timestamps at all.
 */
export function alignsWith(chorus: ChorusInfo, videoDurationSeconds: number | null): boolean {
  if (videoDurationSeconds === null || chorus.trackDuration === null || chorus.trackDuration === undefined) {
    return false;
  }
  return Math.abs(chorus.trackDuration - videoDurationSeconds) <= MAX_DRIFT_SECONDS;
}

interface TimedLine {
  at: number;
  text: string;
}

/** `[mm:ss.xx] text`, which is all of the LRC format that matters here. */
function parseLrc(synced: string): TimedLine[] {
  const lines: TimedLine[] = [];

  for (const raw of synced.split('\n')) {
    const match = /^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.+?)\s*$/.exec(raw);
    if (!match) continue;

    const text = normalizeAnswer(match[3] ?? '');
    if (text.length < MIN_LINE_LENGTH) continue;

    lines.push({ at: Number(match[1]) * 60 + Number(match[2]), text });
  }

  return lines;
}

/**
 * The most repeated line, and every place it lands.
 *
 * All occurrences are kept rather than just the first two, because the gaps
 * between them are what `verse` angles are found in. Ties break on whichever line
 * was seen first, which is arbitrary but stable; a song with two equally repeated
 * lines has two choruses as far as this is concerned and either is a fine place
 * to start a clip.
 */
function findHook(lines: TimedLine[], trackDuration: number | null): ChorusInfo | null {
  if (lines.length < MIN_LINES) return null;

  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
  }

  let hook: string | null = null;
  let best = 1;
  for (const [text, count] of counts) {
    if (count > best) {
      best = count;
      hook = text;
    }
  }

  // Every line unique: a spoken-word piece, or a rap with no hook. There is no
  // chorus to find, and saying so is better than returning the first line.
  if (!hook) return null;

  const hits = lines
    .filter((line) => line.text === hook)
    .map((line) => Math.round(line.at))
    .sort((a, b) => a - b);

  if (hits.length === 0) return null;

  return { hits, line: hook, trackDuration: trackDuration ?? null };
}

/**
 * Looks up one track. Returns null for anything without usable synced lyrics,
 * which includes every instrumental, and which the caller must treat as "use the
 * profile" rather than as an error.
 */
export async function fetchChorus(artist: string, title: string): Promise<ChorusInfo | null> {
  const url = new URL(LRCLIB_URL);
  url.searchParams.set('artist_name', artist);
  url.searchParams.set('track_name', title);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    // A lyrics source being down must never stop a pool from filling: every caller
    // has a fallback, and a slightly worse window beats no round at all.
    return null;
  }

  if (!response.ok) return null;

  const parsed = lrclibSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;

  const { instrumental, syncedLyrics, duration } = parsed.data;
  if (instrumental || !syncedLyrics) return null;

  return findHook(parseLrc(syncedLyrics), duration ?? null);
}

/* ------------------------------------------------------------ clip profiles */

/**
 * Where a genre's interesting part tends to live, as a fraction of the track.
 *
 * Needed because a great deal of this catalogue has no lyrics at all, and the 30%
 * rule that suits a pop song is wrong for most of it. A main title states its
 * theme almost immediately, after a few seconds of studio logo; a battle theme
 * opens on its hook because it has to loop.
 *
 * `spread` is deliberate variety rather than sloppiness: drawing the same track
 * twice in a month should not ask the identical question.
 */
export interface ClipProfile {
  anchor: number;
  spread: number;
  /** Never start before this: logos, silence, a slow fade in. */
  minStart: number;
  /** Never start after this, however long the track is. */
  maxStart: number;
  /**
   * Whether this kind of music is usually uploaded as a music video, with a
   * scene, a skit or a spoken intro before the song starts. Such an upload is
   * never opened on its intro unless the recording's length says where the
   * music begins. Openings, film themes and game tracks start on the music.
   */
  sceneBeforeMusic?: boolean;
}

/** Sung music: skip the intro, land somewhere around the first chorus. */
export const VOCAL_PROFILE: ClipProfile = {
  anchor: 0.3,
  spread: 0.06,
  minStart: 15,
  maxStart: 80,
  sceneBeforeMusic: true
};

/**
 * Instrumental themes: the statement comes early and the piece is usually built
 * to be recognised from its opening bars, so aiming a third of the way in walks
 * straight past the thing being asked about.
 */
export const THEME_PROFILE: ClipProfile = { anchor: 0.18, spread: 0.07, minStart: 5, maxStart: 55 };

/** Dialogue: the whole clip is the scene, so start at the top and stay there. */
export const DIALOGUE_PROFILE: ClipProfile = { anchor: 0, spread: 0, minStart: 0, maxStart: 4 };

/* --------------------------------------------------------------- the window */

export type HighlightAngle = 'intro' | 'chorus' | 'verse';

/** How the moment was located, which is the quality of the round in one word. */
export type HighlightSource = 'chorus' | 'hint' | 'profile';

export interface ClipPlan {
  startGuess: number;
  endGuess: number;
  startReveal: number;
  endReveal: number;
  angle: HighlightAngle;
  source: HighlightSource;
}

/** How long the room hears before it has to answer. */
const GUESS_SECONDS = 20;

/**
 * How long the reveal plays.
 *
 * Twelve, because that is the blind test kind's `revealMs`, and the reveal phase
 * is the shorter of the two clocks. It was twenty, which meant the last eight
 * seconds of every single generated reveal were cut off mid-phrase by a phase
 * change: the window said one thing and the round ran to another.
 *
 * The guess window has no such problem, because `timingFromPayload` derives the
 * answering clock from it. Nothing derives the reveal clock, so this has to match
 * it by hand.
 */
const REVEAL_SECONDS = 12;

/**
 * How much the reveal overlaps the end of the guess window.
 *
 * The player reloads the video between the two, which leaves a short gap; a
 * second of overlap makes the join sound like the song carrying on rather than
 * skipping a beat.
 */
const REVEAL_OVERLAP = 1;

/** An intro worth asking about is over by roughly here. */
const INTRO_SECONDS = 18;

/**
 * How long after a hook line a verse may begin.
 *
 * The lyrics give the moment the hook *line* starts, and a chorus section runs on
 * well past it — typically fifteen to twenty-five seconds. Clearing only a few
 * seconds put the start of a "verse" window inside the tail of the chorus it was
 * supposed to avoid, which is the whole point of the angle. Twenty is the short
 * end of a normal chorus, so it clears most and truncates none.
 */
const CHORUS_TAIL = 20;

/** And how long before the next one it must end. A shorter run-up is enough. */
const CHORUS_LEAD = 6;

export interface ClipOptions {
  /** Lyrics evidence, when there is any and it aligns with this video. */
  chorus?: ChorusInfo | null;
  profile?: ClipProfile;
  /** The round's difficulty target, 0 to 100. Decides which angle is drawn. */
  difficulty?: number;
  /**
   * A model's estimate of where the interesting part is, as a fraction.
   *
   * A fraction rather than a timestamp on purpose. Asked for in seconds a model
   * invents plausible-looking numbers with no relation to the track; asked for a
   * proportion it is merely approximate, and an approximate proportion can be
   * clamped into a sane range and is still better than a blind convention.
   */
  hintFraction?: number | null;
  /**
   * The recording's own length, from a catalogue, when it is known.
   *
   * A video longer than its recording carries that much that is not the song,
   * which is what a window has to start past. See `clipWindow`.
   */
  trackSeconds?: number | null;
  /** What kind of upload this is. Unknown is treated as a music video, the cautious guess. */
  upload?: UploadKind;
  /** Injectable for tests. */
  random?: () => number;
}

/**
 * Which angle this round takes.
 *
 * Difficulty is the dial, because the same recording is an easy question from its
 * opening riff and a hard one from its second verse. Easy rounds lean on whatever
 * is iconic; hard rounds deliberately avoid it. The randomness in between is what
 * stops a long session feeling like a formula.
 */
function pickAngle(difficulty: number, hasChorus: boolean, roll: number): HighlightAngle {
  if (difficulty <= 35) {
    // The iconic end. Intro and chorus are both fair game; an intro is often the
    // easier of the two, which is what this end of the slider asked for.
    if (!hasChorus) return 'intro';
    return roll < 0.45 ? 'intro' : 'chorus';
  }

  if (difficulty <= 70) {
    if (!hasChorus) return roll < 0.3 ? 'intro' : 'verse';
    return roll < 0.2 ? 'intro' : roll < 0.8 ? 'chorus' : 'verse';
  }

  // The hard end: anything but the part everyone knows.
  if (!hasChorus) return 'verse';
  return roll < 0.75 ? 'verse' : 'chorus';
}

/**
 * A stretch that is demonstrably not the chorus.
 *
 * The widest gap between consecutive hook occurrences, which for most songs is a
 * verse or a bridge. Returns null when the gaps are all too narrow to hold a
 * window, which is what happens to a song that is nearly all chorus.
 */
function verseStart(chorus: ChorusInfo, duration: number): number | null {
  const marks = [0, ...chorus.hits, duration];
  let bestStart: number | null = null;
  let bestWidth = 0;

  for (let index = 0; index < marks.length - 1; index++) {
    const from = marks[index] ?? 0;
    const to = marks[index + 1] ?? duration;

    /**
     * The first gap opens at the start of the track rather than after a chorus,
     * so there is no hook to clear — but there is an intro, and a "verse" that
     * begins at zero is just the intro angle under another name. Clearing the
     * intro puts it on the first verse, which is what was asked for.
     */
    const tail = index === 0 ? INTRO_SECONDS : CHORUS_TAIL;
    const usable = to - from - tail - CHORUS_LEAD;

    if (usable > bestWidth && usable >= GUESS_SECONDS) {
      bestWidth = usable;
      bestStart = from + tail;
    }
  }

  return bestStart;
}

/**
 * What kind of upload a video is, as far as its clock goes.
 *
 * `topic` is an auto-generated Art Track: the recording and nothing else.
 * `audio` is an official audio or visualiser upload, which also starts on the
 * music. `video` is everything else, most of it music videos, whose cold opens,
 * skits and spoken intros are exactly where a round opened on silence.
 */
export type UploadKind = 'topic' | 'audio' | 'video';

const AUDIO_UPLOAD = /\b(official audio|audio officiel|visuali[sz]er)\b|[([](?:official )?audio[)\]]/i;

export function uploadKind(channel: string, videoTitle: string): UploadKind {
  if (/ - Topic$/i.test(channel.trim())) return 'topic';
  if (AUDIO_UPLOAD.test(videoTitle)) return 'audio';
  return 'video';
}

/**
 * The most of a video that may be something other than the recording before
 * its lyrics timings are given up on even after shifting.
 *
 * A music video's skit or cold open runs from a few seconds to a minute or so.
 * Past this, the video is more likely another edit (an extended cut, a live
 * version) than the recording with a scene in front of it.
 */
const MAX_EXTRA_SECONDS = 90;

/** How far into the music a window starts once a video's extra has been skipped. */
const MUSIC_MARGIN = 3;

/**
 * Where to cut, for a video of known length.
 *
 * ## Inside the music
 *
 * The complaint this is built around: generated rounds opening on silence, or on
 * the part of a music video where nobody sings. Two things caused it. A music
 * video carries seconds that are not the recording (a skit, a cold open, a long
 * outro), and nothing here knew how many; and the intro angle started at a fixed
 * fifteen seconds, which on a video with a spoken opening is the spoken opening.
 *
 * So the recording's own length is used when it is known (from Deezer, the
 * lyrics source or MusicBrainz). The difference from the video's length is the
 * part that is not the song, and a window starting past it is inside the music
 * wherever that part sits: at the front, the window starts just after it; at the
 * back, the window starts a little later in the song than it would have. The
 * lyrics timings are shifted by it too, on the likelier assumption that it sits
 * at the front. And when nothing is known about a music video, the intro angle
 * is not drawn at all, since it is the one angle that lands on its opening.
 *
 * ## The reveal carries on
 *
 * The reveal used to jump to the first chorus, or six seconds before the guess
 * window when there was none, and both could land somewhere silent: the first
 * because the chorus timing was a music video's, the second because the six
 * seconds before a window that starts at the top of the music are not music.
 * It now picks up where the guess window ends, a second before, so the room
 * hears the song carry on: guess 22 to 42, reveal 41 to 53.
 */
export function clipWindow(durationSeconds: number, options: ClipOptions = {}): ClipPlan {
  const random = options.random ?? Math.random;
  const profile = options.profile ?? VOCAL_PROFILE;
  const difficulty = options.difficulty ?? 50;
  const upload = options.upload ?? 'video';

  const latest = Math.max(0, durationSeconds - 2);

  /**
   * How much of the video is not the recording, when the recording's length is
   * known: the lyrics source's length first, then the one the caller has.
   */
  const trackSeconds = options.chorus?.trackDuration ?? options.trackSeconds ?? null;
  const extra = trackSeconds !== null ? Math.max(0, durationSeconds - trackSeconds) : null;
  const drifted = extra !== null && extra > MAX_DRIFT_SECONDS;
  /** The earliest second known to be inside the music. */
  const musicFrom = drifted ? extra + MUSIC_MARGIN : 0;
  /** And the latest a window may end and still be sure to be, wherever the extra sits. */
  const musicUntil = trackSeconds !== null && drifted ? Math.min(latest, trackSeconds) : latest;

  // The lyrics on this video's clock: as they are when it is the recording,
  // shifted past the extra when it is not, and not at all past a plausible extra.
  let chorus: ChorusInfo | null = null;
  if (options.chorus && alignsWith(options.chorus, durationSeconds)) {
    chorus = options.chorus;
  } else if (options.chorus && drifted && extra <= MAX_EXTRA_SECONDS) {
    chorus = { ...options.chorus, hits: options.chorus.hits.map((hit) => hit + extra) };
  }

  /**
   * The intro only where the start of the video is known to be the start of the
   * music: an audio upload, a video whose extra has been measured, or a genre
   * whose uploads are not music videos in the first place.
   */
  const introSafe = !profile.sceneBeforeMusic || upload !== 'video' || extra !== null;
  let angle = pickAngle(difficulty, chorus !== null, random());
  if (angle === 'intro' && !introSafe) angle = chorus ? 'chorus' : 'verse';

  let at: number;
  let source: HighlightSource;

  if (angle === 'chorus' && chorus) {
    // The second occurrence: a first chorus often arrives stripped back, with half
    // the arrangement still to come, while by the second everything is in.
    at = chorus.hits[1] ?? chorus.hits[0] ?? 0;
    source = 'chorus';
  } else if (angle === 'verse' && chorus) {
    const found = verseStart(chorus, durationSeconds);
    at = found ?? Math.round(durationSeconds * profile.anchor);
    source = found === null ? 'profile' : 'chorus';
  } else if (angle === 'intro') {
    at = Math.max(profile.minStart, musicFrom);
    source = chorus ? 'chorus' : 'profile';
  } else if (options.hintFraction != null && Number.isFinite(options.hintFraction)) {
    // Clamped hard: a hint is allowed to steer, never to point off the end.
    const fraction = Math.min(0.8, Math.max(0.05, options.hintFraction));
    at = Math.round(durationSeconds * fraction);
    source = 'hint';
  } else {
    const wander = (random() * 2 - 1) * profile.spread;
    at = Math.round(durationSeconds * (profile.anchor + wander));
    source = 'profile';
  }

  /**
   * The profile's bounds apply to guesses, not to measurements.
   *
   * `maxStart` exists to stop a blind convention wandering into the third verse of
   * a long track. Applied to a position that came from the lyrics it does real
   * damage: a verse found at 2:10 was dragged back to the 80 second ceiling, which
   * on most songs lands inside a chorus. The round then played the hook while
   * reporting itself as a verse, so the hard end of the difficulty slider quietly
   * served the easiest thing in the track.
   */
  if (angle !== 'intro') {
    const ceiling = source === 'chorus' ? durationSeconds : profile.maxStart + musicFrom;
    at = Math.max(profile.minStart, Math.min(at, ceiling, Math.max(0, durationSeconds - GUESS_SECONDS - 2)));
  }

  // Never before the music, and early enough for both windows to end inside it.
  const guessLength = angle === 'intro' ? INTRO_SECONDS : GUESS_SECONDS;
  at = Math.max(at, musicFrom);
  at = Math.min(at, Math.max(musicFrom, musicUntil - guessLength - REVEAL_SECONDS));

  const startGuess = Math.max(0, Math.min(Math.round(at), latest));
  // Both windows are guarded the same way: the payload schema refuses one that is
  // not at least a second wide, and a pathologically short video would otherwise
  // collapse it to nothing and fail validation rather than merely play badly.
  const endGuess = Math.max(Math.min(startGuess + guessLength, latest), startGuess + 1);

  // Carried on from the guess window, a second of overlap so the cut is not a gap,
  // and slid back rather than cut short when the video ends first.
  let startReveal = Math.max(0, endGuess - REVEAL_OVERLAP);
  if (startReveal + REVEAL_SECONDS > latest) startReveal = Math.max(0, latest - REVEAL_SECONDS);
  const endReveal = Math.max(Math.min(startReveal + REVEAL_SECONDS, latest), startReveal + 1);

  return { startGuess, endGuess, startReveal, endReveal, angle, source };
}
