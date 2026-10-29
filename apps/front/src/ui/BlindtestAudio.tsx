import { playedWindows, type ClipWindows, type NextClipView } from 'game-core';
import { msg } from 'i18n';
import { useEffect, useRef, useState } from 'react';

import { useYoutubePlayer } from '../hooks/useYoutube';
import { useT } from '../i18n/locale-context';

/** Full volume unless the clip's author levelled it down. */
const DEFAULT_VOLUME = 100;

/**
 * How long to give YouTube to start before concluding it was not allowed to.
 *
 * Long enough to cover a slow first buffer, short enough that the room is not
 * sitting in silence wondering. It does not have to cover a slow *network*: a
 * clip still loading reports BUFFERING, which counts as started.
 */
const AUTOPLAY_GRACE_MS = 1_600;

/**
 * The player states that mean the clip is running: PLAYING and BUFFERING.
 *
 * Written as numbers rather than `YT.PlayerState.*` because that enum is
 * ambient and type-only here: naming it compiles to a property lookup on the
 * global the API script installs, which is a runtime dependency taken on for two
 * constants that have not moved since 2010. A blocked player sits in UNSTARTED
 * or CUED instead, which is the distinction being drawn.
 */
const RUNNING_STATES = new Set<number>([1, 3]);

/** PLAYING, the state a buffering clip reaches once it has enough to play. */
const PLAYING = 1;

/** One of the two players. See "Two players" below. */
type Slot = 0 | 1;

const other = (slot: Slot): Slot => (slot === 0 ? 1 : 0);

/** The clip the player that is not playing is buffering: this reveal, or the next round. */
interface Buffered {
  slot: Slot;
  code: string;
  start: number;
  end: number;
}

/**
 * The windows the room hears, cut down from the authored ones.
 *
 * The payload is the authored window, as stored; `playedWindows` is what the
 * server timed the round by, so the clip and the countdown end together.
 */
function heard(payload: unknown): Partial<ClipWindows> & { volume?: number } {
  const authored = (payload ?? {}) as Partial<ClipWindows> & { volume?: number };
  const { startGuess, endGuess, startReveal, endReveal } = authored;
  if (startGuess === undefined || endGuess === undefined || startReveal === undefined || endReveal === undefined) {
    return authored;
  }
  return { ...playedWindows({ startGuess, endGuess, startReveal, endReveal }), volume: authored.volume };
}

/**
 * Plays the clip: audible while the room guesses, visible once it is revealed.
 *
 * Kept mounted rather than unmounted between phases: destroying and recreating
 * the iframe costs a reload and a gap in the audio.
 *
 * It lives here rather than in the host screen because it is no longer only the
 * television's. A room with no television has every device for a stage, so the
 * player screen mounts this too, from the redacted `stageRound`. Both callers
 * pass the same three things, and neither knows about the other.
 *
 * ## Out loud first, muted only if refused
 *
 * The previous version started muted every time and offered a button to unmute,
 * on the reasoning that muted autoplay is never blocked. That reasoning is
 * sound; making it the *default* was not. The ordinary case is a laptop or a
 * phone whose owner has been tapping around the app for a minute and therefore
 * has a perfectly good user gesture on record — and it was silenced on purpose,
 * until somebody found a button that, hidden inside a `pointer-events: none`
 * subtree, was not reliably there. Hiding the player in a one-pixel box did not
 * help either: that is a browser's cue to treat the video as furniture.
 *
 * So: a real player, made invisible with `opacity`, playing unmuted at the
 * author's volume. If it has not started a moment later then the browser did
 * refuse, and *only* then does the muted fallback apply — because a clip running
 * silently is still worth having. It stays in step with the server's clock, so
 * the tap that buys sound lands in the middle of the song rather than starting
 * it over ten seconds late.
 *
 * ## Two players
 *
 * A clip loaded when its phase starts loads with the clock running: a second
 * or two of every round went on YouTube fetching the video, out of the room's
 * listening time, and as much again out of a reveal that only lasts five. So
 * there are two players, and while one plays, the other loads what comes
 * after it, silently, and stops on its first frame: this round's reveal while
 * the room guesses, the next round's clip (`next`) during the reveal. When
 * the phase changes the two swap, the buffered one is unmuted and played, and
 * the other is free to load what follows.
 *
 * The reveal waits for the guess to be playing before it is fetched, so the
 * two downloads never compete for the opening second of a round. Anything
 * that is not what was buffered — a host who skipped, a window corrected
 * mid-round — loads the usual way, so a wrong guess costs nothing but the
 * guess.
 */
