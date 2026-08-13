import { useCallback, useEffect, useId, useMemo, useRef, type CSSProperties } from 'react';

export interface UseYoutubeOptions {
  videoId?: string | null;
  width?: number;
  height?: number;
  playerVars?: YT.PlayerVars;
  events?: {
    onReady?: (event: YT.PlayerEvent) => void;
    onStateChange?: (event: YT.OnStateChangeEvent) => void;
    onError?: (event: YT.OnErrorEvent) => void;
  };
}

interface YoutubePlayerProps {
  className?: string;
  style?: CSSProperties;
}

/**
 * The subset of the IFrame API the app drives, each call a no-op until the
 * player exists. `raw` is the escape hatch for anything not listed; the previous
 * version hand-wrapped all forty API methods, of which five were ever called.
 */
export interface YoutubePlayerApi {
  loadVideoById: (...args: Parameters<YT.Player['loadVideoById']>) => void;
  cueVideoById: (...args: Parameters<YT.Player['cueVideoById']>) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  mute: () => void;
  unMute: () => void;
  setVolume: (volume: number) => void;
  /** Seconds into the current video, or 0 before the player is ready. */
  getCurrentTime: () => number;
  getDuration: () => number;
  /** One of the YT.PlayerState values, or -1 before the player exists. */
  getPlayerState: () => number;
  raw: () => YT.Player | undefined;
}

/** Resolves once the IFrame API script has run, and only loads it once. */
let apiReady: Promise<void> | undefined;

function loadIframeApi(): Promise<void> {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  apiReady ??= new Promise<void>((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });

  return apiReady;
}

export function useYoutubePlayer(options: UseYoutubeOptions) {
  const playerRef = useRef<YT.Player | undefined>(undefined);

  // A unique element id per hook instance. The old version derived it from
  // `options.videoId`, which callers never pass, so every player on the page
  // rendered a div with the same id and they fought over the same mount point.
  const playerId = `youtube-player-${useId().replace(/:/g, '')}`;

  // Kept in a ref so the mount effect never needs `options` as a dependency,
  // which is what made the original re-run and re-inject the API script. The
  // assignment lives in an effect rather than the render body so the render
  // stays side-effect free; it is declared before the mount effect, so the ref
  // is current by the time that one runs.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const YoutubePlayer = useMemo(() => {
    function YoutubePlayerContainer({ className, style }: YoutubePlayerProps) {
      return <div className={className ?? ''} style={style} id={playerId} />;
    }
    return YoutubePlayerContainer;
  }, [playerId]);

  useEffect(() => {
    let cancelled = false;

    void loadIframeApi().then(() => {
      // The element is gone if the component unmounted while the script loaded.
      if (cancelled || !document.getElementById(playerId)) {
        return;
      }

      const current = optionsRef.current;

      /**
       * `videoId` is added only when there is one to add.
       *
       * The IFrame API validates the key's presence, not its value: passing
       * `videoId: undefined` throws a synchronous "Invalid video id" from the
       * constructor, while omitting the key entirely is fine and the player waits
       * for a later `loadVideoById`. Most callers here load clips on demand and
       * never supply an initial id, so this is the normal path, not an edge case.
       */
      const options: YT.PlayerOptions = {
        playerVars: current.playerVars,
        height: current.height ?? 390,
        width: current.width ?? 640,
        events: {
          onReady: (event) => current.events?.onReady?.(event),
          onStateChange: (event) => current.events?.onStateChange?.(event),
          onError: (event) => current.events?.onError?.(event)
        }
      };

      if (current.videoId) {
        options.videoId = current.videoId;
      }

      try {
        playerRef.current = new window.YT.Player(playerId, options);
      } catch (error) {
        // Without this the failure surfaces only as an unhandled rejection,
        // because we are inside the API-load promise chain.
        console.error('failed to create the YouTube player', error);
      }
    });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = undefined;
      // Deliberately not clearing `window.YT`. The old cleanup did, and it also
      // ran immediately on mount rather than on unmount (`return destroy()`
      // instead of `return () => destroy()`), so the API script was re-injected
      // on every single mount.
    };
  }, [playerId]);

  const call = useCallback(<T,>(fn: (player: YT.Player) => T, fallback: T): T => {
    const player = playerRef.current;
    // Methods are missing until the iframe finishes initialising, even though
    // the Player object exists.
    return player ? (fn(player) ?? fallback) : fallback;
  }, []);

  return useMemo<{ YoutubePlayer: typeof YoutubePlayer; player: YoutubePlayerApi }>(
    () => ({
      YoutubePlayer,
      player: {
        loadVideoById: (...args) => call((p) => p.loadVideoById?.(...args), undefined),
        cueVideoById: (...args) => call((p) => p.cueVideoById?.(...args), undefined),
        playVideo: () => call((p) => p.playVideo?.(), undefined),
        pauseVideo: () => call((p) => p.pauseVideo?.(), undefined),
        stopVideo: () => call((p) => p.stopVideo?.(), undefined),
        seekTo: (seconds, allowSeekAhead = true) => call((p) => p.seekTo?.(seconds, allowSeekAhead), undefined),
        mute: () => call((p) => p.mute?.(), undefined),
        unMute: () => call((p) => p.unMute?.(), undefined),
        setVolume: (volume) => call((p) => p.setVolume?.(volume), undefined),
        getCurrentTime: () => call((p) => p.getCurrentTime?.(), 0),
        getDuration: () => call((p) => p.getDuration?.(), 0),
        getPlayerState: () => call<number>((p) => p.getPlayerState?.(), -1),
        raw: () => playerRef.current
      }
    }),
    [YoutubePlayer, call]
  );
}
