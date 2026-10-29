import Database from 'better-sqlite3';

import { databaseFile } from '../env.js';

/**
 * The super-admin's window on the database: every table, every row, read only,
 * with personal data and secrets masked.
 *
 * ## Read only by construction
 *
 * The explorer has a connection of its own, opened read only, so a write is
 * refused by SQLite itself and not by a check somebody could forget. It reads
 * beside the app's connection without blocking it, which is what WAL is for.
 *
 * ## Masked unless labelled
 *
 * Every column is labelled below. `show` is plain game data. `mask` is a value
 * nobody reads here: personal data (only a username is shown of a person) and
 * secrets, such as a session id, which would let whoever holds it sign in as
 * that player. `scrub` is JSON shown with the secrets inside it masked, the
 * room passwords and host tokens a saved game carries in its state.
 *
 * A column with no label is masked, and so is every column of a table with
 * none, so a field added later stays hidden until somebody decides it may be
 * seen. A test fails when the schema has a column this list does not name.
 */

export type Treatment = 'show' | 'mask' | 'scrub';

/** Read one column of a table. */
type Labels = Record<string, Treatment>;

const LEGACY_DATES: Labels = { createdAt: 'show', updatedAt: 'show' };

export const COLUMNS: Record<string, Labels> = {
  Users: {
    id: 'show',
    role: 'show',
    login: 'show',
    email: 'mask',
    password: 'mask',
    // When a person signed up and was last seen is theirs too.
    created_at: 'mask',
    last_modified: 'mask',
    last_login: 'mask',
    createdAt: 'mask',
    updatedAt: 'mask'
  },
  Sessions: { sid: 'mask', expires_at: 'show', data: 'mask' },
  PasswordResets: { token_hash: 'mask', user_id: 'show', expires_at: 'show', created_at: 'show' },
  BugReports: {
    id: 'show',
    user_id: 'show',
    login: 'show',
    area: 'show',
    message: 'show',
    page: 'show',
    // A browser and its version, as precise as a fingerprint needs.
    user_agent: 'mask',
    game_code: 'show',
    status: 'show',
    created_at: 'show'
  },

  GameSessions: {
    code: 'show',
    playlist_id: 'show',
    host_user_id: 'show',
    host_token: 'mask',
    phase: 'show',
    config: 'scrub',
    state: 'scrub',
    created_at: 'show',
    last_activity_at: 'show'
  },
  ZombieSessions: {
    code: 'show',
    host_user_id: 'show',
    phase: 'show',
    state: 'scrub',
    created_at: 'show',
    last_activity_at: 'show'
  },
  MafiaSessions: {
    code: 'show',
    host_user_id: 'show',
    phase: 'show',
    state: 'scrub',
    created_at: 'show',
    last_activity_at: 'show'
  },
  GameResults: {
    id: 'show',
    code: 'show',
    playlist_id: 'show',
    playlist_name: 'show',
    host_user_id: 'show',
    finished_at: 'show',
    rounds_total: 'show',
    players: 'scrub',
    awards: 'scrub',
    created_at: 'show'
  },
  QuizCareers: { name: 'show', stats: 'scrub', updated_at: 'show' },
  CzCareers: { name: 'show', stats: 'scrub', updated_at: 'show' },
  MafiaCareers: { name: 'show', stats: 'scrub', updated_at: 'show' },
  Cosmetics: { user_id: 'show', game: 'show', owned: 'scrub', worn: 'scrub', updated_at: 'show' },
  MafiaTemplates: { user_id: 'show', name: 'show', slots: 'scrub', updated_at: 'show' },

  Media: {
    id: 'show',
    user_id: 'show',
    kind: 'show',
    title: 'show',
    category: 'show',
    date: 'show',
    answers: 'scrub',
    payload: 'scrub',
    timing: 'scrub',
    created_at: 'show',
    last_modified: 'show'
  },
  Playlists: {
    id: 'show',
    user_id: 'show',
    name: 'show',
    created_at: 'show',
    last_modified: 'show',
    type: 'show',
    public: 'show',
    ...LEGACY_DATES
  },
  PlaylistItems: { playlist_id: 'show', media_id: 'show', order_num: 'show' },
  MediaPlays: { key: 'show', plays: 'show', recent: 'show', last_played_at: 'show' },

  BlindtestArtistGenres: { artist: 'show', genre_id: 'show', created_at: 'show' },
  BlindtestCalibration: {
    genre_id: 'show',
    signal: 'show',
    mean: 'show',
    sd: 'show',
    top: 'show',
    samples: 'show',
    fitted_at: 'show'
  },
  BlindtestDuplicateDismissals: { media_a: 'show', media_b: 'show', created_at: 'show' },
  BlindtestDuplicateIndex: { media_id: 'show', code: 'show', artist: 'show', title: 'show' },
  BlindtestDuplicatePairs: { media_a: 'show', media_b: 'show', reason: 'show' },
  BlindtestFame: { key: 'show', facts: 'scrub', expires_at: 'show' },
  BlindtestGenreDismissals: { media_id: 'show', category: 'show', created_at: 'show' },
  BlindtestRequests: {
    id: 'show',
    genre_id: 'show',
    name: 'show',
    found_as: 'show',
    user_id: 'show',
    created_at: 'show'
  },
  BlindtestSearchLedger: { day: 'show', searches: 'show', units: 'show' },
  BlindtestSeedHarvests: { genre_id: 'show', harvested_at: 'show', seeds: 'show', error: 'show' },
  BlindtestSeeds: {
    id: 'show',
    genre_id: 'show',
    source: 'show',
    source_key: 'show',
    artist: 'show',
    title: 'show',
    search: 'show',
    aliases: 'scrub',
    year: 'show',
    fame: 'show',
    searched_at: 'show',
    found: 'show',
    tried_at: 'show',
    tries: 'show',
    videos: 'scrub',
    videos_from: 'show',
    created_at: 'show',
    duration: 'show'
  },

  // What the app was before the media table, kept as the migration left it.
  Videos: {
    id: 'show',
    user_id: 'show',
    title: 'show',
    artist: 'show',
    code: 'show',
    startGuess: 'show',
    endGuess: 'show',
    startReveal: 'show',
    endReveal: 'show',
    created_at: 'show',
    last_modified: 'show',
    type: 'show',
    date: 'show',
    ...LEGACY_DATES
  },
  Images: {
    id: 'show',
    user_id: 'show',
    name: 'show',
    description: 'show',
    type: 'show',
    date: 'show',
    ...LEGACY_DATES
  },
  ContentPlaylists: {
    content_type: 'show',
    content_id: 'show',
    playlist_id: 'show',
    user_id: 'show',
    order_num: 'show'
  },
  MetaData: { content_id: 'show', key: 'show', value: 'scrub', type: 'show', ...LEGACY_DATES },
  GameSets: { id: 'show', name: 'show', options: 'scrub', password: 'mask', ...LEGACY_DATES }
};

