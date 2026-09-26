#!/usr/bin/env node
//
// Parse-check every .jsh / .bsh script in the repo.
//
// WHY THIS EXISTS, separately from `lint:jsh`:
//
//   1. Biome silently SKIPS files over its 1 MiB maxSize, so the largest
//      generated bundles (skills/xlsx/scripts/xlsx.jsh at ~1.2 MB) are not
//      parse-checked by anything today. This checker has no size limit.
//   2. A syntax error is a different class of defect from a lint finding, and
//      deserves its own fast, dependency-free signal. `lint:jsh` shells out to
//      `npx @ai-ecoverse/biome-jsh`, so it needs an install; this runs on node
//      alone and finishes in milliseconds.
//   3. A .jsh is an entry point, not a module, so it is typically not imported
//      by any test. A `tst` suite over an extracted module cannot see a syntax
//      error in the .jsh that uses it. That is not hypothetical: ai-ecoverse/
//      skills#417 shipped five unparseable lines in slack-ext.jsh (an
//      apostrophe inside a single-quoted string) while its extracted-module
//      suite reported 69 tests / 146 assertions all passing.
//
// A .jsh is executed as the body of an AsyncFunction, which is why top-level
// `await` and `return` are legal in one. Parsing it the same way is therefore
// exactly the right check, and matches how lint:jsh wraps these files. No .jsh
// in this repo uses ESM `import`, which an AsyncFunction body cannot contain.
//
// Usage:
//   node tools/check-jsh-parse.mjs                 # all tracked .jsh/.bsh
//   node tools/check-jsh-parse.mjs a.jsh b.jsh     # only those files
//   git ls-files '*.jsh' | node tools/check-jsh-parse.mjs --stdin
//
// Exit 0 when every file parses, 1 when any file does not (or cannot be read).

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Parse one source string as an AsyncFunction body.
 * @returns {null|string} null when it parses, else the error message.
 */
export function parseFailure(source) {
  try {
    // eslint-disable-next-line no-new
    new AsyncFunction(source);
    return null;
  } catch (err) {
    return err && err.message ? String(err.message) : 'unknown parse error';
  }
}

/** Files to check: explicit argv, stdin list, or every tracked .jsh/.bsh. */
export function collectFiles(argv, stdinText) {
  const explicit = argv.filter((a) => a !== '--stdin' && !a.startsWith('-'));
  if (explicit.length > 0) return explicit;
  if (argv.includes('--stdin')) {
    return String(stdinText || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  // Filter by extension in JS rather than with a git pathspec: `git ls-files '*.jsh'`
  // returns nothing under some git builds while plain `git ls-files` lists the files,
  // and a discovery step that silently finds zero files would report success.
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\.(jsh|bsh)$/.test(l));
}

function main() {
  const argv = process.argv.slice(2);
  let stdinText = '';
  if (argv.includes('--stdin')) stdinText = readFileSync(0, 'utf8');

  const files = collectFiles(argv, stdinText);
  if (files.length === 0) {
    console.log('check-jsh-parse: no .jsh/.bsh files found');
    return 0;
  }

  const failures = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (err) {
      failures.push({ file, message: 'could not read: ' + (err && err.message) });
      continue;
    }
    const message = parseFailure(source);
    if (message) failures.push({ file, message });
  }

  if (failures.length === 0) {
    console.log(`check-jsh-parse: ${files.length} file(s) parse cleanly`);
    return 0;
  }

  for (const f of failures) {
    console.error(`check-jsh-parse: ${f.file}: ${f.message}`);
    console.error('  (a .jsh is parsed as an AsyncFunction body; a common cause is an');
    console.error("   apostrophe inside a single-quoted string, e.g. 'the human's own')");
  }
  console.error(`check-jsh-parse: ${failures.length} of ${files.length} file(s) do NOT parse`);
  return 1;
}

// Only run when invoked directly, so the test can import parseFailure.
if (process.argv[1] && process.argv[1].endsWith('check-jsh-parse.mjs')) {
  process.exit(main());
}
