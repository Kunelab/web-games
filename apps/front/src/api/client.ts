import type { AnswerField, FieldMeta, KindTiming, Readiness, SessionConfig } from 'game-core';

import { apiBaseUrl } from '../tools/api-url';

/**
 * Typed API client.
 *
 * Uses fetch rather than axios: the only thing axios was providing here was a
 * base URL and a 401 interceptor, both of which are three lines. One dependency
 * fewer, and the error shape is ours rather than axios's.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Lets the app react to an expired session once, in one place. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Skips the global 401 handling, for the session probe on page load. */
  allowAnonymous?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, allowAnonymous } = options;

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });

  if (response.status === 401 && !allowAnonymous) {
    for (const listener of unauthorizedListeners) {
      listener();
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const payload: unknown = text ? safeJson(text) : null;

  if (!response.ok) {
    const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const rawMessage = body.message;

    const message =
      (typeof rawMessage === 'string' ? rawMessage : '') || `La requête a échoué (${response.status})`;
    const details = body.details;

    throw new ApiError(message, response.status, details);
  }

  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------- shapes */

export interface AuthUser {
  id: number;
  login: string;
}

/** Mirrors MediaView on the server. */
export interface MediaItem {
  id: number;
  user_id: number | null;
  kind: string;
  title: string;
  category: string | null;
  date: string | null;
  answers: AnswerField[];
  payload: unknown;
  timing: KindTiming | null;
  effectiveTiming: KindTiming;
  readiness: Readiness;
  created_at: string | null;
  last_modified: string | null;
}

/** The kind registry as served by the API, which drives the generated forms. */
export interface KindDescriptor {
  id: string;
  label: { fr: string; en: string };
  description: { fr: string; en: string };
  icon: string;
  formFields: FieldMeta[];
  defaultPayload: unknown;
  defaultAnswers: AnswerField[];
  answersEditable: boolean;
  defaultTiming: KindTiming;
  presentedByHost: boolean;
}

export interface Playlist {
  id: number;
  user_id: number | null;
  name: string | null;
  public: boolean | null;
  created_at: string | null;
  last_modified: string | null;
  owner: { id: number; login: string | null } | null;
  items: MediaItem[];
  kindCounts: Record<string, number>;
  notReadyCount: number;
}

export interface MediaInputBody {
  kind: string;
  title: string;
  category?: string | null;
  date?: string | null;
  answers: AnswerField[];
  payload: unknown;
  timing?: KindTiming | null;
}

/** One cell of a generated memory panel: a picture and the answer for it. */
export interface PanelItem {
  label: string;
  aliases: string[];
  imageUrl: string;
  /** The article it came from, so a doubtful cell can be checked. */
  pageUrl: string;
  theme: string;
}

export interface PanelTheme {
  id: string;
  label: string;
}

export interface YoutubeMetadata {
  videoId: string;
  rawTitle: string;
  title: string;
  artist: string;
  channel: string;
  year: string;
  durationSeconds: number | null;
}

export interface StartedSession {
  code: string;
  hostToken: string;
  total: number;
  skipped: { title: string; missing: string[] }[];
}

export interface SessionSummary {
  code: string;
  phase: string;
  playlistName: string;
  players: number;
  total: number;
}

/* --------------------------------------------------------------------- calls */

export const api = {
  /* auth */
  me: () => request<AuthUser | null>('/user', { allowAnonymous: true }),
  login: (username: string, password: string) =>
    request<AuthUser>('/user/login', { method: 'POST', body: { username, password } }),
  register: (username: string, password: string, email: string) =>
    request<AuthUser>('/user/register', { method: 'POST', body: { username, password, email } }),
  logout: () => request<{ message: string }>('/user/logout', { method: 'POST' }),

  /* media */
  kinds: () => request<KindDescriptor[]>('/media/kinds'),
  listMedia: (query: { kind?: string; category?: string; search?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.kind) params.set('kind', query.kind);
    if (query.category) params.set('category', query.category);
    if (query.search) params.set('search', query.search);
    const suffix = params.toString();
    return request<MediaItem[]>(`/media${suffix ? `?${suffix}` : ''}`);
  },
  categories: () => request<string[]>('/media/categories'),
  getMedia: (id: number) => request<MediaItem>(`/media/${id}`),
  createMedia: (body: MediaInputBody) => request<MediaItem>('/media', { method: 'POST', body }),
  updateMedia: (id: number, body: MediaInputBody) =>
    request<MediaItem>(`/media/${id}`, { method: 'PATCH', body }),
  duplicateMedia: (id: number) => request<MediaItem>(`/media/${id}/duplicate`, { method: 'POST' }),
  deleteMedia: (id: number) => request<void>(`/media/${id}`, { method: 'DELETE' }),
  mediaUsage: (id: number) => request<{ playlists: number }>(`/media/${id}/usage`),

  /* youtube */
  panelThemes: () => request<{ themes: PanelTheme[] }>('/media/panel/themes'),
  buildPanel: (themes: string[], count: number) =>
    request<{ items: PanelItem[] }>(
      `/media/panel?themes=${encodeURIComponent(themes.join(','))}&count=${count}`
    ),

  youtubeLookup: (ref: string) =>
    request<YoutubeMetadata>('/media/youtube/lookup', { method: 'POST', body: { ref } }),
  youtubeImport: (playlistRef: string, category?: string) =>
    request<{ imported: number; notReady: number; items: MediaItem[] }>('/media/youtube/import', {
      method: 'POST',
      body: { playlistRef, category }
    }),

  /* playlists */
  listPlaylists: () => request<Playlist[]>('/playlists'),
  getPlaylist: (id: number) => request<Playlist>(`/playlists/${id}`),
  createPlaylist: (body: { name: string; public?: boolean; mediaIds?: number[] }) =>
    request<Playlist>('/playlists', { method: 'POST', body }),
  updatePlaylist: (id: number, body: { name?: string; public?: boolean; mediaIds?: number[] }) =>
    request<Playlist>(`/playlists/${id}`, { method: 'PATCH', body }),
  /** `dropped` counts items the copy could not carry over, see the route. */
  duplicatePlaylist: (id: number) =>
    request<Playlist & { dropped: number }>(`/playlists/${id}/duplicate`, { method: 'POST' }),
  deletePlaylist: (id: number) => request<void>(`/playlists/${id}`, { method: 'DELETE' }),

  /* play */
  startSession: (playlistId: number, config?: Partial<SessionConfig>) =>
    request<StartedSession>('/play/sessions', { method: 'POST', body: { playlistId, config } }),
  sessionSummary: (code: string) => request<SessionSummary>(`/play/sessions/${code}`, { allowAnonymous: true }),
  endSession: (code: string) => request<void>(`/play/sessions/${code}`, { method: 'DELETE' }),
  mySessions: () =>
    request<{ code: string; hostToken: string; phase: string; playlistName: string }[]>('/play/mine')
};
