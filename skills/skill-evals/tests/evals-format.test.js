// evals-format.js: every validateSet rule has a failing case; score/outcome/lift pin the values
// slicc's runner produced on the same inputs (packages/bench at 2fc68c08: judge.mjs score(),
// format.mjs outcome(), results.mjs reportData()).
//
// Run from the skill directory: tst tests/evals-format.test.js

import test, { is, ok } from 'tst';
import {
  lift,
  outcome,
  rubricItems,
  score,
  toRunnerSet,
  validateFindings,
  validateSet,
} from '../scripts/evals-format.js';

const RUBRIC = [
  '# Rubric',
  '## Source facts (verified 2026-09-30)',
  '- fact',
  '## Items',
  'A1_answer — the answer is right',
  'A2_shown — the run is shown',
].join('\n');

const task = (over = {}) => ({
  id: 'tst-001',
  title: 'A task',
  task: 'Do the thing.',
  rubric: RUBRIC,
  weights: { A1_answer: 60, A2_shown: 40 },
  slicc: { files: [{ from: 'files/a.js', to: '/workspace/eval/a.js' }], timeoutSeconds: 600 },
  ...over,
});

const set = (tasks = [task()], over = {}) => ({
  benchmark: 'ecoverse-tst',
  skill: 'tst',
  last_updated: '2026-09-30',
  tasks,
  ...over,
});

const sliccTask = (over = {}) =>
  task({
    setup: [{ run: 'mkdir -p /workspace/eval' }, { ask: 'Log in to X', check: 'test -f /x' }],
    teardown: [{ run: 'rm -rf /workspace/eval' }],
    ...over,
  });

const HOST = { harness: 'host', skill: 'tst' };
const SLICC = { harness: 'slicc', skill: 'tst' };

test('a valid host set and a valid slicc set pass', () => {
  is(validateSet(set(), HOST), { ok: true, errors: [] });
  is(validateSet(set([sliccTask({ slicc: { requires: ['login:x'] } })]), SLICC), {
    ok: true,
    errors: [],
  });
});

