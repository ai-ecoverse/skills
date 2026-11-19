import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { parseCgi, withBox } from './run.js';

const GA4 =
  '---\ntype: BigQuery Dataset\ntitle: GA4 Ecommerce\ndescription: "The GA4 sample dataset."\ntags: [analytics, ga4]\n---\n\nSee the [events table](/tables/events.md).\n';
const EVENTS =
  '---\ntype: BigQuery Table\ntitle: Events\ndescription: One row per event.\ntags: [ga4]\n---\n\n# Schema\n';
const PLAY = '---\ntype: Playbook\ntitle: Freshness\n---\n\nCheck [events](../tables/events.md).\n';

function seed(box) {
  box.write('datasets/ga4.md', GA4);
  box.write('tables/events.md', EVENTS);
  box.write('playbooks/freshness.md', PLAY);
}

test('--help and help print usage and exit 0', async () => {
  await withBox(async (box) => {
    for (const words of [['--help'], ['-h'], ['help'], [], ['log', '--help']]) {
      const r = box.run(words);
      is(r.exitCode, 0, words.join(' '));
      ok(
        r.stdout.startsWith('wiki — an Open Knowledge Format (OKF) knowledge base'),
        'usage on stdout'
      );
      is(r.stderr, '');
    }
  });
});

test('the root comes from --root, then WIKI_ROOT, then the config file; there is no default', async () => {
  await withBox(async (box) => {
    let r = box.run(['root']);
    is(r.exitCode, 1, 'no root anywhere is an error');
    ok(r.stderr.includes('no bundle root'), r.stderr);
    is(box.run(['config', 'get', 'root']).exitCode, 1, 'config get with nothing set exits 1');

    r = box.run(['config', 'set', 'root', box.kb]);
    is(r.exitCode, 0, r.stderr);
    is(JSON.parse(fs.readFileSync(box.config, 'utf8')), { root: box.kb });
    is(box.run(['root']).stdout, `${box.kb}\t${box.config}\n`);

    const other = path.join(box.dir, 'other');
    fs.mkdirSync(other);
    is(box.run(['root'], { WIKI_ROOT: other }).stdout, `${other}\tWIKI_ROOT\n`);
    is(box.run(['root', '--root', box.home], { WIKI_ROOT: other }).stdout, `${box.home}\t--root\n`);
    is(box.run(['--root=/tmp', 'root']).stdout, '/tmp\t--root\n');

    r = box.run(['config', 'set', 'root', path.join(box.dir, 'missing')]);
    is(r.exitCode, 1, 'a missing directory is refused');
    is(
      JSON.parse(fs.readFileSync(box.config, 'utf8')),
      { root: box.kb },
      'the config is unchanged'
    );

    fs.writeFileSync(box.config, JSON.stringify({ root: box.kb, theme: 'x' }));
    is(box.run(['config', 'unset', 'root']).exitCode, 0);
    is(JSON.parse(fs.readFileSync(box.config, 'utf8')), { theme: 'x' }, 'unset keeps other keys');
  });
});

test('a malformed config file is ignored with a warning that names it', async () => {
  await withBox(async (box) => {
    fs.mkdirSync(path.dirname(box.config), { recursive: true });
    fs.writeFileSync(box.config, '{not json');
    const r = box.run(['root']);
    is(r.exitCode, 1);
    ok(r.stderr.includes(`ignoring malformed ${box.config}`), r.stderr);
  });
});