export function treatmentOf(table: string, column: string): Treatment {
  return COLUMNS[table]?.[column] ?? 'mask';
}

/**
 * The keys masked inside a scrubbed JSON value, wherever they sit in it.
 *
 * By the end of the key, so `hostToken`, `gmToken` and `playerToken` are all
 * caught, while `tokens` (the shop's currency) and `maxTokens` (a model's
 * budget) are not. A key that merely says a password exists, `needsPassword`,
 * is masked as well: hiding a boolean costs nothing.
 */
const SECRET_KEY = /(token|password|secret|e-?mail|cookie)$|^(sid|ip|ip_?address|user_?agent)$/i;

/** What a masked value is replaced with, inside JSON as on screen. */
export const MASK = '•••';

function scrubbed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubbed);
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = SECRET_KEY.test(key) && entry !== null ? MASK : scrubbed(entry);
  }
  return copy;
}

/**
 * One cell, ready to send.
 *
 * Masked is a value of its own rather than a string, so the screen can draw it
 * as masked and nobody mistakes it for data. An empty cell stays `null` even
 * where its column is masked: that a player gave no e-mail address is not the
 * address.
 */
export type Cell = null | number | string | { masked: true } | { preview: string; length: number } | { blob: number };

/** How long a text cell may be in a page of rows before only its start is sent. */
const PREVIEW_LENGTH = 160;

function cellOf(value: unknown, treatment: Treatment, whole: boolean): Cell {
  if (value === null || value === undefined) return null;
  if (treatment === 'mask') return { masked: true };
  if (Buffer.isBuffer(value)) return { blob: value.length };
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') return value as number;

  let text = value;
  if (treatment === 'scrub') {
    try {
      text = JSON.stringify(scrubbed(JSON.parse(value)));
    } catch {
      // Not JSON after all, so nothing in it is keyed; shown as the text it is.
    }
  }
  return whole || text.length <= PREVIEW_LENGTH
    ? text
    : { preview: text.slice(0, PREVIEW_LENGTH), length: text.length };
}

