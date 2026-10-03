import test, { is, ok } from 'tst';
import * as intentMod from '../scripts/intent.js';

const lib = intentMod.default || intentMod;

// Trimmed from httpbin's pizza form and a Wikipedia infobox, captured 2026-10-02.
const FORM = [
  'Page URL: https://httpbin.org/forms/post',
  'Page Title: ',
  '- rootwebarea',
  '  - paragraph',
  '    - text "Customer name:" [ref=e1]',
  '    - textbox "Customer name:" [ref=e2] [box=10,10,200,20]',
  '  - paragraph',
  '    - text "Telephone:" [ref=e3]',
  '    - textbox "Telephone:" [ref=e4] [box=10,40,200,20]',
  '  - group "Pizza Size" [ref=e7]',
  '    - paragraph',
  '      - radio "Small" [ref=e9] [box=10,80,12,12]',
  '    - paragraph',
  '      - radio "Medium" [ref=e11] [box=10,100,12,12]',
  '  - button "Submit order" [ref=e29] [box=10,300,100,24]',
].join('\n');

const INFOBOX = [
  'Page URL: https://en.wikipedia.org/wiki/Kurt_G%C3%B6del',
  'Page Title: Kurt Gödel - Wikipedia',
  '- rootwebarea',
  '  - heading "Kurt Gödel" [ref=e1]',
  '  - table',
  '    - rowgroup',
  '      - row "Born Kurt Friedrich Gödel April 28, 1906 Brünn, Austria-Hungary" [ref=e87]',
  '        - rowheader "Born" [ref=e88]',
  '        - cell "Kurt Friedrich Gödel April 28, 1906 Brünn, Austria-Hungary" [ref=e89]',
  '      - row "Doctoral advisor Hans Hahn" [ref=e155]',
  '        - rowheader "Doctoral advisor" [ref=e156]',
  '        - cell "Hans Hahn" [ref=e158]',
  '  - paragraph',
  '    - text "Gödel was a logician and mathematician." [ref=e185]',
].join('\n');

const el = (token, role, label, extra = {}) => ({
  token,
  role,
  label,
  kind: /^(textbox|searchbox|combobox|spinbutton)$/.test(role) ? 'fill' : 'click',
  region: '',
  ...extra,
});

test('classify: each kind, and the boundary cases that fooled the first rules', () => {
  const kinds = {
    'click the Search button': 'ACT',
    'fill out the name field with "Lars Trieloff"': 'ACT',
    'check the terms checkbox': 'ACT',
    'confirm the booking by clicking the button': 'ACT',
    'can you click the Load more button?': 'ACT',
    'press the Back button inside the checkout wizard': 'ACT',
    'click the "Learn More" link next to Recreation.gov': 'ACT',
    'what is the total price in the cart?': 'RETRIEVE',
    'could you tell me the departure time of the cheapest flight?': 'RETRIEVE',
    'find the phone number in the footer': 'RETRIEVE',
    'until when are applications open?': 'RETRIEVE',
    'is the cart empty?': 'VERIFY',
    'check that the order was placed': 'VERIFY',
    'confirm the password field is masked': 'VERIFY',
    'are we on github.com/ai-ecoverse?': 'VERIFY',
    'wait until the results load': 'WAIT_FOR',
    'hang tight until the error banner goes away': 'WAIT_FOR',
    'open https://example.com': 'NAVIGATE',
    'take me to localhost:3000/dashboard': 'NAVIGATE',
    'go back': 'NAVIGATE',
    'hit reload to see if the page updates': 'NAVIGATE',
    'news.ycombinator.com': 'NAVIGATE',
  };
  for (const [text, kind] of Object.entries(kinds)) is(lib.classify(text).kind, kind, text);
});

test('parseNavigate: URLs get a scheme; history words', () => {
  is(lib.parseNavigate('go to news.ycombinator.com'), { op: 'goto', url: 'https://news.ycombinator.com' });
  is(lib.parseNavigate('take me to localhost:3000/x'), { op: 'goto', url: 'http://localhost:3000/x' });
  is(lib.parseNavigate('refresh the page'), { op: 'reload' });
  is(lib.parseNavigate('press back').op, 'back');
});

test('parseAct: the value to type is not part of the target', () => {
  const fill = lib.parseAct('fill out the name field with Lars Trieloff');
  is([fill.op, fill.value, fill.target], ['type', 'Lars Trieloff', 'the name field']);
  const typed = lib.parseAct('type "Berlin" into Where from');
  is([typed.op, typed.value, typed.target], ['type', 'Berlin', 'Where from']);
  const enter = lib.parseAct('Enter "Ada Lovelace" as the customer name');
  is([enter.op, enter.value, enter.target], ['type', 'Ada Lovelace', 'the customer name']);
  const search = lib.parseAct('type Kurt Gödel into the search box and press Enter');
  is([search.op, search.value, search.submit], ['type', 'Kurt Gödel', true]);
  is(lib.parseAct('select Medium from the size dropdown').op, 'select');
  is(lib.parseAct('press Enter'), { op: 'press', value: null, key: 'Enter', direction: null, submit: false, target: '' });
  is(lib.parseAct('scroll to the bottom').direction, 'bottom');
  is(lib.parseAct('uncheck the newsletter box').op, 'uncheck');
  is(lib.parseAct('choose the medium pizza size').op, 'click');
  // Typing names the field without its value; a select is named by both.
  is(lib.actQuery('type "Search" into the box', lib.parseAct('type "Search" into the box')), 'the box');
});

