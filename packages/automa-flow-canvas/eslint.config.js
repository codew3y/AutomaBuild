/**
 * Lint, for the one rule that pays for the whole setup.
 *
 * `react-hooks/exhaustive-deps` is why this file exists. A callback that
 * closes over a render value and does not declare it is frozen at whatever
 * that value was on the render it was created — and `tsc` cannot see the
 * problem, because the code is perfectly well typed. It shipped a `publish`
 * that posted every flow's graph to the default flow's endpoint and returned
 * 201, for a whole session, silently.
 *
 * Everything else here is deliberately quiet. A lint run that reports a
 * hundred stylistic opinions is a lint run nobody reads, and the correctness
 * rules then go unnoticed with them.
 */

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two this is for.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // Unused code is worth failing on, but an argument named with a leading
      // underscore is a deliberate "this exists to satisfy a signature".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Off, with reasons rather than by default:
      //
      // The codebase runs TypeScript directly on Node's type stripping, so
      // `any` in a few boundary casts is load-bearing rather than lazy, and
      // the compiler already refuses the ones that matter.
      '@typescript-eslint/no-explicit-any': 'off',
      // `!` is used where a preceding check has already proven the value, and
      // the alternative is a second check that can never fail.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // Tests reach into shapes on purpose to prove something about them.
    files: ['test/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  {
    // Build scripts are Node programs, not browser code.
    files: ['scripts/**/*.{js,mjs}', '*.config.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
)
