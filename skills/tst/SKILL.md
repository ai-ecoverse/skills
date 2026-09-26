---
name: tst
description: |
  Use this when you need to run or write automated tests for JavaScript or TypeScript inside
  SLICC with the bundled `tst` runner. Triggers on "run the tests", "write a test for this",
  "add unit tests", "node --test doesn't work here", "tst: no test files matched",
  "tst: TypeScript 6 is not installed", "prove the bug is fixed", or a repo whose `*.test.js`
  files were written for CI and have never been executed anywhere.
  Covers the one-time TypeScript install `tst` needs before its first run, the `tst` CLI
  (default `**/*.test.{js,ts}` glob from cwd, `--reporter=tap|spec`, exit codes), the `tst`
  module's assertions (`is`, `ok`, `same`, `not`, `any`, `almost`, `throws`, `rejects`),
  `test.skip`/`only`/`todo`/`demo`, per-test `timeout`/`retry`/`data`, async tests, why
  `node:test`, `vitest` and `node:assert` are unavailable, and the RED-first /
  byte-identical-revert / mutation discipline that proves a test exercises the defect instead of
  merely existing. Not for Playwright or browser-UI testing.
allowed-tools: bash
---

# tst: running tests inside SLICC

`tst` is SLICC's bundled test runner. It executes `*.test.js` and `*.test.ts` files, each in its
own realm, and reports TAP by default.

## Step zero: TypeScript must be installed once

`tst` transpiles `.ts` through the TypeScript compiler, and it resolves that compiler **from disk
before it runs anything** — including a suite made only of `.js` files. On an instance where
TypeScript has never been installed, every invocation fails like this:

```text
$ cd /tmp/tstprobe && tst a.test.js
tst: TypeScript 6 is not installed in node_modules: run `ipk add -g typescript@6.0.3`
  (no network fallback; searched from /tmp/tstprobe:
   /tmp/tstprobe/node_modules, /tmp/node_modules, /node_modules, /shared/lib/node_modules)
```

Install it once per instance, then re-run:

```bash
ipk add -g typescript@6.0.3     # 'add' and 'install' are the same verb; typescript@6 also works
ipk list -g                     # confirm: typescript@6.0.3
```

What is known about this, stated separately from what is guessed:

- **Measured.** With the package absent from all four searched paths, the command above fails for a
  plain `.js` test file. Running `ipk add -g typescript@6.0.3` — which installs into
  `/shared/lib/node_modules/typescript` — makes the identical command succeed. Two states, one
  variable, same build.
- **Measured.** Moving that same package aside *after* a successful run changes nothing: `tst`
  keeps running both `.js` tests and freshly created `.ts` tests, exit 0.
- **Inferred, not proven.** The compiler is resolved from disk at first use and then held in memory
  for the rest of the session, which is why the error is reachable only *before* the first
  successful run and why no filesystem change can re-trigger it afterwards. A cold start could not
  be forced to confirm this, so treat the caching as the best available explanation rather than
  established behaviour. What matters operationally is the first bullet: install TypeScript before
  your first `tst` invocation on a fresh instance.

## Running it

```bash
tst                          # default glob **/*.test.{js,ts}, walked from cwd
tst --reporter=spec          # readable tree with one line per assertion
tst 'src/*.test.js'          # explicit glob(s), resolved from cwd
```

There is no `node --test` here (`node: unsupported option '--test'`, exit 9) and no `vitest`.
`tst` is the runner; do not build an assertion library.

## Why a local run matters

