// RuleTester for P1 — no-unsafe-exec.

'use strict';

const { RuleTester } = require('eslint');
const rule = require('../rules/no-unsafe-exec.js');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-unsafe-exec', rule, {
  valid: [
    // Plain literal — no interpolation at all.
    { code: "exec('ls -la');" },
    { code: 'exec(`ls -la`);' },

    // Template with only safe call expressions.
    { code: 'exec(`echo ${JSON.stringify(msg)}`);' },
    { code: 'exec(`gh api /repos/${encodeURIComponent(repo)}`);' },
    { code: 'exec(`gh api /repos/${validateRepo(repo)}`);' },
    { code: 'exec(`echo ${sanitizeBranch(branch)}`);' },

    // Mixed safe forms.
    { code: 'exec(`run ${JSON.stringify(a)} ${encodeURIComponent(b)}`);' },

    // Not an exec-family callee → ignored.
    { code: 'foo(`bar ${x}`);' },
    { code: 'console.log(`bar ${x}`);' },

    // First arg isn't a template literal → out of scope for this rule.
    { code: "exec('cmd ' + x);" },
    { code: 'exec(cmd);' },

    // Empty interpolation list.
    { code: 'exec(`static ${"literal"}`);' },
  ],

  invalid: [
    // Real swarm.jsh bug before fix.
    {
      code: 'exec(`playwright-cli eval --tab=${tabId} "${expr.replace(/"/g, "")}"`);',
      errors: [
        { messageId: 'unsafeInterpolation', data: { callee: 'exec', snippet: 'tabId' } },
        {
          messageId: 'unsafeInterpolation',
          data: { callee: 'exec', snippet: 'expr.replace(/"/g, "")' },
        },
      ],
    },
    // Bare identifier.
    {
      code: 'exec(`rm -f ${tmpFile}`);',
      errors: [{ messageId: 'unsafeInterpolation' }],
    },
    // Member expression.
    {
      code: 'exec(`slicc webhook delete ${webhook.id}`);',
      errors: [{ messageId: 'unsafeInterpolation' }],
    },
    // Binary expression inside interpolation.
    {
      code: 'exec(`cmd ${a + b}`);',
      errors: [{ messageId: 'unsafeInterpolation' }],
    },
    // Mix: one safe, one unsafe → only the unsafe one is reported.
    {
      code: 'exec(`run ${JSON.stringify(a)} ${b}`);',
      errors: [{ messageId: 'unsafeInterpolation', data: { callee: 'exec', snippet: 'b' } }],
    },
    // spawn() is also covered.
    {
      code: 'spawn(`ls ${dir}`);',
      errors: [{ messageId: 'unsafeInterpolation', data: { callee: 'spawn', snippet: 'dir' } }],
    },
  ],
});
