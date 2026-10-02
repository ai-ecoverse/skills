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

test('the menu stays within kev option limit with many fields and goal values', () => {
  const lines = ['Page URL: https://example.com/form', '- rootwebarea'];
  for (let i = 1; i <= 8; i++) lines.push(`  - textbox "Field ${i}" [ref=f${i}]: ""`);
  for (let i = 1; i <= 20; i++) lines.push(`  - button "Button ${i}" [ref=b${i}]`);
  const shot = page.parseSnapshot(lines.join('\n'));
  const candidates = Array.from({ length: 40 }, (_, i) => `Value${i}`);
  const menu = page.buildMenu(shot, 'Fill the form', { candidates, offerDone: true });
  ok(menu.length <= page.MAX_OPTIONS, `menu has ${menu.length} options`);
  is(
    menu.filter((a) => a.operation === 'CLICK').length,
    page.MAX_CLICKS,
    'clicks keep their places'
  );
  ok(
    menu.some((a) => a.id === 'WAIT'),
    'WAIT is offered'
  );
  ok(
    menu.some((a) => a.id === 'DONE'),
    'DONE is offered'
  );
  is(new Set(menu.map((a) => a.id)).size, menu.length, 'ids are unique');
});

test('the agent schema allows only menu ids and asks for text on its own key', () => {
  const menu = page.buildMenu(page.parseSnapshot(SNAPSHOT), 'Enter London', {});
  const schema = page.decisionSchema(menu);
  is(
    schema.properties.action.enum,
    menu.map((a) => a.id)
  );
  is(schema.required, ['action']);
  ok(
    menu.some((a) => a.id === 'type:e3' && a.text === null),
    'a field without goal values has one type action'
  );
  const prompt = page.agentPrompt('Goal: Enter London', menu);
  ok(prompt.includes('type:e3  type into textbox "Where to?"'));
  ok(prompt.includes('StructuredOutput'));
});

// ── viewport, diff, orient ────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 800, scrollY: 0, scrollHeight: 2400 };
const BOXED = [
  'Page URL: https://news.example.com/',
  'Page Title: News',
  '- rootwebarea "News"',
  '  - banner',
  '    - link "Home" [ref=e1] [box=10,10,60,20]',
  '  - main',
  '    - searchbox "Search news" [ref=e2] [box=100,60,300,32]: ""',
  '    - link "Top story about comets" [ref=e3] [box=20,120,400,20]',
  '    - link "Skip to content" [ref=e4] [box=0,0,0,0]',
  '    - link "Carousel next" [ref=e5] [box=1400,300,40,40]',
  '    - link "Older comets archive" [ref=e6] [box=20,1600,200,20]',
  '    - link "Unrelated footer link" [ref=e7] [box=20,2300,200,20]',
  '  - alert "Saved"',
].join('\n');

test('a box is read off the ref line and the value after it still parses', () => {
  const shot = page.parseSnapshot(BOXED);
  const search = shot.elements.find((e) => e.token === 'e2');
  is(search.box, [100, 60, 300, 32]);
  is(search.value, undefined, 'an empty value stays empty');
  const filled = page.parseSnapshot('  - textbox "Name" [ref=e9] [box=1,2,3,4]: "Ada"');
  is(filled.elements[0].value, 'Ada');
  is(filled.elements[0].label, 'Name');
  is(shot.texts, [{ role: 'alert', text: 'Saved' }]);
});

test('place sorts elements by the viewport', () => {
  const shot = page.parseSnapshot(BOXED);
  const where = Object.fromEntries(shot.elements.map((e) => [e.token, page.place(e, VIEWPORT)]));
  is(where, { e1: 'in', e2: 'in', e3: 'in', e4: 'hidden', e5: 'aside', e6: 'below', e7: 'below' });
  is(page.place(shot.elements[0], null), 'unknown', 'no viewport, no judgement');
});

test('inView keeps the visible controls, off-screen ones the goal names, and offers scrolls', () => {
  const shot = page.parseSnapshot(BOXED);
  const view = page.inView(shot, 'Open the comets archive', VIEWPORT);
  is(
    view.elements.map((e) => e.token),
    ['e1', 'e2', 'e3', 'e6']
  );
  const reasons = Object.fromEntries(view.excluded.map((x) => [x.element.token, x.reason]));
  is(reasons, { e4: 'zero size', e5: 'scrolled sideways', e7: 'below the visible area' });
  is(view.scroll, { up: false, down: true });
  const scrolled = page.inView(shot, 'x', { ...VIEWPORT, scrollY: 1600 });
  ok(scrolled.scroll.up, 'scrolled down, so up is offered');
});

test('the menu offers scrolls only when there is somewhere to scroll', () => {
  const shot = page.parseSnapshot(BOXED);
  const down = page.buildMenu(shot, 'x', { scroll: { up: false, down: true } }).map((a) => a.id);
  ok(down.includes('SCROLL_DOWN'));
  ok(!down.includes('SCROLL_UP'));
  const none = page.buildMenu(shot, 'x', {}).map((a) => a.id);
  ok(!none.some((id) => id.startsWith('SCROLL')));
});