test("wiki okf puts the root after the okf command and passes okf's exit status through", async () => {
  await withBox(async (box) => {
    seed(box);
    let r = box.run(['okf', 'validate'], { WIKI_ROOT: box.kb });
    is(r.exitCode, 0, r.stderr);
    is(JSON.parse(r.stdout).valid, true);
    r = box.run(['okf', 'search', '--type', 'Playbook'], { WIKI_ROOT: box.kb });
    is(
      JSON.parse(r.stdout).results.map((c) => c.id),
      ['playbooks/freshness']
    );
    r = box.run(['okf', 'version'], { WIKI_ROOT: box.kb });
    is(JSON.parse(r.stdout).version, '0.5.2');
    is(box.okfCalls(), [
      ['validate', box.kb],
      ['search', box.kb, '--type', 'Playbook'],
      ['version'],
    ]);
    r = box.run(['okf', 'validate'], { WIKI_ROOT: box.kb, FAKE_OKF_STATUS: '1' });
    is(r.exitCode, 1, "okf's validation failure is wiki's exit status");
    r = box.run(['okf', 'validate'], { WIKI_ROOT: box.kb, OKF_BIN: path.join(box.dir, 'no-okf') });
    is(r.exitCode, 1);
    ok(r.stderr.includes('install @ai-ecoverse/wasi-okf'), r.stderr);
  });
});

test("wiki log keeps OKF's log format: date groups, newest first", async () => {
  await withBox(async (box) => {
    const env = { WIKI_ROOT: box.kb };
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = box.run(['log', 'creation', 'Started', 'the', 'bundle.'], env);
    is(r.exitCode, 0, r.stderr);
    is(
      fs.readFileSync(path.join(box.kb, 'log.md'), 'utf8'),
      `# Directory Update Log\n\n## ${day}\n* **Creation**: Started the bundle.\n`
    );
    box.run(['log', 'Update', 'Added [GA4](/datasets/ga4.md).'], env);
    is(
      fs.readFileSync(path.join(box.kb, 'log.md'), 'utf8'),
      `# Directory Update Log\n\n## ${day}\n* **Creation**: Started the bundle.\n* **Update**: Added [GA4](/datasets/ga4.md).\n`
    );

    box.write('log.md', '# Directory Update Log\n\n## 2020-01-02\n* **Update**: Old.\n');
    box.run(['log', 'update', 'New.'], env);
    is(
      fs.readFileSync(path.join(box.kb, 'log.md'), 'utf8'),
      `# Directory Update Log\n\n## ${day}\n* **Update**: New.\n\n## 2020-01-02\n* **Update**: Old.\n`
    );

    is(box.run(['log', 'two words', 'x'], env).exitCode, 2, 'a kind is one word');
    is(box.run(['log', 'update'], env).exitCode, 2, 'a message is required');
    is(
      fs.readdirSync(box.kb).filter((f) => f.endsWith('.tmp')),
      [],
      'no temp file left'
    );
  });
});

