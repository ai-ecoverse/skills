import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  binEntries,
  checkSkill,
  checkSkills,
  commandFiles,
  parseLsFiles,
  shippedChanges,
  skillNames,
  sliccyModules,
} from './check-skill-packages.mjs';

const JSH = '#!/usr/bin/env jsh\n';

function fixture(files) {
  const tracked = new Map();
  const contents = new Map();
  for (const [path, spec] of Object.entries(files)) {
    const { mode = '100644', text = '' } = typeof spec === 'string' ? { text: spec } : spec;
    tracked.set(path, mode);
    contents.set(path, text);
  }
  const read = (path) => {
    if (!contents.has(path)) throw new Error(`ENOENT ${path}`);
    return contents.get(path);
  };
  return { tracked, read };
}

const manifest = (value) => JSON.stringify(value);

const packaged = (overrides = {}) => ({
  'skills/s/SKILL.md': '---\nname: s\n---\n',
  'skills/s/package.json': manifest({
    name: '@ai-ecoverse/s',
    bin: { s: 'scripts/s.jsh' },
    dependencies: { '@ai-ecoverse/sliccy-browser': '0.1.42' },
  }),
  'skills/s/scripts/s.jsh': {
    mode: '100755',
    text: `${JSH}const b = require('sliccy:browser');\nconst cli = require('sliccy:cli');\n`,
  },
  ...overrides,
});

test('git ls-files -s lines become path → mode', () => {
  const tracked = parseLsFiles(
    '100755 0123abcd 0\tskills/s/scripts/s.jsh\n100644 89ef0123 0\tskills/s/SKILL.md\n\nnot a line\n'
  );
  assert.deepEqual(
    [...tracked],
    [
      ['skills/s/scripts/s.jsh', '100755'],
      ['skills/s/SKILL.md', '100644'],
    ]
  );
  assert.deepEqual(skillNames(tracked), ['s']);
});

test('only a change to shipped files moves a skill to the package layout', () => {
  assert.deepEqual(
    shippedChanges([
      'skills/a/tests/a.test.js',
      'skills/b/evals/x.json',
      'skills/c/SKILL.md',
      'skills/d/scripts/d.jsh',
      'skills/d/tests/d.test.js',
      'tools/x.mjs',
      'skills/e/node_modules/x/index.js',
    ]),
    ['c', 'd']
  );
});

test('a well-formed package passes', () => {
  assert.deepEqual(checkSkill('s', { ...fixture(packaged()), requirePackage: true }), []);
});

test('commands are .jsh files and extensionless jsh scripts, outside tests and evals', () => {
  const files = fixture({
    'skills/s/SKILL.md': '',
    'skills/s/scripts/a.jsh': JSH,
    'skills/s/scripts/b': JSH,
    'skills/s/scripts/c': '#!/bin/sh\n',
    'skills/s/scripts/d.js': JSH,
    'skills/s/tests/fixture.jsh': JSH,
    'skills/s/evals/e.jsh': JSH,
    'skills/s/scripts/f': '#!/usr/bin/jsh\n',
  });
  assert.deepEqual(commandFiles('s', files), ['scripts/a.jsh', 'scripts/b', 'scripts/f']);
});

test('a skill with commands and no package.json fails only when a package is required', () => {
  const files = fixture({ 'skills/s/SKILL.md': '', 'skills/s/scripts/a.jsh': JSH });
  assert.deepEqual(checkSkill('s', files), []);
  const [problem] = checkSkill('s', { ...files, requirePackage: true });
  assert.match(
    problem,
    /skills\/s: add a package\.json whose bin lists its commands \(scripts\/a\.jsh\)/
  );
  assert.deepEqual(
    checkSkill('s', { ...fixture({ 'skills/s/SKILL.md': '' }), requirePackage: true }),
    []
  );
});

test('a package.json without bin is left alone in lint, and must list the commands at the gate', () => {
  const files = fixture(
    packaged({ 'skills/s/package.json': manifest({ name: 'x', dependencies: {} }) })
  );
  assert.deepEqual(checkSkill('s', files), []);
  const problems = checkSkill('s', { ...files, requirePackage: true });
  assert.ok(
    problems.some((p) => /scripts\/s\.jsh is not in bin/.test(p)),
    problems.join('\n')
  );
});

