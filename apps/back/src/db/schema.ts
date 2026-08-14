import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * These tables were originally created by Sequelize `sync()`, which pluralises
 * model names and adds its own `createdAt` / `updatedAt` columns alongside the
 * hand-declared `created_at` / `last_modified` ones. Every identifier below is
 * spelled out explicitly so an existing production database keeps working
 * without a rename migration. Do not "tidy" these names.
 *
 * Datetime columns are TEXT because that is how Sequelize stored dates on
 * SQLite. New rows are written as ISO-8601 strings.
 */

const now = sql`CURRENT_TIMESTAMP`;

/** Columns Sequelize adds to every model that does not opt out of timestamps. */
const sequelizeTimestamps = {
  createdAt: text('createdAt')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updatedAt')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
};

export const users = sqliteTable('Users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  role: text('role'),
  login: text('login'),
  email: text('email'),
  password: text('password'),
  created_at: text('created_at').default(now),
  last_modified: text('last_modified').default(now),
  last_login: text('last_login'),
  ...sequelizeTimestamps
});

export const videos = sqliteTable(
  'Videos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: integer('user_id').references(() => users.id),
    title: text('title'),
    artist: text('artist'),
    code: text('code'),
    startGuess: integer('startGuess'),
    endGuess: integer('endGuess'),
    startReveal: integer('startReveal'),
    endReveal: integer('endReveal'),
    created_at: text('created_at').default(now),
    last_modified: text('last_modified').default(now),
    type: text('type'),
    /** Stored as `YYYY-MM-DD`, not a full timestamp. */
    date: text('date'),
    ...sequelizeTimestamps
  },
  (table) => [index('Videos_user_id_idx').on(table.user_id)]
);

export const images = sqliteTable(
  'Images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: integer('user_id').references(() => users.id),
    name: text('name'),
    description: text('description'),
    type: text('type'),
    /** Stored as `YYYY-MM-DD`, not a full timestamp. */
    date: text('date'),
    ...sequelizeTimestamps
  },
  (table) => [index('Images_user_id_idx').on(table.user_id)]
);

export const playlists = sqliteTable(
  'Playlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: integer('user_id').references(() => users.id),
    name: text('name'),
    created_at: text('created_at').default(now),
    last_modified: text('last_modified').default(now),
    type: text('type'),
    public: integer('public', { mode: 'boolean' }),
    ...sequelizeTimestamps
  },
  (table) => [index('Playlists_user_id_idx').on(table.user_id)]
);

/**
 * Polymorphic join table: `content_id` points at `Videos.id` when
 * `content_type = 'video'` and at `Images.id` when `content_type = 'image'`,
 * so it cannot carry a real foreign key. Declared with `timestamps: false`
 * in the Sequelize model, hence no createdAt/updatedAt here.
 */
export const contentPlaylists = sqliteTable(
  'ContentPlaylists',
  {
    content_type: text('content_type').notNull(),
    content_id: integer('content_id').notNull(),
    playlist_id: integer('playlist_id').notNull(),
    user_id: integer('user_id').references(() => users.id),
    order_num: integer('order_num')
  },
  (table) => [
    primaryKey({ columns: [table.content_type, table.content_id, table.playlist_id] }),
    index('ContentPlaylists_playlist_id_idx').on(table.playlist_id)
  ]
);

export const metaData = sqliteTable(
  'MetaData',
  {
    content_id: integer('content_id').notNull(),
    key: text('key').notNull(),
    value: text('value'),
    type: text('type'),
    ...sequelizeTimestamps
  },
  (table) => [primaryKey({ columns: [table.content_id, table.key] })]
);

export const gameSets = sqliteTable('GameSets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name'),
  options: text('options'),
  password: text('password'),
  ...sequelizeTimestamps
});

/**
 * New table. The old stack declared `express-session-sqlite` but never wired a
 * store, so sessions actually lived in memory and every restart logged
 * everyone out. This backs the Fastify session store instead.
 */
export const sessions = sqliteTable('Sessions', {
  sid: text('sid').primaryKey(),
  /** Unix epoch milliseconds. */
  expiresAt: integer('expires_at').notNull(),
  data: text('data').notNull()
});

/* ------------------------------------------------------------------------- *
 * The media model
 *
 * One table for every kind of thing a game can present. `kind` names the
 * variant and `payload` holds whatever that variant needs, as JSON validated
 * against the kind's Zod schema in game-core.
 *
 * The alternative was a table per kind, which is what the old Videos/Images
 * split was. Every new kind then costs a migration, a form and a branch in each
 * read query, and the join table has to stay polymorphic to point at any of
 * them. Here a new kind costs one file in game-core.
 * ------------------------------------------------------------------------- */

