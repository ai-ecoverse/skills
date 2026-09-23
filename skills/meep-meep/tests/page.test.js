import test, { is, ok, throws } from 'tst';
import * as pageMod from '../scripts/page.js';

const page = pageMod.default || pageMod;

const SNAPSHOT = [
  'Page URL: http://localhost:8787/preview/tmp/meep/link.html',
  'Page Title: Library',
  '- rootwebarea "Library"',
  '  - link "Incompleteness theorems" [ref=e1]',
  '  - link "Other article" [ref=e2]',
  '  - textbox "Where to?" [ref=e3]: ""',
  '  - button "Search" [ref=e4]',
].join('\n');

// Trimmed from the Google Flights start page, captured 2026-09-22.
const FLIGHTS = [
  'Page URL: https://www.google.com/travel/flights?hl=en&gl=us&curr=USD',
  'Page Title: Find Cheap Flights Worldwide & Book Your Ticket - Google Flights',
  '- rootwebarea',
  '  - button "Main menu" [ref=e1]',
  '  - link "Sign in" [ref=e15]',
  '  - combobox "Change ticket type. Round trip" [ref=e18]',
  '  - button "1 passenger, change number of passengers." [ref=e19]',
  '  - combobox "Where from?" [ref=e22]',
  '  - button "Swap origin and destination." [ref=e23]',
  '  - combobox "Where to?" [ref=e24]',
  '  - textbox "Departure" [ref=e25]',
  '  - button "Search for flights" [ref=e27]',
  ...Array.from({ length: 40 }, (_, i) => `  - link "Footer ${i}" [ref=e${100 + i}]`),
].join('\n');

const GOAL =
  'Search Google Flights from Berlin to London. Type Berlin into Where from and pick the Berlin suggestion, type London into Where to and pick the London suggestion, then press Search.';

test('parseSnapshot keeps clickable and editable refs', () => {
  const shot = page.parseSnapshot(SNAPSHOT);
  is(shot.title, 'Library');
  is(
    shot.elements.map((e) => e.token),
    ['e1', 'e2', 'e3', 'e4']
  );
  is(shot.elements[2].kind, 'fill');
  is(shot.elements[3].kind, 'click');
});

test('a field value is read quoted or bare', () => {
  const shot = page.parseSnapshot(
    ['  - combobox "Where from?" [ref=e22]: Berlin', '  - textbox "Name" [ref=e3]: "Ada"'].join(
      '\n'
    )
  );
  is(shot.elements[0].value, 'Berlin');
  is(shot.elements[1].value, 'Ada');
});

test('text candidates are quoted strings and names in the goal', () => {
  is(page.textCandidates(GOAL), ['Berlin', 'London']);
  is(page.textCandidates('Enter "New York" in the field.'), ['New York']);
  is(page.textCandidates('Type "Sep 30" into Departure from Berlin.'), [
    'Sep 30',
    'Departure',
    'Berlin',
  ]);
});

test('the menu offers each field once per candidate and caps clicks', () => {
  const shot = page.parseSnapshot(FLIGHTS);
  const menu = page.buildMenu(shot, GOAL, { candidates: ['Berlin', 'London'] });
  const ids = menu.map((a) => a.id);
  ok(ids.includes('type:e22:Berlin'));
  ok(ids.includes('type:e24:London'));
  ok(ids.includes('click:e27'), 'Search for flights is kept');
  is(menu.filter((a) => a.operation === 'CLICK').length, page.MAX_CLICKS);
  ok(!ids.includes('DONE'), 'DONE only when asked for');
  is(ids[ids.length - 1], 'WAIT');
  ok(menu.length < 256, 'kev accepts at most 255 options');
});

test('a new suggestion outranks old footer links', () => {
  const before = page.parseSnapshot(FLIGHTS);
  const after = page.parseSnapshot(
    `${FLIGHTS}\n  - option "Berlin Brandenburg Airport" [ref=e300]\n  - option "Berlin, Germany" [ref=e301]`
  );
  const previous = new Set(before.elements.map((e) => e.label));
  const clicks = page.rankClicks(after.elements, GOAL, previous).map((e) => e.token);
  ok(clicks.includes('e300'));
  ok(clicks.includes('e301'));
  ok(!clicks.includes('e139'), 'the last footer link is dropped');
});

