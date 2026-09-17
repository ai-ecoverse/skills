// Cone-bound lick targeting in templates/loose-ends.shtml (slicc#3212 Layer C).
// Run with:
//
//   node --test skills/loose-ends/tests/lick-target.test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'loose-ends.shtml');
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

function lickPayload() {
  const fn = new Function(extractFunction('lickPayload') + '\nreturn lickPayload;');
  return fn();
}

test('do and open-session carry target when the task has a filing cone', () => {
  const payload = lickPayload();
  assert.deepEqual(payload('do', { id: 'le-1', title: 'Ping Marta' }, 'cone-adobe'), {
    action: 'do',
    data: { id: 'le-1', title: 'Ping Marta' },
    target: 'cone-adobe',
  });
  assert.deepEqual(
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
  assert.deepEqual(payload('do', { id: 'le-1' }, undefined), {
    action: 'do',
    data: { id: 'le-1' },
  });
  assert.deepEqual(payload('do', { id: 'le-1' }, ''), {
    action: 'do',
    data: { id: 'le-1' },
  });
});

test('scoop-local actions do not use lickPayload', () => {
  assert.match(source, /lickPayload\('do'/);
  assert.match(source, /lickPayload\('open-session'/);
  assert.match(source, /slicc\.lick\(\{ action: 'done'/);
  assert.match(source, /slicc\.lick\(\{ action: 'snooze'/);
  assert.match(source, /slicc\.lick\(\{ action: 'unsnooze'/);
  assert.match(source, /slicc\.lick\(\{\s*action: 'request-load'/);
  assert.equal(source.includes("lickPayload('snooze'"), false);
  assert.equal(source.includes("lickPayload('done'"), false);
  assert.equal(source.includes("lickPayload('request-load'"), false);
});
