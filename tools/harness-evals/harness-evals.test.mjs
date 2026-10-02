import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAdapter, validateArms } from './adapter.mjs';
import { escalationDelta, escalationTotals, invalidReason } from './escalations.mjs';
import {
  customPlaceholders,
  fillGoal,
  fillText,
  formatDate,
  resolvePlaceholders,
  shellQuote,
  tabIds,
  validateGoals,
} from './placeholders.mjs';
import { plan, touchedSkills } from './plan.mjs';
import { markdown, readRecords, summarize } from './report.mjs';

const is = (a, b, m) => assert.deepEqual(a, b, m);

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

test('resolvePlaceholders refuses a missing, null or empty value instead of running "null"', async () => {
  const goal = { id: 'hn', goal: 'open {{top}} on {{date:+1:D}}', expect_url: ['id={{top}}'] };
  is(await resolvePlaceholders(goal, async () => 42), { top: '42' });
  is(await resolvePlaceholders({ id: 'd', goal: '{{date:+1:D}}' }, undefined), {});
  for (const bad of [null, undefined, '', {}])
    await assert.rejects(
      resolvePlaceholders(goal, async () => bad),
      /\{\{top\}\} resolved to no value/
    );
  await assert.rejects(resolvePlaceholders(goal, false), /adapter resolves no placeholders/);
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
      {
        id: 'kev-0.8b-vision',
        kind: 'skill',
        pool: 'gpu',
        setup: ['kev pull --model 0.8b-vision'],
      },
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

test('report keeps skills apart: the same arm id in two skills is two rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const rec = (skill, arm, goal, pass, extra = {}) => ({
    skill,
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
  writeFileSync(join(dir, 'a/records/1.json'), JSON.stringify(rec('meep', 'kev', 'flights', true)));
  writeFileSync(
    join(dir, 'a/records/2.json'),
    JSON.stringify(rec('meep', 'kev', 'hn', false, { error: 'x' }))
  );
  writeFileSync(
    join(dir, 'a/records/3.json'),
    JSON.stringify(rec('meep', 'bare', 'flights', true))
  );
  writeFileSync(
    join(dir, 'b/records/4.json'),
    JSON.stringify(rec('other', 'bare', 'login', false, { cost_usd: 0.5 }))
  );
  const s = summarize(readRecords(dir));
  is(
    s.skills.map((k) => k.skill),
    ['meep', 'other']
  );
  const [meep, other] = s.skills;
  is(meep.arms, ['bare', 'kev']);
  is(meep.goals, ['flights', 'hn']);
  const kev = meep.rows.find((r) => r.arm === 'kev');
  is([kev.passed, kev.runs, kev.errors], [1, 2, 1]);
  is(kev.goals.hn, { passed: 0, runs: 1 });
  is(meep.rows.find((r) => r.arm === 'bare').runs, 1, "other's bare stays out of meep's");
  is(other.rows, [
    {
      arm: 'bare',
      runs: 1,
      passed: 0,
      self_passed: 0,
      errors: 0,
      invalid: 0,
      escalations_allowed: 0,
      median_seconds: 10,
      median_steps: 3,
      cost_usd: 0.5,
      goals: { login: { passed: 0, runs: 1 } },
    },
  ]);
  const md = markdown(s);
  assert.match(md, /## meep[\s\S]*\| kev \| 1\/2 \|[\s\S]*## other[\s\S]*\| bare \| 0\/1 \|/);
  assert.doesNotMatch(md, /meep-meep/);
});

test('escalations: totals need every row to carry the counter, deltas refuse a reset', () => {
  const row = (asked, allowed, denied) => ({ name: 's', escalations: { asked, allowed, denied } });
  is(escalationTotals(JSON.stringify({ scoops: [row(1, 1, 0), row(2, 0, 2)] })), {
    asked: 3,
    allowed: 1,
    denied: 2,
  });
  is(escalationTotals(JSON.stringify({ scoops: [] })), { asked: 0, allowed: 0, denied: 0 });
  is(
    escalationTotals(JSON.stringify({ scoops: [row(0, 0, 0), { name: 'cone' }] })),
    null,
    'old leader'
  );
  is(escalationTotals('not json'), null);
  is(escalationDelta({ asked: 1, allowed: 0, denied: 1 }, { asked: 4, allowed: 2, denied: 1 }), {
    asked: 3,
    allowed: 2,
    denied: 0,
  });
  is(
    escalationDelta({ asked: 5, allowed: 0, denied: 0 }, { asked: 0, allowed: 0, denied: 0 }),
    null
  );
  is(escalationDelta(null, { asked: 0, allowed: 0, denied: 0 }), null);
});

test('a skill arm run with approved escalations is invalid; the cone agent arm is not', () => {
  is(
    invalidReason('skill', { asked: 3, allowed: 2, denied: 1 }),
    '2 command(s) escalated to the cone and approved'
  );
  is(invalidReason('skill', { asked: 3, allowed: 0, denied: 3 }), null, 'denied is fine');
  is(invalidReason('agent', { asked: 3, allowed: 3, denied: 0 }), null);
  is(invalidReason('skill', null), 'escalation counts unknown for this run');
  is(invalidReason('agent', null), null);
});

test('report leaves invalid runs out of every score and counts them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  mkdirSync(join(dir, 'records'), { recursive: true });
  const rec = (n, pass, invalid) => ({
    skill: 'meep',
    arm: 'hybrid',
    goal: 'flights',
    repeat: n,
    pass,
    self_ok: pass,
    seconds: 10 * n,
    steps: n,
    cost_usd: 1,
    escalations: { asked: invalid ? 5 : 0, allowed: invalid ? 5 : 0, denied: 0 },
    invalid: invalid ? '5 command(s) escalated to the cone and approved' : null,
    error: null,
  });
  writeFileSync(join(dir, 'records/1.json'), JSON.stringify(rec(1, false, false)));
  writeFileSync(join(dir, 'records/2.json'), JSON.stringify(rec(2, true, true)));
  const [row] = summarize(readRecords(dir)).skills[0].rows;
  is([row.passed, row.runs, row.invalid, row.escalations_allowed], [0, 1, 1, 5]);
  is([row.cost_usd, row.median_seconds, row.goals.flights], [1, 10, { passed: 0, runs: 1 }]);
  assert.match(markdown(summarize(readRecords(dir))), /\| hybrid \| 0\/1 \| 0\/1 \|.*\| 0 \| 1 \|/);
});
