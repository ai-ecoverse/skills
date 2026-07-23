// Vitest config for the skills repo.
// Single project: runs the ESLint plugin's RuleTester tests under Node.
// Browser project (for SLICC dogfooding) will be added in a later slice.

'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    include: ['tools/**/*.test.js'],
    globals: true,
    environment: 'node',
  },
});
