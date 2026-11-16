'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: { ...globals.browser, ORION: 'writable' },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: ['src/core.js'], rules: { 'no-redeclare': ['error', { builtinGlobals: false }] } },
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  // e2e callbacks passed to page.evaluate() run inside the browser page.
  { files: ['tests/e2e/**/*.js', 'tests/system/**/*.js'], languageOptions: { globals: { ...globals.browser, ORION: 'readonly' } } },
];
