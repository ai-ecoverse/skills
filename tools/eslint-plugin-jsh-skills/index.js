// eslint-plugin-jsh-skills — custom ESLint rules for `.jsh` skill scripts.
// Local plugin, consumed via npm "file:" link from the repo root.

'use strict';

const argvSlice = require('./rules/argv-slice.js');
const noUnsafeExec = require('./rules/no-unsafe-exec.js');

const plugin = {
  meta: {
    name: 'eslint-plugin-jsh-skills',
    version: '0.1.0',
  },
  rules: {
    'argv-slice': argvSlice,
    'no-unsafe-exec': noUnsafeExec,
  },
};

// Flat-config preset: enable every rule at "error".
// Apply this on top of a `files: ['**/*.jsh']` block.
plugin.configs = {
  recommended: {
    plugins: { 'jsh-skills': plugin },
    rules: {
      'jsh-skills/argv-slice': 'error',
      'jsh-skills/no-unsafe-exec': 'error',
    },
  },
};

module.exports = plugin;