// [rule, set, options, a substring the error must contain]
const failing = [
  // runner rules (format.mjs wording)
  ['id is missing', set([task({ id: '' })]), HOST, 'id is missing'],
  ['task text is missing', set([task({ task: ' ' })]), HOST, 'task text is missing'],
  ['rubric is missing', set([task({ rubric: '' })]), HOST, 'rubric is missing'],
  ['weights not an object', set([task({ weights: [60, 40] })]), HOST, 'weights must be an object'],
  ['weights empty', set([task({ weights: {} })]), HOST, 'weights has no items'],
  [
    'item id not an identifier',
    set([task({ weights: { A1_answer: 60, '2bad': 40 } })]),
    HOST,
    'is not an identifier',
  ],
  [
    'non-integer weight',
    set([task({ weights: { A1_answer: 59.5, A2_shown: 40.5 } })]),
    HOST,
    'must be a positive integer',
  ],
  [
    'zero weight',
    set([task({ weights: { A1_answer: 100, A2_shown: 0 } })]),
    HOST,
    'weight of A2_shown must be a positive integer',
  ],
  [
    'weights not summing to 100',
    set([task({ weights: { A1_answer: 59, A2_shown: 40 } })]),
    HOST,
    'weights sum to 99, not 100',
  ],
  [
    'weight key absent from the rubric',
    set([task({ weights: { A1_answer: 60, B9_other: 40 } })]),
    HOST,
    'rubric never names item B9_other',
  ],
  ['duplicate task ids', set([task(), task()]), HOST, 'duplicate task id tst-001'],
  ['slicc not an object', set([task({ slicc: ['x'] })]), HOST, 'slicc must be an object'],
  [
    'slicc.files with a relative "to"',
    set([task({ slicc: { files: [{ from: 'files/a.js', to: 'workspace/a.js' }] } })]),
    HOST,
    'absolute VFS',
  ],
  [
    'slicc.timeoutSeconds not an integer',
    set([task({ slicc: { timeoutSeconds: 10.5 } })]),
    HOST,
    'timeoutSeconds must be a positive integer',
  ],
  ['slicc.website not a string', set([task({ slicc: { website: 1 } })]), HOST, 'website'],
  [
    'slicc.requires not a list',
    set([task({ slicc: { requires: 'login' } })]),
    SLICC,
    'requires must be a list',
  ],
  ['slicc.skills not a list', set([task({ slicc: { skills: 'tst' } })]), HOST, 'skills must be'],
  // envelope rules
  ['no tasks list', { benchmark: 'ecoverse-tst', skill: 'tst' }, HOST, 'a task set is'],
  ['benchmark missing', set(undefined, { benchmark: '' }), HOST, 'benchmark name is missing'],
  [
    'benchmark not ecoverse-<skill>',
    set(undefined, { benchmark: 'tst-evals' }),
    HOST,
    'benchmark must be ecoverse-tst',
  ],
  ['skill not the folder name', set(), { harness: 'host', skill: 'other' }, 'skill must be'],
  [
    'skill missing everywhere',
    set(undefined, { skill: undefined }),
    { harness: 'host' },
    'skill is missing',
  ],
  ['last_updated not a date', set(undefined, { last_updated: '2026-9-30' }), HOST, 'last_updated'],
  ['tasks empty', set([]), HOST, 'tasks is empty'],
  ['harness unknown', set(), { harness: 'ci', skill: 'tst' }, 'harness must be one of'],
  // ecoverse task rules
  ['unknown task key', set([task({ teardwon: [] })]), HOST, 'unknown task key teardwon'],
  ['supplied digest', set([task({ task_sha: 'deadbeefdeadbeef' })]), HOST, 'omit task_sha'],
  [
    'id without the skill prefix',
    set([task({ id: 'speck-001' })]),
    HOST,
    'id must start with tst-',
  ],
  ['id with unsafe characters', set([task({ id: 'tst-0/1 x' })]), HOST, 'id must use only'],
  ['title empty', set([task({ title: '' })]), HOST, 'title must be'],
  [
    'no Source facts heading',
    set([task({ rubric: RUBRIC.replace('## Source facts (verified 2026-09-30)', '## Facts') })]),
    HOST,
    'Source facts (verified YYYY-MM-DD)',
  ],
  [
    'Source facts date impossible',
    set([task({ rubric: RUBRIC.replace('2026-09-30', '2026-02-30') })]),
    HOST,
    'is not a date',
  ],
  [
    'no Items section',
    set([task({ rubric: RUBRIC.replace('## Items', '## Checks') })]),
    HOST,
    'needs a "## Items" section',
  ],
  [
    'Items line without an em dash',
    set([task({ rubric: RUBRIC.replace('A2_shown — ', 'A2_shown - ') })]),
    HOST,
    'Items line is not',
  ],
  [
    'weighted id named only outside Items',
    set([
      task({
        rubric: RUBRIC.replace('- fact', '- fact about A2_shown').replace(
          'A2_shown — the run is shown',
          ''
        ),
      }),
    ]),
    HOST,
    'Items never defines A2_shown',
  ],
  [
    'Items defines an unweighted id',
    set([task({ rubric: `${RUBRIC}\nA3_extra — not weighted` })]),
    HOST,
    'A3_extra, which has no weight',
  ],
  [
    'Items defines an id twice',
    set([task({ rubric: `${RUBRIC}\nA2_shown — again` })]),
    HOST,
    'defines A2_shown twice',
  ],
  [
    'slicc.files from absolute',
    set([task({ slicc: { files: [{ from: '/etc/passwd', to: '/workspace/a' }] } })]),
    HOST,
    'must be relative',
  ],
  [
    'slicc.files from escaping with ..',
    set([task({ slicc: { files: [{ from: '../../x.js', to: '/workspace/a' }] } })]),
    HOST,
    'must be relative',
  ],
  // setup / teardown step rules (slicc harness)
  ['setup not a list', set([task({ setup: { run: 'x' } })]), SLICC, 'setup must be a list'],
  ['step not an object', set([task({ setup: ['ls'] })]), SLICC, 'setup[0] is not an object'],
  [
    'step with both run and ask',
    set([task({ setup: [{ run: 'x', ask: 'y' }] })]),
    SLICC,
    'exactly one of run or ask',
  ],
  [
    'step with neither',
    set([task({ teardown: [{ check: 'x' }] })]),
    SLICC,
    'exactly one of run or ask',
  ],
  [
    'run step empty',
    set([task({ setup: [{ run: ' ' }] })]),
    SLICC,
    'run must be a non-empty string',
  ],
  [
    'check on a run step',
    set([task({ setup: [{ run: 'x', check: 'true' }] })]),
    SLICC,
    'check is only allowed on an ask step',
  ],
  [
    'check empty',
    set([task({ setup: [{ ask: 'x', check: '' }] })]),
    SLICC,
    'check must be a non-empty',
  ],
  ['unknown step key', set([task({ setup: [{ run: 'x', cwd: '/' }] })]), SLICC, 'unknown key cwd'],
  // host-only rules
  [
    'host task with setup',
    set([task({ setup: [{ run: 'x' }] })]),
    HOST,
    'a host task has no setup',
  ],
  [
    'host task with an ask teardown',
    set([task({ teardown: [{ ask: 'log out' }] })]),
    HOST,
    'a host task has no teardown',
  ],
  [
    'host task with requires',
    set([task({ slicc: { requires: ['login:x'] } })]),
    HOST,
    'a host task has no slicc.requires',
  ],
];

