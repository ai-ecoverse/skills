// P4 — flag `process.argv.slice(N)` where N !== 2.
// A `.jsh` script's argv is always `[node, scriptPath, ...userArgs]`,
// so the only correct slice index for "the user's args" is 2.
// Historically caused two bugs in monday.jsh (.slice(1) made the script
// invoke itself as a subcommand and die with exit 127).

'use strict';

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require `process.argv.slice(2)` in jsh entry scripts',
      recommended: true,
    },
    schema: [],
    messages: {
      wrongIndex:
        'process.argv.slice({{value}}) is almost certainly wrong; .jsh argv is [node, scriptPath, ...args] so use .slice(2).',
      nonLiteral:
        'process.argv.slice() should be called with the literal 2; got a non-literal argument.',
      missingArg: 'process.argv.slice() called with no argument; use .slice(2).',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        // Match `process.argv.slice(...)`
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        if (callee.computed) return;
        if (!callee.property || callee.property.name !== 'slice') return;

        const argvMember = callee.object;
        if (!argvMember || argvMember.type !== 'MemberExpression') return;
        if (argvMember.computed) return;
        if (!argvMember.property || argvMember.property.name !== 'argv') return;

        const procRef = argvMember.object;
        if (!procRef || procRef.type !== 'Identifier' || procRef.name !== 'process') return;

        const arg = node.arguments[0];
        if (!arg) {
          context.report({ node, messageId: 'missingArg' });
          return;
        }
        if (arg.type !== 'Literal' || typeof arg.value !== 'number') {
          context.report({ node: arg, messageId: 'nonLiteral' });
          return;
        }
        if (arg.value !== 2) {
          context.report({
            node: arg,
            messageId: 'wrongIndex',
            data: { value: String(arg.value) },
          });
        }
      },
    };
  },
};
