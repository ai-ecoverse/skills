import test, { is } from 'tst';
import * as _mod_0 from '../scripts/pr-watch-filter.js';

const { buildPrWatchFilter, composePrWatchFilter, findWatchWebhook, } = _mod_0.default || _mod_0;
const HEAD = ['trieloff/topic', 1234, 'abc123'];

function compile(source) {
  return Function(`return (${source});`)();
}

test('matches every PR-linked GitHub webhook payload shape', () => {
  const filter = compile(buildPrWatchFilter(267, ...HEAD));
  const bodies = [
    { number: 267, pull_request: { number: 267 } },
    { pull_request: { number: 267 } },
    { issue: { number: 267, pull_request: {} } },
    { check_run: { pull_requests: [{ number: 267 }] } },
    { check_run: { pull_requests: [], check_suite: { pull_requests: [{ number: 267 }] } } },
    { check_suite: { pull_requests: [{ number: 267 }] } },
    { sha: 'abc123', branches: [{ name: 'trieloff/topic' }] },
  ];

  for (const body of bodies) is(filter({ body }), true);
});

test('uses commit or repository plus branch when check payloads omit pull_requests', () => {
  const filter = compile(buildPrWatchFilter(267, 'topic', 1234, 'abc123'));

  is(
    filter({
      body: {
        check_run: {
          pull_requests: [],
          check_suite: {
            pull_requests: [],
            head_branch: 'topic',
            head_repository: { id: 1234 },
          },
        },
      },
    }),
    true
  );
  is(
    filter({
      body: {
        check_suite: {
          pull_requests: [],
          head_sha: 'abc123',
        },
      },
    }),
    true
  );
  is(filter({ body: { repository: { id: 1234 }, branches: [{ name: 'topic' }] } }), true);
});

test('rejects same-named branches from other forks', () => {
  const filter = compile(buildPrWatchFilter(267, 'topic', 1234, 'abc123'));
  const bodies = [
    { check_suite: { pull_requests: [], head_branch: 'topic', head_repository: { id: 9999 } } },
    {
      check_run: {
        pull_requests: [],
        check_suite: { head_branch: 'topic', head_repository: { id: 9999 } },
      },
    },
    { repository: { id: 9999 }, branches: [{ name: 'topic' }] },
  ];

  for (const body of bodies) is(filter({ body }), false);
});

test('drops unrelated repository events', () => {
  const filter = compile(buildPrWatchFilter(267, ...HEAD));
  const bodies = [
    { pull_request: { number: 266 } },
    { issue: { number: 261 } },
    { check_run: { pull_requests: [{ number: 265 }] } },
    { check_suite: { pull_requests: [], head_branch: 'someone/else' } },
    { repository: { id: 1234 }, branches: [{ name: 'main' }] },
    {},
  ];

  for (const body of bodies) is(filter({ body }), false);
});

test('composes a user predicate with the mandatory PR scope', () => {
  const scoped = buildPrWatchFilter(267, ...HEAD);
  const filter = compile(composePrWatchFilter(scoped, "e => e.body.action !== 'synchronize'"));

  is(filter({ body: { action: 'opened', pull_request: { number: 267 } } }), true);
  is(filter({ body: { action: 'synchronize', pull_request: { number: 267 } } }), false);
  is(filter({ body: { action: 'opened', pull_request: { number: 266 } } }), false);
});

test('safely embeds unusual branch names', () => {
  const headRef = 'feature/quote-"-$()';
  const filter = compile(buildPrWatchFilter(267, headRef, 1234, 'abc123'));
  is(filter({ body: { repository: { id: 1234 }, branches: [{ name: headRef }] } }), true);
});

test('distinguishes filtered watches from legacy endpoints', () => {
  const output = `Active webhooks:\n  old-id  pr-owner-repo-267-watch  https://example.test/old-id  -> scoop\n  new-id  pr-owner-repo-268-watch  https://example.test/new-id  -> scoop  [filtered]\n`;

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

test('reports the delivery target so a watch can be reconciled', () => {
  const output = [
    'Active webhooks:',
    '  a1  pr-owner-repo-1-watch  https://example.test/a1  -> cone-helix  [filtered]',
    '  a2  pr-owner-repo-2-watch  https://example.test/a2  -> gh-watch-scoop-scoop',
    '  a3  pr-owner-repo-3-watch  https://example.test/a3  [filtered]',
    '  a4  pr-owner-repo-4-watch  https://example.test/a4  ->  [filtered]',
    '',
  ].join('\n');

  is(findWatchWebhook(output, 'pr-owner-repo-1-watch').target, 'cone-helix');
  is(findWatchWebhook(output, 'pr-owner-repo-2-watch').target, 'gh-watch-scoop-scoop');
  // No target column at all, and a target column with nothing in it, must both
  // read as "unknown" rather than as a unit literally named `[filtered]`.
  is(findWatchWebhook(output, 'pr-owner-repo-3-watch').target, null);
  is(findWatchWebhook(output, 'pr-owner-repo-4-watch').target, null);
  // Parsing the target must not disturb the other two fields.
  is(findWatchWebhook(output, 'pr-owner-repo-3-watch').filtered, true);
  is(findWatchWebhook(output, 'pr-owner-repo-2-watch').filtered, false);
  is(findWatchWebhook(output, 'pr-owner-repo-1-watch').id, 'a1');
});
