import type { Database } from 'better-sqlite3';

/**
 * Idempotent DDL that reproduces exactly what Sequelize `sync({ force: false })`
 * used to create, so a fresh checkout gets a working database and an existing
 * production database is left completely untouched.
 *
 * For schema changes from here on, use the drizzle-kit workflow instead:
 *   npm run db:generate   # writes a migration to ./drizzle
 *   npm run db:migrate    # applies pending migrations
 */
const statements = [
  `CREATE TABLE IF NOT EXISTS "Users" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "role" TEXT,
    "login" TEXT,
    "email" TEXT,
    "password" TEXT,
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
    "last_modified" TEXT DEFAULT CURRENT_TIMESTAMP,
    "last_login" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS "Videos" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER REFERENCES "Users" ("id"),
    "title" TEXT,
    "artist" TEXT,
    "code" TEXT,
    "startGuess" INTEGER,
    "endGuess" INTEGER,
    "startReveal" INTEGER,
    "endReveal" INTEGER,
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
    "last_modified" TEXT DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT,
    "date" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS "Images" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER REFERENCES "Users" ("id"),
    "name" TEXT,
    "description" TEXT,
    "type" TEXT,
    "date" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS "Playlists" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER REFERENCES "Users" ("id"),
    "name" TEXT,
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
    "last_modified" TEXT DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT,
    "public" INTEGER,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS "ContentPlaylists" (
    "content_type" TEXT NOT NULL,
    "content_id" INTEGER NOT NULL,
    "playlist_id" INTEGER NOT NULL,
    "user_id" INTEGER REFERENCES "Users" ("id"),
    "order_num" INTEGER,
    PRIMARY KEY ("content_type", "content_id", "playlist_id")
  )`,

  `CREATE TABLE IF NOT EXISTS "MetaData" (
    "content_id" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "type" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    PRIMARY KEY ("content_id", "key")
  )`,

  `CREATE TABLE IF NOT EXISTS "GameSets" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "name" TEXT,
    "options" TEXT,
    "password" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  )`,

  // New in the Fastify stack: persistent sessions.
  `CREATE TABLE IF NOT EXISTS "Sessions" (
    "sid" TEXT PRIMARY KEY,
    "expires_at" INTEGER NOT NULL,
    "data" TEXT NOT NULL
  )`,

  // The media model. One table for every kind of presentable thing.
  `CREATE TABLE IF NOT EXISTS "Media" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER REFERENCES "Users" ("id"),
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "date" TEXT,
    "answers" TEXT NOT NULL DEFAULT '[]',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "timing" TEXT,
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
    "last_modified" TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS "PlaylistItems" (
    "playlist_id" INTEGER NOT NULL REFERENCES "Playlists" ("id") ON DELETE CASCADE,
    "media_id" INTEGER NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
    "order_num" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("playlist_id", "media_id")
  )`,

  `CREATE TABLE IF NOT EXISTS "GameSessions" (
    "code" TEXT PRIMARY KEY,
    "playlist_id" INTEGER REFERENCES "Playlists" ("id") ON DELETE SET NULL,
    "host_user_id" INTEGER REFERENCES "Users" ("id"),
    "host_token" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" INTEGER NOT NULL
  )`,

  // Finished games, kept for history and stats. Live sessions are deleted when
  // they end; this row is what remains.
  `CREATE TABLE IF NOT EXISTS "GameResults" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "playlist_id" INTEGER REFERENCES "Playlists" ("id") ON DELETE SET NULL,
    "playlist_name" TEXT NOT NULL,
    "host_user_id" INTEGER REFERENCES "Users" ("id"),
    "finished_at" INTEGER NOT NULL,
    "rounds_total" INTEGER NOT NULL,
    "players" TEXT NOT NULL,
    "awards" TEXT NOT NULL DEFAULT '[]',
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE INDEX IF NOT EXISTS "GameResults_finished_at_idx" ON "GameResults" ("finished_at")`,

  // CoronaZ raids in progress, restored on boot like quiz sessions.
  `CREATE TABLE IF NOT EXISTS "ZombieSessions" (
    "code" TEXT PRIMARY KEY,
    "host_user_id" INTEGER REFERENCES "Users" ("id"),
    "phase" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" TEXT DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS "ZombieSessions_last_activity_idx" ON "ZombieSessions" ("last_activity_at")`,

  // CoronaZ lifetime tallies per nickname: the roguelite's memory.
  `CREATE TABLE IF NOT EXISTS "CzCareers" (
    "name" TEXT PRIMARY KEY,
    "stats" TEXT NOT NULL,
    "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE INDEX IF NOT EXISTS "Media_user_id_idx" ON "Media" ("user_id")`,
  `CREATE INDEX IF NOT EXISTS "Media_kind_idx" ON "Media" ("kind")`,
  `CREATE INDEX IF NOT EXISTS "Media_category_idx" ON "Media" ("category")`,
  `CREATE INDEX IF NOT EXISTS "PlaylistItems_playlist_id_idx" ON "PlaylistItems" ("playlist_id")`,
  `CREATE INDEX IF NOT EXISTS "GameSessions_last_activity_idx" ON "GameSessions" ("last_activity_at")`,

  `CREATE INDEX IF NOT EXISTS "Videos_user_id_idx" ON "Videos" ("user_id")`,
  `CREATE INDEX IF NOT EXISTS "Images_user_id_idx" ON "Images" ("user_id")`,
  `CREATE INDEX IF NOT EXISTS "Playlists_user_id_idx" ON "Playlists" ("user_id")`,
  `CREATE INDEX IF NOT EXISTS "ContentPlaylists_playlist_id_idx" ON "ContentPlaylists" ("playlist_id")`,
  `CREATE INDEX IF NOT EXISTS "Sessions_expires_at_idx" ON "Sessions" ("expires_at")`
];

export function bootstrapSchema(sqlite: Database): void {
  for (const statement of statements) {
    sqlite.exec(statement);
  }
}
