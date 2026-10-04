// The defects the BU Bench V2.1 explore-40 losses showed (2026-10-04), one
// test each. Fixtures are made up; no task text.
import test, { is, ok } from 'tst';
import * as intentMod from '../scripts/intent.js';
import * as snapshotMod from '../scripts/snapshot.js';
import * as scanMod from '../scripts/page-scan.js';
import * as armMod from '../scripts/arm.js';

const lib = intentMod.default || intentMod;
const page = snapshotMod.default || snapshotMod;
const scan = scanMod.default || scanMod;
const arm = armMod.default || armMod;

// A results page whose product cards are links named by all of their text:
// a hidden "Report item" button, the title, price, rating and sales.
const TITLE =
  'Brass Desk Lamp with Adjustable Arm, Warm White LED, Touch Dimmer, USB Charging Port, Eye-Caring Reading Light for Study, Office, Bedroom and Dorm, 3 Colour Modes and 10 Brightness Levels';
const CARD = `Report item ${TITLE} $24.99 4.8 3,000+ sold Free shipping`;
const SHOP = [
  'Page URL: https://shop.example/search?q=desk+lamp',
  'Page Title: desk lamp - Shop',
  '- rootwebarea',
  '  - link "Help" [ref=e1] [box=10,10,40,20]',
  '  - button "Sort by price" [ref=e2] [box=60,10,80,20]',
  `  - link "${CARD}" [ref=e3] [box=10,60,300,400]`,
  `    - heading "${TITLE}" [ref=e4]`,
  '  - link "Report item Plain Lamp $9.99 4.1 20 sold" [ref=e5] [box=320,60,300,400]',
  '  - textbox [ref=e6] [box=10,500,200,20]',
].join('\n');

test('1: a control with a long name stays a candidate, shown short', () => {
  const { elements } = page.parseSnapshot(SHOP);
  const cands = lib.controlCandidates(elements, null);
  const card = cands.find((c) => c.ref === 'e3');
  ok(CARD.length > 200 && card, `the ${CARD.length}-character card link is a candidate`);
  const shown = lib.describeControl(card);
  ok(shown.length < 140 && shown.includes('…'), shown);
  // Matching still uses the whole name: words from the end of it rank it first.
  const ranked = lib.lexicalRank(cands, 'click the lamp with 3,000+ sold');
  is(ranked[0].candidate.ref, 'e3');
  const listed = lib.listLines('list the links that mention Brass', elements, []);
  is(listed.lines.length, 1);
  ok(listed.lines[0].startsWith('  e3 link'), listed.lines[0]);
});

test('2: a content-named control is found by the text it contains', () => {
  // What the page offers for the card: aria-label none, innerText without
  // the visually hidden "Report item" button, textContent with it.
  const shownText = `${TITLE}\n$24.99\n4.8\n3,000+ sold\nFree shipping`;
  is(scan.nameScore(CARD, [shownText]) > 0, true);
  is(scan.nameScore(CARD, [`Report item ${shownText}`]), 3);
  // Short or unrelated text does not count as the same control.
  is(scan.nameScore(CARD, ['Free shipping']), 0);
  is(scan.nameScore(CARD, ['Help']), 0);
  is(scan.nameScore('Help', ['Help']), 3);
  // The page's own text of the card: no hidden prefix, two hidden captions
  // after it, and textContent runs adjacent texts together.
  const pageText = `${TITLE} $24.99 4.8 3,000+ sold Free shipping Show preview Similar items`;
  is(scan.nameScore(CARD, [pageText]) > 0, true);
  is(scan.nameScore(CARD, [`${TITLE} $24.994.83,000+ soldFree shipping`]) > 0, true);
  // Another card of the same seller is not this one.
  is(scan.nameScore(CARD, ['Report item Brass Floor Lamp, Tripod Stand, Linen Shade $89.00 4.6 120 sold Free shipping']), 0);
  // The better of two candidates: the card itself over a lone price.
  ok(scan.nameScore(CARD, [shownText]) > scan.nameScore(CARD, ['$24.99']));
});

