import test, { is, throws } from 'tst';
import * as filterMod from '../scripts/pr-watch-filter.js';

const filters = filterMod.default || filterMod;
const { buildPrWatchFilter, composePrWatchFilter, findWatchWebhook } = filters;
const HEAD = ['topic', 1234, 'abc123'];

function compile(source) {
  return Function(`return (${source});`)();
}

test('rejects a non-positive PR number before emitting a filter', () => {
  throws(() => buildPrWatchFilter(0, ...HEAD), new TypeError());
  throws(() => buildPrWatchFilter('nope', ...HEAD), new TypeError());
});

test('matches every PR-linked GitHub webhook payload shape', () => {
  const filter = compile(buildPrWatchFilter(267, ...HEAD));
  const bodies = [
    { number: 267, pull_request: { number: 267 } },
    { pull_request: { number: 267 } },
    { issue: { number: 267, pull_request: {} } },
    { check_run: { pull_requests: [{ number: 267 }] } },
    { check_suite: { pull_requests: [{ number: 267 }] } },
    { sha: 'abc123' },
  ];
  for (const body of bodies) is(filter({ body }), true);
});

test('drops unrelated repository events', () => {
  const filter = compile(buildPrWatchFilter(267, ...HEAD));
  is(filter({ body: { pull_request: { number: 266 } } }), false);
  is(filter({ body: { issue: { number: 261 } } }), false);
  is(filter({ body: {} }), false);
});

test('rejects same-named branches from other forks', () => {
  const filter = compile(buildPrWatchFilter(267, 'topic', 1234, 'abc123'));
  is(
    filter({
      body: {
        check_suite: { pull_requests: [], head_branch: 'topic', head_repository: { id: 9999 } },
      },
    }),
    false
  );
});

test('composes a user predicate with the mandatory PR scope', () => {
  const scoped = buildPrWatchFilter(267, ...HEAD);
  const filter = compile(composePrWatchFilter(scoped, "e => e.body.action !== 'synchronize'"));
  is(filter({ body: { action: 'opened', pull_request: { number: 267 } } }), true);
  is(filter({ body: { action: 'synchronize', pull_request: { number: 267 } } }), false);
  is(filter({ body: { action: 'opened', pull_request: { number: 266 } } }), false);
});

test('distinguishes filtered watches from legacy endpoints', () => {
  const output =
    'Active webhooks:\n  old-id  pr-owner-repo-267-watch  https://example.test/old-id  -> scoop\n  new-id  pr-owner-repo-268-watch  https://example.test/new-id  -> scoop  [filtered]\n';
  is(findWatchWebhook(output, 'pr-owner-repo-267-watch'), {
    id: 'old-id',
    filtered: false,
    target: 'scoop',
  });
  is(findWatchWebhook(output, 'pr-owner-repo-268-watch'), {
    id: 'new-id',
    filtered: true,
    target: 'scoop',
  });
  is(findWatchWebhook(output, 'pr-owner-repo-26-watch'), null);
});
