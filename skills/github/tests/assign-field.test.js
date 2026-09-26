import test, { is, ok } from 'tst';
import * as _mod_0 from '../scripts/assign-field.js';

const { assignField } = _mod_0.default || _mod_0;
function build(pairs) {
  const body = {};
  for (const [key, value] of pairs) assignField(body, key, value);
  return body;
}

test('assigns plain keys verbatim so existing callers are unaffected', () => {
  is(build([['title', 'hello'], ['draft', 'true']]), {
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

  is(body, {
    tree: [{
      path: 'tiles/basic/skills/myskill',
      mode: '120000',
      type: 'blob',
      sha: 'deadbeef',
    }],
    base_tree: 'basesha',
  });
  ok(Array.isArray(body.tree), 'numeric index must create an array, not an object');
});

test('empty brackets append in argument order', () => {
  is(build([['parents[]', 'a'], ['parents[]', 'b'], ['parents[]', 'c']]), {
    parents: ['a', 'b', 'c'],
  });
});

test('supports multiple indices and nested objects', () => {
  is(build([
    ['tree[0][path]', 'first'],
    ['tree[1][path]', 'second'],
    ['commit[author][name]', 'Lars'],
  ]), {
    tree: [{ path: 'first' }, { path: 'second' }],
    commit: { author: { name: 'Lars' } },
  });
});

test('nests arrays inside array elements', () => {
  is(build([['a[0][b][]', 'x'], ['a[0][b][]', 'y']]), {
    a: [{ b: ['x', 'y'] }],
  });
});

test('overwrites a scalar that is in the way of a container', () => {
  is(build([['a', 'scalar'], ['a[b]', 'nested']]), { a: { b: 'nested' } });
});

test('keeps unbalanced or interior brackets as literal keys', () => {
  for (const key of ['tree[0', 'tree0]', 'tree[0][path', 'a[b]c']) {
    const body = build([[key, 'v']]);
    is(body, { [key]: 'v' }, `${key} should stay literal`);
  }
});

test('preserves values containing an equals sign or brackets', () => {
  is(build([['q[filter]', 'a=b[c]']]), { q: { filter: 'a=b[c]' } });
});

test('returns the body so callers may chain', () => {
  const body = {};
  is(assignField(body, 'parents[]', 'sha'), body);
});

test('sparse indices keep array length semantics', () => {
  is(build([['parents[]', 'a'], ['parents[2]', 'c']]), {
    parents: ['a', undefined, 'c'],
  });
});

// ─── hostile keys: `-f` values come straight off the command line ────────────

test('does not pollute Object.prototype through __proto__', () => {
  const body = build([['__proto__[polluted]', 'yes']]);

  is({}.polluted, undefined, 'Object.prototype must be untouched');
  is(Object.prototype.polluted, undefined);
  // The key survives as ordinary data rather than being silently dropped.
  ok(Object.prototype.hasOwnProperty.call(body, '__proto__'));
  is(JSON.stringify(body), '{"__proto__":{"polluted":"yes"}}');
});

test('does not reach Object.prototype through constructor or prototype', () => {
  build([['constructor[prototype][x]', 'boom'], ['prototype[y]', 'boom']]);

  is({}.x, undefined);
  is({}.y, undefined);
});

test('treats a plain __proto__ key as data', () => {
  const body = build([['__proto__', 'plain']]);

  is({}.polluted, undefined);
  is(JSON.stringify(body), '{"__proto__":"plain"}');
});

// ─── container conflicts: never lose a value the user supplied ────────────────

test('reshapes an array to an object rather than dropping a non-index key', () => {
  // JSON.stringify omits non-index array properties, so keeping the array would
  // make `k` vanish from the request body without any warning.
  const body = build([['parents[]', 'x'], ['parents[k]', 'y']]);

  is(body, { parents: { 0: 'x', k: 'y' } });
  is(JSON.stringify(body), '{"parents":{"0":"x","k":"y"}}');
});

test('keeps an existing object when an index key arrives later', () => {
  const body = build([['a[b][c]', '1'], ['a[0][c]', '2']]);

  is(body, { a: { b: { c: '1' }, 0: { c: '2' } } });
});

test('appends past the highest integer key of a stand-in object', () => {
  const body = build([['a[b]', '1'], ['a[]', '2'], ['a[]', '3']]);

  is(body, { a: { b: '1', 0: '2', 1: '3' } });
});
