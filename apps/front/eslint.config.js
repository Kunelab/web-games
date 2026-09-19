import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config, replacing .eslintrc.cjs plus the nine files under eslint-rules/.
 * `eslint-plugin-react` is gone: with the new JSX transform and TypeScript
 * checking props, almost everything it enforced (prop-types, undefined
 * components, unknown DOM properties) is now a compile error instead.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**', '*.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // `configs['recommended-latest']` at the top level is still the eslintrc-style
  // config in v7; the flat one lives under `configs.flat`.
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }]
    }
  },
  {
    // node:test's describe/it return promises that the runner itself awaits, so
    // the floating-promise rule fires on every single block. Same exemption as
    // the one in game-core and coronaz-core.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off'
    }
  },
  {
    files: ['eslint.config.js', 'vite.config.ts'],
    ...tseslint.configs.disableTypeChecked
  },
  {
    /**
     * The build-time scripts, which are Node and are in no tsconfig.
     *
     * `recommendedTypeChecked` is applied to everything above, and a type-aware
     * rule reaching a file no project owns does not report a lint error: it
     * throws, and takes the whole run down with it. `eslint .` on this package
     * has been exiting 2 on `scripts/art-cutout.mjs` since the script was added,
     * which is only invisible because a package earlier in `pnpm -r lint` was
     * failing first and stopping the run.
     *
     * They are plain Node modules, so they get Node globals and the untyped
     * rule set, the same trade `vite.config.ts` already takes above.
     */
    files: ['scripts/**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node
    }
  },
  prettier
);
