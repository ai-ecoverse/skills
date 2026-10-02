import test, { is, ok } from 'tst';

/* Phase 8g: the project + runs `gh monitor add <owner/repo>` through a SHELL
   (slicc.exec takes a command string). This cuts the GHD-ADDREPO region
   (validation, quoting, command building, result summary) out of the BUILT
   panel and evaluates it, so it tests the shipped text.

     cd <dir holding tests/> && tst tests/add-repo.test.js
     GHD_PANEL=/path/to/other.shtml tst tests/add-repo.test.js

   Builtin `tst` runner (node:test is not available here). */
const fs = require('fs');
const env = (typeof process !== 'undefined' && process.env) || {};
const PANEL = env.GHD_PANEL ||
  ['../github-dashboard.shtml', '../assets/sprinkle/github-dashboard.shtml']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => fs.existsSync(p)) ||
  (() => { throw new Error('github-dashboard.shtml not found; set GHD_PANEL'); })();

let API = null;
function api() {
  if (API) return API;
  const s = fs.readFileSync(PANEL, 'utf8');
  const a = s.indexOf('GHD-ADDREPO:START');
  const b = s.indexOf('GHD-ADDREPO:END');
  if (a < 0 || b < 0 || b < a) throw new Error(`${PANEL}: no GHD-ADDREPO region`);
  API = new Function(s.slice(s.lastIndexOf('/*', a), s.lastIndexOf('\n', b)) +
    '\nreturn { buildAddCommand, summarizeAdd, shellQuote, shortError };')();
  return API;
}
const build = (t) => api().buildAddCommand(t);

// The ONLY command shapes that may ever reach the shell.
const SAFE = /^gh monitor add '[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*'( --no-bb-project| --bb-project 'proj_[A-Za-z0-9]+')?$/;

test('valid slugs build exactly one quoted command', () => {
  const cases = [
    ['ai-ecoverse/skills', "gh monitor add 'ai-ecoverse/skills'"],
    ['  octocat/Hello-World  ', "gh monitor add 'octocat/Hello-World'"],
    ['a.b_c-d/E.9-x_y', "gh monitor add 'a.b_c-d/E.9-x_y'"],
    ['ai-ecoverse/kev.js', "gh monitor add 'ai-ecoverse/kev.js'"],
    ['a/b\u00a0', "gh monitor add 'a/b'"], // trim() also drops a trailing NBSP: harmless
    ['octocat/Hello-World none', "gh monitor add 'octocat/Hello-World' --no-bb-project"],
    ['octocat/Hello-World proj_example01', "gh monitor add 'octocat/Hello-World' --bb-project 'proj_example01'"],
    ['octocat/Hello-World   proj_example01', "gh monitor add 'octocat/Hello-World' --bb-project 'proj_example01'"],
  ];
  for (const [input, cmd] of cases) {
    const r = build(input);
    is(r.ok, true, `accepted: ${JSON.stringify(input)}`);
    is(r.cmd, cmd, `command for ${JSON.stringify(input)}`);
  }
  is(build('octocat/Hello-World none').bb, null, 'none -> bb null');
  is(build('ai-ecoverse/skills').bb, undefined, 'no second word -> let gh resolve');
});

const HOSTILE = [
  'a/b;rm -rf x', '$(x)/y', 'a/$(x)', '`x`/y', 'a/`id`', 'a b/c', 'a/b c', '../x', 'x/..', '', '   ',
  'a/', '/b', 'a', 'a/b/c', "a/b'", "a/b';rm -rf x;'", 'a/b"', 'a/b\nrm -rf x', 'a/b\trm', 'a/b|cat',
  'a/b&&id', 'a/b>x', 'a/b<x', 'a/b\\', '-x/y', '.x/y', 'x/-y', 'x/.y', 'a/b none extra',
  'a/b proj_', 'a/b proj_x;rm', 'a/b --no-bb-project', 'a/b --bb-project=x', 'a/b -R c/d',
  'a/b proj_x y', 'a/b NONE', 'a/b ${IFS}', '\u0430/b', 'a*/b', 'a/b?', 'a/b#c', '~/b',
  'a' + '/b'.repeat(90),
];

test('injection attempts are rejected before anything runs', () => {
  for (const input of HOSTILE) {
    const r = build(input);
    is(r.ok, false, `rejected: ${JSON.stringify(input)}`);
    is(r.cmd, undefined, `no command for ${JSON.stringify(input)}`);
  }
});

test('whatever is accepted, the command has the one safe shape (deterministic fuzz)', () => {
  // Mostly-valid slugs with shell metacharacters sprinkled in, so the fuzz
  // lands on BOTH sides of the pattern rather than being all-rejected.
  const safe = 'abcXYZ019._-';
  const meta = "/ ;$()`'\"\\|&<>*?#~!{}[]\n\t=,+%@^:";
  let seed = 20260925;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  const word = () => {
    let w = '';
    const len = 1 + rnd(10);
    for (let j = 0; j < len; j++) w += rnd(100) < 90 ? safe[rnd(safe.length)] : meta[rnd(meta.length)];
    return w;
  };
  const third = () => [' none', ' proj_' + word(), ' ' + word(), ''][rnd(4)];
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 20000; i++) {
    const t = word() + '/' + word() + third();
    const r = build(t);
    if (!r.ok) {
      rejected++;
      is(r.cmd, undefined, 'a rejected input builds no command');
      continue;
    }
    accepted++;
    ok(SAFE.test(r.cmd), `unsafe command built from ${JSON.stringify(t)}: ${r.cmd}`);
  }
  console.log(`# fuzz: ${accepted} accepted, ${rejected} rejected of 20000; every accepted command has the safe shape`);
  ok(accepted > 1000 && rejected > 1000, 'the fuzz exercised both sides');
});