test('wiki sprinkle installs the panel and a cgi-bin/ bound to the root and okf', async () => {
  await withBox(async (box) => {
    const dir = path.join(box.dir, 'sprinkles', 'llm-wiki');
    const odd = path.join(box.dir, `it's "kb"`);
    fs.mkdirSync(odd);
    const r = box.run(['sprinkle', dir, '--root', odd]);
    is(r.exitCode, 0, r.stderr);
    is(r.stdout.trim().split('\n'), [
      path.join(dir, 'llm-wiki.shtml'),
      path.join(dir, 'cgi-bin', 'concepts'),
      path.join(dir, 'cgi-bin', 'show'),
    ]);
    const html = fs.readFileSync(path.join(dir, 'llm-wiki.shtml'), 'utf8');
    ok(
      html.includes(`<meta name="llm-wiki-root" content="${odd.replace(/"/g, '&quot;')}" />`),
      'the root is in the panel, attribute-escaped'
    );
    const sh = fs.readFileSync(path.join(dir, 'cgi-bin', 'show'), 'utf8');
    ok(sh.includes(`WIKI_ROOT='${odd.replace(/'/g, `'\\''`)}'`), sh);
    ok(sh.includes(`OKF_BIN='${box.okf}'`), sh);
    ok(sh.endsWith(' cgi show\n'), sh);
    is(fs.statSync(path.join(dir, 'cgi-bin', 'concepts')).mode & 0o777, 0o755);
  });
});

test('cgi concepts answers the filtered concepts with descriptions, tags and every type', async () => {
  await withBox(async (box) => {
    seed(box);
    const env = { WIKI_ROOT: box.kb, REQUEST_METHOD: 'GET' };
    let r = parseCgi(box.run(['cgi', 'concepts'], env).stdout);
    is(r.status, 200);
    is(r.headers['content-type'], 'application/json');
    is(r.headers['x-wiki'], '1');
    is(r.headers['cache-control'], 'no-store');
    is(r.body.types, ['BigQuery Dataset', 'BigQuery Table', 'Playbook']);
    is(
      r.body.concepts.map((c) => c.id),
      ['datasets/ga4', 'playbooks/freshness', 'tables/events']
    );
    is(
      r.body.concepts[0].description,
      'The GA4 sample dataset.',
      'a quoted description is unquoted'
    );
    is(r.body.concepts[0].tags, ['analytics', 'ga4']);
    r = parseCgi(
      box.run(['cgi', 'concepts'], { ...env, QUERY_STRING: 'text=schema&type=BigQuery+Table' })
        .stdout
    );
    is(
      r.body.concepts.map((c) => c.id),
      ['tables/events']
    );
    is(r.body.filters, { text: 'schema', type: 'BigQuery Table', tag: '' });
    ok(
      box
        .okfCalls()
        .some(
          (a) =>
            JSON.stringify(a) ===
            JSON.stringify(['search', box.kb, '--text', 'schema', '--type', 'BigQuery Table'])
        ),
      'filters reach okf as argv'
    );
  });
});

test('cgi show answers a concept and its backlinks; bad ids, methods and origins change nothing', async () => {
  await withBox(async (box) => {
    seed(box);
    const env = { WIKI_ROOT: box.kb, REQUEST_METHOD: 'GET' };
    let r = parseCgi(box.run(['cgi', 'show'], { ...env, PATH_INFO: '/tables/events' }).stdout);
    is(r.status, 200);
    is(r.body.concept.title, 'Events');
    is(r.body.backlinks, ['datasets/ga4', 'playbooks/freshness']);
    is(
      parseCgi(box.run(['cgi', 'show'], { ...env, QUERY_STRING: 'id=datasets/ga4' }).stdout).body
        .concept.id,
      'datasets/ga4'
    );
    for (const bad of ['/../etc/passwd', '/a//b', '/./x']) {
      r = parseCgi(box.run(['cgi', 'show'], { ...env, PATH_INFO: bad }).stdout);
      is(r.status, 400, bad);
    }
    r = parseCgi(box.run(['cgi', 'show'], { ...env, PATH_INFO: '/nope' }).stdout);
    is(r.status, 404);
    is(r.body, { ok: false, error: 'concept not found: nope' });
    is(
      parseCgi(box.run(['cgi', 'concepts'], { ...env, REQUEST_METHOD: 'POST' }).stdout).status,
      405
    );
    is(
      parseCgi(box.run(['cgi', 'concepts'], { ...env, HTTP_SEC_FETCH_SITE: 'cross-site' }).stdout)
        .status,
      403
    );
    is(
      parseCgi(
        box.run(['cgi', 'concepts'], {
          ...env,
          HTTP_ORIGIN: 'https://evil.test',
          HTTP_HOST: 'kb.local',
        }).stdout
      ).status,
      403
    );
    is(parseCgi(box.run(['cgi', 'frob'], env).stdout).status, 404);
    is(
      parseCgi(box.run(['cgi', 'concepts'], { REQUEST_METHOD: 'GET' }).stdout).status,
      500,
      'no root'
    );
    const before = box.okfCalls().length;
    box.run(['cgi', 'show'], { ...env, PATH_INFO: '/../etc/passwd' });
    is(box.okfCalls().length, before, 'a refused id never reaches okf');
  });
});
