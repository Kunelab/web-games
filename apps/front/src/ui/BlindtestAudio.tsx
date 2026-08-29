import { useEffect } from 'react';

import { useYoutubePlayer } from '../hooks/useYoutube';

/**
 * Plays the clip without showing it during the guess phase.
 *
 * Kept nearly invisible rather than unmounted: destroying and recreating the
 * iframe between phases costs a reload and a gap in the audio.
 *
 * It lives here rather than in the host screen because it is no longer only the
 * television's. A hostless quick match has no television — every phone is its
 * own stage — so the player screen mounts this too, from the redacted
 * `stageRound`. Both callers pass the same three things, and neither knows about
 * the other.
 */
export function BlindtestAudio({ code, payload, phase }: { code: string; payload: unknown; phase: string }) {
  const revealing = phase === 'reveal';
  const window_ = payload as {
    startGuess?: number;
    endGuess?: number;
    startReveal?: number;
    endReveal?: number;
  };

  const { YoutubePlayer, player } = useYoutubePlayer({
    width: 640,
    height: 360,
    playerVars: { controls: 0, disablekb: 1, fs: 0, autoplay: 1 },
    events: { onError: (event) => console.error('youtube error', event.data) }
  });

  const start = revealing ? window_.startReveal : window_.startGuess;
  const end = revealing ? window_.endReveal : window_.endGuess;

  useEffect(() => {
    if (!code) return;
    player.loadVideoById({ videoId: code, startSeconds: start, endSeconds: end });
    // `player` is stable for the life of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, start, end]);

  return (
    <div className={revealing ? 'yt-visible' : 'yt-hidden'}>
      <YoutubePlayer />
    </div>
  );
}
