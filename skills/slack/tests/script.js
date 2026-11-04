// script.js — read a shipped .jsh the way jsh runs it, for tests.
// The `#!/usr/bin/env jsh` line is stripped and kept as an empty line, so line
// numbers still match, as the jsh executors and tools/check-jsh-parse.mjs do:
// an AsyncFunction body cannot contain a hashbang.
import { readFileSync } from 'node:fs';

export function stripShebang(source) {
  if (!source.startsWith('#!')) return source;
  const newline = source.indexOf('\n');
  return newline === -1 ? '' : `\n${source.slice(newline + 1)}`;
}

export function readScript(file) {
  return stripShebang(readFileSync(file, 'utf8'));
}
