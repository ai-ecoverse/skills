const assert = require('node:assert/strict');
const test = require('node:test');
const { assignField } = require('../scripts/assign-field.js');

function build(pairs) {
  const body = {};
  for (const [key, value] of pairs) assignField(body, key, value);
  return body;
}

test('assigns plain keys verbatim so existing callers are unaffected', () => {
  assert.deepEqual(build([['title', 'hello'], ['draft', 'true']]), {
    title: 'hello',
    draft: 'true',
  });
});

test('builds the mode-120000 symlink tree from references/gotchas.md', () => {
  const body = build([
    ['tree[0][path]', 'tiles/basic/skills/myskill'],
    ['tree[0][mode]', '120000'],
    ['tree[0][type]', 'blob'],
    ['tree[0][sha]', 'deadbeef'],
    ['base_tree', 'basesha'],
  ]);

  assert.deepEqual(body, {
    tree: [{
      path: 'tiles/basic/skills/myskill',
      mode: '120000',
      type: 'blob',
      sha: 'deadbeef',
    }],
    base_tree: 'basesha',
  });
  assert.ok(Array.isArray(body.tree), 'numeric index must create an array, not an object');
});

test('empty brackets append in argument order', () => {
  assert.deepEqual(build([['parents[]', 'a'], ['parents[]', 'b'], ['parents[]', 'c']]), {
    parents: ['a', 'b', 'c'],
  });
});

test('supports multiple indices and nested objects', () => {
  assert.deepEqual(build([
    ['tree[0][path]', 'first'],
    ['tree[1][path]', 'second'],
    ['commit[author][name]', 'Lars'],
  ]), {
    tree: [{ path: 'first' }, { path: 'second' }],
    commit: { author: { name: 'Lars' } },
  });
});

test('nests arrays inside array elements', () => {
  assert.deepEqual(build([['a[0][b][]', 'x'], ['a[0][b][]', 'y']]), {
    a: [{ b: ['x', 'y'] }],
  });
});

test('overwrites a scalar that is in the way of a container', () => {
  assert.deepEqual(build([['a', 'scalar'], ['a[b]', 'nested']]), { a: { b: 'nested' } });
});

test('keeps unbalanced or interior brackets as literal keys', () => {
  for (const key of ['tree[0', 'tree0]', 'tree[0][path', 'a[b]c']) {
    const body = build([[key, 'v']]);
    assert.deepEqual(body, { [key]: 'v' }, `${key} should stay literal`);
  }
});

test('preserves values containing an equals sign or brackets', () => {
  assert.deepEqual(build([['q[filter]', 'a=b[c]']]), { q: { filter: 'a=b[c]' } });
});

test('returns the body so callers may chain', () => {
  const body = {};
  assert.equal(assignField(body, 'parents[]', 'sha'), body);
});
