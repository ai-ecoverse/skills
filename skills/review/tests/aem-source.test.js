const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const reviewSource = fs.readFileSync(path.join(__dirname, '../scripts/review.jsh'), 'utf8');
const aemSource = fs.readFileSync(path.join(__dirname, '../../aem/scripts/aem-ext.jsh'), 'utf8');
const aemStart = aemSource.indexOf('function treeListUrl(');
const aemEnd = aemSource.indexOf('// ── dispatch', aemStart);
assert.ok(aemStart >= 0 && aemEnd > aemStart, 'AEM review command section must exist');

async function aemCard(org, site, command = 'sweep', id) {
  let stdout = '';
  const context = vm.createContext({
    flags: {},
    flag: (name) => ({ path: '/index.md', id })[name],
    requireOrgSite: () => ({ org, site }),
    apiBase: () => 'https://admin.example.invalid',
    operationUrl: () => 'https://admin.example.invalid/status',
    dieOnError() {},
    process: {
      stdout: {
        write: (s) => {
          stdout += s;
        },
      },
      stderr: { write() {} },
    },
    apiFetch: async (_method, url) => ({
      json: url.endsWith('/status')
        ? {
            preview: { status: 200 },
            live: { status: 404 },
          }
        : {
            children: url.includes('/preview/')
              ? [
                  {
                    type: 'file',
                    path: `/${org}/sites/${site}/preview/index.md`,
                    lastModified: '2026-09-01T00:00:00Z',
                  },
                ]
              : [],
          },
    }),
  });
  vm.runInContext(aemSource.slice(aemStart, aemEnd), context);
  await vm.runInContext(command === 'sweep' ? 'cmdSweep()' : 'cmdReviewSource()', context);
  return JSON.parse(stdout.trim());
}

async function review(
  command,
  flags,
  sources = [],
  spawn = async () => ({ exitCode: 0, stdout: '' })
) {
  let stdout = '';
  let stderr = '';
  let code = 0;
  const calls = [];
  const exec = Object.assign(async () => ({ exitCode: 0 }), {
    spawn: async (argv) => {
      calls.push(argv);
      return spawn(argv);
    },
  });
  const argv = [];
  argv.parseFlags = () => ({ flags, subcommand: command, positional: [command, ...sources] });
  const exit = (exitCode) => {
    const error = new Error('exit');
    error.name = 'NodeExitError';
    error.exitCode = exitCode;
    throw error;
  };
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    'require',
    'process',
    reviewSource
  );
  try {
    await run(
      (name) => (name === 'sliccy:exec' ? { exec } : { die: (_msg, opts) => exit(opts.exitCode) }),
      {
        argv,
        exit,
        stdout: {
          write: (s) => {
            stdout += s;
          },
        },
        stderr: {
          write: (s) => {
            stderr += s;
          },
        },
      }
    );
  } catch (error) {
    if (error.name !== 'NodeExitError') throw error;
    code = error.exitCode;
  }
  return { code, stdout, stderr, calls };
}

test('sweep and enrichment IDs keep identical paths in different sites separate', async () => {
  const first = await aemCard('org-one', 'site-one');
  const second = await aemCard('org-one', 'site-two');
  const third = await aemCard('org-two', 'site-one');
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.equal(first.id, 'aem:org-one/site-one:index');
  assert.equal((await aemCard('org-one', 'site-one', 'review')).id, first.id);
  assert.equal((await aemCard('org-one', 'site-one', 'review', 'explicit')).id, 'explicit');
  assert.equal(first.primaryActionLabel, 'Publish');
  assert.equal((await aemCard('org-one', 'site-one', 'review')).primaryActionLabel, 'Publish');
});

test('ingest forwards site flags only to AEM and uses the sweep card ID', async () => {
  const card = await aemCard('example', 'docs');
  const result = await review(
    'ingest',
    { path: '/index.md', org: 'example', site: 'docs', 'dry-run': true },
    ['aem-ext', 'pangram'],
    async (argv) => ({
      exitCode: 0,
      stdout: JSON.stringify({ source: argv[0], id: argv[argv.indexOf('--id') + 1] }),
    })
  );
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).id, card.id);
  assert.deepEqual(result.calls[0], [
    'aem-ext',
    'review',
    '--path',
    '/index.md',
    '--id',
    card.id,
    '--org',
    'example',
    '--site',
    'docs',
  ]);
  assert.deepEqual(result.calls[1], ['pangram', 'review', '--path', '/index.md', '--id', card.id]);
});

