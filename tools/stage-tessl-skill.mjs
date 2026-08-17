#!/usr/bin/env node

import { copyFile, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_SKILL_PATH = /^skills\/[a-z0-9][a-z0-9-]*$/;

function containsPath(parent, child) {
  const childFromParent = relative(parent, child);
  return (
    childFromParent === '' ||
    (childFromParent !== '..' &&
      !childFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(childFromParent))
  );
}

async function resolvePhysicalPath(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve destination: ${path}`);
    missingSegments.push(basename(cursor));
    cursor = parent;
  }
}

async function assertConcreteTree(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${path}`);
  if (stat.isFile()) return;
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem entry: ${path}`);
  for (const entry of (await readdir(path)).sort()) {
    await assertConcreteTree(join(path, entry));
  }
}

async function copyConcreteTree(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${source}`);
  if (stat.isDirectory()) {
    await mkdir(destination);
    for (const entry of (await readdir(source)).sort()) {
      await copyConcreteTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`unsupported filesystem entry: ${source}`);
  await copyFile(source, destination);
}

export async function stageSkill({ skillPath, destination, repoRoot = REPO_ROOT }) {
  if (typeof skillPath !== 'string' || !SAFE_SKILL_PATH.test(skillPath)) {
    throw new Error(`unsafe skill path: ${JSON.stringify(skillPath)}`);
  }
  if (!destination) throw new Error('destination is required');

  const source = resolve(repoRoot, skillPath);
  const skillName = basename(skillPath);
  const sourceStat = await lstat(source);
  const manifestStat = await lstat(join(source, 'SKILL.md'));
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`skill is not a canonical directory: ${skillPath}`);
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`skill has no regular SKILL.md: ${skillPath}`);
  }
  await assertConcreteTree(source);

  const physicalSource = await realpath(source);
  const stageRoot = await resolvePhysicalPath(destination);
  if (containsPath(physicalSource, stageRoot) || containsPath(stageRoot, physicalSource)) {
    throw new Error(`destination overlaps canonical skill ${skillPath}: ${stageRoot}`);
  }

  try {
    const destinationStat = await lstat(stageRoot);
    if (!destinationStat.isDirectory() || (await readdir(stageRoot)).length > 0) {
      throw new Error(`destination must be an empty directory: ${stageRoot}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(join(stageRoot, '.tessl-plugin'), { recursive: true });
  await mkdir(join(stageRoot, 'skills'));
  await writeFile(
    join(stageRoot, '.tessl-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: `local/${skillName}`,
        version: '0.0.0',
        private: true,
        description: `Isolated lint package for ${skillName}.`,
        skills: [skillPath],
      },
      null,
      2
    )}\n`
  );
  await copyConcreteTree(source, join(stageRoot, skillPath));
  return stageRoot;
}

async function main() {
  const [skillPath, destination, ...extra] = process.argv.slice(2);
  if (!skillPath || !destination || extra.length > 0) {
    throw new Error('usage: node tools/stage-tessl-skill.mjs <skills/name> <destination>');
  }
  console.log(await stageSkill({ skillPath, destination }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`stage-tessl-skill: ${error.message}`);
    process.exitCode = 1;
  });
}
