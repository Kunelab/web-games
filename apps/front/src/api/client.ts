import type { AnswerField, FieldMeta, FinalAward, KindTiming, Readiness, SessionConfig } from 'game-core';
import type { Currency, LobbyCard, LobbyGame, LockerView, ShopItem } from 'lobby-core';

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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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

    const message = (typeof rawMessage === 'string' ? rawMessage : '') || `La requête a échoué (${response.status})`;
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
  /**
   * What this account may do beyond its own things.
   *
   * Sent so a screen can *offer* what the server will allow — the correction
   * controls on a generated round are an admin's, and drawing them for
   * everybody would mean most hosts pressing a button that answers "réservée à
   * un administrateur". Never the authority: every one of those actions is
   * checked again on the server, against this same field read from the session
   * rather than from the client.
   */
  role?: string;
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
  /** Themes sharing a group render under one heading. */
  group: string;
  /** True when the nationality picker applies. */
  byNationality: boolean;
}

export interface PanelNationality {
  id: string;
  label: string;
}

/** A window on the 0–100 obscurity scale: 0 household names, 100 deep cuts. */
export interface DifficultyRange {
  min: number;
  max: number;
}

export interface DifficultyPreset extends DifficultyRange {
  id: string;
  label: string;
}

/** One subject from the generalized Wikipedia lookup. */
export interface WikiSubject {
  title: string;
  label: string;
  imageUrl: string;
  description: string;
  pageUrl: string;
  monthlyViews: number;
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

/** One player's line in a recorded game. */
export interface ResultPlayer {
  name: string;
  score: number;
  rank: number;
  correct: number;
  wrong: number;
  fastestMs: number | null;
  roundsWon: number;
  bestCombo: number;
}

/** A finished game as the history page reads it. */
export interface GameResult {
  id: number;
  code: string;
  playlistName: string;
  finishedAt: number;
  roundsTotal: number;
  players: ResultPlayer[];
  awards: FinalAward[];
}

/** A filed bug report, as the operator's screen reads it. */
export interface BugReport {
  id: number;
  login: string | null;
  area: string;
  message: string;
  page: string | null;
  userAgent: string | null;
  gameCode: string | null;
  status: string;
  createdAt: string | null;
}

/** Lifetime tallies for one nickname. */
export interface PlayerCareer {
  name: string;
  games: number;
  wins: number;
  totalPoints: number;
  bestScore: number;
  correct: number;
  wrong: number;
  awards: number;
  fastestEverMs: number | null;
  bestComboEver: number;
  /** Achievement keys, in prestige order. See app/badges.ts for the labels. */
  badges: string[];
  /** The badge worn as a title, usually the last of `badges`. */
  title: string | null;
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
  changePassword: (current: string, next: string) =>
    request<{ message: string }>('/user/password', { method: 'POST', body: { current, next } }),
  /**
   * Asks for a reset link. Anonymous, because the whole point is being locked out.
   *
   * Answers the same way whether or not the address is known, so the screen has
   * nothing to branch on and should not try. `link` comes back only on a
   * deployment running with `PASSWORD_RESET_ECHO`, which exists because there is
   * no mailer yet; normally the link is in the server log and this is undefined.
   */
  forgotPassword: (email: string) =>
    request<{ message: string; link?: string }>('/user/forgot-password', {
      method: 'POST',
      body: { email }
    }),
  checkResetToken: (token: string) =>
    request<{ valid: boolean }>('/user/reset-password/check', {
      method: 'POST',
      body: { token }
    }),
  resetPassword: (token: string, password: string) =>
    request<{ message: string }>('/user/reset-password', {
      method: 'POST',
      body: { token, password }
    }),

  /* bug reports */
  /**
   * Files a bug report. Works signed in or not, because the commonest moment to
   * meet a bug is halfway through a game and the players in one have no account.
   * Nothing is mailed; the report waits in a table for whoever runs the box.
   */
  reportBug: (report: { area: string; message: string; page?: string; gameCode?: string }) =>
    request<{ id: number; message: string }>('/bugs', { method: 'POST', body: report }),
  listBugs: (status?: 'new' | 'seen' | 'closed') =>
    request<BugReport[]>(`/bugs${status ? `?status=${status}` : ''}`),
  setBugStatus: (id: number, status: 'new' | 'seen' | 'closed') =>
    request<{ message: string }>(`/bugs/${id}`, { method: 'PATCH', body: { status } }),
  deleteBug: (id: number) => request<void>(`/bugs/${id}`, { method: 'DELETE' }),

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
  updateMedia: (id: number, body: MediaInputBody) => request<MediaItem>(`/media/${id}`, { method: 'PATCH', body }),
  duplicateMedia: (id: number) => request<MediaItem>(`/media/${id}/duplicate`, { method: 'POST' }),
  deleteMedia: (id: number) => request<void>(`/media/${id}`, { method: 'DELETE' }),
  mediaUsage: (id: number) => request<{ playlists: number }>(`/media/${id}/usage`),