for (const [rule, s, opts, needle] of failing) {
  test(`rejects: ${rule}`, () => {
    const r = validateSet(s, opts);
    is(r.ok, false);
    const hit = r.errors.find((e) => e.includes(needle));
    ok(hit, `expected an error containing "${needle}", got: ${r.errors.join(' | ')}`);
  });
}

test('a slicc task may carry setup, ask with check, teardown and requires', () => {
  is(validateSet(set([sliccTask()]), SLICC).ok, true);
});

test('rubricItems reads only the Items section', () => {
  const r = rubricItems(`${RUBRIC}\n## Notes\nnot an item`);
  is(r.ids, ['A1_answer', 'A2_shown']);
  is(r.bad, []);
});

test('toRunnerSet drops setup and teardown and nothing else', () => {
  const input = set([sliccTask(), task({ id: 'tst-002' })]);
  const before = JSON.stringify(input);
  const out = toRunnerSet(input);
  is(JSON.stringify(input), before, 'the input is not mutated');
  is(out.tasks[0].setup, undefined);
  is(out.tasks[0].teardown, undefined);
  const expected = JSON.parse(before);
  delete expected.tasks[0].setup;
  delete expected.tasks[0].teardown;
  is(out, expected);
  is(validateSet(out, HOST), { ok: true, errors: [] });
});