test('3: links carry their URLs, and a URL question lists them', () => {
  const { elements } = page.parseSnapshot(SHOP);
  const anchors = [
    { name: 'Help', href: 'https://shop.example/help' },
    { name: `${TITLE} $24.99 4.8 3,000+ sold Free shipping`, href: 'https://shop.example/item/1001.html' },
    { name: 'Plain Lamp $9.99 4.1 20 sold', href: 'https://shop.example/item/1002.html' },
  ];
  const linked = lib.applyLinks(elements, anchors);
  is(linked.find((e) => e.token === 'e3').href, 'https://shop.example/item/1001.html');
  is(linked.find((e) => e.token === 'e5').href, 'https://shop.example/item/1002.html');
  is(linked.find((e) => e.token === 'e1').href, 'https://shop.example/help');
  ok(lib.isList('what is the URL of the Brass Desk Lamp link?'));
  ok(lib.listWantsControls('what are the URLs of the product links?'));
  const listed = lib.listLines('what is the URL of the Brass lamp link?', linked, []);
  ok(listed.lines[0].includes('https://shop.example/item/1001.html'), listed.lines[0]);
});

test('4: a tab a click opened is the new one in the tab list', () => {
  const before = ['AAA111', 'BBB222'];
  is(lib.openedTab(before, ['AAA111', 'BBB222', 'CCC333']), 'CCC333');
  is(lib.openedTab(before, ['AAA111', 'BBB222']), null);
  is(lib.openedTab(before, ['AAA111']), null);
  // playwright-cli tab-list: one tab per line, its target id in brackets.
  const ids = lib.tabIds('[AAA111] https://shop.example/ "Shop"\n[CCC333] https://shop.example/item/1 "Item [new]"');
  is(ids, ['AAA111', 'CCC333']);
});

test('5: a field shows its placeholder, type and required flag', () => {
  const { elements } = page.parseSnapshot(SHOP);
  const scanned = [{ role: 'textbox', name: '', state: 'placeholder "E-Mail", email, required' }];
  const withStates = lib.applyStates(elements, scanned);
  const field = withStates.find((e) => e.token === 'e6');
  is(field.state, 'placeholder "E-Mail", email, required');
  const line = lib.describeControl(lib.controlCandidates([field], null)[0]);
  ok(line.includes('placeholder "E-Mail"') && line.includes('required'), line);
});

test('6: a --ref that contradicts the words of the intent is refused', () => {
  const option = { token: 'e53', role: 'option', label: '฿ 2,500,000', kind: 'click' };
  const search = { token: 'e94', role: 'button', label: 'Search', kind: 'click' };
  const next = { token: 'e30', role: 'button', label: '›', kind: 'click' };
  const card = { token: 'e3', role: 'link', label: CARD, kind: 'click' };
  const field = { token: 'e4', role: 'textbox', label: 'textbox', kind: 'fill' };
  const onPage = [option, search, next, card, field];
  ok(lib.refConflict('click the Search button', option, onPage), 'the page has a Search button, and e53 is not it');
  is(lib.refConflict('click this', option, onPage), null);
  is(lib.refConflict('select 2,500,000 as the maximum price', option, onPage), null);
  is(lib.refConflict('click the Search button', search, onPage), null);
  is(lib.refConflict('click the first product card', card, onPage), null);
  is(lib.refConflict('open the Brass lamp listing', card, onPage), null);
  // Words no control on the page has say nothing against the ref: an icon's label differs from its meaning.
  is(lib.refConflict('click the next page arrow', next, onPage), null);
  // The text to type is not the field's name.
  is(lib.refConflict('type "Search" into the first textbox', field, onPage), null);
  is(lib.refConflict('press Enter', option, onPage), null);
});

test('date: the arms may read the clock', () => {
  ok(arm.UTILITIES.includes('date'), arm.UTILITIES.join(','));
});