export const media = sqliteTable(
  'Media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: integer('user_id').references(() => users.id),
    /** Registered id from game-core's kind registry, e.g. 'blindtest'. */
    kind: text('kind').notNull(),
    /** Librarian-facing name. Never shown to players: it usually gives it away. */
    title: text('title').notNull(),
    /** Free-form grouping the host chooses, e.g. "années 80". */
    category: text('category'),
    /** `YYYY-MM-DD`, for chronological ordering. */
    date: text('date'),
    /** JSON array of AnswerField: the scorable answers. */
    answers: text('answers').notNull(),
    /** JSON object, shape decided by `kind`. */
    payload: text('payload').notNull(),
    /** JSON KindTiming overriding the kind's defaults, or null to use them. */
    timing: text('timing'),
    created_at: text('created_at').default(now),
    last_modified: text('last_modified').default(now)
  },
  (table) => [
    index('Media_user_id_idx').on(table.user_id),
    index('Media_kind_idx').on(table.kind),
    index('Media_category_idx').on(table.category)
  ]
);

/**
 * Playlist contents.
 *
 * Replaces `ContentPlaylists`, whose `content_id` pointed at either Videos or
 * Images depending on a sibling column, so it could carry no foreign key and
 * every read needed two joins and a merge. One media table means one real
 * foreign key, and `ON DELETE CASCADE` means deleting an item cannot leave a
 * playlist pointing at nothing.
 */
export const playlistItems = sqliteTable(
  'PlaylistItems',
  {
    playlist_id: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    media_id: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    order_num: integer('order_num').notNull().default(0)
  },
  (table) => [
    primaryKey({ columns: [table.playlist_id, table.media_id] }),
    index('PlaylistItems_playlist_id_idx').on(table.playlist_id)
  ]
);

/**
 * A game in progress, persisted so a server restart mid-party is survivable.
 *
 * The old implementation held sessions in a plain object in `server.js`, so a
 * deploy or a crash ended the game and lost every score. `state` is the engine's
 * snapshot, rewritten on each phase change.
 */
export const gameSessions = sqliteTable(
  'GameSessions',
  {
    /** Five characters, typed in by players. Also the primary key. */
    code: text('code').primaryKey(),
    playlist_id: integer('playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    host_user_id: integer('host_user_id').references(() => users.id),
    /** Secret proving whoever holds it is the host. */
    host_token: text('host_token').notNull(),
    phase: text('phase').notNull(),
    /** JSON SessionConfig. */
    config: text('config').notNull(),
    /** JSON engine state: rounds, players, submissions, scores. */
    state: text('state').notNull(),
    created_at: text('created_at').default(now),
    last_activity_at: integer('last_activity_at').notNull()
  },
  (table) => [index('GameSessions_last_activity_idx').on(table.last_activity_at)]
);

/**
 * A finished game, kept.
 *
 * `GameSessions` rows are working state and are deleted when a game ends or goes
 * idle, which meant no game left any trace: no history, no stats, no "who won last
 * week". One row is written here at the moment a session reaches `finished`, with
 * the standings and tallies denormalised as JSON — the session state they come from
 * is about to be deleted, so there is nothing to join against later.
 */
export const gameResults = sqliteTable(
  'GameResults',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The join code the game ran under. Codes recycle, so not unique here. */
    code: text('code').notNull(),
    playlist_id: integer('playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    playlist_name: text('playlist_name').notNull(),
    host_user_id: integer('host_user_id').references(() => users.id),
    /** Unix epoch milliseconds. */
    finished_at: integer('finished_at').notNull(),
    rounds_total: integer('rounds_total').notNull(),
    /** JSON: final standings plus per-player tallies. */
    players: text('players').notNull(),
    /** JSON: the FinalAward list handed out at the ceremony. */
    awards: text('awards').notNull().default('[]'),
    created_at: text('created_at').default(now)
  },
  (table) => [index('GameResults_finished_at_idx').on(table.finished_at)]
);

/**
 * A CoronaZ raid in progress. Same contract as `GameSessions`: the engine state
 * is one JSON snapshot rewritten on each phase change, so a restart resumes the
 * raid. Kept as its own table because the two engines share nothing but the idea.
 */
export const zombieSessions = sqliteTable(
  'ZombieSessions',
  {
    code: text('code').primaryKey(),
    host_user_id: integer('host_user_id').references(() => users.id),
    phase: text('phase').notNull(),
    /** JSON CzState. */
    state: text('state').notNull(),
    created_at: text('created_at').default(now),
    last_activity_at: integer('last_activity_at').notNull()
  },
  (table) => [index('ZombieSessions_last_activity_idx').on(table.last_activity_at)]
);

/**
 * The roguelite substrate: one row per nickname (game masters under their
 * login), lifetime CoronaZ tallies as JSON. Trophies and perks are *derived*
 * from these numbers on read, never stored — a rebalanced threshold applies
 * retroactively for free.
 */
export const czCareers = sqliteTable('CzCareers', {
  name: text('name').primaryKey(),
  /** JSON CzCareerStats. */
  stats: text('stats').notNull(),
  updated_at: text('updated_at').default(now)
});

export type MediaRow = typeof media.$inferSelect;
export type GameResultRow = typeof gameResults.$inferSelect;
export type NewMediaRow = typeof media.$inferInsert;
export type PlaylistItemRow = typeof playlistItems.$inferSelect;
export type GameSessionRow = typeof gameSessions.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;
export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
export type Playlist = typeof playlists.$inferSelect;
export type NewPlaylist = typeof playlists.$inferInsert;
export type ContentPlaylist = typeof contentPlaylists.$inferSelect;
export type NewContentPlaylist = typeof contentPlaylists.$inferInsert;
