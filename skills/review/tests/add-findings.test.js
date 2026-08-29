// Behaviour tests for the `add-findings` / `clear-findings` inbound-message
// handlers in templates/review.shtml, run with:
//
//   node --test skills/review/tests/add-findings.test.js
//
// Same extract-and-compile approach as ensure-item.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', 'templates/review.shtml');

function extractBranch(action) {
  const src = fs.readFileSync(TEMPLATE, 'utf8');
  const needle = "msg.action === '" + action + "'";
  const start = src.indexOf(needle);
  assert.ok(start >= 0, action + ' branch not found in template');
  const brace = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > brace, 'end of ' + action + ' branch not found');
  return src.slice(brace + 1, end);
}

function makeHandler(action, initialState) {
  const body = extractBranch(action);
  const counters = { renders: 0, saves: 0, views: [] };
  const state = initialState;
  const saveState = () => {
    counters.saves++;
  };
  const renderQueue = () => {
    counters.renders++;
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

test('add-findings creates a card when the id is unknown', () => {
  const h = makeHandler('add-findings', { items: [], findings: {}, view: 'queue' });
  h.send({
    action: 'add-findings',
    id: 'page-1',
    source: 'pangram',
    summary: 'Human',
    severity: 'info',
    findings: [],
  });
  assert.equal(h.state.items.length, 1);
  assert.equal(h.state.items[0].id, 'page-1');
  assert.equal(h.state.items[0].status, 'pending');
  assert.equal(h.state.findings['page-1'].pangram.summary, 'Human');
  assert.equal(h.counters.saves, 1);
  assert.equal(h.counters.renders, 1);
});

test('add-findings replaces one source and leaves the other', () => {
  const h = makeHandler('add-findings', {
    items: [{ id: 'page-1', title: 'Sec', status: 'pending' }],
    findings: {
      'page-1': {
        pangram: { summary: 'old', severity: 'info', findings: [] },
        'check-llm-cliches': { summary: '4 matches', severity: 'warn', findings: [{ title: 'no-chain' }] },
      },
    },
    view: 'queue',
  });
  h.send({
    action: 'add-findings',
    id: 'page-1',
    source: 'pangram',
    summary: 'AI · 100%',
    severity: 'fail',
    findings: [{ title: 'AI-Generated', body: 'High confidence' }],
  });
  assert.equal(h.state.findings['page-1'].pangram.summary, 'AI · 100%');
  assert.equal(h.state.findings['page-1'].pangram.severity, 'fail');
  assert.equal(h.state.findings['page-1']['check-llm-cliches'].summary, '4 matches');
  assert.equal(h.state.items[0].status, 'pending');
});

test('add-findings ignores a message without source', () => {
  const h = makeHandler('add-findings', { items: [], findings: {}, view: 'queue' });
  h.send({ action: 'add-findings', id: 'page-1', summary: 'nope' });
  assert.equal(h.state.items.length, 0);
  assert.deepEqual(h.state.findings, {});
});

test('clear-findings drops one source', () => {
  const h = makeHandler('clear-findings', {
    items: [{ id: 'page-1' }],
    findings: {
      'page-1': {
        pangram: { summary: 'Human' },
        'check-llm-cliches': { summary: 'clean' },
      },
    },
  });
  h.send({ action: 'clear-findings', id: 'page-1', source: 'pangram' });
  assert.equal(h.state.findings['page-1'].pangram, undefined);
  assert.equal(h.state.findings['page-1']['check-llm-cliches'].summary, 'clean');
});

test('clear-findings without source drops the card bucket', () => {
  const h = makeHandler('clear-findings', {
    items: [{ id: 'page-1' }],
    findings: { 'page-1': { pangram: { summary: 'Human' } } },
  });
  h.send({ action: 'clear-findings', id: 'page-1' });
  assert.equal(h.state.findings['page-1'], undefined);
});