// Parity: [name, weights, findings, rewardHacking, runner score, runner outcome, runner statuses]
const F = (item, status) => ({ item, status });
const W3 = { A1: 50, A2: 30, A3: 20 };
const parity = [
  ['all met', W3, [F('A1', 'met'), F('A2', 'met'), F('A3', 'met')], false, 1, 'pass'],
  [
    'all violated',
    W3,
    [F('A1', 'violated'), F('A2', 'violated'), F('A3', 'violated')],
    false,
    0,
    'fail',
  ],
  [
    'only A1 met',
    W3,
    [F('A1', 'met'), F('A2', 'violated'), F('A3', 'violated')],
    false,
    0.5,
    'partial',
  ],
  [
    'not_assessable earns nothing',
    W3,
    [F('A1', 'met'), F('A2', 'violated'), F('A3', 'not_assessable')],
    false,
    0.5,
    'partial',
  ],
  [
    'duplicate met+violated: violated wins',
    W3,
    [F('A1', 'met'), F('A1', 'violated'), F('A2', 'met'), F('A3', 'met')],
    false,
    0.5,
    'partial',
    { A1: 'violated', A2: 'met', A3: 'met' },
  ],
  [
    'duplicate not_assessable then met: not_assessable wins',
    W3,
    [F('A1', 'not_assessable'), F('A1', 'met'), F('A2', 'met'), F('A3', 'met')],
    false,
    0.5,
    'partial',
    { A1: 'not_assessable', A2: 'met', A3: 'met' },
  ],
  [
    'duplicate met+met',
    W3,
    [F('A1', 'met'), F('A1', 'met'), F('A2', 'met'), F('A3', 'met')],
    false,
    1,
    'pass',
  ],
  ['missing item earns nothing', W3, [F('A1', 'met'), F('A2', 'met')], false, 0.8, 'partial'],
  [
    'boundary 99/1, weight-1 not_assessable',
    { A1: 99, A2: 1 },
    [F('A1', 'met'), F('A2', 'not_assessable')],
    false,
    0.99,
    'partial',
  ],
  [
    'boundary 99/1, only weight-1 met',
    { A1: 99, A2: 1 },
    [F('A1', 'violated'), F('A2', 'met')],
    false,
    0.01,
    'partial',
  ],
  [
    'all not_assessable',
    W3,
    [F('A1', 'not_assessable'), F('A2', 'not_assessable'), F('A3', 'not_assessable')],
    false,
    0,
    'fail',
  ],
  ['no findings', W3, [], false, 0, 'fail'],
  ['reward hacking zeroes', W3, [F('A1', 'met'), F('A2', 'met'), F('A3', 'met')], true, 0, 'fail'],
  [
    'unknown item earns nothing',
    W3,
    [F('Z9', 'met'), F('A1', 'violated'), F('A2', 'violated'), F('A3', 'violated')],
    false,
    0,
    'fail',
  ],
  [
    'bogus status first is never overridden (runner quirk)',
    W3,
    [F('A1', 'maybe'), F('A1', 'met'), F('A2', 'met'), F('A3', 'met')],
    false,
    0.5,
    'partial',
    { A1: 'maybe', A2: 'met', A3: 'met' },
  ],
  [
    '33/33/34 two met',
    { A1: 33, A2: 33, A3: 34 },
    [F('A1', 'met'), F('A2', 'met'), F('A3', 'violated')],
    false,
    0.66,
    'partial',
  ],
  ['single item', { A1: 100 }, [F('A1', 'met')], false, 1, 'pass'],
];

for (const [name, weights, findings, rh, want, wantOutcome, statuses] of parity) {
  test(`score parity: ${name}`, () => {
    const r = score(findings, weights, { rewardHacking: rh });
    is(r.score, want);
    is(outcome(r.score), wantOutcome);
    is(r.verdict, want === 1);
    if (statuses) is(r.statuses, statuses);
  });
}

test('score reports missing items and the reward-hacking flag', () => {
  is(score([F('A1', 'met')], W3).missing_items, ['A2', 'A3']);
  const rh = score([F('A1', 'met'), F('A2', 'met'), F('A3', 'met')], W3, { rewardHacking: true });
  is([rh.rh_zeroed, rh.earned_weight, rh.verdict], [true, 100, false]);
});

// [value, runner outcome]
const outcomes = [
  [1, 'pass'],
  [1.0000001, 'pass'],
  [2, 'pass'],
  [Infinity, 'pass'],
  [0.9999999, 'partial'],
  [0.5, 'partial'],
  [0.01, 'partial'],
  [1e-9, 'partial'],
  [0, 'fail'],
  [-0, 'fail'],
  [-0.1, 'fail'],
  [-Infinity, 'fail'],
  [NaN, 'fail'],
  [null, 'fail'],
  [undefined, 'fail'],
  ['1', 'fail'],
];

test('outcome parity', () => {
  for (const [v, want] of outcomes) is(outcome(v), want, `outcome(${String(v)})`);
});

test('validateFindings rejects unknown items and statuses', () => {
  is(validateFindings([F('A1', 'met')], W3), []);
  is(validateFindings([F('Z9', 'met'), F('A1', 'maybe')], W3), [
    'finding for unknown item "Z9"',
    'finding A1 has status "maybe"',
  ]);
  is(validateFindings('x', W3), ['findings is not a list']);
});

const rec = (task_id, skills, repeat, s, duration, cost, extra = {}) => ({
  benchmark: 'ecoverse-tst',
  task_id,
  repeat,
  config: { harness: 'dev', model: 'claude-sonnet-5', skills, default_skills: false },
  score: s,
  metrics: { duration, cost },
  ...extra,
});

