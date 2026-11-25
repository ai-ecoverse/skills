import { readFileSync } from 'node:fs';
import test, { is, ok } from 'tst';
import { readScript } from './script.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package maps outlook to its script', () => {
  is(pkg.bin, { outlook: 'scripts/outlook.jsh' });
  ok(pkg.files.includes('scripts') && pkg.files.includes('SKILL.md'));
  is(pkg.private, true);
  ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies['@ai-ecoverse/sliccy-browser'] ?? ''));
  ok(pkg.engines.node);
});

test('script starts with the jsh hashbang and strips to a blank line', () => {
  const raw = readFileSync(new URL('../scripts/outlook.jsh', import.meta.url), 'utf8');
  ok(raw.startsWith('#!/usr/bin/env jsh\n'));
  ok(readScript(new URL('../scripts/outlook.jsh', import.meta.url).pathname).startsWith('\n'));
});

test('SKILL.md has a host section and a short description', () => {
  const md = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  ok(md.includes('## On a host'));
  ok(md.includes('references/jsh-host.md'));
  const d = /description: >-\n([\s\S]*?)\nallowed-tools/.exec(md)[1].replace(/\s+/g, ' ').trim();
  ok(d.length <= 1024);
});
