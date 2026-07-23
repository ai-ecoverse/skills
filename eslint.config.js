// Flat ESLint config for the skills repo.
// Lints both .js (tooling) and .jsh (skill scripts) files.

'use strict';

const js = require('@eslint/js');
const jshSkills = require('eslint-plugin-jsh-skills');

module.exports = [
  {
    ignores: ['node_modules/**', '**/node_modules/**'],
  },
  // .jsh scripts — apply the recommended jsh-skills rule set.
  {
    files: ['skills/**/*.jsh'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // jsh runtime exposes Node-like globals via the realm.
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // jsh-realm-injected helpers
        fs: 'readonly',
        exec: 'readonly',
        require: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        crypto: 'readonly',
      },
    },
    plugins: { 'jsh-skills': jshSkills },
    rules: {
      ...jshSkills.configs.recommended.rules,
      // Historical .jsh scripts interpolate unvalidated values into exec().
      // Keep this at "warn" until those call sites are wrapped (JSON.stringify /
      // encodeURIComponent / a validate*|sanitize* helper); then promote to
      // "error" so new violations fail CI.
      'jsh-skills/no-unsafe-exec': 'warn',
    },
  },
  // Tooling (.js) — base recommended only, no jsh-skills rules.
  {
    files: ['tools/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: js.configs.recommended.rules,
  },
];
