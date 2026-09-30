import test, { is, ok } from 'tst';
import * as H from '../scripts/harness.js';

const RUBRIC =
  '# Rubric\n\n## Source facts (verified 2026-09-30)\n- fact\n\n## Items\nA1_x \u2014 first\nA2_y \u2014 second\n';
const task = (id, extra = {}) => ({
  id,
  title: id,
  task: `do ${id}`,
  rubric: RUBRIC,
  weights: { A1_x: 60, A2_y: 40 },
  slicc: {
    files: [
      { from: 'files/a/a.js', to: `/workspace/eval/${id}/a.js` },
      { from: 'files/a/b.txt', to: `/workspace/eval/${id}/sub/b.js` },
    ],
    timeoutSeconds: 300,
  },
  ...extra,
});
const SET = {
  benchmark: 'ecoverse-demo',
  skill: 'demo',
  last_updated: '2026-09-30',
  tasks: [
    task('demo-001', {
      setup: [{ run: 'true' }, { ask: 'log in to X', check: 'test -f /tmp/x' }],
      teardown: [{ run: 'rm -rf /workspace/eval/demo-001' }, { ask: 'log out of X' }],
    }),
    task('demo-002', { slicc: { files: [], timeoutSeconds: 900, requires: ['a GitHub login'] } }),
  ],
};
const plan = (o = {}) =>
  H.buildPlan({
    set: SET,
    skill: 'demo',
    runId: 'demo-r1',
    created: '2026-09-30T00:00:00.000Z',
    root: '/tmp/skill-evals',
    privateDir: '/scoops/skill-evals/home/skill-evals',
    ...o,
  });

test('makeRunId is skill, UTC stamp and 4 hex', () => {
  is(H.makeRunId('tst', Date.UTC(2026, 8, 30, 13, 4, 5), 0xab), 'tst-20260930T130405-00ab');
  ok(H.isSafeName(H.makeRunId('tst', 0, 65535)));
  ok(!H.isSafeName('a/b'));
});

test('taskCwd is the deepest common fixture directory', () => {
  is(H.taskCwd(SET.tasks[0]), '/workspace/eval/demo-001/');
  is(H.taskCwd({ slicc: { files: [] } }), null);
  is(H.taskCwd({ slicc: { files: [{ to: '/tmp/x/y.js' }] } }), '/tmp/x/');
});

test('writableRoots widens to /<root>/<first>/ and skips /tmp and /shared', () => {
  const t = (to) => ({ slicc: { files: [{ to }] } });
  is(H.writableRoots([t('/workspace/eval/a/x.js'), t('/workspace/eval/b/y.js')]), [
    '/workspace/eval/',
  ]);
  is(H.writableRoots([t('/tmp/eval/a.js'), t('/shared/q/a.js')]), []);
});

test('plan orders runs in condition blocks: all without, then all with', () => {
  const p = plan({ repeats: 2 });
  is(p.runs.length, 8);
  is(
    p.runs.map((r) => `${r.n}:${r.task_id}:${r.condition}:${r.repeat}`),
    [
      '1:demo-001:without:1',
      '2:demo-002:without:1',
      '3:demo-001:without:2',
      '4:demo-002:without:2',
      '5:demo-001:with:1',
      '6:demo-002:with:1',
      '7:demo-001:with:2',
      '8:demo-002:with:2',
    ]
  );
  is(p.stage_dir, '/tmp/skill-evals/demo-r1/.agents/skills/demo');
  is(p.private_dir, '/scoops/skill-evals/home/skill-evals/demo-r1');
});

test('plan lists every ask for the cone, with its check, and requires as asks', () => {
  const p = plan();
  is(p.asks.before, [
    { task_id: 'demo-001', ask: 'log in to X', check: 'test -f /tmp/x' },
    { task_id: 'demo-002', ask: 'Make sure this is available and logged in: a GitHub login' },
  ]);
  is(p.asks.after, [{ task_id: 'demo-001', ask: 'log out of X' }]);
  is(p.cone, []);
});

test('plan: harness scoop gets the fixture root and a background_after above the timeout', () => {
  const p = plan();
  is(p.harness_scoop.writablePaths, ['/scoops/skill-evals/', '/shared/', '/workspace/eval/']);
  is(p.harness_scoop.bash_background_after, 900 + 300);
});

test('plan: an installed skill puts cone steps first; bad inputs throw', () => {
  const p = plan({ installed: true });
  is(p.cone.length, 2);
  ok(p.cone[0].includes('only the cone can'));
  let err = null;
  try {
    plan({ taskIds: ['demo-009'] });
  } catch (e) {
    err = e.message;
  }
  is(err, 'unknown task ids: demo-009');
  err = null;
  try {
    plan({ repeats: 0 });
  } catch (e) {
    err = e.message;
  }
  ok(err?.includes('repeats'));
  is(plan({ taskIds: ['demo-002'], conditions: ['with'] }).runs.length, 1);
});

