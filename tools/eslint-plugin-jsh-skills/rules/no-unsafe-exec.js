// P1 — flag `exec(`backtick…${x}…`)` where `x` is not provably safe.
//
// Real bugs this prevents (all from git history):
//   - swarm.jsh    exec(`playwright-cli eval --tab=${tabId} "${expr.replace(...)}"`)
//   - linkedin/servicenow/slack    similar tab/eval wrappers
//   - shell injection via un-validated user IDs interpolated into args
//
// "Safe" interpolation: a literal, an empty-interpolation template,
// or a call to JSON.stringify / encodeURIComponent / validate*/sanitize*.
// Anything else (Identifier, MemberExpression, arbitrary call, binary expr)
// is reported. String-concat forms (`'cmd ' + x`) are intentionally out of
// scope — covered (if needed) by a future, separate rule.

'use strict';

const EXEC_CALLEES = new Set(['exec', 'execSync', 'spawn', 'spawnSync']);
const SAFE_CALLEE_NAMES = new Set(['JSON.stringify', 'encodeURIComponent']);
const SAFE_CALLEE_PREFIXES = ['validate', 'sanitize', 'escape'];

function calleeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    return calleeName(node.object) + '.' + (node.property.name || '');
  }
  return '';
}

function isSafeCallee(callee) {
  const name = calleeName(callee);
  if (!name) return false;
  if (SAFE_CALLEE_NAMES.has(name)) return true;
  // Match the leaf name (after the last '.') for namespaced helpers.
  const leaf = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return SAFE_CALLEE_PREFIXES.some((p) => leaf.startsWith(p));
}

function isSafeExpression(expr) {
  if (!expr) return true;
  if (expr.type === 'Literal') return true;
  if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) return true;
  if (expr.type === 'CallExpression') return isSafeCallee(expr.callee);
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow unvalidated interpolation into exec()/spawn() shell commands',
      recommended: true,
    },
    schema: [],
    messages: {
      unsafeInterpolation:
        'Unsafe interpolation in {{callee}}() — `${{{snippet}}}` is not validated. Wrap with JSON.stringify(), encodeURIComponent(), or a validate*/sanitize* helper.',
    },
  },

  create(context) {
    const src = context.sourceCode || context.getSourceCode();

    return {
      CallExpression(node) {
        // Callee must be a bare identifier from EXEC_CALLEES.
        if (!node.callee || node.callee.type !== 'Identifier') return;
        if (!EXEC_CALLEES.has(node.callee.name)) return;

        const arg = node.arguments[0];
        if (!arg || arg.type !== 'TemplateLiteral') return;
        if (arg.expressions.length === 0) return; // No interpolation.

        for (const expr of arg.expressions) {
          if (isSafeExpression(expr)) continue;
          const snippet = src.getText(expr).slice(0, 60);
          context.report({
            node: expr,
            messageId: 'unsafeInterpolation',
            data: { callee: node.callee.name, snippet },
          });
        }
      },
    };
  },
};
