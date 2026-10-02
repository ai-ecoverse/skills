// tst assertion semantics: pins claims references/assertions.md states as measured.
//
// Run from the skill directory: tst tests/assertions.test.js

import test, { Assertion, almost, is, ok, same, throws } from 'tst';

// `throws` rethrows any Assertion, so it cannot observe a failed assertion. Catch it directly;
// a failure caught here is not recorded against the test.
const failure = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof Assertion) return e;
    throw e;
  }
  return null;
};

// The failing operator, or null when the assertion passed.
const failedWith = (fn) => failure(fn)?.operator ?? null;

test('a failed assertion throws an Assertion named by name and operator', () => {
  const e = failure(() => is(1, '1'));
  ok(e instanceof Assertion);
  is(e.name, 'Assertion');
  is(e.operator, 'is');
});

// [case as written in the reference, thunk, failing operator or null for a pass]
const cases = [
  ['same([0], [-0]) passes: members compare with ===', () => same([0], [-0]), null],
  ['same([NaN], [NaN]) fails: members compare with ===', () => same([NaN], [NaN]), 'same'],
  ['is(0, -0) fails, the opposite of same', () => is(0, -0), 'is'],
  ['is(NaN, NaN) passes, the opposite of same', () => is(NaN, NaN), null],
  ['same({a: 1}, {a: 2}) passes vacuously', () => same({ a: 1 }, { a: 2 }), null],
  ['is({a: 1}, {a: 2}) fails: is compares values', () => is({ a: 1 }, { a: 2 }), 'is'],
  ['almost(1e6, 1e6 + 0.1) fails: tolerance is absolute', () => almost(1e6, 1e6 + 0.1), 'almost'],
  ['almost(1e-9, 2e-9) passes: tolerance is absolute', () => almost(1e-9, 2e-9), null],
];

for (const [name, fn, operator] of cases) {
  test(name, () => {
    is(failedWith(fn), operator);
  });
}

test('throws matches an Error instance by name and reports both names on mismatch', () => {
  throws(() => {
    throw new RangeError('r');
  }, new RangeError());
  const e = failure(() =>
    throws(() => {
      throw new TypeError('x');
    }, new RangeError())
  );
  is(e?.operator, 'throws');
  is(e?.actual, 'TypeError');
  is(e?.expected, 'RangeError');
});
