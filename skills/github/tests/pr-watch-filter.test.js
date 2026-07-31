const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildPrWatchFilter,
  composePrWatchFilter,
  findWatchWebhook,
} = require('../scripts/pr-watch-filter.js');

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

  for (const body of bodies) assert.equal(filter({ body }), true);
});

test('uses commit or repository plus branch when check payloads omit pull_requests', () => {
  const filter = compile(buildPrWatchFilter(267, 'topic', 1234, 'abc123'));

  assert.equal(
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
  assert.equal(
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
  assert.equal(filter({ body: { repository: { id: 1234 }, branches: [{ name: 'topic' }] } }), true);
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

  for (const body of bodies) assert.equal(filter({ body }), false);
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

  for (const body of bodies) assert.equal(filter({ body }), false);
});

test('composes a user predicate with the mandatory PR scope', () => {
  const scoped = buildPrWatchFilter(267, ...HEAD);
  const filter = compile(composePrWatchFilter(scoped, "e => e.body.action !== 'synchronize'"));

  assert.equal(filter({ body: { action: 'opened', pull_request: { number: 267 } } }), true);
  assert.equal(filter({ body: { action: 'synchronize', pull_request: { number: 267 } } }), false);
  assert.equal(filter({ body: { action: 'opened', pull_request: { number: 266 } } }), false);
});

test('safely embeds unusual branch names', () => {
  const headRef = 'feature/quote-"-$()';
  const filter = compile(buildPrWatchFilter(267, headRef, 1234, 'abc123'));
  assert.equal(filter({ body: { repository: { id: 1234 }, branches: [{ name: headRef }] } }), true);
});

test('distinguishes filtered watches from legacy endpoints', () => {
  const output = `Active webhooks:\n  old-id  pr-owner-repo-267-watch  https://example.test/old-id  -> scoop\n  new-id  pr-owner-repo-268-watch  https://example.test/new-id  -> scoop  [filtered]\n`;

  assert.deepEqual(findWatchWebhook(output, 'pr-owner-repo-267-watch'), {
    id: 'old-id',
    filtered: false,
  });
  assert.deepEqual(findWatchWebhook(output, 'pr-owner-repo-268-watch'), {
    id: 'new-id',
    filtered: true,
  });
  assert.equal(findWatchWebhook(output, 'pr-owner-repo-26-watch'), null);
});
