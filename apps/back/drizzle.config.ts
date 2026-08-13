import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_FILE ?? './kune.db'
  },
  // The legacy tables were created by Sequelize `sync()`, so they use its
  // pluralised PascalCase names. `casing: 'preserve'` stops drizzle-kit from
  // rewriting the identifiers declared in schema.ts.
  casing: 'preserve',
  verbose: true,
  strict: true
});