export interface ColumnView {
  name: string;
  type: string;
  masked: boolean;
}

export interface TableView {
  name: string;
  rows: number;
  columns: ColumnView[];
}

export interface RowView {
  rowid: number;
  cells: Cell[];
}

/** A page of a table. */
export interface PageView {
  table: string;
  columns: ColumnView[];
  total: number;
  page: number;
  pageSize: number;
  rows: RowView[];
}

export const PAGE_SIZE = 50;

export class ExplorerError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

/** A read-only connection to a database file. SQLite refuses every write on it. */
export function openReader(file: string): Database.Database {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** Quoted for SQL, once checked against the tables and columns that exist. */
function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function createExplorer(file: string) {
  let connection: Database.Database | undefined;
  const reader = () => (connection ??= openReader(file));

  function tableNames(): string[] {
    return (
      reader()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
  }

  function columnsOf(table: string): ColumnView[] {
    return (
      reader()
        .prepare(`PRAGMA table_info(${quoted(table)})`)
        .all() as { name: string; type: string }[]
    ).map((column) => ({ name: column.name, type: column.type, masked: treatmentOf(table, column.name) === 'mask' }));
  }

  /** The table, as it exists. Anything else is a 404, before a name reaches SQL. */
  function known(table: string): string {
    if (!tableNames().includes(table)) throw new ExplorerError(404, 'Table inconnue');
    return table;
  }

  function rowOf(table: string, columns: ColumnView[], record: Record<string, unknown>, whole: boolean): RowView {
    return {
      rowid: Number(record.__rowid),
      cells: columns.map((column) => cellOf(record[column.name], treatmentOf(table, column.name), whole))
    };
  }

  return {
    tables(): TableView[] {
      return tableNames().map((name) => ({
        name,
        rows: (
          reader()
            .prepare(`SELECT COUNT(*) AS count FROM ${quoted(name)}`)
            .get() as { count: number }
        ).count,
        columns: columnsOf(name)
      }));
    },

    /**
     * One page of a table, in rowid order or sorted by a column.
     *
     * Never by a masked one: ordered by e-mail, a page would still say whose
     * address comes before whose.
     */
    page(table: string, options: { page: number; sort?: string; direction: 'asc' | 'desc' }): PageView {
      const name = known(table);
      const columns = columnsOf(name);
      if (options.sort !== undefined) {
        const column = columns.find((candidate) => candidate.name === options.sort);
        if (!column) throw new ExplorerError(400, 'Colonne inconnue');
        if (column.masked) throw new ExplorerError(400, 'Une colonne masquée ne se trie pas');
      }

      const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
      const order = options.sort === undefined ? `rowid ${direction}` : `${quoted(options.sort)} ${direction}, rowid`;
      const total = (
        reader()
          .prepare(`SELECT COUNT(*) AS count FROM ${quoted(name)}`)
          .get() as { count: number }
      ).count;
      const records = reader()
        .prepare(`SELECT rowid AS __rowid, * FROM ${quoted(name)} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(PAGE_SIZE, options.page * PAGE_SIZE) as Record<string, unknown>[];

      return {
        table: name,
        columns,
        total,
        page: options.page,
        pageSize: PAGE_SIZE,
        rows: records.map((record) => rowOf(name, columns, record, false))
      };
    },

    /** One row in full: nothing shortened, everything masked as on the page. */
    row(table: string, rowid: number): { table: string; columns: ColumnView[]; row: RowView } {
      const name = known(table);
      const columns = columnsOf(name);
      const record = reader()
        .prepare(`SELECT rowid AS __rowid, * FROM ${quoted(name)} WHERE rowid = ?`)
        .get(rowid) as Record<string, unknown> | undefined;
      if (!record) throw new ExplorerError(404, 'Ligne introuvable');
      return { table: name, columns, row: rowOf(name, columns, record, true) };
    },

    close(): void {
      connection?.close();
      connection = undefined;
    }
  };
}

export type Explorer = ReturnType<typeof createExplorer>;

/** The app's own database, opened the first time a super-admin looks. */
export const explorer = createExplorer(databaseFile);