test('shellQuote closes and escapes a quote (second line of defence)', () => {
  is(api().shellQuote("it's"), "'it'\\''s'");
  is(api().shellQuote('a/b'), "'a/b'");
});

// Real `gh monitor add` output, captured against a SCRATCH config (GH_MONITOR_CONFIG).
const ESC = '\u001b';
const R = {
  added: { exitCode: 0, stderr: '', stdout: `${ESC}[32m\u2713${ESC}[0m Monitoring ${ESC}[1moctocat/Hello-World${ESC}[0m\n  bb project   : ${ESC}[36mproj_example01${ESC}[0m\n` },
  addedNull: { exitCode: 0, stderr: '', stdout: `${ESC}[32m\u2713${ESC}[0m Monitoring ${ESC}[1moctocat/Hello-World${ESC}[0m\n  bb project   : ${ESC}[33mnull \u2014 no bb thread links for this repo${ESC}[0m\n` },
  duplicate: { exitCode: 1, stdout: '', stderr: `${ESC}[31mError:${ESC}[0m monitor add: ai-ecoverse/skills is already monitored (bbProject: proj_example02).\nDuplicates are an error rather than a silent no-op, because two entries for one repo would mean\n` },
  notFound: { exitCode: 1, stdout: '', stderr: `${ESC}[31mgh:${ESC}[0m monitor add: GitHub returned 404 for ai-ecoverse/nope.\nThat means either the repository does not exist (check the spelling and the owner), or it is\n` },
  noBb: { exitCode: 1, stdout: '', stderr: `${ESC}[31mError:${ESC}[0m monitor add: no bb project could be resolved for octocat/Hello-World.\nNo bb project declares it as a git remote, and none is named "Hello-World".\n` },
  ambiguous: { exitCode: 1, stdout: '', stderr: `${ESC}[31mError:${ESC}[0m monitor add: ai-ecoverse/ai-aligned-gh matches 2 bb projects by git remote, so this command\nwill not guess which one owns the threads:\n  proj_aaa111  ai-aligned-gh  (ai-ecoverse/ai-aligned-gh)\n  proj_bbb222  aag  (ai-ecoverse/ai-aligned-gh)\n` },
  proxy: { exitCode: 1, stdout: '', stderr: `${ESC}[31mgh:${ESC}[0m monitor add failed: HTTP 502 Bad Gateway https://api.github.com/repos/octocat/Hello-World: {"error":"Proxy fetch failed: The operation couldn\u2019t be completed. (AsyncHTTPClient.HTTPClientError error 1.)"}\n` },
  stack: { exitCode: 1, stdout: '', stderr: 'TypeError: boom\n    at monitorAdd (gh.jsh:3050:11)\n    at main (gh.jsh:9000:3)\n' },
  exit0NoConfirm: { exitCode: 0, stdout: '', stderr: '' },
};

test('results: success, and each failure the command really prints', () => {
  const s = (r, t) => api().summarizeAdd(r, build(t));
  let x = s(R.added, 'octocat/Hello-World');
  is(x.ok, true);
  is(x.text, 'octocat/Hello-World added. It appears after the next poll, in about 34 min.');
  is(s(R.addedNull, 'octocat/Hello-World none').ok, true);
  x = s(R.duplicate, 'ai-ecoverse/skills');
  is(x.kind, 'duplicate');
  is(x.text, 'ai-ecoverse/skills is already watched.');
  x = s(R.notFound, 'ai-ecoverse/nope');
  is(x.text, 'ai-ecoverse/nope not found, or private to this token.');
  x = s(R.noBb, 'octocat/Hello-World');
  is(x.kind, 'bb-choice');
  is(x.text, 'No bb project for octocat/Hello-World. Append a proj_ id or none, then Enter.');
  x = s(R.ambiguous, 'ai-ecoverse/ai-aligned-gh');
  is(x.text, 'ai-ecoverse/ai-aligned-gh matches several bb projects (proj_aaa111, proj_bbb222). Append one, then Enter.');
  x = s(R.proxy, 'octocat/Hello-World');
  is(x.kind, 'failed');
  ok(!x.text.includes(ESC) && x.text.length <= 140 && x.text.startsWith('monitor add failed: HTTP 502'), x.text);
  x = s(R.stack, 'a/b');
  is(x.text, 'TypeError: boom', 'first line only, no stack frames');
  x = s(R.exit0NoConfirm, 'a/b');
  is(x.ok, false, 'exit 0 without "Monitoring <slug>" is not trusted');
  x = s({ timedOut: true }, 'a/b');
  is(x.kind, 'timeout');
});