test('a bin target must be tracked, executable, a jsh script and shipped', () => {
  const withoutScript = Object.fromEntries(
    Object.entries(packaged()).filter(([path]) => path !== 'skills/s/scripts/s.jsh')
  );
  const missing = checkSkill('s', fixture(withoutScript));
  assert.ok(
    missing.some((p) => /bin\.s: scripts\/s\.jsh is not a tracked file/.test(p)),
    missing.join('\n')
  );

  const plain = checkSkill(
    's',
    fixture(packaged({ 'skills/s/scripts/s.jsh': { mode: '100644', text: `${JSH}` } }))
  );
  assert.ok(
    plain.some((p) =>
      /is not executable \(git update-index --chmod=\+x skills\/s\/scripts\/s\.jsh\)/.test(p)
    ),
    plain.join('\n')
  );

  const node = checkSkill(
    's',
    fixture(
      packaged({ 'skills/s/scripts/s.jsh': { mode: '100755', text: '#!/usr/bin/env node\n' } })
    )
  );
  assert.ok(
    node.some((p) => /does not start with #!\/usr\/bin\/env jsh/.test(p)),
    node.join('\n')
  );

  const unshipped = checkSkill(
    's',
    fixture(
      packaged({
        'skills/s/package.json': manifest({
          name: 's',
          bin: { s: './scripts/s.jsh' },
          files: ['references', 'SKILL.md'],
          dependencies: { '@ai-ecoverse/sliccy-browser': '1' },
        }),
      })
    )
  );
  assert.ok(
    unshipped.some((p) => /is not in package\.json files/.test(p)),
    unshipped.join('\n')
  );

  const shipped = checkSkill(
    's',
    fixture(
      packaged({
        'skills/s/package.json': manifest({
          name: 's',
          bin: { s: './scripts/s.jsh' },
          files: ['scripts/', 'SKILL.md'],
          dependencies: { '@ai-ecoverse/sliccy-browser': '1' },
        }),
      })
    )
  );
  assert.deepEqual(shipped, []);
});

test('a bin name must be a command name, and a package needs a name', () => {
  const problems = checkSkill(
    's',
    fixture(
      packaged({
        'skills/s/package.json': manifest({
          bin: { 'a b': 'scripts/s.jsh' },
          dependencies: { '@ai-ecoverse/sliccy-browser': '1' },
        }),
      })
    )
  );
  assert.ok(
    problems.some((p) => /"a b" is not a command name/.test(p)),
    problems.join('\n')
  );
  assert.ok(
    problems.some((p) => /package\.json: needs a name/.test(p)),
    problems.join('\n')
  );
});

test('every command must be in bin', () => {
  const problems = checkSkill(
    's',
    fixture(packaged({ 'skills/s/scripts/other': { mode: '100755', text: JSH } }))
  );
  assert.deepEqual(problems, [
    'skills/s/package.json: scripts/other is not in bin, so SLICC 7 never installs it as a command',
  ]);
});

test('a sliccy module that jsh does not ship must be a dependency', () => {
  const problems = checkSkill(
    's',
    fixture(
      packaged({
        'skills/s/package.json': manifest({ name: 's', bin: { s: 'scripts/s.jsh' } }),
        'skills/s/scripts/lib.js': "module.exports = () => require('sliccy:usb');\n",
        'skills/s/tests/t.test.js': "import x from 'sliccy:agent';\n",
      })
    )
  );
  assert.deepEqual(problems, [
    'skills/s/package.json: scripts/s.jsh requires sliccy:browser; add @ai-ecoverse/sliccy-browser to dependencies',
    'skills/s/package.json: scripts/lib.js requires sliccy:usb; add @ai-ecoverse/sliccy-usb to dependencies',
  ]);
  const unscoped = checkSkill(
    's',
    fixture(
      packaged({
        'skills/s/package.json': manifest({
          name: 's',
          bin: { s: 'scripts/s.jsh' },
          optionalDependencies: { 'sliccy-browser': '1' },
        }),
      })
    )
  );
  assert.deepEqual(unscoped, []);
});

test('sliccy modules are found in require, dynamic import and static import', () => {
  assert.deepEqual(
    sliccyModules(
      "require('sliccy:cli'); await import(\"sliccy:browser\"); import x from 'sliccy:agent'; require('sliccy:' + name);"
    ),
    ['agent', 'browser', 'cli']
  );
});

test('bin entries: a string bin is named after the unscoped package', () => {
  assert.deepEqual(binEntries({ name: '@ai-ecoverse/x', bin: 'scripts/x' }), [['x', 'scripts/x']]);
  assert.deepEqual(binEntries({ name: 'y', bin: { a: 'a.jsh', b: 'b.jsh' } }), [
    ['a', 'a.jsh'],
    ['b', 'b.jsh'],
  ]);
  assert.deepEqual(binEntries(null), []);
});

test('a package.json that is not JSON is a problem', () => {
  assert.deepEqual(checkSkill('s', fixture(packaged({ 'skills/s/package.json': '{' }))).length, 1);
});

test('checkSkills walks every skill', () => {
  const files = fixture({
    ...packaged({ 'skills/s/scripts/other': { mode: '100755', text: JSH } }),
    'skills/t/SKILL.md': '',
    'skills/t/scripts/t.jsh': JSH,
  });
  assert.equal(checkSkills(files).length, 1);
  assert.equal(checkSkills({ ...files, requirePackage: true }).length, 2);
});

test('the CLI prints a PASS verdict for a clean tree and fails on a problem', () => {
  const tool = fileURLToPath(new URL('./check-skill-packages.mjs', import.meta.url));
  const clean = spawnSync('node', [tool], { input: '', encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, /^check-skill-packages: PASS 0 packaged of 0 skills$/m);
  const broken = spawnSync('node', [tool], {
    input:
      '100644 abc 0\tskills/no-such-skill-here/SKILL.md\n100644 abc 0\tskills/no-such-skill-here/package.json\n',
    encoding: 'utf8',
  });
  assert.equal(broken.status, 1);
  assert.match(
    broken.stderr,
    /::error title=check-skill-packages::skills\/no-such-skill-here\/package\.json: can't be read as JSON/
  );
  assert.doesNotMatch(broken.stderr, /PASS/);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const slack = spawnSync('node', [tool], {
    input: spawnSync('git', ['ls-files', '-s', '--', 'skills/slack'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout,
    encoding: 'utf8',
  });
  assert.equal(slack.status, 0, slack.stderr);
  assert.match(slack.stderr, /^check-skill-packages: PASS 1 packaged of 1 skills$/m);
});
