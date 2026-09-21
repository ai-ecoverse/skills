import test, { is } from 'tst';
import * as sheetMod from '../sheet.js';

const sheet = sheetMod.default || sheetMod;
const { deriveSchema, firstRowError, setDerived } = sheet;

test('deriveSchema reads keys from the first row', () => {
  is(deriveSchema([{ name: 'Ada', role: 'dev' }, { name: 'Bob' }]), ['name', 'role']);
});

test('deriveSchema is null for empty or missing data', () => {
  is(deriveSchema([]), null);
  is(deriveSchema(null), null);
  is(deriveSchema(undefined), null);
});

test('firstRowError is null when every row matches the schema', () => {
  is(
    firstRowError(
      [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
      ['a', 'b']
    ),
    null
  );
});

test('firstRowError names missing and unexpected keys', () => {
  is(
    firstRowError([{ a: 1 }], ['a', 'b'], 'people'),
    'Row 0 in sheet "people" is invalid — missing: b\nExpected keys: a, b'
  );
  is(
    firstRowError([{ a: 1, c: 2 }], ['a', 'b']),
    'Row 0 in sheet is invalid — missing: b; unexpected: c\nExpected keys: a, b'
  );
});

test('setDerived stamps total, limit, and offset from data.length', () => {
  is(setDerived({ data: [{}, {}, {}] }), { data: [{}, {}, {}], total: 3, limit: 3, offset: 0 });
});
