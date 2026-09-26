import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Behaviour tests for the `add-findings` / `clear-findings` inbound-message
// handlers in templates/review.shtml, run with:
//
//   node --test skills/review/tests/add-findings.test.js
//
// Same extract-and-compile approach as ensure-item.test.js.

const TEMPLATE = path.join(__dirname, '..', 'templates/review.shtml');

function extractBranch(action) {
  const src = fs.readFileSync(TEMPLATE, 'utf8');
  const needle = "msg.action === '" + action + "'";
  const start = src.indexOf(needle);
  ok(start >= 0, action + ' branch not found in template');
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
  ok(end > brace, 'end of ' + action + ' branch not found');
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

test('add-findings keeps a supplied cone when it creates a missing card', () => {
  const h = makeHandler('add-findings', { items: [], findings: {}, view: 'queue' });
  h.send({
    action: 'add-findings',
    id: 'page-1',
    source: 'pangram',
    summary: 'Human',
    cone: 'cone-adobe',
    findings: [],
  });
  is(h.state.items[0].cone, 'cone-adobe');
});

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
  is(h.state.items.length, 1);
  is(h.state.items[0].id, 'page-1');
  is(h.state.items[0].status, 'pending');
  is(h.state.findings['page-1'].pangram.summary, 'Human');
  is(h.counters.saves, 1);
  is(h.counters.renders, 1);
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
  is(h.state.findings['page-1'].pangram.summary, 'AI · 100%');
  is(h.state.findings['page-1'].pangram.severity, 'fail');
  is(h.state.findings['page-1']['check-llm-cliches'].summary, '4 matches');
  is(h.state.items[0].status, 'pending');
});

test('add-findings ignores a message without source', () => {
  const h = makeHandler('add-findings', { items: [], findings: {}, view: 'queue' });
  h.send({ action: 'add-findings', id: 'page-1', summary: 'nope' });
  is(h.state.items.length, 0);
  is(h.state.findings, {});
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
  is(h.state.findings['page-1'].pangram, undefined);
  is(h.state.findings['page-1']['check-llm-cliches'].summary, 'clean');
});

test('clear-findings without source drops the card bucket', () => {
  const h = makeHandler('clear-findings', {
    items: [{ id: 'page-1' }],
    findings: { 'page-1': { pangram: { summary: 'Human' } } },
  });
  h.send({ action: 'clear-findings', id: 'page-1' });
  is(h.state.findings['page-1'], undefined);
});