test('diffShots matches elements by role and label, not by ref', () => {
  const before = page.parseSnapshot(FLIGHTS);
  before.viewport = { ...VIEWPORT };
  const after = page.parseSnapshot(
    FLIGHTS.replace(/ref=e(\d+)/g, (_, n) => `ref=e${Number(n) + 500}`)
      .replace('combobox "Where from?" [ref=e522]', 'combobox "Where from?" [ref=e522]: "Berlin"')
      .replace('  - link "Footer 0" [ref=e600]\n', '') +
      '\n  - option "Berlin, Germany" [ref=e900]\n  - alert "Choose a destination"'
  );
  after.viewport = { ...VIEWPORT, scrollY: 300 };
  const diff = page.diffShots(before, after);
  is(diff.url, null);
  is(diff.added, [{ token: 'e900', role: 'option', label: 'Berlin, Germany' }]);
  is(diff.removed, [{ token: 'e100', role: 'link', label: 'Footer 0' }]);
  is(diff.changed, [
    { token: 'e522', role: 'combobox', label: 'Where from?', from: '', to: 'Berlin' },
  ]);
  is(diff.texts, [{ role: 'alert', text: 'Choose a destination' }]);
  is(diff.scrolled, 300);
  const lines = page.describeDiff(diff);
  ok(lines.some((l) => l.includes('combobox "Where from?" now = "Berlin"')));
  ok(lines.some((l) => l.includes('new message: "Choose a destination"')));
  ok(lines.some((l) => l.includes('1 new control: option "Berlin, Germany"')));
  is(page.diffShots(null, after), null, 'the first observation has nothing to compare');
});

test('repeated labels are diffed by count', () => {
  const a = page.parseSnapshot('  - link "12 comments" [ref=e1]\n  - link "12 comments" [ref=e2]');
  const b = page.parseSnapshot(
    '  - link "12 comments" [ref=e5]\n  - link "12 comments" [ref=e6]\n  - link "12 comments" [ref=e7]'
  );
  is(
    page.diffShots(a, b).added.map((e) => e.token),
    ['e7']
  );
  is(page.diffShots(b, a).removed.length, 1);
});

test('orient builds the state with changes, new marks and places, and explains every exclusion', () => {
  const prevShot = page.parseSnapshot(BOXED);
  const shot = page.parseSnapshot(
    `${BOXED}\n    - option "Comets 2026" [ref=e8] [box=100,92,300,24]`
  );
  const obs = { shot, viewport: VIEWPORT, diff: page.diffShots(prevShot, shot) };
  const ori = page.orient(obs, {
    goal: 'Open the comets archive',
    history: [{ operation: 'TYPE_TEXT', text: 'comets', label: 'Search news', role: 'searchbox' }],
    candidates: [],
    offerDone: false,
  });
  ok(ori.state.includes('Last action changed:\n  1 new control: option "Comets 2026"'));
  ok(ori.state.includes('[e8] option "Comets 2026" (new)'));
  ok(ori.state.includes('[e6] link "Older comets archive" (below the visible area)'));
  ok(
    !ori.state.includes('Unrelated footer'),
    'an off-screen control the goal does not name is left out'
  );
  ok(ori.menu.some((a) => a.id === 'SCROLL_DOWN'));
  const reasons = Object.fromEntries(ori.excluded.map((x) => [x.token, x.reason]));
  is(reasons.e7, 'below the visible area');
  is(reasons.e4, 'zero size');
  const first = page.orient(
    { shot, viewport: VIEWPORT, diff: null },
    { goal: 'x', history: [], candidates: [] }
  );
  ok(!first.state.includes('Last action changed'), 'no change report before the first action');
});

test('the state says when the last action changed nothing', () => {
  const shot = page.parseSnapshot(BOXED);
  const ori = page.orient(
    { shot, viewport: VIEWPORT, diff: page.diffShots(shot, shot) },
    { goal: 'x', history: [{ operation: 'WAIT' }], candidates: [] }
  );
  ok(
    ori.state.includes(
      'Last action changed:\n  nothing visible: doing the same again will not help'
    )
  );
});

test('without a viewport every control is a candidate, as before', () => {
  const shot = page.parseSnapshot(BOXED);
  const ori = page.orient(
    { shot, viewport: null, diff: null },
    { goal: 'x', history: [], candidates: [] }
  );
  is(ori.excluded, []);
  ok(!ori.menu.some((a) => a.operation === 'SCROLL'));
});

test('a scroll changes the fingerprint even when the snapshot does not', () => {
  const shot = page.parseSnapshot(BOXED);
  ok(page.fingerprint(shot, { scrollY: 0 }) !== page.fingerprint(shot, { scrollY: 640 }));
  is(page.fingerprint(shot), page.fingerprint(shot));
});

