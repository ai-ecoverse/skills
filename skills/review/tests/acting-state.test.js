// Behaviour tests for the in-flight ("acting") card state in
// templates/review.shtml, run with:
//
//   node --test skills/review/tests/acting-state.test.js
//
// A publish/defer click marks the card busy until the cone answers with
// `update-status`. The marker itself is DOM-only, so any full re-render (from
// `load-items` or `ensure-item`) used to drop it and re-enable the buttons,
// allowing a duplicate lick. The template now records the acting ids in a
// non-persisted `actingItems` set and reapplies the marker per card on render.
//
// As in ensure-item.test.js, the real functions are extracted from the shipped
// template and compiled against stubs, rather than copied here.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'review.shtml');
const source = fs.readFileSync(TEMPLATE, 'utf8');

/** Extract a top-level `function name(...) { ... }` declaration by name. */
function extractFunction(name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith('function ' + name + '('));
  assert.ok(start >= 0, name + ' not found in template');
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  assert.ok(end > start, 'end of ' + name + ' not found');
  return lines.slice(start, end + 1).join('\n');
}

/** A stand-in for a rendered card: just enough classList / button surface. */
function fakeCard() {
  const classes = new Set();
  const buttons = [{ disabled: false }, { disabled: false }, { disabled: false }];
  const classList = {
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
  };
  return {
    card: { classList, querySelectorAll: () => buttons },
    dot: { classList: { toggle: classList.toggle } },
    buttons,
    classes,
  };
}

/**
 * Compile the template's real setItemActing/applyItemActing over stub state, and
 * a render step that mirrors renderQueue/createItemCard (prune + reapply).
 */
function makePanel(items) {
  const cardElements = new Map();
  const actingItems = new Set();
  const body = [extractFunction('setItemActing'), extractFunction('applyItemActing')].join('\n');
  const compile = new Function(
    'cardElements',
    'actingItems',
    body + '\nreturn { setItemActing, applyItemActing };'
  );
  const { setItemActing, applyItemActing } = compile(cardElements, actingItems);

  const state = { items };
  const render = () => {
    // Mirrors renderQueue(): stale in-flight ids are pruned, all cards rebuilt.
    [...actingItems].forEach((id) => {
      if (!state.items.some((i) => i.id === id)) actingItems.delete(id);
    });
    cardElements.clear();
    for (const item of state.items) {
      cardElements.set(item.id, fakeCard());
      // Mirrors createItemCard()'s reapply step.
      if (actingItems.has(item.id)) applyItemActing(item.id, true);
    }
  };
  render();
  return { state, cardElements, actingItems, setItemActing, render };
}

const ITEMS = [
  { id: 'page-1', title: 'Security Page', status: 'pending' },
  { id: 'pr-42', title: 'PR #42', status: 'pending' },
];

test('marking a card acting disables its actions', () => {
  const p = makePanel(ITEMS.map((i) => ({ ...i })));
  p.setItemActing('page-1', true);

  const el = p.cardElements.get('page-1');
  assert.equal(el.classes.has('acting'), true);
  assert.equal(
    el.buttons.every((b) => b.disabled),
    true
  );
  assert.equal(p.actingItems.has('page-1'), true);
});

test('a re-render keeps an in-flight card busy (the P2 regression)', () => {
  const p = makePanel(ITEMS.map((i) => ({ ...i })));
  p.setItemActing('page-1', true);

  // An ensure-item arrives before update-status: every card is rebuilt.
  p.render();

  const el = p.cardElements.get('page-1');
  assert.equal(el.classes.has('acting'), true, 'busy marker survives the render');
  assert.equal(
    el.buttons.every((b) => b.disabled),
    true,
    'no duplicate publish/defer lick is possible'
  );
});

test('a re-render does not make other cards busy', () => {
  const p = makePanel(ITEMS.map((i) => ({ ...i })));
  p.setItemActing('page-1', true);
  p.render();

  const other = p.cardElements.get('pr-42');
  assert.equal(other.classes.has('acting'), false);
  assert.equal(
    other.buttons.some((b) => b.disabled),
    false
  );
});

test('clearing the in-flight state re-enables the actions', () => {
  const p = makePanel(ITEMS.map((i) => ({ ...i })));
  p.setItemActing('page-1', true);
  p.setItemActing('page-1', false);
  p.render();

  const el = p.cardElements.get('page-1');
  assert.equal(el.classes.has('acting'), false);
  assert.equal(p.actingItems.has('page-1'), false);
  assert.equal(
    el.buttons.some((b) => b.disabled),
    false
  );
});

test('an item dropped from the queue loses its in-flight marker', () => {
  const p = makePanel(ITEMS.map((i) => ({ ...i })));
  p.setItemActing('page-1', true);

  // load-items replaces the queue without page-1 ...
  p.state.items = [{ id: 'pr-42', title: 'PR #42', status: 'pending' }];
  p.render();
  assert.equal(p.actingItems.has('page-1'), false, 'stale marker pruned');

  // ... and a later re-add must not come back busy.
  p.state.items.push({ id: 'page-1', title: 'Security Page', status: 'pending' });
  p.render();
  assert.equal(p.cardElements.get('page-1').classes.has('acting'), false);
});

test('setItemActing on an unrendered id records without throwing', () => {
  const p = makePanel(ITEMS.map((i) => ({ ...i })));
  p.setItemActing('not-rendered', true);
  assert.equal(p.actingItems.has('not-rendered'), true);
  // The id is not in state.items, so the next render prunes it.
  p.render();
  assert.equal(p.actingItems.has('not-rendered'), false);
});

// ── Source-level assertions: the mechanism must be wired into the real paths ──

test('renderQueue prunes stale in-flight ids', () => {
  const renderQueue = extractFunction('renderQueue');
  assert.match(renderQueue, /\[\.\.\.actingItems\]\.forEach/);
  assert.match(renderQueue, /actingItems\.delete\(id\)/);
});

test('createItemCard reapplies the marker for in-flight items', () => {
  const createItemCard = extractFunction('createItemCard');
  assert.match(
    createItemCard,
    /if \(actingItems\.has\(item\.id\)\) applyItemActing\(item\.id, true\)/
  );
});

test('update-status clears the in-flight record', () => {
  const updateItemStatus = extractFunction('updateItemStatus');
  assert.match(updateItemStatus, /actingItems\.delete\(id\)/);
});

test('the in-flight set is not part of persisted state', () => {
  // saveState() persists `state`; a busy card must not survive a reload, because
  // there is no in-flight lick left to answer it.
  assert.match(source, /^const actingItems = new Set\(\);$/m);
  assert.doesNotMatch(source, /state\.actingItems/);
  assert.doesNotMatch(source, /actingItems:/);
});
