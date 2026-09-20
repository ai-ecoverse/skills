# tst assertions — exact semantics

Every row below was reproduced against the bundled runner. The recipe at the end regenerates the
tables if the runner changes.

## The module surface

`import * as M from 'tst'` exposes 15 bindings: `default` (the `test` function) plus `is`, `ok`,
`same`, `not`, `any`, `almost`, `throws`, `rejects`, `fail`, `pass`, `onPass`, `Assertion`,
`formats`, `run`. There is no named `test` export.

`test` itself carries `skip`, `todo`, `only`, `demo`, `mute`, `fork` and `run`.

## `is` — deep structural equality

| Case | Result |
| --- | --- |
| `is(1, 1)` | pass |
| `is(1, '1')` | **fail** — no coercion |
| `is(NaN, NaN)` | pass |
| `is(0, -0)` | **fail** |
| `is(null, undefined)` | **fail** |
| `is(null, null)`, `is(undefined, undefined)` | pass |
| `is({a: 1}, {a: 1})` (distinct objects) | pass |
| `is({a: {b: 1}}, {a: {b: 1}})` | pass |
| `is({a: {b: 1}}, {a: {b: 2}})` | **fail** |
| `is({a: 1}, {a: 1, b: 2})` (either direction) | **fail** — no subset match |
| `is([1, 2], [1, 2])`, `is([1, [2, 3]], [1, [2, 3]])` | pass |
| `is([1, 2], [2, 1])` | **fail** — arrays are order-sensitive |
| `is([1, 2], {0: 1, 1: 2})` | **fail** |
| `is(new Set([1]), new Set([1]))` | pass |
| `is(new Map([['a', 1]]), new Map([['a', 1]]))` | pass |
| `is(new Date(0), new Date(0))` | pass; `is(new Date(0), new Date(1))` fails |
| `is(0.1 + 0.2, 0.3)` | **fail** — use `almost` |
| `is(Object.create(null), {})` | **fail** |

`is` is the assertion to reach for by default, including for objects and arrays.

## `same` — multiset of iterated members, not deep equality

`same` spreads both operands and compares the resulting member lists as a multiset:
order-insensitive, length-sensitive, and individual members are compared with `===` — not with the
deep `eq` that backs `is`. Two probes pin that down: `same([NaN], [NaN])` **fails** and
`same([0], [-0])` **passes**, which is the exact opposite of `is`.

| Case | Result | Why it matters |
| --- | --- | --- |
| `same([1, 2], [2, 1])` | pass | order-insensitive |
| `same([1, 2], [1, 3])` | fail | member mismatch |
| `same([1, 1, 2], [1, 2, 2])` | fail | multiset, not set |
| `same([1, 1], [1])` | fail | length matters |
| `same([{x: 1}], [{x: 1}])` | **fail** | members compare with `===`, not deeply |
| `same([[1]], [[1]])` | **fail** | same reason |
| `same([1, 2, 2], [2, 1, 2])` | pass | multiset, order-insensitive |
| `same([NaN], [NaN])` | **fail** | `===` |
| `same([0], [-0])` | **pass** | `===` |
| `same([o], [o])` (the same object twice) | pass | identical reference |
| `same('ab', 'ba')` | pass | strings iterate as characters |
| `same('abc', 'ab')` | fail | different member counts |
| `same(new Set([1, 2]), new Set([1, 2]))` | pass | |
| `same(new Map([['a', 1]]), new Map([['a', 1]]))` | **fail** | entries are fresh arrays |
| `same(new Float32Array([1, 2]), [1, 2])` | pass | any iterable works |
| `same({a: 1}, {a: 1})` | pass | **both iterate nothing** |
| `same({a: 1}, {a: 2})` | **pass** | vacuous — no members on either side |
| `same({a: 1}, {b: 1})` | **pass** | vacuous |
| `same({a: 1}, {a: 1, b: 2})` | **pass** | vacuous |
| `same({}, [])` | **pass** | vacuous |
| `same(1, 2)`, `same(1, true)` | **pass** | vacuous |
| `same(2, 'a')` | fail | `'a'` has one member, `2` has none |
| `same({a: 1}, [1])` | fail | zero members vs one |
| `same(null, null)`, `same(undefined, undefined)` | **TypeError** | `object null is not iterable` |

**Rule:** use `same` only for two iterables of primitives where order is genuinely irrelevant.
For anything else use `is`. A `same` on plain objects is a green light that asserts nothing.

## `almost` — absolute tolerance

Default `eps` is `1.1920929e-7` (float32 epsilon) and the comparison is **absolute**, not
relative.