A `*.test.js` file can sit in a repository unexecuted — CI may have no job that runs it
(ai-ecoverse/skills#389), and a test written for CI still needs a local run here. A test that has
never run proves nothing: it may not even load. Before you trust a suite, run it, and make it fail
on purpose at least once.

## The discipline

Presence is not function. Follow these four steps in order every time you add a test for a bug.

1. **Extract into a scratch dir under `/tmp`.** `/tmp` needs no approval and is writable.
   Copy the module under test and write the test beside it, so nothing you do can damage the
   real tree.
2. **Run the suite against the current, unfixed code first, and prove each new assertion goes
   RED against the real defect.** Read the `actual:` value and confirm it is the defect you
   believe in. A test written after the fix proves only that the code still does what it does.
3. **Revert the scratch copy byte-identically and confirm with `cmp`.** Keep a pristine copy
   (`cp mod.js mod.js.orig`) before you touch anything. `cmp` is the only trustworthy identity
   check — a skimmed diff or a matching byte size is not.
4. **Mutate the code under test and confirm the suite goes red, then revert.** Flip one
   condition. A suite that survives a mutation is not testing what you think it is.

## Worked example, end to end

Set up the scratch dir. `median` has a real defect: `Array.prototype.sort()` with no comparator
sorts lexicographically.

```bash
mkdir -p /tmp/median-lab && cd /tmp/median-lab
cat > median.js <<'EOF'
export function median(xs) {
  if (!xs.length) throw new RangeError('median of empty list');
  const s = [...xs].sort();
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
EOF
cp median.js median.js.orig
cat > median.test.js <<'EOF'
import test, { is, throws } from 'tst';
import { median } from './median.js';

test('odd-length list, single digits', () => {
  is(median([3, 1, 2]), 2);
});

test('odd-length list with a multi-digit value', () => {
  is(median([1, 10, 2]), 2);
});

test('even-length list averages the two middle values', () => {
  is(median([1, 2, 3, 10]), 2.5);
});

test('empty list is a RangeError', () => {
  throws(() => median([]), new RangeError());
});
EOF
```

**Step 2 — RED against the unfixed module.** Real output:

```
$ tst; echo "exit=$?"
ok 1 - odd-length list, single digits
not ok 2 - odd-length list with a multi-digit value
  ---
  message: should be equal
  actual: 10
  expected: 2
  ...
not ok 3 - even-length list averages the two middle values
  ---
  message: should be equal
  actual: 6
  expected: 2.5
  ...
ok 4 - empty list is a RangeError
1..4
# tests 4
# pass 2
# fail 2
# assertions 4
exit=1
```

Note test 1: it passes against the buggy code, because `[3,1,2]` happens to sort the same way
lexicographically. That assertion is worthless as a regression test, and only the RED run reveals
it. Tests 2 and 3 name the defect: `actual: 10` and `actual: 6`.

**Fix it, then GREEN.**

```
$ sed -i 's/\.sort();/.sort((a, b) => a - b);/' median.js
$ tst; echo "exit=$?"
ok 1 - odd-length list, single digits
ok 2 - odd-length list with a multi-digit value
ok 3 - even-length list averages the two middle values
ok 4 - empty list is a RangeError
1..4
# tests 4
# pass 4
# assertions 4
exit=0
```

**Step 4 — mutate, confirm red, revert.** Flip the odd/even condition:

```
$ cp median.js median.js.fixed
$ sed -i 's/return s.length % 2 ?/return !(s.length % 2) ?/' median.js
$ tst; echo "exit=$?"
not ok 1 - odd-length list, single digits
  ---
  message: should be equal
  actual: 1.5
  expected: 2
  ...
not ok 2 - odd-length list with a multi-digit value
  ---
  message: should be equal
  actual: 1.5
  expected: 2
  ...
not ok 3 - even-length list averages the two middle values
  ---
  message: should be equal
  actual: 3
  expected: 2.5
  ...
ok 4 - empty list is a RangeError
1..4
# tests 4
# pass 1
# fail 3
# assertions 4
exit=1
```

Three of four assertions caught the mutation — the suite constrains the branch. Now revert and
prove identity:

```
$ cp median.js.fixed median.js
$ cmp median.js median.js.fixed && echo "identical"
identical
```

The fix you keep is the one you apply to the real tree. Step 3 puts the scratch copy back to the
pristine extract, so re-running the lab re-proves RED instead of quietly testing your local edit:

```
$ cp median.js.orig median.js
$ cmp median.js median.js.orig && echo "identical to the pristine extract"
identical to the pristine extract
$ tst > /dev/null 2>&1; echo "exit=$?"
exit=1
```

Use `--reporter=spec` while iterating; it names the matcher per assertion and prints
`actual`/`expected` inline:

```
► odd-length list with a multi-digit value
× 1 — should be equal
actual: 10
expected: 2

► empty list is a RangeError
√ 1 (throws) — should throw
```

## The CLI

| Behaviour | Detail |
| --- | --- |
| Default glob | `**/*.test.{js,ts}`, walked from **cwd**; subdirectories included |
| Explicit globs | Any number of positional globs, each **relative to cwd** |
| File order | Matched files run in sorted path order, each in its own realm with its own TAP plan |
| `--reporter=<name>` | `tap` (default) or `spec`. Nothing else is accepted |
| Exit 0 | Every test passed (also `--help`) |
| Exit 1 | Any test failed, a file failed to load, or no file matched the glob |
| Exit 2 | Usage error, e.g. `tst: unknown option: --bail` |

There are no `--grep`, `--bail` or `--parallel` flags. Select tests with `test.only` /
`test.skip` instead.

A package can wire the suite to `ipk`: with `"scripts": {"test": "tst"}` in `package.json`,
`ipk test` runs it and propagates the exit code (0 all-pass, 1 any-failure).

## Writing tests

`test` is the **default** export. `import { test }` resolves to `undefined` and fails at load.

```js
import test, { is, ok, same, not, any, almost, throws, rejects, fail, pass } from 'tst';

test('synchronous', () => {
  is(1 + 1, 2);
  ok('non-empty');
});

test('asynchronous — just return a promise', async () => {
  const v = await new Promise((r) => setTimeout(() => r(42), 20));
  is(v, 42);
});

test('a rejection — await it, or the assertion escapes the test', async () => {
  await rejects(() => Promise.reject(new TypeError('boom')), /boom/);
});
```

The body also receives an assert object and the test's `data`, so the named imports are optional:

```js
test('via the assert argument', (t, data) => {
  t.is(data.n, 7);
}, { data: { n: 7 } });
```

| Assertion | Passes when | Default message |
| --- | --- | --- |
| `is(a, b, msg?)` | Deep structural equality. `NaN` equals `NaN`; `0` and `-0` differ; no coercion (`1` vs `'1'` fails); `Set`/`Map`/`Date` compare by value | `should be equal` |
| `ok(v, msg?)` | `v` is truthy | `should be truthy` |
| `not(a, b, msg?)` | `is` would fail | `should differ` |
| `any(a, list, msg?)` | `a` deep-equals at least one member of `list` | `should be one of` |
| `almost(a, b, eps?, msg?)` | `Math.abs(a - b) <= eps`, an **absolute** tolerance, default `1.1920929e-7`; array-likes compare element-wise and lengths must match | `should almost equal` |
| `throws(fn, expected?, msg?)` | `fn()` throws. `expected` may be an `Error` instance (matched on `.name`), a `RegExp` (against `String(err)`), or a predicate | `should throw` |
| `rejects(fn, expected?, msg?)` | `await fn()` rejects; same matcher forms. **Returns a promise — await it** | `should reject` |
| `same(a, b, msg?)` | Iterated members match as a multiset. **Not deep equality**; see `references/assertions.md` before using it | `should have same members` |
| `fail(msg)` | Never — unconditional failure | — |
| `pass(msg)` | Always | — |

A failed assertion throws an `Assertion` (an `Error` subclass, `name: 'Assertion'`, with
`operator`, `actual`, `expected`). It ends that test body — later assertions in the same test do
not run — while remaining tests still run. Any other thrown error fails the test with its
message.

| Modifier / option | Effect |
| --- | --- |
| `test.skip(name, fn)` | Registered, never run, reported as skipped |
| `test.todo(name[, fn])` | Same, labelled todo. `test('name')` with no body is also a todo |
| `test.only(name, fn)` | If any test is `only`, all non-`only` tests are skipped |
| `test.mute(name, fn)` | Runs and counts, but suppresses its per-assertion output |
| `test.demo(name, fn)` | Runs; a failure is excluded from the failure summary (but see Common errors) |
| `{ timeout: ms }` | Per-test budget; default **5000 ms**, reported as `timeout after 5000ms` |
| `{ retry: n }` | Re-runs the body up to `n` extra times; passes if any attempt passes |
| `{ data: value }` | Passed as the second argument to the body |

`test(name, fn, opts)` and `test(name, opts, fn)` are both accepted.

There is no `describe`, `it`, `beforeEach`, `beforeAll` or `expect` — all undefined. There is no
setup/teardown facility: use a plain factory function called at the top of each test, or `data`.
Calling `test()` from inside a running test registers nothing; the nested test never executes.

## A test realm resolves almost nothing

Inside a `*.test.js` file, `require`/`import` resolves **only** `'tst'` and relative paths.
Everything else fails with `tst: cannot require <name>`: `fs`, `node:fs`, `path`, and every
`sliccy:*` bridge (`sliccy:exec`, `sliccy:http`, `sliccy:skill`, …).

Relative specifiers must be **string literals** — the runner bundles the local modules it can see
in the source at load time. `./mod.js`, `./mod` and `./mod.ts` all resolve; a computed specifier
(`const p = './mod.js'; require(p)`) fails with `tst: cannot require ./mod.js`.

The bridge ban applies transitively. A relative module that requires a bridge **at top level**
takes the whole file down at load time with `tst: local module not bundled: <name>` — no TAP
output, exit 1. So test such a module by separating the logic from the I/O:

```js
// bad: untestable here — the bridge is resolved when the module loads
const exec = require('sliccy:exec');
export function listBranches() {
  return parseBranches(exec('git branch').stdout);
}
```

```js
// good: the pure part is importable and the bridge is injectable
export function parseBranches(stdout) {
  return stdout.split('\n').map((l) => l.replace(/^\*?\s+/, '')).filter(Boolean);
}
export function listBranches(run = () => require('sliccy:exec')('git branch')) {
  return parseBranches(run().stdout);
}
```

The `good` form loads because the `require` sits inside a default argument that a test never
evaluates. `tst` then tests `parseBranches(stdout)` directly, and `listBranches` with a stub:

```js
import test, { is, throws } from 'tst';
import { parseBranches, listBranches } from './branches.js';

test('the pure part is directly testable', () => {
  is(parseBranches('* main\n  feat/x\n'), ['main', 'feat/x']);
});

test('the wrapper is testable with an injected run', () => {
  is(listBranches(() => ({ stdout: '* main\n  dev\n' })), ['main', 'dev']);
});

test('without a stub the bridge is unavailable', () => {
  throws(() => listBranches(), /local module not bundled: sliccy:exec/);
});
```

The realm does provide `process` (`cwd()`, `argv` as `['node', '<file>']`), `console`, `fetch`
(real network), `crypto`, `Buffer`, `TextEncoder`, `structuredClone`, `performance`, `URL`,
`__dirname` and `__filename`.

`.test.ts` files work, and so does importing a relative `.ts` module from a `.js` test — but types,
interfaces and enums are **transpiled away, never checked**. A `const n: number = 'a string'` runs
happily. Do not treat a green `tst` run as type checking.

A relative **JSON** import is not supported: `require('./fixture.json')` aborts the file with
`local-require resolve error: Debug Failure. Output generation failed`. Ship fixtures as a `.js`
module that exports the object.

## Common errors

| Symptom | Cause and fix |
| --- | --- |
| `tst: no test files matched /abs/path/x.test.js` | Globs resolve from cwd, so an absolute path matches nothing. `cd` to the directory and pass a relative glob. Exit is 1 and stdout is empty, so a stdout-only capture looks like a clean no-op |
| `tst: cannot require vitest` / `assert` / `node:assert` / `node:test` | None of these exist in a test realm. Import from `'tst'`. Test files elsewhere that import `vitest` cannot be run by `tst` — do not copy that pattern |
| `tst: local module not bundled: fs` (or `sliccy:exec`, …) | A **relative** module you imported reached for a bridge. Inject the dependency instead; see the section above |
| `Cannot find module 'node:test'` | From `node`/`jsh`, not `tst`: `node:test` is genuinely absent (CJS `require`, static and dynamic `import` all fail), and `node --test` exits 9 |
| `Error: Cannot find module 'tst'` under `node` or `jsh` | The `tst` module resolves only inside files run by the `tst` command. Do not `run()` the runner from a `.jsh` |
| A failing `test.demo` still fails the run | With the default `tap` reporter the process exits 1; with `--reporter=spec` it exits 0. Do not rely on `demo` being non-fatal in CI |
| Assertions stop being listed after you call `onPass()` | `onPass` replaces the runner's own per-assertion hook for the rest of that test, so those assertions vanish from the output and the count. Use it only in throwaway probes |
| Suite output appears twice, counts doubled | Something called `run()` / `test.run()` in a file executed by `tst`. The CLI already runs registered tests |
| `same({a: 1}, {a: 2})` passes | `same` compares iterated members, and a plain object iterates nothing, so unrelated objects "match". Use `is` for objects. `same(null, null)` throws a `TypeError` |
| A file produces no TAP output at all and exits 1 | It threw while loading — a bad import, or an assertion at module scope outside any `test()` |
| `local-require resolve error: Debug Failure. Output generation failed` | A relative `.json` import. Convert the fixture to a `.js` module |
| `tst: cannot require ./mod.js` for a file that exists | The specifier was computed, not a literal. Only literal relative specifiers get bundled |
| `tst: TypeScript 6 is not installed in node_modules` | The compiler has never been installed on this instance, and `tst` needs it before it runs anything — even a `.js`-only suite. `ipk add -g typescript@6.0.3`, then re-run. Expect this only on the first invocation of a session: once a run has succeeded, the error stops being reachable even if the package is removed (see Step zero) |

## Reference

`references/assertions.md` — exact `is` vs `same` semantics with reproduced cases, the remaining
module exports (`Assertion`, `formats`, `run`, `onPass`), and the introspection recipe used to
characterise them.
