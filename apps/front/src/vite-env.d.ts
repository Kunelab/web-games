/// <reference types="vite/client" />

/**
 * The API location is split across three variables for historical reasons.
 * `VITE_API_PORT` may or may not include its leading colon; `apiBaseUrl` in
 * tools/api-url.ts normalises it.
 */
interface ImportMetaEnv {
  readonly VITE_API_PROTOCOL?: 'http' | 'https';
  readonly VITE_API_URL?: string;
  readonly VITE_API_PORT?: string;
  /** Origin the buzzer QR code points at. Falls back to the current origin. */
  readonly VITE_BUZZER_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Called once by the YouTube IFrame API script when it finishes loading. */
  onYouTubeIframeAPIReady?: () => void;
}