// The records lift-parity.mjs fed to results.mjs reportData().
const HOST_RECORDS = [
  rec('tst-001', 'none', 1, 0.35, 300, 0.9),
  rec('tst-001', 'none+tst', 1, 1, 180, 0.6),
  rec('tst-001', 'none', 2, 0.35, 320, 1.0),
  rec('tst-001', 'none+tst', 2, 0.65, 200, 0.7),
  rec('tst-002', 'none', 1, 0.6, 240, 0.8),
  rec('tst-002', 'none+tst', 1, 0.8, 250, 0.85),
  rec('tst-002', 'none', 2, 0, 400, 1.3),
  rec('tst-002', 'none+tst', 2, 1, 150, 0.5),
  rec('tst-003', 'none', 1, undefined, 500, 1.5, { error: 'judge down', error_stage: 'judge' }),
  rec('tst-003', 'none+tst', 1, 0.7, 210, 0.66),
  rec('tst-003', 'none', 2, undefined, 90, 0.2, { error: 'leader down', error_stage: 'agent' }),
  rec('tst-003', 'none+tst', 2, 0.85, 220, 0.7),
  rec('tst-004', 'none', 1, 0.2, 260, null),
  rec('tst-004', 'none+tst', 1, 0.9, 230, 0.55),
  rec('tst-004', 'none+tst', 1, 0.4, 999, 9.99),
];

test('lift equals the runner skill delta on the same records', () => {
  const s = lift(HOST_RECORDS).skills[0];
  // runner: score 0.57 (0.3 -> 0.87, pct 1.9), duration -133.333 (pct -0.396),
  // cost -0.438 (pct -0.3982), n 5
  is([s.from, s.to], ['none', 'none+tst']);
  is([s.score.delta, s.score.from, s.score.to, s.score.pct, s.score.n], [0.57, 0.3, 0.87, 1.9, 5]);
  is([s.duration.delta, s.duration.pct, s.duration.n], [-133.333, -0.396, 6]);
  is([s.cost.delta, s.cost.pct, s.cost.n], [-0.438, -0.3982, 5]);
});

test('lift reports each task with its n and raw scores, and flags thin evidence', () => {
  const s = lift(HOST_RECORDS).skills[0];
  is(
    s.tasks.map((t) => [t.task_id, t.score.n, t.duration.n, t.cost.n]),
    [
      ['tst-001', 2, 2, 2],
      ['tst-002', 2, 2, 2],
      ['tst-003', 0, 1, 1],
      ['tst-004', 1, 1, 0],
    ]
  );
  is(s.tasks[0].score.to_scores, [1, 0.65]);
  is([s.min_repeats, s.conclusive], [0, false]);
});

test('lift on slicc records: with minus without, conclusive at two repeats', () => {
  const r = (task_id, condition, repeat, s, duration, cost) => ({
    harness: 'slicc',
    benchmark: 'ecoverse-tst',
    task_id,
    repeat,
    condition,
    score: s,
    metrics: { duration, cost },
  });
  const out = lift([
    r('tst-001', 'without', 1, 0.2, 100, 1),
    r('tst-001', 'with', 1, 0.8, 60, 0.5),
    r('tst-001', 'without', 2, 0.4, 120, 1),
    r('tst-001', 'with', 2, 1, 80, 0.7),
  ]);
  is(out.harness, 'slicc');
  const s = out.skills[0];
  is(
    [s.from, s.to, s.score.delta, s.duration.delta, s.cost.delta],
    ['without', 'with', 0.6, -40, -0.4]
  );
  is([s.min_repeats, s.conclusive], [2, true]);
});

test('lift refuses to merge the two harnesses', () => {
  let message = null;
  try {
    lift([...HOST_RECORDS, { ...HOST_RECORDS[0], harness: 'slicc' }]);
  } catch (e) {
    message = e.message;
  }
  ok(message, 'lift should throw');
  is(message, 'records mix harnesses (unstamped, slicc); report each harness on its own');
});
