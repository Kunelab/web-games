import { msg } from 'i18n';
import { useEffect, useState } from 'react';

import { useYoutubePlayer } from '../hooks/useYoutube';
import { useT } from '../i18n/locale-context';

/**
 * Plays the clip: audible while the room guesses, visible once it is revealed.
 *
 * Kept mounted rather than unmounted between phases: destroying and recreating
 * the iframe costs a reload and a gap in the audio.
 *
 * It lives here rather than in the host screen because it is no longer only the
 * television's. A hostless quick match has no television — every phone is its
 * own stage — so the player screen mounts this too, from the redacted
 * `stageRound`. Both callers pass the same three things, and neither knows about
 * the other.
 */
export function BlindtestAudio({ code, payload, phase }: { code: string; payload: unknown; phase: string }) {
  const t = useT();
  const revealing = phase === 'reveal';
  const window_ = payload as {
    startGuess?: number;
    endGuess?: number;
    startReveal?: number;
    endReveal?: number;
  };

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

  /**
   * Whether this browser has let us make a sound yet.
   *
   * Not a preference — a fact about the page. Browsers refuse to start audible
   * media until the person has interacted with the document, and a phone that
   * has just joined by scanning a QR code has interacted with nothing. There is
   * no flag that turns this off; the only currency is a gesture.
   *
   * So the player starts muted (which always autoplays, so the clip is *running*
   * and in sync from the first frame) and one tap unmutes it. The alternative —
   * autoplay unmuted and hope — is what made the room silent with no way to
   * tell whether the clip was playing, blocked, or missing.
   */
  const [audible, setAudible] = useState(false);

  const start = revealing ? window_.startReveal : window_.startGuess;
  const end = revealing ? window_.endReveal : window_.endGuess;

  useEffect(() => {
    if (!code || !ready) return;
    player.loadVideoById({ videoId: code, startSeconds: start, endSeconds: end });
    if (audible) player.unMute();
    else player.mute();
    // `player` is stable for the life of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, start, end, ready, audible]);

  return (
    <div className={revealing ? 'yt-visible' : 'yt-hidden'}>
      <YoutubePlayer />
      {!audible && (
        /**
         * Deliberately outside the hidden wrapper, because during the guess
         * phase that wrapper is a one-pixel square: a button inside it would be
         * unclickable, which is the one thing this button must not be.
         */
        <button
          type="button"
          className="yt-unmute"
          onClick={() => {
            setAudible(true);
            player.unMute();
            player.setVolume(100);
            player.playVideo();
          }}
        >
          🔇 {t(msg('play.tapForSound'))}
        </button>
      )}
    </div>
  );
}
