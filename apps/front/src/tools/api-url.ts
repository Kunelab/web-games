/**
 * The API origin was rebuilt from three env vars in four different files, each
 * handling the missing-port case slightly differently (`read-playlist.jsx` even
 * hardcoded `:5173`). It is assembled once here instead.
 *
 * `VITE_API_PORT` is accepted with or without its leading colon.
 *
 * These fall back with `||` rather than `??` because an unset variable and one
 * set to the empty string have to mean the same thing here. The Docker build
 * passes `VITE_API_URL=` explicitly to mean "derive the host from the page",
 * and `??` treated that empty string as a real value: every request went to
 * `https:///api` behind a reverse proxy.
 */

const protocol = import.meta.env.VITE_API_PROTOCOL || 'http';
const host = import.meta.env.VITE_API_URL || window.location.hostname;

function portSuffix(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim().replace(/^:/, '');
  return trimmed ? `:${trimmed}` : '';
}

/** e.g. `http://kune.local:3000` */
export const apiOrigin = `${protocol}://${host}${portSuffix(import.meta.env.VITE_API_PORT)}`;

/** e.g. `http://kune.local:3000/api` */
export const apiBaseUrl = `${apiOrigin}/api`;

/**
 * Resolves an asset path the server handed us into something a browser can load.
 *
 * The engine returns round assets as `/api/play/asset/<token>`, a path rather than a
 * URL, because in production the API and the page share an origin. In development
 * they do not: the page is on Vite's port and the API is on its own, so dropping that
 * path straight into an `img` tag asks the dev server for it and gets the SPA's HTML
 * back. Nothing rendered, no error in the network tab that looks like one, which is
 * why every image was simply missing while the questions were fine.
 *
 * Anything already absolute is passed through, so a payload holding a plain external
 * URL still works.
 */
export function assetUrl(path: string | undefined): string {
  if (!path) return '';
  if (/^(https?:)?\/\//i.test(path) || path.startsWith('data:')) return path;
  return `${apiOrigin}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Origin players open to reach the buzzer. This is the frontend, not the API, so
 * it defaults to wherever the app is currently served from rather than to a
 * hardcoded dev port.
 */
export const buzzerOrigin = import.meta.env.VITE_BUZZER_ORIGIN || window.location.origin;

/** The address a player opens for a given join code. */
export function joinUrl(code: string): string {
  return `${buzzerOrigin}/rejoindre/${encodeURIComponent(code)}`;
}