test('a Google consent wall is answered without the decider', () => {
  const wall = page.parseSnapshot(
    'Page URL: https://consent.google.com/ml?continue=x\n  - button "Accept all" [ref=e3]\n  - button "Reject all" [ref=e4]'
  );
  is(page.directAction(wall, '').id, 'click:e4');
  is(page.directAction(page.parseSnapshot(SNAPSHOT), SNAPSHOT), null);
});

// Captured 2026-10-01 (webrunner run 2026-10-01T17-32-09-flights): a range
// picker moved the departure to the return date, and a check on "London"
// alone passed the run.
test('a field that no longer shows what was typed is reported', () => {
  const history = [
    { operation: 'TYPE_TEXT', text: 'Oct 8', label: 'Departure', role: 'textbox' },
    { operation: 'TYPE_TEXT', text: 'Oct 15', label: 'Return', role: 'textbox' },
    { operation: 'TYPE_TEXT', text: 'Berlin', label: 'Where from?', role: 'combobox' },
  ];
  const shot = page.parseSnapshot(
    [
      '  - combobox "Where from?" [ref=e22]: "Berlin"',
      '  - textbox "Departure" [ref=e25]: "Thu, Oct 15"',
      '  - textbox "Return" [ref=e26]: "Thu, Oct 15"',
    ].join('\n')
  );
  is(page.driftLines(history, shot), [
    '  textbox "Departure" was typed "Oct 8" but shows "Thu, Oct 15"',
  ]);
  const state = page.compactState('g', shot, page.buildMenu(shot, 'g', {}), history);
  ok(state.includes('Not as typed:\n  textbox "Departure" was typed "Oct 8"'));
  const fine = page.parseSnapshot('  - textbox "Departure" [ref=e25]: "Thu, Oct 8"');
  is(page.driftLines(history.slice(0, 1), fine), [], 'a reformatted value still matches');
});

test('a number in an expected text does not match a longer number', () => {
  ok(page.containsValue('departure thu, oct 15', 'oct 15'));
  ok(!page.containsValue('departure thu, oct 15', 'oct 1'));
  ok(page.containsValue('oct 15, then oct 1.', 'oct 1'), 'a later exact match still counts');
  ok(page.containsValue('anything', ''));
});

test('every --expect and --expect-url must match', () => {
  const obs = {
    shot: { url: 'https://www.google.com/travel/flights/search?tfs=x' },
    raw: 'textbox "Departure": "Thu, Oct 15"\ntextbox "Return": "Thu, Oct 15"\nLondon',
  };
  ok(page.checkExpect(obs, 'London', '/travel/flights/search'));
  ok(
    !page.checkExpect(obs, ['London', 'Oct 8', 'Oct 15'], '/travel/flights/search'),
    'the wrong departure fails'
  );
  ok(!page.checkExpect(obs, ['London', 'Oct 1'], null), 'Oct 1 is not Oct 15');
  ok(!page.checkExpect(obs, null, ['/search', '/hotels']));
  ok(!page.checkExpect(obs, null, null), 'no check, no pass');
});

test('a page that changed almost completely is not marked new control by control', () => {
  const before = page.parseSnapshot(FLIGHTS);
  const after = page.parseSnapshot(
    [
      'Page URL: https://www.google.com/travel/flights/search',
      ...Array.from({ length: 30 }, (_, i) => `  - link "Result ${i}" [ref=r${i}]`),
    ].join('\n')
  );
  const diff = page.diffShots(before, after);
  ok(diff.replaced);
  const lines = page.describeDiff(diff);
  ok(lines.some((l) => l.includes('the page changed almost completely (30 new controls')));
  ok(!lines.some((l) => l.includes('new control:') || l.includes('new controls:')));
  const ori = page.orient(
    { shot: after, viewport: null, diff },
    { goal: 'x', history: [{ operation: 'WAIT' }], candidates: [] }
  );
  ok(!ori.state.includes('(new)'));
});

test('SHRUG is offered only when asked and keeps the menu within the option limit', () => {
  const shot = page.parseSnapshot(SNAPSHOT);
  ok(!page.buildMenu(shot, 'x', {}).some((a) => a.id === 'SHRUG'));
  const menu = page.buildMenu(shot, 'x', {
    offerShrug: true,
    offerDone: true,
    scroll: { up: true, down: true },
  });
  is(menu[menu.length - 1].id, 'SHRUG');
  const lines = ['Page URL: https://example.com/form', '- rootwebarea'];
  for (let i = 1; i <= 8; i++) lines.push(`  - textbox "Field ${i}" [ref=f${i}]: ""`);
  for (let i = 1; i <= 20; i++) lines.push(`  - button "Button ${i}" [ref=b${i}]`);
  const big = page.buildMenu(page.parseSnapshot(lines.join('\n')), 'x', {
    candidates: Array.from({ length: 40 }, (_, i) => `V${i}`),
    offerDone: true,
    offerShrug: true,
    scroll: { up: true, down: true },
  });
  ok(big.length <= page.MAX_OPTIONS, `menu has ${big.length} options`);
});

