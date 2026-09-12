import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_FILE ?? './kune.db'
  },
  /**
   * No `casing` line, which is how you ask for the names as declared.
   *
   * The legacy tables were created by Sequelize `sync()`, so they carry its
   * pluralised PascalCase names and drizzle-kit must not rewrite the
   * identifiers in schema.ts. That used to say `casing: 'preserve'`, which is
   * what drizzle-kit's own generator understands but not what its config
   * schema accepts: the zod enum takes only 'snake_case' and 'camelCase', so
   * every drizzle-kit command (generate, push, studio, check) died on a
   * ZodError before doing anything. Omitting the key is the same instruction
   * and a valid config: with it unset the generator uses `column.name`, the
   * declared identifier, which is exactly what 'preserve' meant.
   */
  verbose: true,
  strict: true
});
