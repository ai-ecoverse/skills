import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cone-bound lick targeting in templates/review.shtml (slicc#3212 Layer C).
// Run with:
//
//   node --test skills/review/tests/lick-target.test.js
//
// Publish / defer / comment / submit-revisions pass the card's filing cone as
// Layer-B `target`. Scoop-local actions (toggle-review-mode, toggle-speck,
// pins) omit it.

const TEMPLATE = path.join(__dirname, '..', 'templates', 'review.shtml');
const source = fs.readFileSync(TEMPLATE, 'utf8');

function extractFunction(name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith('function ' + name + '('));
  ok(start >= 0, name + ' not found in template');
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  ok(end > start, 'end of ' + name + ' not found');
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
  is(calls[0], { action: 'publish', data: { id: 'page-1' }, target: 'cone-adobe' });
  is(calls[1], { action: 'defer', data: { id: 'page-1' } });
  is(calls[2], { action: 'comment', data: { id: 'page-1', comment: 'nits' } });
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
  is(acting, [
    ['page-1', true],
    ['page-1', true],
  ]);
  is(calls[0].action, 'publish');
  is(calls[0].target, 'cone-helix');
  is(calls[1].action, 'defer');
  is(calls[1].target, 'cone-helix');
});

test('cone-bound call sites use lickBound; scoop-local licks do not', () => {
  ok((/lickBound\(action,/).test(source));
  ok((/lickBound\('comment'/).test(source));
  ok((/lickBound\('submit-revisions'/).test(source));
  ok((/slicc\.lick\(\{ action: 'toggle-review-mode'/).test(source));
  ok((/slicc\.lick\(\{ action: 'toggle-speck'/).test(source));
  ok((/slicc\.lick\(\{ action: 'pins'/).test(source));
  is(source.includes("lickBound('toggle-review-mode'"), false);
  is(source.includes("lickBound('pins'"), false);
});
