import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const reviewSource = fs.readFileSync(path.join(__dirname, '../scripts/review.jsh'), 'utf8');
const aemSource = fs.readFileSync(path.join(__dirname, '../../aem/scripts/aem-ext.jsh'), 'utf8');
const aemStart = aemSource.indexOf('function treeListUrl(');
const aemEnd = aemSource.indexOf('// ── dispatch', aemStart);
ok(aemStart >= 0 && aemEnd > aemStart, 'AEM review command section must exist');

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
  spawn = async () => ({ exitCode: 0, stdout: '' }),
  env = {}
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
        env,
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
  is(new Set([first.id, second.id, third.id]).size, 3);
  is(first.id, 'aem:org-one/site-one:index');
  is((await aemCard('org-one', 'site-one', 'review')).id, first.id);
  is((await aemCard('org-one', 'site-one', 'review', 'explicit')).id, 'explicit');
  is(first.primaryActionLabel, 'Publish');
  is((await aemCard('org-one', 'site-one', 'review')).primaryActionLabel, 'Publish');
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
  is(result.code, 0);
  is(JSON.parse(result.stdout).id, card.id);
  is(result.calls[0], [
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
  is(result.calls[1], ['pangram', 'review', '--path', '/index.md', '--id', card.id]);
});

test('ingest preserves explicit IDs and passes org/site aliases as literal argv values', async () => {
  const result = await review(
    'ingest',
    { path: '/index.md', id: 'explicit', o: "org's name", repo: 'docs; literal', 'dry-run': true },
    ['aem-ext'],
    async () => ({ exitCode: 0, stdout: '{"source":"aem-source"}' })
  );
  is(result.code, 0);
  is(result.calls[0], [
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
    is(result.code, failAction ? 1 : 0);
    ok(
      result.calls.some((argv) => argv[0] === 'sprinkle' && JSON.parse(argv[3]).id === 'second')
    );
    ok((failAction ? /pushed 1 card\(s\).*1 failed/ : /pushed 2 card\(s\)/).test(result.stderr));
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
    is(result.code, 0);
    const message = JSON.parse(result.calls.find((argv) => argv[0] === 'sprinkle')[3]);
    is(message.primaryActionLabel, override || 'Accept');
  }
});

test('ingest without a label preserves an existing label; AEM defaults to Publish', async () => {
  for (const source of ['custom', 'aem-ext']) {
    const result = await review('ingest', { path: '/draft.md' }, [source], async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === source ? JSON.stringify({ source }) : '',
    }));
    is(result.code, 0);
    const message = JSON.parse(result.calls.find((argv) => argv[0] === 'sprinkle')[3]);
    is(message.primaryActionLabel, source === 'aem-ext' ? 'Publish' : undefined);
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
        is(result.code, 0);
        const message = dryRun
          ? JSON.parse(result.stdout)
          : JSON.parse(result.calls.find((argv) => argv[0] === 'sprinkle')[3]);
        is(message.primaryActionLabel, override || sourceLabel || 'Publish');
        if (dryRun)
          is(
            result.calls.some((argv) => argv[0] === 'sprinkle'),
            false
          );
      }
    }
  }
});

test('ingest and sweep stamp the filing cone from TMPDIR on ensure-item', async () => {
  const env = { TMPDIR: '/tmp/cone-adobe/review' };
  const ingest = await review(
    'ingest',
    { path: '/draft.md' },
    ['custom'],
    async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === 'custom' ? JSON.stringify({ source: 'custom' }) : '',
    }),
    env
  );
  is(ingest.code, 0);
  const ingestMsg = JSON.parse(ingest.calls.find((argv) => argv[0] === 'sprinkle')[3]);
  is(ingestMsg.action, 'ensure-item');
  is(ingestMsg.cone, 'cone-adobe');

  const sweep = await review(
    'sweep',
    { org: 'example', site: 'docs' },
    [],
    async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === 'aem-ext' ? '{"id":"page"}\n' : '',
    }),
    env
  );
  is(sweep.code, 0);
  const sweepMsg = JSON.parse(
    sweep.calls.find((argv) => argv[0] === 'sprinkle' && JSON.parse(argv[3]).action === 'ensure-item')[3]
  );
  is(sweepMsg.cone, 'cone-adobe');
});

test('ingest omits cone when TMPDIR is unset', async () => {
  const result = await review(
    'ingest',
    { path: '/draft.md' },
    ['custom'],
    async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === 'custom' ? JSON.stringify({ source: 'custom' }) : '',
    })
  );
  const message = JSON.parse(result.calls.find((argv) => argv[0] === 'sprinkle')[3]);
  is(message.cone, undefined);
});

test('empty or non-string CLI labels fail before invoking a source', async () => {
  for (const value of ['', ' ', true, ['Publish', 'Approve']]) {
    const result = await review('ingest', { path: '/draft.md', 'primary-action-label': value });
    is(result.code, 2);
    is(result.calls.length, 0);
  }
});