test('System 1 shrugs when it says so, is unsure, or has no text to type', () => {
  const click = { id: 'click:e1', operation: 'CLICK' };
  is(page.shrugReason({ action: click, confidence: 0.9 }, 0.5), '');
  // Captured 2026-10-01 (run 2026-10-01T17-40-36-flights, kev-9b), steps 8 and 10.
  is(
    page.shrugReason(
      {
        action: { id: 'click:e31', operation: 'CLICK' },
        confidence: 0.1094,
        probabilities: { 'click:e31': 0.1094, 'type:e3:Oct 15': 0.105, SCROLL_DOWN: 0.0767 },
      },
      0.5
    ),
    'confidence 0.11 < 0.5, runner-up 0.10'
  );
  is(
    page.shrugReason(
      {
        action: { id: 'click:e27', operation: 'CLICK' },
        confidence: 0.39,
        probabilities: { 'click:e27': 0.39, 'click:e19': 0.0417 },
      },
      0.5
    ),
    '',
    'a low top choice far ahead of the rest stands'
  );
  is(
    page.shrugReason({ action: click, confidence: 0.31 }, 0.5),
    'confidence 0.31 < 0.5, runner-up 0.00'
  );
  is(
    page.shrugReason({ action: { id: 'SHRUG', operation: 'SHRUG' }, confidence: 0.9 }, 0.5),
    'chose SHRUG'
  );
  is(
    page.shrugReason(
      { action: { id: 'type:e3', operation: 'TYPE_TEXT', text: null }, confidence: 0.9 },
      0.5
    ),
    'picked a field with no value to type'
  );
  is(
    page.shrugReason({ action: click }, 0.5),
    '',
    'no confidence (a direct action) is not a shrug'
  );
});

test('System 2 hears System 1 top choices without SHRUG', () => {
  const menu = page.buildMenu(page.parseSnapshot(SNAPSHOT), 'x', { offerShrug: true });
  const hint = page.shrugHint(
    { probabilities: { 'click:e1': 0.4, SHRUG: 0.35, 'click:e2': 0.2, WAIT: 0.05 } },
    'confidence 0.40 < 0.5',
    menu
  );
  ok(hint.startsWith('A fast model was unsure here (confidence 0.40 < 0.5). Its top choices:'));
  ok(hint.includes('click:e1 (40%)  click link "Incompleteness theorems"'));
  ok(!hint.includes('SHRUG'));
  const prompt = page.agentPrompt(
    'Goal: x',
    menu.filter((a) => a.id !== 'SHRUG'),
    hint
  );
  ok(prompt.indexOf(hint) < prompt.indexOf('Menu:'), 'the hint comes before the menu');
});

test('factored typing offers each field once and asks for its text separately', () => {
  const shot = page.parseSnapshot(FLIGHTS);
  const candidates = ['Berlin', 'London', 'Oct 8', 'Oct 15'];
  const flat = page.buildMenu(shot, GOAL, { candidates });
  const factored = page.buildMenu(shot, GOAL, { candidates, factorText: true });
  const fields = shot.elements.filter((e) => e.kind === 'fill').length;
  is(flat.filter((a) => a.operation === 'TYPE_TEXT').length, fields * candidates.length);
  is(factored.filter((a) => a.operation === 'TYPE_TEXT').length, fields);
  const from = factored.find((a) => a.id === 'type:e22');
  is(from.text, null);
  is(from.candidates, candidates);
  const q = page.textQuestion(from);
  is(q.criteria, { t0: 'Berlin', t1: 'London', t2: 'Oct 8', t3: 'Oct 15' });
  ok(q.instructions.includes('combobox "Where from?"'));
  is(
    page.shrugReason(
      { action: { ...from, text: 'Berlin' }, confidence: 0.9, textConfidence: 0.3 },
      0.5
    ),
    'text confidence 0.30 < 0.5'
  );
});

// Captured 2026-10-01 (run 2026-10-01T17-48-12-hn-kev): Hacker News exposes
// its whole story table as one clickable row, and that row's 3,000-character
// label made a one-step decision take 10 s.
test('a container row is left out and long labels are cut', () => {
  const table = `1. upvote Clef: our open-source decision models (cloudflare.com) ${'155 points | hide | 51 comments '.repeat(80)}`;
  const shot = page.parseSnapshot(
    [
      'Page URL: https://news.ycombinator.com/',
      `  - listitem "${table}" [ref=e22] [box=0,40,1200,2000]`,
      `  - link "${'A very long story title '.repeat(8)}" [ref=e29] [box=10,60,400,20]`,
      '  - link "51 comments" [ref=e41] [box=10,80,90,20]',
    ].join('\n')
  );
  const ori = page.orient(
    { shot, viewport: { width: 1200, height: 800, scrollY: 0, scrollHeight: 3000 }, diff: null },
    { goal: 'Open the comments page of the top story', history: [], candidates: [] }
  );
  ok(!ori.menu.some((a) => a.id === 'click:e22'));
  is(ori.excluded.find((x) => x.token === 'e22').reason, 'a container: label over 200 characters');
  const title = ori.menu.find((a) => a.id === 'click:e29');
  ok(title.describe.length < 130, 'the long title is cut in the menu');
  ok(title.describe.endsWith('…"'));
  ok(ori.state.length < 900, `the state stays short (${ori.state.length} chars)`);
});

