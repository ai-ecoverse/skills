// `jira create` field coercion: pins the shapes Jira accepts for allowed-value fields.
//
// Run from the skill directory: tst tests/coerce-field.test.js
//
// Before this helper existed, `--field-security "Not a Security Issue"` was posted as a bare
// string and Jira answered 400 "Could not find valid 'id' or 'name' in security level
// object", which made the command's own required-field hint impossible to follow.

import test, { is, same } from 'tst';
import { coerceFieldValue } from '../lib/field-values.js';

// Shaped like a real createmeta: Jira hands back option objects with ids, and plain fields
// carry no allowedValues at all.
const META = {
  security: {
    allowedValues: [
      { id: '11800', name: 'All Users' },
      { id: '11900', name: 'Not a Security Issue' },
    ],
  },
  customfield_12900: {
    allowedValues: [
      { id: '131916', value: 'Altai' },
      { id: '131917', value: 'Alps' },
    ],
  },
  // A select whose options carry no id — Jira takes {value} for these.
  customfield_14101: { allowedValues: [{ value: 'Unspecified' }] },
  // A name-only option, the remaining shape Jira accepts.
  customfield_15000: { allowedValues: [{ name: 'Not Required' }] },
  summary: {},
  customfield_99999: { allowedValues: [] },
};

const coerce = (id, v) => coerceFieldValue(META, id, v);

test('an allowed value named by the user is sent as the id Jira demands', () => {
  same(coerce('security', 'Not a Security Issue'), { id: '11900' });
  same(coerce('customfield_12900', 'Altai'), { id: '131916' });
});

test('matching is case- and whitespace-insensitive', () => {
  same(coerce('security', 'not a security issue'), { id: '11900' });
  same(coerce('security', '  Not a Security Issue  '), { id: '11900' });
  same(coerce('customfield_12900', 'ALTAI'), { id: '131916' });
});

test('an option is matchable by name, by value, or by its id', () => {
  same(coerce('customfield_12900', 'Alps'), { id: '131917' });
  same(coerce('customfield_12900', '131917'), { id: '131917' });
  same(coerce('security', '11800'), { id: '11800' });
});

test('an option without an id falls back to the shape it does carry', () => {
  same(coerce('customfield_14101', 'Unspecified'), { value: 'Unspecified' });
  same(coerce('customfield_15000', 'Not Required'), { name: 'Not Required' });
});

test('a field with no closed value set is passed through untouched', () => {
  is(coerce('summary', 'Allowlist client helix-wac-prod'), 'Allowlist client helix-wac-prod');
  is(coerce('customfield_99999', 'anything'), 'anything');
  is(coerce('customfield_404', 'unknown field'), 'unknown field');
});

test('an unmatched name is passed through so Jira reports it, never dropped', () => {
  // Silently discarding this would turn a typo into a missing-required-field 400 that names
  // the field the user thought they had just supplied.
  is(coerce('security', 'Doc Cloud'), 'Doc Cloud');
  is(coerce('customfield_12900', 'Himalaya'), 'Himalaya');
});

test('a non-string value is returned as-is', () => {
  const labels = ['Cloud=DocumentCloud', 'Non-FedRAMP'];
  is(coerce('labels', labels), labels);
  same(coerce('security', { id: '11900' }), { id: '11900' });
  is(coerce('customfield_10001', 42), 42);
});
