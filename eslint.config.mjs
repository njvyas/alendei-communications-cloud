// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.d.ts',
      'packages/db/migrations/**',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // `any` is banned outright for Phase 1; use `unknown` + narrowing.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // TS `@ts-ignore` suppressions are not permitted; `@ts-expect-error` requires a reason.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // NestJS relies on `emitDecoratorMetadata`: a constructor parameter's type
  // must survive to runtime for dependency injection to resolve it. Rewriting
  // such an import to `import type` erases that metadata and breaks DI at
  // runtime with no compile-time signal, so the rule is off for the API.
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },

  // Frontend runs in the browser.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Command-line entry points and test files report to the terminal directly;
  // they are not part of the request path that must log structurally.
  {
    files: [
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/test/**/*.ts',
      'scripts/**',
      '**/src/cli/**',
      '*.config.{ts,mjs,js}',
      '**/*.config.{ts,mjs,js}',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
);
