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
 */
export function BlindtestAudio({ code, payload, phase }: { code: string; payload: unknown; phase: string }) {
  const t = useT();
  const revealing = phase === 'reveal';
  const window_ = payload as {
    startGuess?: number;
    endGuess?: number;
    startReveal?: number;
    endReveal?: number;
    volume?: number;
  };

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

  const { YoutubePlayer, player, ready } = useYoutubePlayer({
    width: 640,
    height: 360,
    playerVars: {
      /**
       * No controls, no keyboard, no fullscreen, no related videos at the end.
       *
       * A blind test is a question, and a question with a seek bar under it is
       * not one: the answer is a drag away, and on the guess screen even the
       * elapsed time gives away how long the clip is. `disablekb` matters as
       * much as the bar itself — space and arrow keys are how somebody scrubs a
       * video without noticing there was a rule against it.
       */
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      modestbranding: 1,
      autoplay: 1,
      playsinline: 1
    },
    events: { onError: (event) => console.error('youtube error', event.data) }
  });

  const start = revealing ? window_.startReveal : window_.startGuess;
  const end = revealing ? window_.endReveal : window_.endGuess;

  // Cleared on every reload and on unmount, so a phase change cannot leave an
  // old verdict to fire over a clip that is already playing.
  const grace = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!code || !ready) return;

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

    clearTimeout(grace.current);
    grace.current = setTimeout(() => {
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
    // `player` is stable for the life of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, start, end, ready, volume]);

  return (
    <>
      <div className={revealing ? 'yt-visible' : 'yt-hidden'}>
        <YoutubePlayer />
      </div>
      {silenced && (
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
