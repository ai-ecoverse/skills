#!/usr/bin/env node

import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_FILE = /^skills\/([a-z0-9][a-z0-9-]*)\//;
const PLUGIN_MANIFEST = /^tiles\/([a-z0-9][a-z0-9-]*)\/\.tessl-plugin\/plugin\.json$/;
const TILE_SKILL = /^tiles\/([a-z0-9][a-z0-9-]*)\/skills(?:\/|$)/;

async function isCanonicalSkill(repoRoot, skillName) {
  try {
    const directory = await lstat(join(repoRoot, 'skills', skillName));
    const manifest = await lstat(join(repoRoot, 'skills', skillName, 'SKILL.md'));
    return (
      directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      manifest.isFile() &&
      !manifest.isSymbolicLink()
    );
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function detectTesslChanges({ changedFiles, repoRoot = REPO_ROOT }) {
  const skillNames = new Set();
  const plugins = new Set();

  for (const file of changedFiles) {
    const skillMatch = file.match(SKILL_FILE);
    if (skillMatch) skillNames.add(skillMatch[1]);

    const pluginMatch = file.match(PLUGIN_MANIFEST);
    if (pluginMatch) plugins.add(pluginMatch[1]);

    const tileSkillMatch = file.match(TILE_SKILL);
    if (tileSkillMatch) plugins.add(tileSkillMatch[1]);
  }

  const skills = [];
  for (const skillName of [...skillNames].sort()) {
    if (await isCanonicalSkill(repoRoot, skillName)) skills.push(`skills/${skillName}`);
  }

  return { skills, plugins: [...plugins].sort() };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const changedFiles = input
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
  console.log(JSON.stringify(await detectTesslChanges({ changedFiles })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`detect-tessl-changes: ${error.message}`);
    process.exitCode = 1;
  });
}