test('stageable drops evals/, .git and node_modules only', () => {
  is(
    H.stageable([
      'SKILL.md',
      'evals/slicc/tasks.json',
      'scripts/x.jsh',
      '.git/HEAD',
      'node_modules/a.js',
      'evalsx.md',
    ]),
    ['SKILL.md', 'scripts/x.jsh', 'evalsx.md']
  );
});

test('descriptionIsBlockScalar detects | and > (slicc#3690)', () => {
  ok(H.descriptionIsBlockScalar('---\nname: tst\ndescription: |\n  Use this\n---\n'));
  ok(H.descriptionIsBlockScalar('---\nname: x\ndescription: >-\n  a\n---\n'));
  ok(!H.descriptionIsBlockScalar('---\nname: x\ndescription: Use this when a | b\n---\n'));
});

test('agentArgv: timeout first, prompt last as one element', () => {
  is(
    H.agentArgv({ cwd: '/w/', prompt: 'p q', model: 'haiku', thinking: 'low', timeoutSeconds: 60 }),
    ['timeout', '60', 'agent', '--model', 'haiku', '--thinking', 'low', '/w/', '*', 'p q']
  );
  is(
    H.agentArgv({
      cwd: '/j/',
      commands: 'echo',
      prompt: 'p',
      model: 'm',
      timeoutSeconds: 5,
      schemaB64: 'e30=',
      transcript: false,
    }),
    [
      'timeout',
      '5',
      'agent',
      '--model',
      'm',
      '--schema-b64',
      'e30=',
      '--no-persist-session',
      '/j/',
      'echo',
      'p',
    ]
  );
});

test('costRow prefers the live row; costDelta diffs cost, tokens, turns, new models', () => {
  const row = (c, t, tok, models, source = 'live') => ({
    name: 'me',
    source,
    models,
    turns: t,
    usage: {
      input: tok,
      output: 1,
      cacheRead: 2,
      cacheWrite: 3,
      totalTokens: tok + 6,
      cost: { total: c },
    },
  });
  const json = { scoops: [row(9, 9, 9, [], 'frozen'), row(1, 10, 100, ['opus'])] };
  is(H.costRow(json, 'me').turns, 10);
  is(H.costRow(json, 'nobody'), null);
  const d = H.costDelta(row(1, 10, 100, ['opus']), row(1.0425, 14, 150, ['opus', 'haiku']));
  is(
    [d.cost, d.turns, d.tokens.input, d.tokens.total, d.models_new],
    [0.0425, 4, 50, 50, ['haiku']]
  );
});

const TRANSCRIPT = (uuid, turns = 3) =>
  `# Agent session: brave-owl\n\n- jid: agent_brave_owl\n- exit code: 0\n- turns: ${turns}\n- messages: 5\n- timestamp: 2026-09-30T13-13-09-339Z\n\n## Prompt\n\n[eval-run ${uuid}] do it\n\n---\n\n## user\n\ndo it\n`;

test('parseTranscript reads the header and the verbatim prompt', () => {
  const t = H.parseTranscript(TRANSCRIPT('u1'));
  is(
    [t.name, t.exitCode, t.turns, t.messages, t.prompt],
    ['brave-owl', 0, 3, 5, '[eval-run u1] do it\n']
  );
});

test('findTranscript matches the nonce in ## Prompt only, and only a unique hit', () => {
  const a = { name: 'a.md', text: TRANSCRIPT('u1') };
  const b = { name: 'b.md', text: TRANSCRIPT('u2') };
  const c = { name: 'c.md', text: `${TRANSCRIPT('zz')}\n## user\n[eval-run u1]\n` };
  is(H.findTranscript([a, b, c], 'u1')?.name, 'a.md');
  is(H.findTranscript([b, c], 'u1'), null);
  is(H.findTranscript([a, a], 'u1'), null);
});

test('truncateMiddle keeps both ends', () => {
  is(H.truncateMiddle('abcdefghij', 4), 'ab\n... [6 characters omitted] ...\nij');
  is(H.truncateMiddle('abc', 4), 'abc');
});

const P = plan();
const RUN = P.runs[0];
const DELTA = { cost: 0.2, turns: 3, tokens: { total: 1 }, models_new: ['claude-haiku-4-5'] };

test('buildRecord: exact attribution, seconds, no text fields', () => {
  const r = H.buildRecord({
    plan: P,
    run: RUN,
    uuid: 'u',
    rc: 0,
    ms: 12345,
    delta: DELTA,
    transcript: { turns: 3 },
    startedAt: 't',
  });
  is(
    [r.harness, r.condition, r.metrics.duration, r.metrics.cost, r.attribution, r.error],
    ['slicc', 'without', 12.345, 0.2, 'exact', undefined]
  );
  is(r.config.models_seen, ['claude-haiku-4-5']);
});

