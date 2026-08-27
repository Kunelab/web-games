import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `*.cjs` is the Prettier config, which is not part of any tsconfig and so
  // cannot be type-checked. Same exclusion as both apps.
  { ignores: ['dist/**', 'node_modules/**', '*.cjs'] },
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
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error'
    }
  },
  {
    // node:test's describe/it return promises that the runner itself awaits, so
    // the floating-promise rule fires on every single block.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off'
    }
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked
  },
  prettier
);