  /* wikipedia */
  panelThemes: () =>
    request<{
      themes: PanelTheme[];
      nationalities: PanelNationality[];
      difficultyPresets: DifficultyPreset[];
      defaultRange: DifficultyRange;
    }>('/media/panel/themes'),
  buildPanel: (themes: string[], count: number, range: DifficultyRange, nationalities: string[]) => {
    const params = new URLSearchParams({
      themes: themes.join(','),
      count: String(count),
      dmin: String(range.min),
      dmax: String(range.max)
    });
    if (nationalities.length > 0) params.set('nats', nationalities.join(','));
    return request<{ items: PanelItem[] }>(`/media/panel?${params.toString()}`);
  },
  wikiSearch: (query: string) =>
    request<{ results: WikiSubject[] }>(`/media/wiki/search?q=${encodeURIComponent(query)}`),

  youtubeLookup: (ref: string) => request<YoutubeMetadata>('/media/youtube/lookup', { method: 'POST', body: { ref } }),
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
  /**
   * Plays one library item on its own, so its author can hear what players will.
   *
   * Same shape as `startSession` because it is the same thing: a real game with a
   * one-item order. It owns no playlist, and the server keeps it out of the
   * history — see `rehearsal` on the session state.
   */
  rehearseMedia: (mediaId: number, config?: Partial<SessionConfig>) =>
    request<StartedSession>('/play/rehearsals', { method: 'POST', body: { mediaId, config } }),
  sessionSummary: (code: string) => request<SessionSummary>(`/play/sessions/${code}`, { allowAnonymous: true }),
  endSession: (code: string) => request<void>(`/play/sessions/${code}`, { method: 'DELETE' }),
  mySessions: () =>
    request<
      {
        code: string;
        hostToken: string;
        phase: string;
        playlistName: string;
        /** Seats taken, and how many of them still have a socket. */
        players: number;
        connected: number;
      }[]
    >('/play/mine'),

  /* history */
  results: (limit = 30) => request<GameResult[]>(`/play/results?limit=${limit}`),
  careers: () => request<PlayerCareer[]>('/play/careers'),

  /* CoronaZ */
  czCreate: (config: unknown, seed?: number, gmLoadout?: string[]) =>
    request<{ code: string; hostToken: string; gmToken?: string }>('/zombie/sessions', {
      method: 'POST',
      body: { config, seed, gmLoadout }
    }),
  czSummary: (code: string) =>
    request<{ code: string; phase: string; scenario: string; mode: string; players: number }>(
      `/zombie/sessions/${code}`,
      { allowAnonymous: true }
    ),
  czEnd: (code: string) => request<void>(`/zombie/sessions/${code}`, { method: 'DELETE' }),
  czMine: () =>
    request<{ code: string; hostToken: string; gmToken?: string; phase: string; scenario: string }[]>('/zombie/mine'),
  czCareers: () => request<CzCareer[]>('/zombie/careers'),
  czMe: () => request<CzCareer>('/zombie/me'),
  czUnlockGm: (classId: string) => request<CzCareer>('/zombie/unlock', { method: 'POST', body: { classId } }),

  /* the board, and the shop */

  /**
   * Open lobbies across every game. Anonymous, like the join screen it feeds:
   * players have no accounts and a board you must sign in to read is a board
   * nobody arrives at.
   */
  lobbies: (game?: LobbyGame) =>
    request<LobbyCard[]>(`/lobbies${game ? `?game=${game}` : ''}`, { allowAnonymous: true }),

  shop: (game: LobbyGame) =>
    request<{ items: ShopItem[]; currency: Currency }>(`/shop/${game}`, { allowAnonymous: true }),
  locker: (game: LobbyGame) => request<LockerView>(`/locker/${game}`),
  buyItem: (game: LobbyGame, itemId: string) =>
    request<LockerView>(`/locker/${game}/buy`, { method: 'POST', body: { itemId } }),
  wearItem: (game: LobbyGame, slot: string, itemId: string | null) =>
    request<LockerView>(`/locker/${game}/wear`, { method: 'POST', body: { slot, itemId } }),