test('a failed action is reported in the history', () => {
  is(
    page.describeStep({
      operation: 'CLICK',
      role: 'button',
      label: 'Thursday, October 15, 2026 ????',
      failed: true,
    }),
    'tried to click button "Thursday, October 15, 2026 ????" but it was gone'
  );
  is(
    page.describeStep({
      operation: 'TYPE_TEXT',
      text: 'Oct 8',
      role: 'textbox',
      label: 'Departure',
      failed: true,
    }),
    'tried to type "Oct 8" into textbox "Departure" but it was gone'
  );
});

// Armchair Bike Touring (2026-10-01): the rules and the game's messages are
// page text; the decider only saw the buttons.
test('page text goes into the state, visible first, without the site chrome', () => {
  const shot = page.parseSnapshot(
    [
      'Page URL: https://www.biketouringtips.com/ArmchairBikeTouring/',
      '- rootwebarea',
      '  - navigation',
      '    - text "Home What\'s New Search Menu" [ref=e1] [box=0,0,800,20]',
      '  - main',
      '    - text "You\'ll be penalized if you ride further than 60 miles in one day." [ref=e2] [box=10,100,700,20]',
      '    - text "0: Forest Mild Uphill Town" [ref=e3] [box=10,1500,300,20]',
      '    - text "Everything\'s packed." [ref=e4] [box=10,80,300,20]',
      '    - text "Everything\'s packed." [ref=e5] [box=10,2000,300,20]',
      '    - text "hidden" [ref=e6] [box=0,0,0,0]',
      '    - button "Start Tour" [ref=e16] [box=615,351,74,22]',
    ].join('\n')
  );
  const viewport = { width: 1200, height: 800, scrollY: 0, scrollHeight: 2400 };
  is(page.pageTextLines(shot, viewport), [
    "  You'll be penalized if you ride further than 60 miles in one day.",
    "  Everything's packed.",
    '  0: Forest Mild Uphill Town',
  ]);
  const ori = page.orient(
    { shot, viewport, diff: null },
    { goal: 'Ride the tour', history: [], candidates: [] }
  );
  ok(ori.state.includes("Page text:\n  You'll be penalized"));
  ok(ori.state.indexOf('Page text:') < ori.state.indexOf('Controls:'));
  ok(
    !page
      .orient(
        { shot, viewport, diff: null },
        { goal: 'x', history: [], candidates: [], pageText: false }
      )
      .state.includes('Page text:')
  );
  const long = page.parseSnapshot(
    Array.from(
      { length: 100 },
      (_, i) => `  - text "line ${i} ${'x'.repeat(40)}" [ref=t${i}]`
    ).join('\n')
  );
  const lines = page.pageTextLines(long, null);
  ok(lines.join('').length <= 1500 + lines.length * 2, 'capped');
});

// Captured 2026-10-01 (run 2026-10-01T18-39-47-armchair-bike): kev pressed
// "Buy and Eat" three times with no food selected; the game's message sat in
// a layout row, and a 100-mile terrain list filled the page text.
test('a game message in a row is page text, and a no-effect action is marked', () => {
  const raw = [
    'Page URL: https://www.biketouringtips.com/ArmchairBikeTouring/',
    '- rootwebarea',
    '  - row "You\'re out of energy. You must stop and eat some food." [ref=e13]',
    `  - text "${Array.from({ length: 100 }, (_, i) => `${i}: Valley Flat`).join(' ')}" [ref=e40]`,
    '  - link "Pancakes (500 Cals) $3.00" [ref=e20]',
    '  - button "Buy and Eat" [ref=e56]',
  ].join('\n');
  const shot = page.parseSnapshot(raw);
  ok(!shot.elements.some((e) => e.role === 'row'), 'a row is not a control');
  const history = [{ operation: 'CLICK', role: 'button', label: 'Buy and Eat' }];
  const ori = page.orient(
    { shot, viewport: null, diff: page.diffShots(shot, shot) },
    { goal: 'Eat something', history, candidates: [] }
  );
  ok(ori.state.includes("  You're out of energy. You must stop and eat some food."));
  ok(ori.state.includes('[e56] button "Buy and Eat" (no effect last time)'));
  ok(!ori.state.includes('[e20] link "Pancakes (500 Cals) $3.00" (no effect'));
  const terrain = ori.state.split('\n').find((l) => l.startsWith('  0: Valley Flat'));
  ok(terrain.length <= 303, `one long text is cut (${terrain.length})`);
});

