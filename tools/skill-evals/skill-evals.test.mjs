import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { auditTable, auditTrace } from './audit.mjs';
import { checkRecords, readRecords, stampRecords } from './check.mjs';
import { ADAPTER_CHECK, patchRunId } from './patch-runner.mjs';
import { entriesFor, missingFixtures, plan, selectFromChanges, selectFromInput } from './plan.mjs';
import { stageSkill } from './stage.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const withHost = new Set(['tst', 'speck2']);
const hasHostSet = (s) => withHost.has(s);

test('a touched skill with a host set is selected; one without is not', () => {
  assert.deepEqual(
    selectFromChanges(['skills/speck2/SKILL.md', 'skills/other/x.js', 'README.md'], { hasHostSet }),
    ['speck2']
  );
});

test('eval machinery changes run the pilot skill', () => {
  for (const path of [
    '.github/workflows/skill-evals.yml',
    'tools/skill-evals/plan.mjs',
    'skills/skill-evals/scripts/evals-format.js',
  ])
    assert.deepEqual(selectFromChanges([path], { hasHostSet }), ['tst'], path);
  assert.deepEqual(
    selectFromChanges(['skills/skill-evals/SKILL.md', '.github/workflows/biome.yml'], {
      hasHostSet,
    }),
    []
  );
});

test('dispatch input: all, a list, and unknown or unsafe names', () => {
  const allWithHostSet = () => ['speck2', 'tst'];
  assert.deepEqual(selectFromInput('all', { hasHostSet, allWithHostSet }), ['speck2', 'tst']);
  assert.deepEqual(selectFromInput(' tst , tst ', { hasHostSet, allWithHostSet }), ['tst']);
  assert.throws(() => selectFromInput('nope', { hasHostSet, allWithHostSet }), /no skills\/nope/);
  assert.throws(() => selectFromInput('..', { hasHostSet, allWithHostSet }), /not a skill name/);
});

test('entries: two conditions, the set timeout, guardrails from the run count', () => {
  const set = {
    tasks: [
      { id: 'x-1', slicc: { timeoutSeconds: 600 } },
      { id: 'x-2', slicc: { timeoutSeconds: 300 } },
    ],
  };
  const [none, withSkill] = entriesFor('x', set, { repeats: 2 });
  assert.equal(none.condition, 'none');
  assert.equal(withSkill.condition, 'none+x');
  assert.equal(none.timeout, 600);
  assert.equal(none.runs, 4);
  assert.equal(none.deadline, 4 * 15 + 10 + 20);
  assert.equal(none.job_minutes, none.deadline + 45);
  assert.equal(none.max_cost, 10);
  assert.equal(none.max_task_cost, 2);
  assert.deepEqual(entriesFor('x', set, { taskFilter: ['nope'] }), []);
  assert.equal(entriesFor('x', set, { taskFilter: ['x-2'] })[0].tasks, 'x-2');
});

test('missing fixtures are reported', () => {
  const set = { tasks: [{ id: 't-1', slicc: { files: [{ from: 'files/a.js', to: '/a' }] } }] };
  assert.deepEqual(
    missingFixtures(set, '/nowhere', () => false),
    ['t-1: fixture files/a.js does not exist']
  );
});

test('the committed tst host set plans and validates', async () => {
  const got = await plan({
    root: REPO,
    changed: ['tools/skill-evals/plan.mjs'],
    readdir: (d) => readdirSync(d),
  });
  assert.deepEqual(got.errors, []);
  assert.deepEqual(
    got.matrix.include.map((e) => e.condition),
    ['none', 'none+tst']
  );
  assert.ok(got.skills[0].tasks >= 1);
  assert.equal(got.expected_runs, 2 * got.skills[0].tasks);
});

