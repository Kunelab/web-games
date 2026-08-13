import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Flat config, replacing the .eslintrc.cjs + eslint-rules/ split. Most of what
 * those files hand-configured (undefined variables, unused variables, shadowing,
 * import correctness) is now either a TypeScript compile error or covered by
 * typescript-eslint's type-checked preset, so the config is a fraction of the
 * size and actually catches more.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'drizzle/**', 'node_modules/**', '*.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Fastify handlers legitimately return the reply object.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Fastify's plugin contract (FastifyPluginAsync) requires an async
      // function whether or not the body awaits anything, and the service
      // methods stay async for a uniform call signature even where the
      // underlying better-sqlite3 transaction is synchronous.
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }]
    }
  },
  {
    // These run outside the request lifecycle and are allowed to log freely.
    files: ['src/db/migrate.ts', 'src/env.ts', 'src/smoke.ts', 'src/smoke-run.ts', 'drizzle.config.ts'],
    rules: { 'no-console': 'off' }
  },
  {
    files: ['eslint.config.js', 'drizzle.config.ts'],
    ...tseslint.configs.disableTypeChecked
  },
  prettier
);