// Captured 2026-10-01 (run 2026-10-01T18-42-40-armchair-bike): Show details,
// Hide details, Show details... each click changed the page, so the stall
// brake never fired.
test('a page seen a few cycles ago is a circle, and the state says so', () => {
  is(page.cycleBack(['a', 'b'], 'a'), 2);
  is(page.cycleBack(['a', 'b', 'c'], 'c'), 0, 'one back is a plain stall, not a circle');
  is(page.cycleBack(['a', 'b', 'c', 'd', 'e'], 'a'), 0, 'outside the window');
  is(page.cycleBack([], 'a'), 0);
  const shot = page.parseSnapshot(
    '  - button "Show details" [ref=e18]\n  - button "Return to taking a Photo" [ref=e17]'
  );
  const history = [
    { operation: 'CLICK', role: 'button', label: 'Show details' },
    { operation: 'CLICK', role: 'button', label: 'Hide details' },
  ];
  const ori = page.orient(
    { shot, viewport: null, diff: null },
    { goal: 'Ride the tour', history, candidates: [], cycle: 2 }
  );
  ok(ori.state.includes('Going in circles: the page is back to how it was 2 steps ago.'));
  ok(ori.state.includes('[e18] button "Show details" (part of the circle)'));
  ok(!ori.state.includes('Return to taking a Photo" (part'));
});

// ── System 2 ──────────────────────────────────────────────────────────

test('the plan and notes System 2 wrote are part of System 1 state', () => {
  const shot = page.parseSnapshot(SNAPSHOT);
  const ori = page.orient(
    { shot, viewport: null, diff: null },
    {
      goal: 'Open the article',
      history: [],
      candidates: [],
      plan: ['Click Incompleteness theorems', 'Check the heading says Gödel'],
      notes: ['The Search link does nothing'],
    }
  );
  ok(
    ori.state.includes(
      'Plan:\n  1. Click Incompleteness theorems\n  2. Check the heading says Gödel'
    )
  );
  ok(ori.state.includes('Notes:\n  - The Search link does nothing'));
  ok(ori.state.indexOf('Plan:') < ori.state.indexOf('Done so far:'));
  const bare = page.orient(
    { shot, viewport: null, diff: null },
    { goal: 'x', history: [], candidates: [] }
  );
  ok(!bare.state.includes('Plan:'));
});

test('a long run keeps the last ten actions in the state', () => {
  const history = Array.from({ length: 14 }, (_, i) => ({
    operation: 'CLICK',
    role: 'button',
    label: `B${i}`,
  }));
  const state = page.compactState('g', page.parseSnapshot(SNAPSHOT), [], history);
  ok(state.includes('Done so far: (4 earlier actions) clicked button "B4"'));
  ok(!state.includes('"B3"'));
});

test('System 2 gets the trail, the plan, the notes, the hint, the images and the menu', () => {
  const menu = page.buildMenu(page.parseSnapshot(SNAPSHOT), 'x', {});
  const prompt = page.system2Prompt({
    goal: 'Eat, then ride',
    plan: ['Get Some Food', 'Start Riding'],
    notes: ['select a food item before Buy and Eat'],
    trail: [
      {
        step: 3,
        describe: 'click button "Start Riding"',
        system: 'System 1',
        confidence: 0.55,
        changes: ['  1 new control: button "Keep Riding"'],
      },
      {
        step: 4,
        describe: 'click button "Buy and Eat"',
        system: 'System 1',
        confidence: 0.66,
        outcome: 'no visible effect',
        changes: [],
      },
    ],
    hint: 'A fast model was unsure here (confidence 0.06 < 0.5).',
    state: 'Goal: Eat, then ride\nControls:\n  [e1] link "x"',
    imageCount: 2,
    menu,
  });
  ok(prompt.includes('The attached images are the page now'));
  ok(prompt.includes('then the page one step earlier'));
  ok(!prompt.includes('open --view'), 'System 2 is never told to run a command');
  ok(prompt.includes('must not run any command'));
  ok(prompt.includes('  1. Get Some Food'));
  ok(prompt.includes('  - select a food item before Buy and Eat'));
  ok(
    prompt.includes(
      '  step 3 (System 1 at 55%): click button "Start Riding"\n      1 new control: button "Keep Riding"'
    )
  );
  ok(prompt.includes('  step 4 (System 1 at 66%): click button "Buy and Eat" [no visible effect]'));
  ok(prompt.includes('A fast model was unsure here'));
  ok(prompt.includes('click:e1  click link "Incompleteness theorems"'));
  const blind = page.system2Prompt({ goal: 'g', trail: [], state: 's', menu });
  ok(blind.includes('must not run any command') && !blind.includes('attached image'));
  ok(blind.includes('(no steps yet)') && blind.includes('(none yet)'));
  const schema = page.system2Schema(menu);
  is(schema.required, ['action', 'assessment', 'plan', 'notes']);
  is(
    schema.properties.action.enum,
    menu.map((a) => a.id)
  );
});

