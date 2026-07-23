// RuleTester for P4 — argv-slice.
// Runs under vitest. Vitest's `describe`/`it` are global, and ESLint's
// RuleTester binds onto whatever `describe`/`it` it finds on the global,
// so no extra wiring is needed.

'use strict';

const { RuleTester } = require('eslint');
const rule = require('../rules/argv-slice.js');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('argv-slice', rule, {
  valid: [
    { code: 'const args = process.argv.slice(2);' },
    { code: 'process.argv.slice(2);' },
    // Unrelated `.slice()` calls must not be flagged.
    { code: 'const xs = [1, 2, 3].slice(1);' },
    { code: 'const xs = foo.argv.slice(1);' }, // different object
    { code: "const xs = process.env.slice(1);" }, // different property
    { code: 'const xs = "abc".slice(1);' },
  ],
  invalid: [
    {
      code: 'const args = process.argv.slice(1);',
      errors: [{ messageId: 'wrongIndex', data: { value: '1' } }],
    },
    {
      code: 'const args = process.argv.slice(0);',
      errors: [{ messageId: 'wrongIndex', data: { value: '0' } }],
    },
    {
      code: 'const args = process.argv.slice(3);',
      errors: [{ messageId: 'wrongIndex', data: { value: '3' } }],
    },
    {
      code: 'const args = process.argv.slice();',
      errors: [{ messageId: 'missingArg' }],
    },
    {
      code: 'const n = 1; const args = process.argv.slice(n);',
      errors: [{ messageId: 'nonLiteral' }],
    },
  ],
});