test('cleanRequest: intent fields only, strictly checked', () => {
  is(lib.cleanRequest({ intent: '  click   Search ', ref: 'e12', sure: 0.8 }).req, { intent: 'click Search', ref: 'e12', sure: 0.8 });
  ok(lib.cleanRequest({ intent: 'x', argv: ['rm', '-rf'] }).error.includes('unknown field'));
  ok(lib.cleanRequest({ intent: 'x', ref: 'e1; rm -rf /' }).error.includes('--ref'));
  ok(lib.cleanRequest({ intent: 'x', tab: '../../etc' }).error.includes('--tab'));
  ok(lib.cleanRequest({ intent: 'x', sure: 2 }).error.includes('--sure'));
  ok(lib.cleanRequest({ intent: 'x', model: 'rm' }).error.includes('--model'));
  ok(lib.cleanRequest({}).error.includes('--intent is required'));
  is(lib.cleanRequest({ intent: 'x', kind: 'wait-for' }).req.kind, 'WAIT_FOR');
});

test('textSegments: a row keeps its label and value together', () => {
  const segs = lib.textSegments(INFOBOX);
  const texts = segs.map((s) => s.text);
  ok(texts.includes('Doctoral advisor Hans Hahn'), texts.join(' | '));
  is(segs.find((s) => s.text === 'Doctoral advisor Hans Hahn').ref, 'e155');
  const best = lib.lexicalRank(segs, 'who was his doctoral advisor?')[0].candidate;
  is(best.text, 'Doctoral advisor Hans Hahn');
  is(lib.lexicalRank(segs, 'when was he born?')[0].candidate.ref, 'e87');
});

test('lexicalRank: a typing intent only ranks fields first', () => {
  const elements = [el('e2', 'textbox', 'Customer name:'), el('e4', 'textbox', 'Telephone:'), el('e29', 'button', 'Submit order')];
  const cands = lib.controlCandidates(elements, null);
  const parsed = lib.parseAct('enter 555-0142 as the telephone number');
  const ranked = lib.lexicalRank(cands, lib.actQuery('enter 555-0142 as the telephone number', parsed), { op: parsed.op });
  is(ranked[0].candidate.ref, 'e4');
  ok(ranked[2].score < -50, 'a button cannot take typing');
});

test('controlCandidates: labels that differ only in numbers are one series', () => {
  const elements = [el('e1', 'link', 'comments'), el('e2', 'link', '165 comments'), el('e3', 'link', '21 comments'), el('e4', 'link', '35 comments')];
  const cands = lib.controlCandidates(elements, null);
  is(lib.describeControl(cands[1]), 'link "165 comments" (1st of 3)');
  is(cands[3].rank, { k: 3, n: 3 });
  is(cands[0].rank, null);
  // "the top story's comments": the ordinal favours the first of the series.
  const ranked = lib.lexicalRank(cands, 'open the comments of the top story');
  is(ranked[0].candidate.ref, 'e2');
});

test('applyStates: pairs scanned states by role, name and order', () => {
  const elements = [el('e9', 'radio', 'Small'), el('e11', 'radio', 'Medium'), el('e17', 'checkbox', 'Bacon')];
  const states = [
    { role: 'radio', name: 'small', state: 'not checked' },
    { role: 'radio', name: 'Medium', state: 'checked' },
    { role: 'checkbox', name: 'Bacon', state: 'not checked' },
  ];
  const out = lib.applyStates(elements, states);
  is(out.map((e) => e.state), ['not checked', 'checked', 'not checked']);
  is(out[1].value, 'checked');
  is(lib.stateSegments(out)[1].text, 'radio "Medium": checked');
});

test('verdict: act only at or above the threshold, never on NONE', () => {
  is(lib.verdict({ e1: 0.71, e2: 0.2, NONE: 0.09 }).sure, true);
  is(lib.verdict({ e1: 0.69, e2: 0.2, NONE: 0.11 }).sure, false);
  is(lib.verdict({ NONE: 0.9, e1: 0.1 }).pick, null);
  is(lib.verdict({ e1: 0.65 }, { sure: 0.6 }).sure, true);
  is(lib.SURE, 0.7);
  // kev: NONE does not veto; the best other choice decides.
  is(lib.verdict({ NONE: 0.46, e2: 0.41, e6: 0.04 }, { sure: 0.4, ignoreNone: true }), { pick: 'e2', p: 0.41, sure: true, ranked: [['NONE', 0.46], ['e2', 0.41], ['e6', 0.04]] });
});

