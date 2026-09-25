import test, { is, ok } from 'tst';

// Evaluates the FENCED renovateFilter block (8< ... >8) of the fetcher itself,
// located the way the other suites locate it; GHD_FETCHER points elsewhere
// (used to show this suite is RED against the fetcher without the filter).
const fs = require('fs');
const FILE = (process.env && process.env.GHD_FETCHER) ||
  ['../scripts/fetch-snapshot.mjs', '../fetch-snapshot.mjs']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => fs.existsSync(p)) ||
  (() => { throw new Error('fetch-snapshot.mjs not found; set GHD_FETCHER'); })();
const src = fs.readFileSync(FILE, 'utf8');
const a = src.indexOf('/* ---- 8< renovateFilter');
const b = src.indexOf('/* ---- >8 end renovateFilter');
// Absent block -> a stub that throws, so each test goes red on its own.
const isRenovateDependencyDashboard = a >= 0 && b > a
  ? new Function(src.slice(a, b) + '\nreturn isRenovateDependencyDashboard;')()
  : () => { throw new Error(`isRenovateDependencyDashboard is not defined in ${FILE}`); };

// Raw GitHub issues-list shapes, copied from the live API on 2026-09-25
// (GET repos/ai-ecoverse/slicc/issues, the fetcher's own call), body truncated.
const SENTENCE = 'This issue lists Renovate updates and detected dependencies.';
const DASHBOARD_211 = {
  number: 211,
  title: 'Dependency Dashboard',
  user: { login: 'renovate[bot]', type: 'Bot' },
  state: 'open',
  body: SENTENCE + ' Read the [Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) docs to learn',
};
const RENOVATE_PR_3476 = {
  number: 3476,
  title: 'chore(deps): update dependency @cloudflare/workers-types to v5.20260918.1',
  user: { login: 'renovate[bot]', type: 'Bot' },
  pull_request: { url: 'https://api.github.com/repos/ai-ecoverse/slicc/pulls/3476' },
  state: 'closed',
  body: 'This PR contains the following updates:\n\n| Package | Change |',
};

test('D1 the real slicc#211 shape is dropped', () => {
  is(isRenovateDependencyDashboard(DASHBOARD_211), true);
});

test('K1 a Renovate update PR is kept (it is real work, even if it quotes the dashboard)', () => {
  is(isRenovateDependencyDashboard(RENOVATE_PR_3476), false);
  // Belt and braces: a PR is kept even with a dashboard-like title and the sentence.
  is(isRenovateDependencyDashboard({ ...DASHBOARD_211, pull_request: { url: 'x' } }), false);
});

test('K2 an issue titled "Dependency Dashboard" by a HUMAN is kept', () => {
  is(isRenovateDependencyDashboard({ ...DASHBOARD_211, user: { login: 'octocat', type: 'User' } }), false);
  is(isRenovateDependencyDashboard({ ...DASHBOARD_211, user: null }), false);
});

test('K3 a renovate-authored issue that is NOT a dashboard is kept', () => {
  is(isRenovateDependencyDashboard({ number: 900, title: 'Action Required: Fix Renovate Configuration', user: { login: 'renovate[bot]', type: 'Bot' }, state: 'open', body: 'There is an error with this repository\'s Renovate configuration that needs to be fixed.' }), false);
});

test('D2 a custom-titled dashboard carrying the fixed body sentence is dropped', () => {
  is(isRenovateDependencyDashboard({ ...DASHBOARD_211, title: 'Renovate: pending updates (slicc)' }), true);
  // Author match is case-insensitive (/renovate/i), e.g. a self-hosted "Renovate-Bot".
  is(isRenovateDependencyDashboard({ ...DASHBOARD_211, title: 'Deps', user: { login: 'Renovate-Bot', type: 'User' } }), true);
});

test('E1 malformed input never throws and is kept', () => {
  for (const v of [null, undefined, 42, 'x', {}, { user: { login: 'renovate[bot]' } }]) is(isRenovateDependencyDashboard(v), false);
});

test('W1 wiring: the filter runs on the raw issues list, before the window and any record', () => {
  const listCall = src.indexOf('issues?state=all&sort=updated');
  const filterAt = src.indexOf('if (!isRenovateDependencyDashboard(it)) return true;', listCall);
  const windowAt = src.indexOf('const kept = items.filter(', listCall);
  const recordAt = src.indexOf('const rec = {', listCall);
  ok(listCall > 0 && filterAt > listCall && filterAt < windowAt && windowAt < recordAt, `list ${listCall} < filter ${filterAt} < window ${windowAt} < record ${recordAt}`);
  ok(/filtered: \{\s*renovateDependencyDashboard: filteredOut\.renovateDependencyDashboard\.length/.test(src), 'meta.filtered.renovateDependencyDashboard is published');
});
