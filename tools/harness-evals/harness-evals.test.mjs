import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAdapter, validateArms } from './adapter.mjs';
import {
  customPlaceholders,
  fillGoal,
  fillText,
  formatDate,
  shellQuote,
  tabIds,
  validateGoals,
} from './placeholders.mjs';
import { plan, touchedSkills } from './plan.mjs';
import { markdown, readRecords, summarize } from './report.mjs';

const NOW = new Date(Date.UTC(2026, 9, 1)); // 2026-10-01

test('dates fill relative to now, across month ends, in every format', () => {
  assert.equal(formatDate(NOW, 'YYYY-MM-DD'), '2026-10-01');
  assert.equal(formatDate(NOW, 'MMMM D, YYYY'), 'October 1, 2026');
  assert.equal(formatDate(NOW, 'M/D'), '10/1');
  assert.equal(
    fillText('{{date:+7:MMM D}} to {{date:+14:MMM D}}', { now: NOW }),
    'Oct 8 to Oct 15'
  );
  assert.equal(fillText('{{date:+31:MMM D}}', { now: NOW }), 'Nov 1');
  assert.equal(fillText('{{date:-1:YYYY-MM-DD}}', { now: NOW }), '2026-09-30');
});

test('custom placeholders come from the adapter, and a missing value refuses to run', () => {
  const goal = {
    id: 'hn',
    url: 'https://x/',
    goal: 'open {{top}}',
    expect_url: ['id={{top}}', '{{date:+1:D}}'],
  };
  assert.deepEqual(customPlaceholders(goal), ['top']);
  assert.deepEqual(fillGoal(goal, { now: NOW, values: { top: '42' } }).expect_url, ['id=42', '2']);
  assert.throws(() => fillGoal(goal, { now: NOW, values: {} }), /\{\{top\}\} has no value/);
});

test('validateGoals accepts a goals file and rejects goals without a check', () => {
  const ok = {
    last_updated: '2026-10-01',
    goals: [{ id: 'flights', url: 'https://x', goal: 'g', expect: ['London'], max_steps: 14 }],
  };
  assert.deepEqual(validateGoals(ok), []);
  const bad = {
    last_updated: 'soon',
    goals: [{ id: 'A', url: 'ftp://x', goal: '', expect: [], max_steps: 0 }],
  };
  const errs = validateGoals(bad).join('\n');
  for (const want of [
    'last_updated',
    'id must be',
    'url must be',
    'goal is empty',
    'needs expect',
    'max_steps',
  ])
    assert.match(errs, new RegExp(want));
});

test('shellQuote survives quotes and spaces; tabIds reads tab-list lines', () => {
  assert.equal(shellQuote(`it's "Ada"`), `'it'\\''s "Ada"'`);
  const listing =
    '[ABC123DEF] https://a.example/ "A" (active)\n2. [XYZ9876] https://b.example/ "B"\nNo tabs open\n[peer:REMOTE1] https://c "C"';
  assert.deepEqual(tabIds(listing), ['ABC123DEF', 'XYZ9876']);
});

test('validateArms checks ids, kinds, pools, skills, setup and agent models', () => {
  assert.deepEqual(
    validateArms([
      { id: 'kev', kind: 'skill', pool: 'gpu', setup: ['kev pull --model 9b'] },
      { id: 'bare', kind: 'agent', pool: 'bench', model: 'm' },
    ]),
    []
  );
  const errs = validateArms([
    { id: 'X', kind: 'tool', pool: 'tpu', skills: ['Bad Name'], setup: 'x' },
    { id: 'a', kind: 'agent', pool: 'bench' },
  ]).join('\n');
  for (const want of [
    'id must be',
    'kind must be',
    'pool must be',
    'bad skill name',
    'setup must be',
    'names its model',
  ])
    assert.match(errs, new RegExp(want));
});

function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'harness-repo-'));
  const dir = join(root, 'skills/demo/evals/harness');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'skills/demo/SKILL.md'), '---\nname: demo\n---\n');
  writeFileSync(
    join(dir, 'goals.json'),
    JSON.stringify({
      last_updated: '2026-10-01',
      goals: [{ id: 'g', url: 'https://x', goal: 'do', expect: ['done'] }],
    })
  );
  writeFileSync(
    join(dir, 'harness.mjs'),
    `export const goals = './goals.json';
export const arms = [
  { id: 'fast', kind: 'skill', pool: 'gpu', skills: ['helper'], setup: ['echo ready'] },
  { id: 'bare', kind: 'agent', pool: 'bench', model: 'claude-haiku-4-5' },
];
export function command(goal, arm, { shellQuote }) { return 'demo ' + shellQuote(goal.goal); }
export function judge(raw, goal) { return goal.expect.every((t) => raw.includes(t)); }
`
  );
  mkdirSync(join(root, 'skills/plain'), { recursive: true });
  writeFileSync(join(root, 'skills/plain/SKILL.md'), '---\nname: plain\n---\n');
  return root;
}

test('loadAdapter imports a skill adapter and resolves its goals file', async () => {
  const root = fakeRepo();
  const { adapter, goalsPath } = await loadAdapter(join(root, 'skills/demo'));
  assert.equal(adapter.arms.length, 2);
  assert.equal(
    adapter.command({ goal: "it's" }, adapter.arms[0], { shellQuote }),
    `demo 'it'\\''s'`
  );
  assert.equal(adapter.judge('all done', { expect: ['done'] }), true);
  assert.ok(goalsPath.endsWith('skills/demo/evals/harness/goals.json'));
  await assert.rejects(loadAdapter(join(root, 'skills/plain')), /does not exist/);
});

test('plan: only skills with an adapter, one entry per arm, agent arms keep a bare leader', async () => {
  assert.deepEqual(
    touchedSkills([
      'skills/demo/SKILL.md',
      'skills/plain/x.js',
      'tools/a.mjs',
      'skills/demo/evals/harness/goals.json',
    ]),
    ['demo', 'plain']
  );
  const root = fakeRepo();
  const { include } = await plan('all', 'origin/main', root);
  assert.deepEqual(include, [
    { skill: 'demo', arm: 'fast', runs_on: 'cloud-run-gpu', gpu: '1', inject: 'demo,helper' },
    { skill: 'demo', arm: 'bare', runs_on: 'cloud-run-bench', gpu: '', inject: '' },
  ]);
  await assert.rejects(plan('plain', 'origin/main', root), /has no evals\/harness\/harness.mjs/);
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
