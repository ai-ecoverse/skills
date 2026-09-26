// bb thread list: --limit passthrough, --offset, --all paging and dedup.
//
// Run from the skill directory: tst tests/thread-list.test.js

import test, { is, ok } from 'tst';
import { runBb, threadServer } from './harness.js';

const listCalls = (run) => run.calls.filter((c) => c.method === 'GET' && c.path === '/threads');

test('--all pages with offset and stops at the first short page', async () => {
  const run = await runBb(['thread', 'list', '--all', '--json'], { server: threadServer(450) });
  is(run.exitCode, 0);
  is(
    listCalls(run).map((c) => [c.params.limit, c.params.offset]),
    [
      ['200', '0'],
      ['200', '200'],
      ['200', '400'],
    ]
  );
  is(run.out.length, 1);
  is(Array.isArray(run.out[0]), true);
  is(run.out[0].length, 450);
  is(run.out[0][0].id, 't-0000');
  is(run.out[0][449].id, 't-0449');
});

test('--all makes one extra request when the total is an exact page multiple', async () => {
  const run = await runBb(['thread', 'list', '--all', '--json'], { server: threadServer(400) });
  is(run.exitCode, 0);
  is(
    listCalls(run).map((c) => c.params.offset),
    ['0', '200', '400']
  );
  is(run.out[0].length, 400);
});

test('--all keeps filters on every page and starts at --offset', async () => {
  const run = await runBb(
    ['thread', 'list', '--all', '--project', 'p-fake', '--archived', '--offset', '50', '--json'],
    { server: threadServer(300) }
  );
  is(run.exitCode, 0);
  const calls = listCalls(run);
  is(
    calls.map((c) => c.params.offset),
    ['50', '250']
  );
  for (const call of calls) {
    is(call.params.projectId, 'p-fake');
    is(call.params.archived, 'true');
  }
  is(run.out[0].length, 250);
});

test('--all deduplicates by id when rows shift between pages', async () => {
  // Three threads appear after page one is read, so page two starts with the
  // last three rows of page one again.
  const run = await runBb(['thread', 'list', '--all', '--json'], {
    server: threadServer(450, { insertAfterFirstRead: 3 }),
  });
  is(run.exitCode, 0);
  const ids = run.out[0].map((t) => t.id);
  is(new Set(ids).size, ids.length);
  is(ids.length, 450);
  is(ids[0], 't-0000');
  is(ids.at(-1), 't-0449');
});

test('--all prints every thread in the human listing too', async () => {
  const run = await runBb(['thread', 'list', '--all'], { server: threadServer(230) });
  is(run.exitCode, 0);
  ok(run.stdout.includes('id:t-0000'));
  ok(run.stdout.includes('id:t-0229'));
  is(run.stdout.split('\n').filter((l) => l.includes('id:t-')).length, 230);
});

test('--all stops when a full page adds no new id', async () => {
  // A server that ignores offset would otherwise loop forever.
  const stuck = threadServer(200);
  const server = (req) => stuck({ ...req, params: { ...req.params, offset: '0' } });
  const run = await runBb(['thread', 'list', '--all', '--json'], { server });
  is(run.exitCode, 0);
  is(listCalls(run).length, 2);
  is(run.out[0].length, 200);
  ok(/already seen/u.test(run.stderr));
});

test('--all with --limit is refused rather than guessed', async () => {
  const run = await runBb(['thread', 'list', '--all', '--limit', '5'], {
    server: threadServer(10),
  });
  is(run.exitCode, 1);
  ok(/--all/u.test(run.error.message) && /--limit/u.test(run.error.message));
  is(listCalls(run).length, 0);
});

test('--offset is passed through with --limit', async () => {
  const run = await runBb(['thread', 'list', '--limit', '10', '--offset', '40', '--json'], {
    server: threadServer(100),
  });
  is(run.exitCode, 0);
  const calls = listCalls(run);
  is(calls.length, 1);
  is(calls[0].params.limit, '10');
  is(calls[0].params.offset, '40');
  is(
    run.out[0].map((t) => t.id),
    Array.from({ length: 10 }, (_, i) => `t-${String(40 + i).padStart(4, '0')}`)
  );
});

test('--offset rejects a value that is not a non-negative integer', async () => {
  for (const bad of ['-1', 'abc', '1.5']) {
    const run = await runBb(['thread', 'list', `--offset=${bad}`], { server: threadServer(10) });
    is(run.exitCode, 1, `--offset=${bad}`);
    ok(/--offset must be a non-negative integer/u.test(run.error.message), `--offset=${bad}`);
    is(listCalls(run).length, 0);
  }
});

test('--limit above 200 reaches the server unclamped', async () => {
  const run = await runBb(['thread', 'list', '--limit', '2000', '--json'], {
    server: threadServer(891),
  });
  is(run.exitCode, 0);
  is(listCalls(run)[0].params.limit, '2000');
  is(run.out[0].length, 891);
  // A short page is the whole answer, so no truncation note.
  ok(!/full page/u.test(run.stderr));
});

test('a full page warns on stderr and names --offset and --all', async () => {
  const run = await runBb(['thread', 'list', '--limit', '200', '--json'], {
    server: threadServer(891),
  });
  is(run.exitCode, 0);
  is(run.out[0].length, 200);
  ok(/full page of 200/u.test(run.stderr));
  ok(/--offset 200/u.test(run.stderr));
  ok(/--all/u.test(run.stderr));
  // The warning stays off stdout so --json output still parses.
  is(JSON.parse(run.stdout).length, 200);
});

test('the default page of 20 also says when more threads may exist', async () => {
  const run = await runBb(['thread', 'list'], { server: threadServer(25) });
  is(run.exitCode, 0);
  is(listCalls(run)[0].params.limit, '20');
  is(listCalls(run)[0].params.offset, undefined);
  ok(/--offset 20/u.test(run.stderr));
});
