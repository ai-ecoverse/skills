// Tests for tools/check-jsh-parse.mjs
//
// These run under `node --test` in GitHub Actions (the same way
// tools/detect-skill-integration.test.mjs does), NOT under the SLICC `tst`
// runner — tools/ is repo tooling executed by the runner's own node, while
// skills/*/tests/*.test.js must use `tst` because they load in the SLICC test
// realm where node:test does not exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as require0 } from 'node:fs';
import {
  parseFailure,
  collectFiles,
  stripShebang,
  hasJshHashbang,
  isJshScript,
} from './check-jsh-parse.mjs';

test('a plain script parses', () => {
  assert.equal(parseFailure('const a = 1; console.log(a);'), null);
});

test('top-level await parses, because a .jsh is an AsyncFunction body', () => {
  assert.equal(parseFailure('const r = await Promise.resolve(1);'), null);
});

test('top-level return parses, for the same reason', () => {
  assert.equal(parseFailure('if (true) { return 0; } console.log("x");'), null);
});

test('an apostrophe inside a single-quoted string is caught', () => {
  // The exact defect that shipped in slack-ext.jsh: five of these, while an
  // extracted-module suite of 146 assertions reported everything passing.
  const src = 'console.log(dim(\'appears as the human\'s own action\'));';
  const msg = parseFailure(src);
  assert.ok(msg, 'expected a parse failure');
  assert.match(msg, /missing \)|Unexpected|Invalid or unexpected/);
});

test('a leading shebang parses, as the jsh executor strips it (slicc stripShebang)', () => {
  assert.equal(parseFailure('#!/usr/bin/env jsh\nconst a = await Promise.resolve(1);'), null);
});

test('only a leading shebang is stripped, and its line is kept for line numbers', () => {
  assert.equal(stripShebang('#!/usr/bin/env jsh\nx'), '\nx');
  assert.equal(stripShebang('#!/usr/bin/env jsh'), '');
  assert.equal(stripShebang('x\n#!/bin/sh'), 'x\n#!/bin/sh');
  assert.ok(parseFailure('const a = 1;\n#!/bin/sh'));
});

test('an unterminated string is caught', () => {
  assert.ok(parseFailure('const s = "no closing quote;'));
});

test('an unbalanced brace is caught', () => {
  assert.ok(parseFailure('function f() { return 1;'));
});

test('an ESM import is reported, since an AsyncFunction body cannot contain one', () => {
  // Not a style opinion: it genuinely cannot parse this way. No .jsh in this
  // repo uses `import`, and this test documents what would happen if one did.
  assert.ok(parseFailure("import x from 'y';"));
});

test('an empty file parses', () => {
  assert.equal(parseFailure(''), null);
});

test("the tool's OWN discovery finds the repo scripts", () => {
  // This must call collectFiles, not re-implement it. An earlier version of this
  // test did its own git ls-files, so breaking the tool discovery so that it
  // found ZERO files did not fail anything -- the checker would have reported
  // "no .jsh/.bsh files found", exited 0, and looked healthy forever. Found by
  // mutation testing; the surviving mutation was pointing at untested code.
  const files = collectFiles([], "");
  assert.ok(files.length > 50, `expected many .jsh files, found ${files.length}`);
  assert.ok(files.every((f) => isJshScript(f)), "every result is a jsh script");
});

test('a file without an extension counts when its first line is a jsh hashbang', () => {
  const heads = {
    'skills/a/scripts/a': '#!/usr/bin/env jsh\nconsole.log(1)\n',
    'skills/b/scripts/b': '#!/bin/env jsh\n',
    'skills/c/scripts/c': '#!/usr/bin/jsh\n',
    'skills/d/scripts/d': '#!/usr/bin/env -S jsh\n',
    'skills/e/scripts/e': '#!/usr/bin/env bash\n',
    'skills/f/scripts/f': '#!/usr/bin/env jshell\n',
    'skills/g/scripts/g': 'console.log(1)\n',
    'skills/h/scripts/h.js': '#!/usr/bin/env jsh\n',
  };
  const head = (f) => heads[f];
  assert.deepEqual(
    Object.keys(heads).filter((f) => isJshScript(f, head)),
    ['skills/a/scripts/a', 'skills/b/scripts/b', 'skills/c/scripts/c', 'skills/d/scripts/d']
  );
  assert.equal(isJshScript('x/y.jsh', () => ''), true);
  assert.equal(hasJshHashbang('#!/usr/bin/env jsh'), true);
  assert.equal(hasJshHashbang(''), false);
});

test('discovery includes the extensionless bluebubbles CLI', () => {
  assert.ok(collectFiles([], '').includes('skills/bluebubbles/scripts/bluebubbles'));
});

test("explicit argv overrides discovery", () => {
  assert.deepEqual(collectFiles(["a.jsh", "b.bsh"], ""), ["a.jsh", "b.bsh"]);
});

test("--stdin reads a newline list and ignores blanks", () => {
  assert.deepEqual(collectFiles(["--stdin"], "x.jsh\n\n y.jsh \n"), ["x.jsh", "y.jsh"]);
});

test("every discovered repo script parses", () => {
  const readFileSync = require0;
  const files = collectFiles([], "");
  assert.ok(files.length > 50);
  const bad = files.filter((f) => parseFailure(readFileSync(f, "utf8")) !== null);
  assert.deepEqual(bad, []);
});