/**
 * Player errors that mean this clip will never play here.
 *
 * 2 is a malformed id; 5 an HTML5 player failure; 100 a deleted or private
 * video; 101 and 150 are the same thing under two numbers, "the owner does not
 * allow this video to be embedded", which in practice also covers a clip whose
 * licence does not cover this country.
 *
 * Worth distinguishing from a slow buffer, which is what the grace timer below
 * is for: a buffering clip recovers on its own and this one never will.
 */
const FATAL_ERRORS = new Set<number>([2, 5, 100, 101, 150]);

export function BlindtestAudio({
  code,
  payload,
  phase,
  next,
  onUnplayable
}: {
  /**
   * The clip, or '' while there is none to play.
   *
   * Empty is an ordinary state rather than a reason to unmount. The screens
   * mount this from the lobby, so the player is built before round one instead
   * of at it, and keep it through rounds of other kinds in a mixed playlist,
   * so the next clip does not have to build it again.
   */
  code: string;
  payload: unknown;
  phase: string;
  /** The next round's clip, sent during the reveal, to buffer in the idle player. */
  next?: NextClipView | null;
  /**
   * Called once when the clip is definitively not going to play.
   *
   * The catalogue checks every clip's territory and embedding rules before it
   * reaches a playlist, but a licence can change between then and game night,
   * and a saved round can be years old. This is the only observer that knows for
   * certain, because it is the one actually trying to play the thing. Without it
   * the round ran its full length as silence and the room was left guessing at
   * nothing.
   */
  onUnplayable?: (reason: number) => void;
}) {
  const t = useT();
  // Only a clip is ever shown: with none loaded, the frame holds whatever played last.
  const revealing = phase === 'reveal' && code !== '';
  const window_ = heard(payload);

  const volume = window_.volume ?? DEFAULT_VOLUME;

  /**
   * Whether the clip is running with the sound turned off.
   *
   * Not a preference and not a default — a verdict, and one only the browser can
   * deliver. Autoplay policies block audible media until the page has had a user
   * gesture, so a phone that has just scanned a QR code and done nothing else
   * genuinely cannot be made to play out loud. There is no flag to read: the only
   * way to know is to try and see whether anything started.
   */
  const [silenced, setSilenced] = useState(false);

  /**
   * The last clip reported as unplayable.
   *
   * Keyed by the video id rather than a boolean so a new clip is reportable
   * again, and held in a ref because the player's error handler is created once
   * when the iframe is built and would otherwise close over the first render's
   * state for the life of the component.
   */
  const reported = useRef<string | null>(null);

  /**
   * The clip currently loaded, and the callback to tell about it.
   *
   * Both through refs, and the first one is not optional. `useYoutube` builds the
   * player once and snapshots the options at that moment, so the `onError` it
   * installs is the closure from the render that built it — round one's. This
   * component is deliberately never remounted between rounds, so reading `code`
   * from that closure means reading round one's id forever: after the first
   * blocked clip, `reported.current !== code` is comparing a value against
   * itself, and every later blocked clip is silently ignored. The room then sits
   * through a full round of silence, which is the exact failure this reporting
   * exists to prevent.
   */
  const codeRef = useRef(code);
  const onUnplayableRef = useRef(onUnplayable);
  useEffect(() => {
    codeRef.current = code;
    onUnplayableRef.current = onUnplayable;
  });

  /**
   * Which player is the room's, and what the other one is buffering.
   *
   * Refs for the same reason as `codeRef`: the players' event handlers are
   * built once and read them long after. `active` is also state, because which
   * of the two is shown at the reveal is a matter of rendering.
   */
  const [active, setActive] = useState<Slot>(0);
  const activeRef = useRef<Slot>(0);
  const buffered = useRef<Buffered | null>(null);

  /**
   * The clip the active player was last given, and the last one heard playing.
   *
   * As `code:start:end`. The second is state because it is what lets the
   * reveal start buffering: not before the guess it follows is under way.
   */
  const activeKey = useRef<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  /**
   * No controls, no keyboard, no fullscreen, no related videos at the end.
   *
   * A blind test is a question, and a question with a seek bar under it is
   * not one: the answer is a drag away, and on the guess screen even the
   * elapsed time gives away how long the clip is. `disablekb` matters as
   * much as the bar itself — space and arrow keys are how somebody scrubs a
   * video without noticing there was a rule against it.
   */
  const playerVars: YT.PlayerVars = {
    controls: 0,
    disablekb: 1,
    fs: 0,
    rel: 0,
    modestbranding: 1,
    autoplay: 1,
    playsinline: 1
  };

  const onError = (slot: Slot, event: YT.OnErrorEvent) => {
    // The idle player's clip is only a guess at the next round; if it cannot
    // play, the round loads it the usual way and reports it then.
    if (slot !== activeRef.current) {
      if (buffered.current?.slot === slot) buffered.current = null;
      return;
    }
    console.error('youtube error', event.data);
    if (FATAL_ERRORS.has(event.data)) {
      // Reported once per clip: a player can fire this more than once while
      // it gives up, and advancing a round twice would skip an innocent one.
      const current = codeRef.current;
      if (current && reported.current !== current) {
        reported.current = current;
        onUnplayableRef.current?.(event.data);
      }
    }
  };

  /**
   * The buffering player stops on its first frame.
   *
   * Reaching PLAYING is the sign it has enough to start; paused there it
   * keeps what it fetched and waits for its round. Not sought back to the
   * start afterwards: a seek cancels the end of the window, and the fraction
   * of a second it ran for is not worth a clip that plays past its end.
   */
  const onStateChange = (slot: Slot, event: YT.OnStateChangeEvent) => {
    const state: number = event.data;
    if (state !== PLAYING) return;
    if (slot === activeRef.current) {
      setStarted(activeKey.current);
      return;
    }
    if (buffered.current?.slot === slot) event.target.pauseVideo();
  };

  const first = useYoutubePlayer({
    width: 640,
    height: 360,
    playerVars,
    events: { onError: (event) => onError(0, event), onStateChange: (event) => onStateChange(0, event) }
  });
  const second = useYoutubePlayer({
    width: 640,
    height: 360,
    playerVars,
    events: { onError: (event) => onError(1, event), onStateChange: (event) => onStateChange(1, event) }
  });
  const slots = [first, second] as const;
  const activeReady = slots[active].ready;

  const start = revealing ? window_.startReveal : window_.startGuess;
  const end = revealing ? window_.endReveal : window_.endGuess;

  // Cleared on every reload and on unmount, so a phase change cannot leave an
  // old verdict to fire over a clip that is already playing.
  const grace = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!code || !activeReady) return;

    const pending = buffered.current;
    activeKey.current = `${code}:${start}:${end}`;
    const swap =
      pending !== null &&
      pending.slot !== activeRef.current &&
      slots[pending.slot].ready &&
      pending.code === code &&
      pending.start === start &&
      pending.end === end;

    if (swap) {
      // What was buffered: play it where it stopped, and silence what the other
      // player is still on.
      const previous = slots[activeRef.current].player;
      activeRef.current = pending.slot;
      buffered.current = null;
      setActive(pending.slot);
      previous.stopVideo();
      const player = slots[pending.slot].player;
      player.unMute();
      player.setVolume(volume);
      player.playVideo();
    } else {
      // A phase that is not the one buffered leaves the buffer stale, and a
      // stale clip still loading would only compete for the network.
      if (pending) {
        slots[pending.slot].player.stopVideo();
        buffered.current = null;
      }

      const player = slots[activeRef.current].player;
      /**
       * Unmuted *before* the load, not after.
       *
       * `loadVideoById` starts playback, and the mute state at that moment is what
       * the autoplay policy judges. Unmuting afterwards leaves the opening second
       * silent at best, and on a browser that let the clip through only because it
       * was muted, it is the moment playback gets cut off.
       */
      player.unMute();
      player.setVolume(volume);
      player.loadVideoById({ videoId: code, startSeconds: start, endSeconds: end });
    }

    clearTimeout(grace.current);
    grace.current = setTimeout(() => {
      const player = slots[activeRef.current].player;
      if (RUNNING_STATES.has(player.getPlayerState())) {
        setSilenced(false);
        return;
      }

      // Refused. Muted playback is never refused, so take it: the room hears
      // nothing for now, but the clip is running and in step with the round.
      player.mute();
      player.playVideo();
      setSilenced(true);
    }, AUTOPLAY_GRACE_MS);

    return () => clearTimeout(grace.current);
    // The players are stable for the life of their hooks, and which one is
    // active is read from its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, start, end, activeReady, volume]);

  /**
   * What comes after the clip playing, into the player that is not playing.
   *
   * During the guess, this round's reveal, once the guess is heard playing.
   * During the reveal, the next round's clip, which the server sends then.
   *
   * Muted, so no autoplay policy refuses it and nobody hears it; the handler
   * above stops it once it has started. Loaded once per clip: the views repeat
   * the same windows and must not restart the buffering.
   */
  const guessing = code !== '' && !revealing ? `${code}:${start}:${end}` : null;
  const upcoming: NextClipView | null = revealing
    ? (next ?? null)
    : guessing !== null &&
        started === guessing &&
        window_.startReveal !== undefined &&
        window_.endReveal !== undefined
      ? { code, start: window_.startReveal, end: window_.endReveal, volume }
      : null;
  const idleReady = slots[other(active)].ready;
  useEffect(() => {
    if (!upcoming || !idleReady) return;
    const idle = other(activeRef.current);
    const pending = buffered.current;
    if (
      pending?.slot === idle &&
      pending.code === upcoming.code &&
      pending.start === upcoming.start &&
      pending.end === upcoming.end
    ) {
      return;
    }

    buffered.current = { slot: idle, code: upcoming.code, start: upcoming.start, end: upcoming.end };
    const player = slots[idle].player;
    player.mute();
    player.setVolume(upcoming.volume);
    player.loadVideoById({ videoId: upcoming.code, startSeconds: upcoming.start, endSeconds: upcoming.end });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcoming?.code, upcoming?.start, upcoming?.end, idleReady]);

  /**
   * And nothing to play stops whatever was playing.
   *
   * Unmounting used to do this, between a blind test and the picture round
   * after it. The player stays now, so a clip whose window had not run out
   * would carry on under the next round.
   */
  useEffect(() => {
    if (code || !activeReady) return;
    slots[activeRef.current].player.stopVideo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, activeReady]);

  return (
    <>
      {slots.map(({ YoutubePlayer }, slot) => (
        <div key={slot} className={revealing && slot === active ? 'yt-visible' : 'yt-hidden'}>
          <YoutubePlayer />
        </div>
      ))}
      {silenced && code && (
        /**
         * A sibling of the wrapper, not a child of it — and that is the whole
         * point of the fragment.
         *
         * `.yt-hidden` carries `pointer-events: none`, which every descendant
         * inherits. The button was drawn, floated over the page, looked
         * perfectly pressable, and swallowed every tap.
         */
        <button
          type="button"
          className="yt-unmute"
          title={t(msg('play.soundBlocked'))}
          onClick={() => {
            // The click is the gesture the policy was waiting for. No reload and
            // no seek: the clip is already at the right second, it is only quiet.
            setSilenced(false);
            const player = slots[activeRef.current].player;
            player.unMute();
            player.setVolume(volume);
            player.playVideo();
          }}
        >
          🔇 {t(msg('play.tapForSound'))}
        </button>
      )}
    </>
  );
}