test('buildRecord flags contamination, timeouts and errors', () => {
  const c = H.buildRecord({
    plan: P,
    run: RUN,
    rc: 0,
    ms: 1,
    delta: DELTA,
    transcript: { turns: 2 },
  });
  is(c.attribution, 'contaminated');
  const t = H.buildRecord({
    plan: P,
    run: RUN,
    rc: 124,
    ms: 1,
    delta: DELTA,
    transcript: { turns: 3 },
  });
  is([t.metrics.timedOut, t.metrics.cost_lower_bound, t.error], [true, true, undefined]);
  const e = H.buildRecord({ plan: P, run: RUN, rc: 1, ms: 1, delta: DELTA, transcript: null });
  is([e.error_stage, e.attribution], ['spawn', 'unknown']);
  const s = H.buildRecord({ plan: P, run: RUN, setupError: 'x exists' });
  is(s.error_stage, 'setup');
});

test('judgePrompt carries task, rubric and transcript but never the weights', () => {
  const t = { ...SET.tasks[0], weights: { A1_x: 73, A2_y: 27 } };
  const p = H.judgePrompt({ task: t, transcript: 'TRANSCRIPT-BODY', finalAnswer: 'FINAL' });
  ok(
    p.includes('do demo-001') &&
      p.includes('A2_y \u2014 second') &&
      p.includes('TRANSCRIPT-BODY') &&
      p.includes('FINAL')
  );
  ok(!p.includes('73') && !p.includes('27'));
});

test('verdictSchema enumerates the item ids and the three statuses', () => {
  const s = H.verdictSchema(['A1_x', 'A2_y']);
  is(s.properties.findings.items.properties.item.enum, ['A1_x', 'A2_y']);
  is(s.properties.findings.items.properties.status.enum, ['met', 'violated', 'not_assessable']);
});

const W = { A1_x: 60, A2_y: 40 };
const V = {
  findings: [
    { item: 'A1_x', status: 'met', evidence: 'e' },
    { item: 'A2_y', status: 'not_assessable', evidence: 'e' },
  ],
  reward_hacking_suspected: false,
};

test('parseVerdict: strict, fence fallback, and invalid output', () => {
  is(H.parseVerdict(JSON.stringify(V), W).parse, 'strict');
  const f = H.parseVerdict(`\`\`\`json\n${JSON.stringify(V)}\n\`\`\``, W);
  is([f.ok, f.parse], [true, 'fallback']);
  is(H.parseVerdict('no json here', W).ok, false);
  const bad = H.parseVerdict(
    JSON.stringify({ ...V, findings: [{ item: 'Z9', status: 'met' }] }),
    W
  );
  ok(!bad.ok && bad.errors[0].includes('Z9'));
  ok(!H.parseVerdict(JSON.stringify({ findings: [] }), W).ok);
});

test('applyVerdict scores like the runner; judgeFailed is an error, not a verdict', () => {
  const base = H.buildRecord({
    plan: P,
    run: RUN,
    rc: 0,
    ms: 1,
    delta: DELTA,
    transcript: { turns: 3 },
  });
  const r = H.applyVerdict(base, V, W, { model: 'haiku', cost: 0.04 });
  is([r.score, r.outcome, r.verdict, r.statuses.A2_y], [0.6, 'partial', false, 'not_assessable']);
  const rh = H.applyVerdict(base, { ...V, reward_hacking_suspected: true }, W, {});
  is([rh.score, rh.outcome], [0, 'fail']);
  const j = H.judgeFailed(base, { attempts: 2 });
  is([j.score, j.error_stage], [null, 'judge']);
});

const rec = (task_id, condition, repeat, sc, duration, cost, extra = {}) => ({
  harness: 'slicc',
  benchmark: 'ecoverse-demo',
  task_id,
  condition,
  repeat,
  n: 0,
  config: { model: 'haiku' },
  metrics: { duration, cost },
  score: sc,
  outcome: sc >= 1 ? 'pass' : sc > 0 ? 'partial' : 'fail',
  judge: { cost: 0.04 },
  ...extra,
});
const RECORDS = [
  rec('demo-001', 'without', 1, 0.4, 100, 0.3),
  rec('demo-001', 'with', 1, 1, 60, 0.2),
  rec('demo-002', 'without', 1, 0, 50, 0.1),
  rec('demo-002', 'with', 1, null, 40, 0.1, {
    error: 'judge failed',
    error_stage: 'judge',
    judge: { cost: 0.08 },
  }),
];

