// tst median lab: the SKILL.md worked example as code. Each expected value is copied from a
// "Real output" block, so a change in tst or in the example breaks this suite loudly.
//
// Run from the skill directory: tst tests/median-lab.test.js

import test, { is, throws } from 'tst';

// Verbatim from the worked example.
function buggy(xs) {
  if (!xs.length) throw new RangeError('median of empty list');
  const s = [...xs].sort();
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// After `sed -i 's/\.sort();/.sort((a, b) => a - b);/'`.
function fixed(xs) {
  if (!xs.length) throw new RangeError('median of empty list');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Step 4 mutation of the fixed copy: `return !(s.length % 2) ?`.
function mutated(xs) {
  if (!xs.length) throw new RangeError('median of empty list');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return !(s.length % 2) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

test('buggy: [3,1,2] still gives 2, the worthless pass', () => {
  is(buggy([3, 1, 2]), 2);
});

test('buggy: lexicographic sort gives the RED actual values', () => {
  is(buggy([1, 10, 2]), 10);
  is(buggy([1, 2, 3, 10]), 6);
});

test('fixed: numeric sort gives the GREEN values', () => {
  is(fixed([3, 1, 2]), 2);
  is(fixed([1, 10, 2]), 2);
  is(fixed([1, 2, 3, 10]), 2.5);
});

test('mutated fixed copy: the Step 4 actual values', () => {
  is(mutated([3, 1, 2]), 1.5);
  is(mutated([1, 10, 2]), 1.5);
  is(mutated([1, 2, 3, 10]), 3);
});

test('every variant rejects an empty list with a RangeError', () => {
  for (const median of [buggy, fixed, mutated]) {
    throws(() => median([]), new RangeError());
  }
});