| Case | Result |
| --- | --- |
| `almost(0.1 + 0.2, 0.3)` | pass |
| `almost(1, 1.0000001)` | pass |
| `almost(1, 1.001)` | fail; `almost(1, 1.001, 0.01)` passes |
| `almost(1e6, 1e6 + 0.1)` | **fail** — absolute tolerance does not scale |
| `almost(1e-9, 2e-9)` | pass |
| `almost([1, 2], [1.0000001, 2])` | pass |
| `almost([1, 2], [1.5, 2])` | fail |
| `almost([1, 2], [1, 2, 3])` | fail — lengths must match |
| `almost(new Float32Array([0.1]), [0.1])` | pass |

## `throws` and `rejects` — matcher forms

Both accept the same optional second argument. `rejects` is async: **await it**, or the assertion
escapes the test body and the test passes for the wrong reason.

```js
throws(() => { throw new RangeError('r'); });                        // any throw
throws(() => { throw new RangeError('r'); }, /r/);                   // RegExp vs String(err)
throws(() => { throw new RangeError('r'); }, new RangeError());      // matched on err.name
throws(() => { throw new Error('zz'); }, (e) => e.message === 'zz'); // predicate

await rejects(async () => { throw new TypeError('boom'); });
await rejects(() => Promise.reject(new Error('nope')), /nope/);
await rejects(async () => { throw new TypeError('x'); }, new TypeError());
await rejects(async () => { throw new Error('code 7'); }, (e) => e.message.includes('7'));
```

A class mismatch reports the names: `operator: 'throws'`, `actual: 'TypeError'`,
`expected: 'RangeError'`. A function that does not throw (or does not reject) fails with the
default message.

## `Assertion`

An `Error` subclass. A failed assertion throws one with `name: 'Assertion'`, `message`,
`operator` (`'is'`, `'ok'`, `'same'`, `'not'`, `'any'`, `'almost'`, `'throws'`, `'rejects'`,
`'fail'`) and, where meaningful, `actual` and `expected`. Exported so a test can inspect a
failure it deliberately provoked:

```js
try { fail('boom'); } catch (e) {
  ok(e instanceof Assertion);   // true; e.operator === 'fail'
}
```

## `onPass`

`onPass(fn)` installs a single global hook called with `{operator, message}` for every **passing**
assertion:

```js
const seen = [];
onPass((a) => seen.push([a.operator, a.message]));
is(1, 1);
ok(true, 'custom msg');
// seen === [['is', 'should be equal'], ['ok', 'custom msg']]
```

The runner uses the same hook to count and print assertions, and installs it before each test.
Calling `onPass` inside a test therefore **replaces the runner's counter for the rest of that
test**: its assertions disappear from the `spec` output and from the totals. Useful for
introspection probes; never leave it in a committed test.

## `formats` and `run`

`formats` holds the two built-in reporters, `formats.tap` and `formats.pretty`, each an object
implementing `testStart`, `testSkip`, `assertion`, `testPass`, `testFail`, `summary` (`tap` also
carries an internal `_n` counter). `--reporter=spec` selects the `pretty` one; `--reporter=pretty`
is rejected — the CLI accepts only `tap` and `spec`.

`run(opts)` (also `test.run(opts)`) is the runner itself, returning
`{assertCount, passed, failed, skipped}`. Its implementation reads `format` (a name or a `formats`
object), `timeout`, `grep`, `bail`, `mute` and `parallel`; only `format` was exercised here, and
the rest are unreachable from the CLI. **The CLI already calls `run`**, so invoking `run()` from a
file that `tst` executes runs the registered tests twice and doubles every count. Do not call it:
there is no supported way to run the runner elsewhere either, since `require('tst')` fails under
`node` and `jsh`.

## `test.fork` is unavailable

`{ fork: true }` fails immediately with
`require('worker_threads'): Node built-in 'worker_threads' is not available in the browser
environment.` Every test shares one realm per file; isolate by file instead.

## Regenerating these tables

Drop this in a scratch dir and run `tst`. It reports each case without failing the suite, so one
run characterises everything.

```js
import test, { is, same, almost, any, not } from 'tst';

const probe = (label, fn) => {
  try {
    fn();
    console.log('PASS  ' + label);
  } catch (e) {
    const detail = e.operator
      ? `[${e.operator}] actual=${JSON.stringify(e.actual)} expected=${JSON.stringify(e.expected)}`
      : `[${e.constructor.name}] ${e.message}`;
    console.log('FAIL  ' + label + '  ' + detail);
  }
};

test('characterise', () => {
  probe("is(1, '1')", () => is(1, '1'));
  probe('same({a: 1}, {a: 2})', () => same({ a: 1 }, { a: 2 }));
  probe('almost(1e6, 1e6 + 0.1)', () => almost(1e6, 1e6 + 0.1));
  // …one probe per case
});
```

To list the exports and the `test` modifiers on the current build:

```js
import test, * as M from 'tst';
test('surface', () => {
  console.log(Object.keys(M).sort().join(', '));
  console.log(Object.keys(M.default).join(', '));
  console.log(String(M.is));   // the implementations are readable via toString()
});
```
