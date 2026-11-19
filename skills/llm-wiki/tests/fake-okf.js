#!/usr/bin/env node
// A stand-in for okf in the tests: the JSON shapes of okf 0.5 for search,
// show, backlinks, validate and version, read from the bundle on disk. It
// appends its argv to $FAKE_OKF_LOG, and exits $FAKE_OKF_STATUS when set.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (process.env.FAKE_OKF_LOG)
  fs.appendFileSync(process.env.FAKE_OKF_LOG, `${JSON.stringify(argv)}\n`);
const [cmd, root, ...rest] = argv;
const out = (o, code = 0) => {
  process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
  process.exitCode = process.env.FAKE_OKF_STATUS ? Number(process.env.FAKE_OKF_STATUS) : code;
};
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : '';
};

function concepts() {
  const found = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p, rel ? `${rel}/${name}` : name);
      else if (name.endsWith('.md') && name !== 'index.md' && name !== 'log.md') {
        const text = fs.readFileSync(p, 'utf8');
        const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) || ['', '', text];
        const get = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1]) || [])[1] || '';
        found.push({
          id: (rel ? `${rel}/` : '') + name.slice(0, -3),
          title: get('title'),
          type: get('type'),
          body: fm[2],
          text,
        });
      }
    }
  };
  walk(root, '');
  return found;
}

if (cmd === 'version') out({ name: 'okf', version: '0.5.2' });
else if (cmd === 'validate')
  out({ bundle: root, command: 'validate', valid: true, errors: 0, warnings: 0, findings: [] });
else if (cmd === 'search') {
  const text = flag('text').toLowerCase();
  const type = flag('type');
  const results = concepts()
    .filter((c) => (!type || c.type === type) && (!text || c.text.toLowerCase().includes(text)))
    .map(({ id, title, type: t }) => ({ id, title, type: t }));
  out({ bundle: root, command: 'search', count: results.length, results });
} else if (cmd === 'show') {
  const c = concepts().find((x) => x.id === rest[0]);
  if (!c)
    out(
      {
        error: {
          code: 400,
          kind: 'validation',
          message: `concept not found: ${rest[0]}`,
          reason: 'validationError',
        },
      },
      1
    );
  else
    out({
      bundle: root,
      command: 'show',
      concept: {
        id: c.id,
        title: c.title,
        type: c.type,
        body: c.body,
        status: 'stable',
        trust_tier: 'unverified',
        stale: false,
      },
    });
} else if (cmd === 'backlinks') {
  const backlinks = concepts()
    .filter((c) => c.text.includes(`/${rest[0]}.md`))
    .map((c) => c.id);
  out({
    bundle: root,
    command: 'backlinks',
    concept_id: rest[0],
    backlinks,
    count: backlinks.length,
  });
} else out({ error: { code: 400, kind: 'usage', message: `unknown command: ${cmd}` } }, 4);
