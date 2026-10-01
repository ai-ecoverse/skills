import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  fillGoal,
  fillText,
  formatDate,
  hnTopFromHtml,
  needsHnTop,
  placeholders,
  shellQuote,
  validateGoals,
} from './goals.mjs';
import { passes, tabIds } from './judge.mjs';
import { markdown, readRecords, summarize } from './report.mjs';

const NOW = new Date(Date.UTC(2026, 9, 1)); // 2026-10-01

test('dates fill relative to now, across month ends, in every format', () => {
  assert.equal(formatDate(NOW, 'YYYY-MM-DD'), '2026-10-01');
  assert.equal(formatDate(NOW, 'MMM D'), 'Oct 1');
  assert.equal(formatDate(NOW, 'MMMM D, YYYY'), 'October 1, 2026');
  assert.equal(formatDate(NOW, 'M/D'), '10/1');
  assert.equal(
    fillText('{{date:+7:MMM D}} to {{date:+14:MMM D}}', { now: NOW }),
    'Oct 8 to Oct 15'
  );
  assert.equal(fillText('{{date:+31:MMM D}}', { now: NOW }), 'Nov 1');
  assert.equal(fillText('{{date:-1:YYYY-MM-DD}}', { now: NOW }), '2026-09-30');
});

test('hn:top fills from the front page, and refuses to run without it', () => {
  const html =
    '<table><tr class="athing submission" id="45123456"><td>…</td></tr><tr class="athing" id="999">';
  assert.equal(hnTopFromHtml(html), '45123456');
  assert.equal(hnTopFromHtml('<html>no stories</html>'), null);
  const goal = {
    id: 'hn',
    url: 'https://news.ycombinator.com/',
    goal: 'x',
    expect_url: ['item?id={{hn:top}}'],
  };
  assert.equal(needsHnTop(goal), true);
  assert.deepEqual(fillGoal(goal, { now: NOW, hnTop: '45123456' }).expect_url, [
    'item?id=45123456',
  ]);
  assert.throws(() => fillGoal(goal, { now: NOW, hnTop: null }), /hn:top/);
  assert.throws(() => fillText('{{nope}}', { now: NOW }), /unknown placeholder/);
  assert.deepEqual(placeholders('a {{date:+7:MMM D}} b {{hn:top}}'), ['date:+7:MMM D', 'hn:top']);
});

test('validateGoals accepts the meep-meep shape and rejects goals without a check', () => {
  const ok = {
    last_updated: '2026-10-01',
    goals: [
      {
        id: 'flights',
        url: 'https://x',
        goal: 'g',
        expect: ['London', '{{date:+7:MMM D}}'],
        max_steps: 14,
      },
    ],
  };
  assert.deepEqual(validateGoals(ok), []);
  const bad = {
    last_updated: 'soon',
    goals: [
      { id: 'A', url: 'ftp://x', goal: '', expect: [], max_steps: 0 },
      { id: 'a', url: 'https://x', goal: 'g', expect: ['{{when}}'] },
    ],
  };
  const errs = validateGoals(bad).join('\n');
  for (const want of [
    'last_updated',
    'id must be',
    'url must be',
    'goal is empty',
    'needs expect',
    'max_steps',
    'unknown placeholder {{when}}',
  ])
    assert.match(errs, new RegExp(want.replace(/[{}]/g, '\\$&')));
});

test('shellQuote survives quotes and spaces', () => {
  assert.equal(shellQuote(`it's "Ada"`), `'it'\\''s "Ada"'`);
});

test('tabIds reads tab-list lines, with or without an index prefix', () => {
  const listing =
    '[ABC123DEF] https://a.example/ "A" (active)\n2. [XYZ9876] https://b.example/ "B"\nNo tabs open\n[peer:REMOTE1] https://c "C" [remote:peer]';
  assert.deepEqual(tabIds(listing), ['ABC123DEF', 'XYZ9876']);
});

test('the shared check uses the page module it is given', () => {
  const page = {
    parseSnapshot: (raw) => ({ url: /url: (\S+)/.exec(raw)?.[1] ?? '' }),
    checkExpect: (obs, expect, urls) =>
      urls.every((u) => obs.shot.url.includes(u)) && expect.every((t) => obs.raw.includes(t)),
  };
  const goal = { expect: ['London'], expect_url: ['/travel'] };
  assert.equal(passes(page, 'url: https://g.co/travel/x\nLondon', goal), true);
  assert.equal(passes(page, 'url: https://g.co/other\nLondon', goal), false);
});

test('report counts passes per arm and goal from records found recursively', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const rec = (arm, goal, pass, extra = {}) => ({
    arm,
    goal,
    repeat: 1,
    pass,
    self_ok: pass,
    seconds: 10,
    steps: 3,
    cost_usd: 0.1,
    error: null,
    ...extra,
  });
  mkdirSync(join(dir, 'a/records'), { recursive: true });
  mkdirSync(join(dir, 'b/records'), { recursive: true });
  writeFileSync(join(dir, 'a/records/1.json'), JSON.stringify(rec('kev', 'flights', true)));
  writeFileSync(
    join(dir, 'a/records/2.json'),
    JSON.stringify(rec('kev', 'hn', false, { error: 'x' }))
  );
  writeFileSync(
    join(dir, 'b/records/3.json'),
    JSON.stringify(rec('agent', 'flights', true, { cost_usd: 0.5 }))
  );
  const s = summarize(readRecords(dir));
  assert.deepEqual(s.arms, ['agent', 'kev']);
  const kev = s.rows.find((r) => r.arm === 'kev');
  assert.equal(kev.passed, 1);
  assert.equal(kev.errors, 1);
  assert.deepEqual(kev.goals.hn, { passed: 0, runs: 1 });
  assert.match(markdown(s), /\| kev \| 1\/2 \|/);
});
