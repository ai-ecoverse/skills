import test, { is } from 'tst';
import * as commandsMod from '../scripts/commands.js';
import * as elementsMod from '../scripts/elements.js';

const elements = elementsMod.default || elementsMod;
const commands = commandsMod.default || commandsMod;

const SNAPSHOT = [
  'Page Title: Northwind Clinic - Google Chrome',
  '- link "Home" [ref=e2]',
  '- textbox "Phone" [ref=e3]',
  '- checkbox "Consent" [ref=e4] [checked]',
  '- button "Submit" [ref=e5]',
  '- radio "Yes" [ref=e6]',
].join('\n');

test('elements keep Edit, CheckBox, and Button and drop the rest', () => {
  const form = elements.elementsFromSnapshot(SNAPSHOT);
  is(form.title, 'Northwind Clinic');
  is(
    form.elements.map((element) => element.role),
    ['Edit', 'CheckBox', 'Button']
  );
  is(form.elements[1].checked, true);
  is(form.elements[0].token, 'e3');
});

test('commands print quoted playwright-cli lines and skip the rest', () => {
  const plan = {
    entities: [{ label: 'Tel', value: '(503) 555-0142' }],
    actions: [
      { action: 'fill', token: 'e3', entityIndex: 0 },
      { action: 'check', token: 'e4', entityIndex: null },
      { action: 'skip', token: 'e9', entityIndex: null },
    ],
  };
  is(commands.planToPlaywrightLines(plan, 'E9A3F'), [
    "playwright-cli fill --tab=E9A3F e3 '(503) 555-0142'",
    'playwright-cli check --tab=E9A3F e4',
  ]);
});

test('a printed plan round-trips through JSON', () => {
  const plan = commands.parsePrintedPlan(
    JSON.stringify({
      actions: [{ action: 'click', token: 'e5' }],
      entities: [],
    })
  );
  is(plan.actions[0].token, 'e5');
});

test('flattenDecision reads the nested element', () => {
  is(
    commands.flattenDecision({
      element: { token: 'e3', role: 'Edit', label: 'Phone' },
      action: 'fill',
      probability: 0.9,
      entityIndex: 0,
    }),
    {
      token: 'e3',
      role: 'Edit',
      label: 'Phone',
      action: 'fill',
      probability: 0.9,
      entityIndex: 0,
    }
  );
});
