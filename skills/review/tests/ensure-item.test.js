import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Behaviour tests for the `ensure-item` inbound-message handler in
// templates/review.shtml, run with:
//
//   node --test skills/review/tests/ensure-item.test.js
//
// The template is a sprinkle (.shtml), so there is no module to require. The
// handler branch is extracted from the template source and compiled in isolation
// against a stub panel state — the same "compile the real source string" approach
// used by skills/github/tests/pr-watch-filter.test.js. Extracting the branch from
// the shipped file (rather than copying it here) keeps the test honest: if the
// branch is renamed or removed, extraction fails and the test fails.

const TEMPLATE = path.join(__dirname, '..', 'templates', 'review.shtml');

/** Pull the body of the `ensure-item` branch out of the template source. */
function extractEnsureItemBody() {
  const lines = fs.readFileSync(TEMPLATE, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes("msg.action === 'ensure-item'"));
  ok(start >= 0, 'ensure-item branch not found in template');
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '  }') {
      end = i;
      break;
    }
  }
  ok(end > start, 'end of ensure-item branch not found');
  return lines.slice(start + 1, end).join('\n');
}

/**
 * Compile the extracted branch into a function over a stub panel environment.
 * Returns { send, state, renders, saves }.
 */
function makeHandler(initialState) {
  const body = extractEnsureItemBody();
  const counters = { renders: 0, saves: 0, views: [] };
  const state = initialState;
  const saveState = () => {
    counters.saves++;
  };
  const renderQueue = () => {
    counters.renders++;
    // Mirror the real renderQueue: cards are rebuilt from state.items and their
    // comment logs are re-read from state.comments, which must be left intact.
    counters.renderedComments = JSON.parse(JSON.stringify(state.comments || {}));
  };
  const showView = (v) => {
    counters.views.push(v);
  };
  const fn = new Function('msg', 'state', 'saveState', 'renderQueue', 'showView', body);
  return {
    send: (msg) => fn(msg, state, saveState, renderQueue, showView),
    state,
    counters,
  };
}

const baseItem = {
  id: 'page-1',
  title: 'Security Page',
  path: '/shared/unreadable/security.md',
  previewUrl: 'https://preview.example.com/security',
  liveUrl: 'https://www.example.com/security',
  status: 'published',
};

test('creates a card when the id is unknown', () => {
  const h = makeHandler({ items: [], comments: {}, view: 'queue' });
  h.send({
    action: 'ensure-item',
    id: 'page-2',
    title: 'New Page',
    path: '/shared/new.md',
    previewUrl: 'https://preview.example.com/new',
  });

  is(h.state.items.length, 1);
  is(h.state.items[0], {
    id: 'page-2',
    title: 'New Page',
    path: '/shared/new.md',
    previewUrl: 'https://preview.example.com/new',
    liveUrl: '',
    status: 'pending',
  });
  is(h.counters.renders, 1);
  is(h.counters.saves, 1);
});

test('updates an existing card in place (the upsert half of the contract)', () => {
  const h = makeHandler({
    items: [{ ...baseItem }],
    comments: {},
    view: 'queue',
  });
  h.send({
    action: 'ensure-item',
    id: 'page-1',
    path: '/shared/readable/security.md',
  });

  is(h.state.items.length, 1, 'no duplicate card is created');
  is(h.state.items[0].path, '/shared/readable/security.md');
  is(h.counters.renders, 1, 'the change is re-rendered');
  is(h.counters.saves, 1, 'the change is persisted');
});

test('leaves unsupplied fields and status untouched', () => {
  const h = makeHandler({ items: [{ ...baseItem }], comments: {}, view: 'queue' });
  h.send({ action: 'ensure-item', id: 'page-1', path: '/shared/readable/security.md' });

  const item = h.state.items[0];
  is(item.title, baseItem.title);
  is(item.previewUrl, baseItem.previewUrl);
  is(item.liveUrl, baseItem.liveUrl);
  is(item.status, 'published', 'status must never be reset by ensure-item');
});

test('updates every supplied field, including empty strings', () => {
  const h = makeHandler({ items: [{ ...baseItem }], comments: {}, view: 'queue' });
  h.send({
    action: 'ensure-item',
    id: 'page-1',
    title: 'Security Page (v2)',
    path: '',
    previewUrl: 'https://preview.example.com/security-v2',
    liveUrl: '',
  });

  is(h.state.items[0], {
    id: 'page-1',
    title: 'Security Page (v2)',
    path: '',
    previewUrl: 'https://preview.example.com/security-v2',
    liveUrl: '',
    status: 'published',
  });
});

