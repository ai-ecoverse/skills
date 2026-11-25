import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const SKILL = read('SKILL.md');
const AUTH = read('references/auth-strategies.md');
const HELPER = read('references/page-context-helper.md');

test('no SLICC 6 install or path instructions are left for SLICC 7', () => {
  is(SKILL.match(/^\s*ipk (install|add) /gm), null);
  is([SKILL, AUTH].join('\n').match(/store[^\n]*\/workspace\/skills\//gi), null);
  ok(!AUTH.includes("exec('cat .config')"), 'auth-strategies.md prints the config file');
});

test('the template is a SLICC 7 command: jsh shebang, package bin, sliccy-browser dependency', () => {
  ok(SKILL.includes('```js\n#!/usr/bin/env jsh\n'), 'template starts with the jsh shebang');
  ok(SKILL.includes('### Package'));
  ok(/"bin": \{ "\{app-name\}": "scripts\/\{app-name\}\.jsh" \}/.test(SKILL), 'package.json bin');
  ok(SKILL.includes('"@ai-ecoverse/sliccy-browser"'), 'sliccy-browser dependency');
  ok(SKILL.includes("from 'tst'"), 'tests use tst');
});

test('the built-ins list does not say that http, vm or worker_threads throw', () => {
  is(/`http`\/`https`\/`net`\/`tls`\/`dns`\/`vm`\/`worker_threads` throw/.test(SKILL), false);
  is(SKILL.includes('`readFileBinary`, `writeFileBinary`, `readDir`, `exists`'), false);
});

test('discovery lists resource timings and warns that a HAR can be empty', () => {
  ok(SKILL.includes("performance.getEntriesByType('resource')"));
  ok(SKILL.includes('An empty HAR is not proof'));
  ok(SKILL.includes('curlwright --tab'));
});

test('credential discovery prints key names, not values', () => {
  for (const cmd of ['localstorage-list', 'cookie-list', 'sessionstorage-list']) {
    const lines = SKILL.split('\n').filter((l) => l.startsWith(`playwright-cli ${cmd}`));
    ok(lines.length > 0, `${cmd} is shown`);
    for (const l of lines) ok(l.includes('| cut -d= -f1'), l);
  }
});

test('the tab helper calls a playwright-cli command that exists', () => {
  ok(!HELPER.includes('playwright-cli list-tabs'));
  ok(HELPER.includes('playwright-cli tab-list'));
});