  /* Mafia */
  mafiaCreate: (config?: {
    maxPlayers?: number;
    dayMs?: number;
    nightMs?: number;
    /** What a corpse gives away; see MafiaConfig.revealOnDeath. */
    revealOnDeath?: 'role' | 'faction' | 'none';
    setup?:
      { mode: 'auto' } | { mode: 'chaos' } | { mode: 'preset'; presetId: string } | { mode: 'custom'; slots: string[] };
    /** Lists the table on the public board. Private by default. */
    public?: boolean;
    /** What the board calls this table; empty means the role list names it. */
    name?: string;
    /** The word at the door; empty means there is no door. */
    password?: string;
  }) => request<{ code: string; hostToken: string }>('/mafia/sessions', { method: 'POST', body: { config } }),
  mafiaSetups: () => request<{ id: string; name: string; description: string; slots: string[] }[]>('/mafia/setups'),
  mafiaTemplates: () => request<{ name: string; slots: string[] }[]>('/mafia/templates'),
  mafiaSaveTemplate: (name: string, slots: string[]) =>
    request<void>('/mafia/templates', { method: 'PUT', body: { name, slots } }),
  mafiaDeleteTemplate: (name: string) =>
    request<void>(`/mafia/templates/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  mafiaSummary: (code: string) =>
    request<{ code: string; phase: string; players: number; maxPlayers: number }>(`/mafia/sessions/${code}`, {
      allowAnonymous: true
    }),
  mafiaEnd: (code: string) => request<void>(`/mafia/sessions/${code}`, { method: 'DELETE' }),
  mafiaMine: () => request<{ code: string; hostToken: string; phase: string; players: number }[]>('/mafia/mine'),
  /* Blind test infini */
  blindtestCatalog: () => request<BlindtestCatalog>('/blindtest/catalog', { allowAnonymous: true }),
  blindtestCount: (settings: BlindtestSettings) =>
    request<{
      region: string;
      total: number;
      /** Genres whose pool is still being fetched; poll again while above zero. */
      pending: number;
      /** null while that genre's pool has not arrived yet. */
      perGenre: { genreId: string; available: number | null }[];
    }>('/blindtest/count', {
      method: 'POST',
      body: settings
    }),
  blindtestCreate: (
    settings: BlindtestSettings & {
      maxRounds: number | null;
      /** 0 searches every round, 1 replays only the shared catalogue. */
      replayShare?: number;
      config?: Partial<SessionConfig>;
    }
  ) =>
    request<{ code: string; hostToken: string; total: number; infinite: boolean }>('/blindtest/sessions', {
      method: 'POST',
      body: settings
    }),
  blindtestStop: (code: string) =>
    request<{ stoppingAfter: number }>(`/blindtest/sessions/${code}/stop`, { method: 'POST' }),
  mafiaMe: () => request<MafiaCareer>('/mafia/me')
};

/** One selectable genre. `facet` marks an era filter over another genre's pool. */
export interface BlindtestGenre {
  id: string;
  label: string;
  section: string;
  answerShape: 'artist-title' | 'work';
  facet: boolean;
}

export interface BlindtestCatalog {
  /** False when the server has no YouTube key, which no retry will fix. */
  available: boolean;
  region: string;
  sections: { id: string; label: string }[];
  genres: BlindtestGenre[];
}

export interface BlindtestSettings {
  genreIds: string[];
  difficultyMin: number;
  difficultyMax: number;
  region: string;
}

/** One nickname's Mafia wallet: the points the store will spend. */
export interface MafiaCareer {
  points: number;
  games: number;
  wins: number;
  soloWins: number;
  kills: number;
  survived: number;
  unlocked: string[];
}

/** One nickname's CoronaZ roguelite ledger. */
export interface CzCareer {
  name: string;
  stats: {
    raids: number;
    wins: number;
    deaths: number;
    escapes: number;
    kills: number;
    bossKills: number;
    searches: number;
    fastestWinTurns: Record<string, number>;
    gmRaids: number;
    gmWins: number;
    gmSpawns: number;
    rations: number;
    unlockedHeroes: string[];
    unlockedGm: string[];
  };
  trophies: string[];
  heroPerks: string[];
  gmPerks: string[];
}
