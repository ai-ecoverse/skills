#!/usr/bin/env node

import { isMain } from './is-main.mjs';

const TILE_SKILL_PATH = /^tiles\/[^/]+\/skills(?:\/|$)/;

export function assertNoTrackedTileSkillPaths(trackedFiles) {
  const invalidPaths = trackedFiles.filter((file) => TILE_SKILL_PATH.test(file));
  if (invalidPaths.length === 0) return;
  throw new Error(
    `tracked tile skill paths are forbidden; declare membership only in source manifests:\n${invalidPaths.join('\n')}`
  );
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const trackedFiles = input.split(/\r?\n/).filter(Boolean);
  assertNoTrackedTileSkillPaths(trackedFiles);
  console.error(`check-tessl-layout: PASS ${trackedFiles.length} tracked files`);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`check-tessl-layout: ${error.message}`);
    process.exitCode = 1;
  });
}