test('aggregate: cells, lift via evals-format, spend by kind', () => {
  const r = H.aggregate(P, RECORDS, {
    preflights: [{ condition: 'without', ok: true, cost: 0.03 }],
  });
  const cell = r.cells.find((c) => c.task_id === 'demo-001' && c.condition === 'with');
  is([cell.n, cell.score, cell.outcomes.pass, cell.duration, cell.cost], [1, 1, 1, 60, 0.2]);
  const errCell = r.cells.find((c) => c.task_id === 'demo-002' && c.condition === 'with');
  is(
    [errCell.n, errCell.runs, errCell.duration, errCell.errors],
    [0, 1, 40, [{ n: 0, stage: 'judge' }]]
  );
  is(
    [r.lift[0].score.delta, r.lift[0].score.n, r.lift[0].duration.n, r.lift[0].conclusive],
    [0.6, 1, 2, false]
  );
  is(r.spend, { tasks: 0.7, judges: 0.2, preflight: 0.03, total: 0.93 });
  ok(r.notes.some((n) => n.includes('noise')));
});

test('aggregate notes #3690, contamination and timeouts', () => {
  const extra = [
    rec('demo-001', 'without', 2, 0.5, 1, 0.1, { attribution: 'contaminated', n: 7 }),
    rec('demo-001', 'with', 2, 0.5, 1, 0.1, {
      metrics: { duration: 1, cost: 0, timedOut: true },
      n: 8,
    }),
  ];
  const r = H.aggregate(P, [...RECORDS, ...extra], { blockScalar: true });
  ok(r.notes[0].startsWith('slicc#3690'));
  ok(
    r.notes.some((n) => n.includes('contaminated')) &&
      r.notes.some((n) => n.includes('lower bound'))
  );
});

test('reportMarkdown shows the table, lift, spend and notes', () => {
  const md = H.reportMarkdown(H.aggregate(P, RECORDS, { blockScalar: true }));
  ok(md.includes('| demo-001 | with | 1 | 1.00 | 1/0/0 | 60.0 | 0.200 | - |'));
  ok(md.includes('score +0.60'));
  ok(md.includes('NOT conclusive'));
  ok(md.includes('slicc#3690'));
});

test('renderDip is one escaped card with the score badges', () => {
  const report = H.aggregate(P, RECORDS);
  report.skill = '<b>demo</b>';
  const html = H.renderDip(report);
  ok(html.startsWith('<div class="sprinkle-action-card">'));
  ok(html.includes('&lt;b&gt;demo&lt;/b&gt;') && !html.includes('<b>demo</b>'));
  ok(html.includes('sprinkle-badge--positive">1.00<'));
  ok(html.includes('>error<'));
  ok(!html.includes('<script'));
});

test('publishFiles uploads report + public records only', () => {
  const full = {
    ...RECORDS[0],
    n: 1,
    uuid: 'secret-uuid',
    error: 'stderr with /Users/jane',
    judge: { model: 'm', cost: 1, attempts: 1, evidence: 'x' },
  };
  const { files, skipped } = H.publishFiles('demo-r1', [
    { rel: 'report.json', text: '{}' },
    { rel: 'report.md', text: '# r' },
    { rel: 'records/1.json', text: JSON.stringify(full) },
    { rel: 'plan.json', text: null },
    { rel: 'preflight-with.json', text: null },
    { rel: 'report.dip.shtml', text: null },
  ]);
  is(
    files.map((f) => f.path),
    [
      'runs/demo-r1/records/demo-001-without-r1.json',
      'runs/demo-r1/report.json',
      'runs/demo-r1/report.md',
    ]
  );
  is(skipped, ['plan.json', 'preflight-with.json', 'report.dip.shtml']);
  const pub = files[0].content;
  ok(!pub.includes('secret-uuid') && !pub.includes('jane') && !pub.includes('evidence'));
});

test('hubCommitLines is a header line plus one base64 line per file', () => {
  const lines = H.hubCommitLines('s', [{ path: 'a', content: 'x' }], (s) => `B64(${s})`)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  is(lines, [
    { key: 'header', value: { summary: 's', description: '' } },
    { key: 'file', value: { path: 'a', encoding: 'base64', content: 'B64(x)' } },
  ]);
});

test('preflightVerdict: without must be unlisted; with must list the staged path', () => {
  is(H.preflightVerdict('without', { listed: false }).ok, true);
  is(H.preflightVerdict('without', { listed: true, path: '/p' }).ok, false);
  is(H.preflightVerdict('with', { listed: true, path: '/s/SKILL.md' }, '/s/SKILL.md').ok, true);
  const other = H.preflightVerdict(
    'with',
    { listed: true, path: '/other/SKILL.md' },
    '/s/SKILL.md'
  );
  ok(!other.ok && other.reason.includes('/other/SKILL.md'));
  is(H.preflightVerdict('with', null).ok, false);
  ok(H.probePrompt('u', 'tst').startsWith('[eval-preflight u]'));
});
