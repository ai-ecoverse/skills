// Cone-bound lick targeting in templates/review.shtml (slicc#3212 Layer C).
// Run with:
//
//   node --test skills/review/tests/lick-target.test.js
//
// Publish / defer / comment / submit-revisions pass the card's filing cone as
// Layer-B `target`. Scoop-local actions (toggle-review-mode, toggle-speck,
// pins) omit it.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'review.shtml');
const source = fs.readFileSync(TEMPLATE, 'utf8');

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

function makeLickBound() {
  const calls = [];
  const slicc = { lick: (event) => calls.push(event) };
  const fn = new Function('slicc', extractFunction('lickBound') + '\nreturn lickBound;');
  return { lickBound: fn(slicc), calls };
}

test('lickBound stamps target only when the card has a filing cone', () => {
  const { lickBound, calls } = makeLickBound();
  lickBound('publish', { id: 'page-1' }, 'cone-adobe');
  lickBound('defer', { id: 'page-1' }, undefined);
  lickBound('comment', { id: 'page-1', comment: 'nits' }, '');
  assert.deepEqual(calls[0], { action: 'publish', data: { id: 'page-1' }, target: 'cone-adobe' });
  assert.deepEqual(calls[1], { action: 'defer', data: { id: 'page-1' } });
  assert.deepEqual(calls[2], { action: 'comment', data: { id: 'page-1', comment: 'nits' } });
});

test('publish and defer pass the card cone through handleItemAction', () => {
  const { lickBound, calls } = makeLickBound();
  const acting = [];
  const setItemActing = (id, on) => acting.push([id, on]);
  const state = { items: [{ id: 'page-1', path: '/shared/a.md', liveUrl: '', previewUrl: '', cone: 'cone-helix' }] };
  const body = extractFunction('handleItemAction');
  const handleItemAction = new Function(
    'state',
    'setItemActing',
    'lickBound',
    body + '\nreturn handleItemAction;'
  )(state, setItemActing, lickBound);

  handleItemAction('publish', 'page-1');
  handleItemAction('defer', 'page-1');
  assert.deepEqual(acting, [
    ['page-1', true],
    ['page-1', true],
  ]);
  assert.equal(calls[0].action, 'publish');
  assert.equal(calls[0].target, 'cone-helix');
  assert.equal(calls[1].action, 'defer');
  assert.equal(calls[1].target, 'cone-helix');
});

test('cone-bound call sites use lickBound; scoop-local licks do not', () => {
  assert.match(source, /lickBound\(action,/);
  assert.match(source, /lickBound\('comment'/);
  assert.match(source, /lickBound\('submit-revisions'/);
  assert.match(source, /slicc\.lick\(\{ action: 'toggle-review-mode'/);
  assert.match(source, /slicc\.lick\(\{ action: 'toggle-speck'/);
  assert.match(source, /slicc\.lick\(\{ action: 'pins'/);
  assert.equal(source.includes("lickBound('toggle-review-mode'"), false);
  assert.equal(source.includes("lickBound('pins'"), false);
});