test('snippet: a long text is cut around the words asked about', () => {
  const long = `${'filler words here. '.repeat(30)}The total price is $42.17 including tax. ${'more filler. '.repeat(30)}`;
  const s = lib.snippet(long, 'what is the total price?', 80);
  ok(s.includes('$42.17'), s);
  ok(s.length <= 82, String(s.length));
});

test('choiceQuestion: one option per candidate and a NONE', () => {
  const cands = lib.controlCandidates([el('e29', 'button', 'Submit order')], null);
  const q = lib.choiceQuestion('ACT', 'press submit', cands, { title: 'Pizza', url: 'https://x' });
  is(Object.keys(q.question.criteria), ['e29', 'NONE']);
  ok(q.state.startsWith('Intent: press submit'));
  ok(lib.textSegments(FORM).some((s) => s.text === 'textbox "Customer name:" = ""'));
});

test('menuQuestion: webrunner wording for kev, ids that map back to refs', () => {
  const cands = lib.controlCandidates([el('e2', 'textbox', 'Customer name:'), el('e29', 'button', 'Submit order')], null);
  const q = lib.choiceQuestion('ACT', 'press submit', cands, { title: 'Pizza', url: 'https://x' }, { style: 'menu' });
  is(Object.keys(q.question.criteria), ['type:e2', 'click:e29', 'NONE']);
  is(q.question.criteria['click:e29'], 'click button "Submit order"');
  ok(q.state.startsWith('Goal: press submit') && q.state.includes('  [e29] button "Submit order"'), q.state);
  is([lib.refOf('click:e29'), lib.refOf('type:e2'), lib.refOf('e5')], ['e29', 'e2', 'e5']);
  is(lib.SURE_BY_MODEL['4b-vision'], 0.6);
});

test('refMemory: which of the same-labelled controls a ref is', () => {
  const mem = lib.refMemory([el('e3', 'button', 'Eat', { seq: 3 }), el('e7', 'link', 'Pasta', { seq: 7 }), el('e9', 'button', 'Eat', { seq: 9 })]);
  is(mem, [
    { ref: 'e3', role: 'button', label: 'Eat', k: 1 },
    { ref: 'e7', role: 'link', label: 'Pasta', k: 1 },
    { ref: 'e9', role: 'button', label: 'Eat', k: 2 },
  ]);
});

test('listLines: a lexical read of links or rows, in page order', () => {
  const elements = [
    el('e1', 'link', 'Opium', { seq: 1 }),
    el('e2', 'link', 'Drug Wars (video game)', { seq: 2 }),
    el('e3', 'button', 'Search', { seq: 3 }),
    el('e4', 'link', 'Illegal drug trade', { seq: 4 }),
  ];
  const listed = lib.listLines('list the links about drug', elements, [], 10);
  is(listed.kind, 'links');
  is(listed.lines, ['  e2 link "Drug Wars (video game)"', '  e4 link "Illegal drug trade"']);
  // No word to match: every item of the kind.
  is(lib.listLines('list the buttons', elements, [], 10).lines, ['  e3 button "Search"']);
  // Rows when no kind of control is named.
  const rows = lib.textSegments(INFOBOX);
  ok(lib.listLines('list the rows that mention advisor', [], rows, 5).lines[0].includes('Doctoral advisor Hans Hahn'));
  ok(lib.isList('list the links about drugs') && !lib.isList('click the list button'));
});

test('regionLines: the closest texts in page order when no single one is sure', () => {
  const segs = [
    { type: 'text', id: 't1', text: 'Mile 12 of 100', line: 10, ref: 'e5' },
    { type: 'text', id: 't2', text: 'Calories 1200 eaten, 900 burned', line: 20, ref: 'e9' },
  ];
  const byId = new Map(segs.map((x) => [x.id, x]));
  is(lib.regionLines([['t2', 0.3], ['NONE', 0.4], ['t1', 0.2]], byId, 6, 'status'), ['  e5 "Mile 12 of 100"', '  e9 "Calories 1200 eaten, 900 burned"']);
});

test('budgetLines: top texts by rank until the budget, shown in page order', () => {
  const texts = [
    { type: 'text', id: 't9', text: 'Calories eaten 3000, burned 3795', line: 90, ref: 'e9' },
    { type: 'text', id: 't2', text: 'Mile 65 of 100', line: 20, ref: 'e2' },
    { type: 'text', id: 't5', text: 'x'.repeat(500), line: 50, ref: 'e5' },
  ];
  const lines = lib.budgetLines(texts, 120, 'calories');
  is(lines, ['  e2 "Mile 65 of 100"', '  e9 "Calories eaten 3000, burned 3795"']);
  ok(lib.budgetLines(texts, 600, '').length === 3);
});
