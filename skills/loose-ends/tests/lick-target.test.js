import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cone-bound lick targeting in templates/loose-ends.shtml (slicc#3212 Layer C).
// Run with:
//
//   tst skills/loose-ends/tests/lick-target.test.js

const TEMPLATE = path.join(__dirname, '..', 'templates', 'loose-ends.shtml');
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

function lickPayload() {
  const fn = new Function(extractFunction('lickPayload') + '\nreturn lickPayload;');
  return fn();
}

test('do and open-session carry target when the task has a filing cone', () => {
  const payload = lickPayload();
  is(payload('do', { id: 'le-1', title: 'Ping Marta' }, 'cone-adobe'), {
    action: 'do',
    data: { id: 'le-1', title: 'Ping Marta' },
    target: 'cone-adobe',
  });
  is(
    payload('open-session', { id: '', file: 'live.md', at: '' }, 'cone-adobe'),
    {
      action: 'open-session',
      data: { id: '', file: 'live.md', at: '' },
      target: 'cone-adobe',
    }
  );
});

test('lickPayload omits target when the task has no cone', () => {
  const payload = lickPayload();
  is(payload('do', { id: 'le-1' }, undefined), {
    action: 'do',
    data: { id: 'le-1' },
  });
  is(payload('do', { id: 'le-1' }, ''), {
    action: 'do',
    data: { id: 'le-1' },
  });
});

test('scoop-local actions do not use lickPayload', () => {
  ok((/lickPayload\('do'/).test(source));
  ok((/lickPayload\('open-session'/).test(source));
  ok((/slicc\.lick\(\{ action: 'done'/).test(source));
  ok((/slicc\.lick\(\{ action: 'snooze'/).test(source));
  ok((/slicc\.lick\(\{ action: 'unsnooze'/).test(source));
  ok((/slicc\.lick\(\{\s*action: 'request-load'/).test(source));
  is(source.includes("lickPayload('snooze'"), false);
  is(source.includes("lickPayload('done'"), false);
  is(source.includes("lickPayload('request-load'"), false);
});