// After both cities are set, Google renames "Search for flights" to "Search"
// and the page below it is full of "Find flights from …" tiles. Captured
// 2026-09-22: the word-count ranking dropped the one button that mattered.
test('the form Search button beats promo tiles that share its words', () => {
  const tiles = Array.from(
    { length: 20 },
    (_, i) =>
      `      - button "Find flights from Chicago (ORD) to City ${i} from $158. Operated by Frontier. Oct 15 to Oct 22. Nonstop" [ref=e${40 + i}]`
  );
  const shot = page.parseSnapshot(
    [
      'Page URL: https://www.google.com/travel/flights?tfs=x',
      '- rootwebarea',
      '  - banner',
      '    - button "Google apps" [ref=e14]',
      '  - search "Flight" [ref=e17]',
      '    - combobox "Where from?" [ref=e22]: "Berlin"',
      '    - combobox "Where to?" [ref=e24]: "London"',
      '    - button "Search" [ref=e27]',
      '  - main',
      '    - list',
      ...tiles,
      '    - link "Flights from New York" [ref=e103]',
    ].join('\n')
  );
  is(shot.elements.find((e) => e.token === 'e27').region, 'search');
  is(shot.elements.find((e) => e.token === 'e14').region, 'banner');
  const previous = new Set(shot.elements.map((e) => e.label));
  const ranked = page.rankClicks(shot.elements, GOAL, previous);
  ok(ranked.map((e) => e.token).includes('e27'), 'Search is offered');
  const goalWords = new Set(GOAL.toLowerCase().match(/[a-z0-9]{3,}/g));
  const score = (e) => page.clickScore(e, goalWords, previous);
  const search = shot.elements.find((e) => e.token === 'e27');
  for (const other of shot.elements.filter((e) => e.kind === 'click' && e.token !== 'e27')) {
    ok(score(search) > score(other), `Search outscores ${other.token}`);
  }
});

test('compact state lists progress and the offered controls with values', () => {
  const shot = page.parseSnapshot(
    FLIGHTS.replace('combobox "Where from?" [ref=e22]', 'combobox "Where from?" [ref=e22]: Berlin')
  );
  const menu = page.buildMenu(shot, GOAL, { candidates: ['Berlin', 'London'] });
  const state = page.compactState(GOAL, shot, menu, [
    { operation: 'TYPE_TEXT', text: 'Berlin', label: 'Where from?', role: 'combobox' },
  ]);
  ok(state.includes('Done so far: typed "Berlin" into "Where from?"'));
  ok(state.includes('[e22] combobox "Where from?" = "Berlin"'));
  is(state.split('[e22]').length, 2, 'a field appears once even with two candidates');
});

test('pickAction accepts only a menu id', () => {
  const menu = page.buildMenu(page.parseSnapshot(SNAPSHOT), 'Open the Incompleteness article', {});
  is(page.pickAction(menu, 'click:e1').element.token, 'e1');
  is(page.pickAction(menu, ' "click:e1" ').element.token, 'e1');
  throws(() => page.pickAction(menu, 'click:e99'));
  throws(() => page.pickAction(menu, undefined));
});

test('the fingerprint ignores ref renumbering', () => {
  const a = page.parseSnapshot(SNAPSHOT);
  const b = page.parseSnapshot(SNAPSHOT.replace(/ref=e(\d)/g, (_, n) => `ref=e${Number(n) + 10}`));
  is(page.fingerprint(a), page.fingerprint(b));
  const c = page.parseSnapshot(SNAPSHOT.replace('[ref=e3]: ""', '[ref=e3]: "London"'));
  ok(page.fingerprint(a) !== page.fingerprint(c));
});

test('a runtime URL is not prefixed twice', () => {
  const config = { BEDROCK_REGION: 'https://bedrock-runtime.us-west-2.amazonaws.com' };
  is(page.runtimeBase(config), 'https://bedrock-runtime.us-west-2.amazonaws.com');
  is(page.regionName(config), 'us-west-2');
  is(
    page.runtimeBase({ BEDROCK_REGION: 'eu-central-1' }),
    'https://bedrock-runtime.eu-central-1.amazonaws.com'
  );
});

test('extractJson ignores prose around the object', () => {
  is(page.extractJson('sure\n{"action":"WAIT"}\n'), { action: 'WAIT' });
});
