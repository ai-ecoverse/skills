import fs from 'node:fs';
import test, { is, ok } from 'tst';
import { runGh, scratchDir } from './gh-local-harness.js';

// `gh monitor add|list|rm` against a scratch config under /tmp
// (GH_MONITOR_CONFIG), never the live /shared/github-monitor/config.json.
// GitHub and `bb project list` are mocked by the harness.

const REPOS = {
  'octocat/Hello-World': { full_name: 'octocat/Hello-World', private: false },
  'octocat/Spoon-Knife': { full_name: 'octocat/Spoon-Knife', private: false },
};
const BB = [
  {
    id: 'proj_example01',
    name: 'hello-world',
    gitRemoteUrl: 'https://github.com/octocat/Hello-World.git',
  },
];

async function setup(label) {
  const dir = await scratchDir(label);
  const file = `${dir}/config.json`;
  return { dir, file, env: { GH_MONITOR_CONFIG: file } };
}

const run = (args, s, extra = {}) => runGh(args, { env: s.env, repos: REPOS, bb: BB, ...extra });

test('monitor list on an absent config says nothing is monitored; --json is []', async () => {
  const s = await setup('mon-absent');
  const r = await run(['monitor', 'list'], s);
  is(r.code, 0, r.err);
  ok(/does not exist — nothing is monitored/.test(r.out), r.out);
  const j = await run(['monitor', 'list', '--json'], s);
  is(j.code, 0, j.err);
  is(JSON.parse(j.out), []);
  ok(!fs.existsSync(s.file), 'list must not create the file');
});

test('monitor add creates the config, resolving the bb project by git remote', async () => {
  const s = await setup('mon-add');
  const r = await run(['monitor', 'add', 'octocat/Hello-World'], s);
  is(r.code, 0, r.err);
  ok(/Monitoring octocat\/Hello-World/.test(r.out), 'the panel keys success on this line');
  ok(
    /placeholder https:\/\/bb\.example\.invalid/.test(r.out),
    'creating the file names the placeholder origin'
  );
  const cfg = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  is(cfg, {
    version: 1,
    bbOrigin: 'https://bb.example.invalid',
    repos: [{ slug: 'octocat/Hello-World', bbProject: 'proj_example01' }],
  });
  ok(
    r.calls.some((c) => c.path === '/repos/octocat/Hello-World'),
    'add verifies the repo on GitHub'
  );
});

test('monitor add --no-bb-project appends null; list --json keeps order and source', async () => {
  const s = await setup('mon-null');
  is((await run(['monitor', 'add', 'octocat/Hello-World'], s)).code, 0);
  const r = await run(['monitor', 'add', 'octocat/Spoon-Knife', '--no-bb-project'], s);
  is(r.code, 0, r.err);
  const j = await run(['monitor', 'list', '--json'], s);
  is(JSON.parse(j.out), [
    { slug: 'octocat/Hello-World', bbProject: 'proj_example01', source: 'file' },
    { slug: 'octocat/Spoon-Knife', bbProject: null, source: 'file' },
  ]);
});

test('monitor add rejects a bad slug, contradicting flags, a duplicate and an unresolved bb project', async () => {
  const s = await setup('mon-reject');
  const bad = await run(['monitor', 'add', '.x/y'], s);
  is(bad.code, 1);
  ok(/invalid repository/.test(bad.err), bad.err);
  is(bad.calls.length, 0, 'no API call for a bad slug');

  const both = await run(
    ['monitor', 'add', 'octocat/Hello-World', '--bb-project', 'proj_example01', '--no-bb-project'],
    s
  );
  is(both.code, 1);
  ok(/contradict/.test(both.err), both.err);

  const unresolved = await run(['monitor', 'add', 'octocat/Spoon-Knife'], s);
  is(unresolved.code, 1);
  ok(/no bb project could be resolved/.test(unresolved.err), unresolved.err);
  ok(!fs.existsSync(s.file), 'a refused add writes nothing');

  is((await run(['monitor', 'add', 'octocat/Hello-World'], s)).code, 0);
  const before = fs.readFileSync(s.file, 'utf8');
  const dup = await run(['monitor', 'add', 'octocat/hello-world'], s);
  is(dup.code, 1);
  ok(/already monitored/.test(dup.err), dup.err);
  is(fs.readFileSync(s.file, 'utf8'), before, 'a duplicate leaves the file byte-identical');
});

test('monitor rm removes; add-then-rm is a byte round trip; the last repo cannot be removed', async () => {
  const s = await setup('mon-rm');
  is((await run(['monitor', 'add', 'octocat/Hello-World'], s)).code, 0);
  const one = fs.readFileSync(s.file, 'utf8');
  is((await run(['monitor', 'add', 'octocat/Spoon-Knife', '--no-bb-project'], s)).code, 0);
  const rm = await run(['monitor', 'rm', 'octocat/Spoon-Knife'], s);
  is(rm.code, 0, rm.err);
  ok(/Stopped monitoring octocat\/Spoon-Knife/.test(rm.out));
  is(fs.readFileSync(s.file, 'utf8'), one, 'add then rm restores the file exactly');

  const last = await run(['monitor', 'rm', 'octocat/Hello-World'], s);
  is(last.code, 1);
  ok(/only monitored repo/.test(last.err), last.err);
  is(fs.readFileSync(s.file, 'utf8'), one);

  const missing = await run(['monitor', 'rm', 'octocat/Nope'], s);
  is(missing.code, 1);
  ok(/is not monitored/.test(missing.err));
});

test('monitor refuses a malformed config with exit 2 and leaves it alone', async () => {
  const s = await setup('mon-bad');
  fs.writeFileSync(s.file, '{"version": 1, "repos": [');
  const r = await run(['monitor', 'add', 'octocat/Hello-World'], s);
  is(r.code, 2);
  ok(/not a valid monitor config/.test(r.err), r.err);
  is(fs.readFileSync(s.file, 'utf8'), '{"version": 1, "repos": [');
});

test('a failed monitor write leaves the original and no temp file (GH_MONITOR_FAULT)', async () => {
  const s = await setup('mon-fault');
  is((await run(['monitor', 'add', 'octocat/Hello-World'], s)).code, 0);
  const before = fs.readFileSync(s.file, 'utf8');
  for (const fault of ['throw-before-rename', 'corrupt-temp']) {
    const r = await run(['monitor', 'add', 'octocat/Spoon-Knife', '--no-bb-project'], {
      env: { ...s.env, GH_MONITOR_FAULT: fault },
    });
    is(r.code, 1, `${fault}: ${r.err}`);
    ok(/is unchanged/.test(r.err), r.err);
    is(fs.readFileSync(s.file, 'utf8'), before, `${fault}: original untouched`);
    is(fs.readdirSync(s.dir), ['config.json'], `${fault}: no temp litter`);
  }
});

test('gh monitor --help lists add, list and rm without a token', async () => {
  const r = await runGh(['monitor', '--help']);
  is(r.code, 0, r.err);
  is(r.tokenCalls.length, 0);
  for (const verb of ['gh monitor add', 'gh monitor list', 'gh monitor rm'])
    ok(r.out.includes(verb), verb);
});