test('ingest preserves explicit IDs and passes org/site aliases as literal argv values', async () => {
  const result = await review(
    'ingest',
    { path: '/index.md', id: 'explicit', o: "org's name", repo: 'docs; literal', 'dry-run': true },
    ['aem-ext'],
    async () => ({ exitCode: 0, stdout: '{"source":"aem-source"}' })
  );
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls[0], [
    'aem-ext',
    'review',
    '--path',
    '/index.md',
    '--id',
    'explicit',
    '--org',
    "org's name",
    '--site',
    'docs; literal',
  ]);
});

for (const failAction of ['ensure-item', 'add-findings', null]) {
  test(`sweep reports ${failAction ? 'failure for ' + failAction : 'success'} and processes remaining cards`, async () => {
    const result = await review('sweep', { org: 'example', site: 'docs' }, [], async (argv) => {
      if (argv[0] === 'aem-ext')
        return { exitCode: 0, stdout: '{"id":"first"}\n{"id":"second"}\n' };
      const message = JSON.parse(argv[3]);
      return {
        exitCode: message.id === 'first' && message.action === failAction ? 1 : 0,
        stderr: 'unavailable',
      };
    });
    assert.equal(result.code, failAction ? 1 : 0);
    assert.ok(
      result.calls.some((argv) => argv[0] === 'sprinkle' && JSON.parse(argv[3]).id === 'second')
    );
    assert.match(result.stderr, failAction ? /pushed 1 card\(s\).*1 failed/ : /pushed 2 card\(s\)/);
  });
}

test('ingest carries source labels, with the CLI override taking priority', async () => {
  for (const override of [undefined, "Accept 'draft' <literally>"]) {
    const result = await review(
      'ingest',
      { path: '/draft.md', 'primary-action-label': override },
      ['custom'],
      async (argv) => ({
        exitCode: 0,
        stdout:
          argv[0] === 'custom'
            ? JSON.stringify({ source: 'custom', primaryActionLabel: 'Accept' })
            : '',
      })
    );
    assert.equal(result.code, 0);
    const message = JSON.parse(result.calls.find((argv) => argv[0] === 'sprinkle')[3]);
    assert.equal(message.primaryActionLabel, override || 'Accept');
  }
});

test('ingest without a label preserves an existing label; AEM defaults to Publish', async () => {
  for (const source of ['custom', 'aem-ext']) {
    const result = await review('ingest', { path: '/draft.md' }, [source], async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === source ? JSON.stringify({ source }) : '',
    }));
    assert.equal(result.code, 0);
    const message = JSON.parse(result.calls.find((argv) => argv[0] === 'sprinkle')[3]);
    assert.equal(message.primaryActionLabel, source === 'aem-ext' ? 'Publish' : undefined);
  }
});

test('sweep dry-run and delivered cards use the same label precedence', async () => {
  for (const sourceLabel of [undefined, 'Release']) {
    for (const override of [undefined, 'Approve']) {
      for (const dryRun of [true, false]) {
        const result = await review(
          'sweep',
          { org: 'example', site: 'docs', 'dry-run': dryRun, 'primary-action-label': override },
          [],
          async (argv) => ({
            exitCode: 0,
            stdout:
              argv[0] === 'aem-ext'
                ? JSON.stringify({ id: 'page', primaryActionLabel: sourceLabel })
                : '',
          })
        );
        assert.equal(result.code, 0);
        const message = dryRun
          ? JSON.parse(result.stdout)
          : JSON.parse(result.calls.find((argv) => argv[0] === 'sprinkle')[3]);
        assert.equal(message.primaryActionLabel, override || sourceLabel || 'Publish');
        if (dryRun)
          assert.equal(
            result.calls.some((argv) => argv[0] === 'sprinkle'),
            false
          );
      }
    }
  }
});

test('empty or non-string CLI labels fail before invoking a source', async () => {
  for (const value of ['', ' ', true, ['Publish', 'Approve']]) {
    const result = await review('ingest', { path: '/draft.md', 'primary-action-label': value });
    assert.equal(result.code, 2);
    assert.equal(result.calls.length, 0);
  }
});