test('does not disturb other items in the queue', () => {
  const other = { ...baseItem, id: 'pr-42', title: 'PR #42', status: 'deferred' };
  const h = makeHandler({ items: [{ ...baseItem }, other], comments: {}, view: 'queue' });
  h.send({ action: 'ensure-item', id: 'page-1', title: 'Renamed' });

  is(h.state.items.length, 2);
  is(h.state.items[1], other);
});

test('preserves comments already attached to the card', () => {
  const comments = {
    'page-1': [
      { text: '📍 PIN #1: tighten the hero copy', num: 1, time: '10:00' },
      { text: 'looks good otherwise', time: '10:01' },
    ],
  };
  const h = makeHandler({ items: [{ ...baseItem }], comments, view: 'queue' });
  h.send({ action: 'ensure-item', id: 'page-1', path: '/shared/readable/security.md' });

  is(h.state.comments, comments, 'comment log survives the update');
  is(
    h.counters.renderedComments,
    comments,
    'the re-render still has the comments to draw'
  );
});

test('initialises a missing items array', () => {
  const h = makeHandler({ comments: {}, view: 'queue' });
  h.send({ action: 'ensure-item', id: 'page-9', title: 'Nine' });
  is(h.state.items.length, 1);
});

test('does not switch away from the document view', () => {
  const h = makeHandler({ items: [{ ...baseItem }], comments: {}, view: 'document' });
  h.send({ action: 'ensure-item', id: 'page-1', title: 'Renamed' });
  is(h.counters.views, [], 'document view is left alone');

  const q = makeHandler({ items: [{ ...baseItem }], comments: {}, view: 'queue' });
  q.send({ action: 'ensure-item', id: 'page-1', title: 'Renamed' });
  is(q.counters.views, ['queue']);
});

test('ensure-item copies cone onto the open document snapshot of the same card', () => {
  const open = {
    id: 'page-1',
    path: '/preview-override.md',
    title: 'Override',
    cone: 'cone-old',
  };
  const h = makeHandler({
    items: [{ ...baseItem, cone: 'cone-old' }],
    comments: {},
    view: 'document',
    docItem: open,
  });
  h.send({ action: 'ensure-item', id: 'page-1', cone: 'cone-adobe' });
  is(h.state.items[0].cone, 'cone-adobe');
  is(h.state.docItem.cone, 'cone-adobe');
  is(h.state.docItem.path, '/preview-override.md', 'open-file path overlay is left alone');
  is(h.state.docItem.title, 'Override');
  is(h.counters.views, [], 'document view is left alone');
});

test('ensure-item does not retarget a different open document', () => {
  const h = makeHandler({
    items: [{ ...baseItem }],
    comments: {},
    view: 'document',
    docItem: { id: 'other', cone: 'cone-keep' },
  });
  h.send({ action: 'ensure-item', id: 'page-1', cone: 'cone-adobe' });
  is(h.state.items[0].cone, 'cone-adobe');
  is(h.state.docItem.cone, 'cone-keep');
});

test('stores a supplied cone on create and does not drop it on later enrichment', () => {
  const h = makeHandler({ items: [], comments: {}, view: 'queue' });
  h.send({ action: 'ensure-item', id: 'page-1', title: 'Security Page', cone: 'cone-adobe' });
  is(h.state.items[0].cone, 'cone-adobe');
  h.send({ action: 'ensure-item', id: 'page-1', path: '/shared/readable/security.md' });
  is(h.state.items[0].cone, 'cone-adobe', 'omitting cone must not drop the filing owner');
  h.send({ action: 'ensure-item', id: 'page-1', cone: 'cone-helix' });
  is(h.state.items[0].cone, 'cone-helix', 'a supplied cone is written like other allowlisted fields');
});

test('unknown fields stay dropped; cone is allowlisted', () => {
  const h = makeHandler({ items: [], comments: {}, view: 'queue' });
  h.send({
    action: 'ensure-item',
    id: 'page-1',
    title: 'Security Page',
    cone: 'cone-adobe',
    mystery: 'nope',
  });
  is(h.state.items[0].cone, 'cone-adobe');
  is(h.state.items[0].mystery, undefined);
});

test('primary action labels survive enrichment and can be replaced or reset', () => {
  const h = makeHandler({ items: [], comments: {}, view: 'queue' });
  h.send({ action: 'ensure-item', id: 'page', primaryActionLabel: 'Publish' });
  is(h.state.items[0].primaryActionLabel, 'Publish');
  h.send({ action: 'ensure-item', id: 'page', title: 'Enriched page' });
  is(h.state.items[0].primaryActionLabel, 'Publish');
  h.send({ action: 'ensure-item', id: 'page', primaryActionLabel: 'Accept' });
  is(h.state.items[0].primaryActionLabel, 'Accept');
  h.send({ action: 'ensure-item', id: 'page', primaryActionLabel: '' });
  is(h.state.items[0].primaryActionLabel, '');
});