test('stage copies the skill without evals/ into a set directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'se-'));
  mkdirSync(join(root, 'skills/demo/evals/host'), { recursive: true });
  mkdirSync(join(root, 'skills/demo/scripts'), { recursive: true });
  writeFileSync(join(root, 'skills/demo/SKILL.md'), '# demo');
  writeFileSync(join(root, 'skills/demo/scripts/a.jsh'), '');
  writeFileSync(join(root, 'skills/demo/evals/host/tasks.json'), '{}');
  const got = stageSkill('demo', join(root, 'stage'), { root });
  assert.deepEqual(readdirSync(join(root, 'stage')), ['demo']);
  assert.deepEqual(readdirSync(join(root, 'stage/demo')), ['demo']);
  assert.deepEqual(readdirSync(got.dest).sort(), ['SKILL.md', 'scripts']);
  mkdirSync(join(root, 'skills/empty'), { recursive: true });
  assert.throws(() => stageSkill('empty', join(root, 'stage'), { root }), /no SKILL.md/);
});

test('check counts judged runs per condition and flags a short cell', () => {
  const planObj = {
    matrix: {
      include: [
        { skill: 'x', condition: 'none', runs: 2 },
        { skill: 'x', condition: 'none+x', runs: 2 },
      ],
    },
  };
  const rec = (skills, extra = {}) => ({
    benchmark: 'ecoverse-x',
    config: { skills },
    score: 0.5,
    ...extra,
  });
  const good = checkRecords(planObj, [rec('none'), rec('none'), rec('none+x'), rec('none+x')]);
  assert.equal(good.ok, true);
  const bad = checkRecords(planObj, [
    rec('none'),
    rec('none', { error: 'judge failed' }),
    rec('none+x', { score: 0 }),
    rec('none+x'),
  ]);
  assert.equal(bad.ok, false);
  assert.deepEqual(
    bad.rows.map((r) => [r.condition, r.judged, r.errored]),
    [
      ['none', 1, 1],
      ['none+x', 2, 0],
    ]
  );
});

test('stamp adds harness to every record, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-rec-'));
  mkdirSync(join(dir, 'a/b'), { recursive: true });
  writeFileSync(join(dir, 'a/b/t-r1.json'), JSON.stringify({ benchmark: 'ecoverse-x', score: 1 }));
  assert.equal(stampRecords(dir, 'host'), 1);
  assert.equal(stampRecords(dir, 'host'), 0);
  assert.equal(readRecords(dir)[0].harness, 'host');
});

test('patch-runner rewrites + in the run id once, is idempotent, and refuses unknown code', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source text of run.mjs
  const run = 'const runId = `${a}-${safe(config.skills)}-r${r.repeat}-${b}`;';
  const got = patchRunId(run, ADAPTER_CHECK);
  assert.equal(got.changed, true);
  assert.ok(got.source.includes("replaceAll('+', '-')"));
  assert.equal(patchRunId(got.source, ADAPTER_CHECK).changed, false);
  assert.equal(patchRunId(run, 'if (!/^[A-Za-z0-9._+-]+$/.test(runId))').changed, false);
  assert.throws(() => patchRunId('const runId = other;', ADAPTER_CHECK), /found it 0 times/);
});

test('audit reads the transcript only and counts per condition', () => {
  const trace = (skills, transcript) => ({
    record: { benchmark: 'ecoverse-x', config: { skills } },
    task: { rubric: 'skills/x/SKILL.md tasks.json' },
    result: { transcript },
  });
  const rows = [
    auditTrace(trace('none', [{ text: 'nothing here' }])),
    auditTrace(trace('none+x', [{ tool: 'read_file', input: '/workspace/skills/x/SKILL.md' }])),
  ];
  assert.deepEqual(
    rows.map((r) => [r.condition, r.skillMd, r.evalSet]),
    [
      ['none', false, false],
      ['none+x', true, false],
    ]
  );
  assert.match(auditTable(rows), /\| ecoverse-x \| `none\+x` \| 1 \| 1 \| 0 \| 0 \|/);
});