test('System 2 plans and notes are cleaned and capped, and notes accumulate', () => {
  is(page.cleanList(['  a ', '', 3, 'b'], 5), ['a', 'b']);
  is(page.cleanList('not a list', 5), null);
  is(
    page.cleanList(
      Array.from({ length: 20 }, (_, i) => `s${i}`),
      page.MAX_PLAN
    ).length,
    page.MAX_PLAN
  );
  is(page.mergeNotes(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  const many = page.mergeNotes(
    Array.from({ length: 8 }, (_, i) => `n${i}`),
    ['new']
  );
  is(many.length, page.MAX_NOTES);
  is(many[many.length - 1], 'new', 'the newest note is kept');
  ok(page.planPrompt('g', 's', 1).includes('The attached image is the page now.'));
  ok(!page.planPrompt('g', 's', 0).includes('attached image'));
  is(page.PLAN_SCHEMA.required, ['plan', 'notes']);
});

// Captured 2026-10-01: a System 2 scoop called StructuredOutput 120+ times
// in one agent() call, one "action" per call.
test('every agent prompt says StructuredOutput is one decision, called once', () => {
  const menu = page.buildMenu(page.parseSnapshot(SNAPSHOT), 'x', {});
  for (const prompt of [
    page.agentPrompt('Goal: x', menu),
    page.system2Prompt({ goal: 'g', trail: [], state: 's', menu }),
  ]) {
    ok(prompt.includes('Call StructuredOutput exactly once: it returns ONE decision'));
  }
  ok(
    page
      .planPrompt('g', 's')
      .includes('Call StructuredOutput exactly once, with the whole plan, then stop.')
  );
});

// Captured 2026-10-01 (bike tour on slicc #3746): kev pressed "Buy and Eat"
// again right after a press that changed nothing, at 0.45, far ahead of the
// runner-up, so it did not shrug.
test('System 1 shrugs when it repeats a dead or circling control', () => {
  const shot = page.parseSnapshot(
    '  - button "Buy and Eat" [ref=e56]\n  - link "Rice and Beans (400 Cals) $2.50" [ref=e21]'
  );
  const history = [{ operation: 'CLICK', role: 'button', label: 'Buy and Eat' }];
  const ori = page.orient(
    { shot, viewport: null, diff: page.diffShots(shot, shot) },
    { goal: 'Eat', history, candidates: [] }
  );
  ok(ori.avoid.has('button|Buy and Eat'));
  const buy = ori.menu.find((a) => a.id === 'click:e56');
  const probabilities = { 'click:e56': 0.45, 'click:e21': 0.05 };
  is(
    page.shrugReason({ action: buy, confidence: 0.45, probabilities }, 0.5, { avoid: ori.avoid }),
    'picked a control that had no effect or went in circles'
  );
  is(
    page.shrugReason({ action: buy, confidence: 0.45, probabilities }, 0.5),
    '',
    'without the avoid set it stands'
  );
  const rice = ori.menu.find((a) => a.id === 'click:e21');
  is(
    page.shrugReason({ action: rice, confidence: 0.9, probabilities }, 0.5, { avoid: ori.avoid }),
    ''
  );
  const moved = page.parseSnapshot(
    '  - button "Buy and Eat" [ref=e56]\n  - text "Calories Eaten: 400" [ref=t1]'
  );
  is(
    page.avoidKeys(history, page.diffShots(shot, moved), 0).size,
    0,
    'a press that changed something is fine'
  );
  is(
    [
      ...page.avoidKeys(
        [
          { role: 'button', label: 'Show details' },
          { role: 'button', label: 'Hide details' },
        ],
        null,
        2
      ),
    ],
    ['button|Show details', 'button|Hide details']
  );
});

// Captured 2026-10-01 (run 2026-10-01T19-51-45-armchair-bike): buying food
// changed only the canvas status panel; the snapshot looked the same, so
// the state said "nothing visible" and the stall brake ended the run.
test('a change only in the pixels is not "nothing visible" and not a dead control', () => {
  const shot = page.parseSnapshot('  - button "Buy and Eat" [ref=e56]');
  const history = [{ operation: 'CLICK', role: 'button', label: 'Buy and Eat' }];
  const obs = { shot, viewport: null, diff: page.diffShots(shot, shot) };
  const canvas = page.orient(obs, { goal: 'Eat', history, candidates: [], pixelsChanged: true });
  ok(canvas.state.includes('the page looks different, but no control or text changed'));
  ok(!canvas.state.includes('(no effect last time)'));
  is(canvas.avoid.size, 0);
  const dead = page.orient(obs, { goal: 'Eat', history, candidates: [] });
  ok(dead.state.includes('nothing visible'));
  ok(dead.avoid.has('button|Buy and Eat'));
});

// Kittens Game and A Dark Room (probed 2026-10-02): the buttons are divs.
// The accessibility tree merged "Gather catnip Refine catnip" into one text
// node with no box, so the page reports its clickable elements instead.
test('clickable elements the snapshot does not show become synthetic buttons', () => {
  const shot = page.parseSnapshot(
    [
      'Page URL: https://kittensgame.com/web/',
      '- rootwebarea',
      '  - text "Gather catnip Refine catnip" [ref=e32]',
      '  - link "Save" [ref=e3] [box=200,10,40,18]',
    ].join('\n')
  );
  const viewport = { width: 1024, height: 576, scrollY: 0, scrollHeight: 576 };
  const found = [
    { t: 'Gather catnip', b: [362, 117, 266, 38] },
    { t: 'Refine catnip', b: [661, 117, 266, 38] },
    { t: 'Save', b: [200, 10, 40, 18] },
    { t: 'whole page', b: [0, 0, 1024, 576] },
    { t: 'x'.repeat(80), b: [10, 300, 50, 20] },
  ];
  const promoted = page.promoteClickable(shot, found, viewport);
  const added = promoted.elements.filter((e) => e.synthetic);
  is(
    added.map((e) => [e.token, e.label, e.role, e.kind]),
    [
      ['c1', 'Gather catnip', 'button', 'click'],
      ['c2', 'Refine catnip', 'button', 'click'],
    ],
    'a real control (Save), a page-sized box and a long text are left out'
  );
  is(added[0].box, [362, 117, 266, 38]);
  const menu = page.buildMenu(promoted, 'Gather catnip', {});
  ok(menu.some((a) => a.id === 'click:c1' && a.describe === 'click button "Gather catnip"'));
  is(page.promoteClickable(shot, [], viewport), shot, 'nothing found, no change');
});

// Drug Wars (probed 2026-10-02): every drug row has the same BUY and MAX buttons.
test('controls that share a label carry the text of their row', () => {
  const shot = page.parseSnapshot(
    [
      'Page URL: https://drugwars.online/game',
      '- rootwebarea',
      '  - button "BUY" [ref=e10] [box=600,100,50,20]',
      '  - text "Heroin $6,037" [ref=e11] [box=60,100,160,20]',
      '  - button "BUY" [ref=e18] [box=600,140,50,20]',
      '  - text "Acid $2,758" [ref=e19] [box=60,140,160,20]',
      '  - text "1" [ref=e14] [box=500,140,10,20]',
      '  - button "Jet" [ref=e90] [box=60,400,60,20]',
    ].join('\n')
  );
  const out = page.addRowContext(shot.elements, shot.texts);
  is(out.find((e) => e.token === 'e10').context, 'Heroin $6,037');
  is(
    out.find((e) => e.token === 'e18').context,
    'Acid $2,758',
    'a digit-only text does not count as the row'
  );
  is(out.find((e) => e.token === 'e90').context, undefined, 'a unique label needs no row');
  const ori = page.orient(
    { shot, viewport: { width: 1024, height: 576, scrollY: 0, scrollHeight: 576 }, diff: null },
    { goal: 'Buy Acid', history: [], candidates: [] }
  );
  ok(ori.menu.some((a) => a.describe === 'click button "BUY" in row "Acid $2,758"'));
  ok(ori.state.includes('[e10] button "BUY" in row "Heroin $6,037"'));
});

test('oversight: a small base chance, more after a big change or a long calm', () => {
  is(page.oversightChance(0.01, []), { chance: 0.01, reason: 'base 0.01' });
  const big = page.oversightChance(0.01, [0.1, 0.9]);
  is(big.chance, 0.26);
  ok(big.reason.includes('the page just changed a lot'));
  const calm = page.oversightChance(0.01, [0.6, 0, 0.01, 0, 0, 0.02, 0]);
  is(calm.chance, 0.05, '6 calm turns: base 0.01 + 2 x 0.02');
  ok(calm.reason.includes('6 turns with almost no change'));
  is(page.oversightChance(0.01, Array(100).fill(0)).chance, 0.31, 'the calm boost is capped');
  is(page.oversightChance(0.4, [1, ...Array(40).fill(0)]).chance, 0.5, 'the total is capped');
  is(page.oversightChance(0, [1]).chance, 0, 'off is off');
});

test('change magnitude: a new page is 1, a quiet page 0', () => {
  const shot = page.parseSnapshot(SNAPSHOT);
  is(page.changeMagnitude(null, 4), 0);
  is(page.changeMagnitude(page.diffShots(shot, shot), 4), 0);
  const moved = page.parseSnapshot(SNAPSHOT.replace('[ref=e3]: ""', '[ref=e3]: "London"'));
  is(page.changeMagnitude(page.diffShots(shot, moved), 4), 0.25);
  const elsewhere = { ...moved, url: 'https://other.example/' };
  is(page.changeMagnitude(page.diffShots(shot, elsewhere), 4), 1);
});

test('the seeded generator replays and the audit hint says System 1 was sure', () => {
  const a = page.seededRandom(42);
  const b = page.seededRandom(42);
  is([a(), a(), a()], [b(), b(), b()]);
  ok(page.seededRandom(7)() !== page.seededRandom(8)());
  const menu = page.buildMenu(page.parseSnapshot(SNAPSHOT), 'x', {});
  const click = menu.find((a) => a.id === 'click:e1');
  const hint = page.oversightHint({ action: click, confidence: 0.93 }, 'base 0.01', menu);
  ok(
    hint.startsWith(
      'Routine review (base 0.01): the fast model was not unsure; it chose click:e1 at 93%'
    )
  );
  ok(hint.includes('Keep that choice if it is right'));
});
