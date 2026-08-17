#!/usr/bin/env node

import { copyFile, lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_SKILL_PATH = /^skills\/[a-z0-9][a-z0-9-]*$/;

async function readManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read manifest ${manifestPath}: ${error.message}`);
  }

  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.skills)) {
    throw new Error(`manifest ${manifestPath} must contain a skills array`);
  }
  return manifest;
}

function validateSkillPath(skillPath, manifestPath) {
  if (typeof skillPath !== 'string' || !SAFE_SKILL_PATH.test(skillPath)) {
    throw new Error(`unsafe skill path in ${manifestPath}: ${JSON.stringify(skillPath)}`);
  }
}

async function assertConcreteTree(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${path}`);
  if (stat.isFile()) return;
  if (!stat.isDirectory()) throw new Error(`unsupported filesystem entry: ${path}`);

  const entries = await readdir(path);
  for (const entry of entries.sort()) await assertConcreteTree(join(path, entry));
}

async function assertCanonicalSkill(repoRoot, skillPath) {
  const source = join(repoRoot, skillPath);
  let stat;
  try {
    stat = await lstat(source);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`declared skill is missing: ${skillPath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`declared skill is not a canonical directory: ${skillPath}`);
  }

  try {
    const skillManifest = await lstat(join(source, 'SKILL.md'));
    if (skillManifest.isSymbolicLink() || !skillManifest.isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`declared skill has no regular SKILL.md: ${skillPath}`);
  }
  await assertConcreteTree(source);
}

async function loadPlugins(repoRoot) {
  const tilesRoot = join(repoRoot, 'tiles');
  const entries = await readdir(tilesRoot, { withFileTypes: true });
  const plugins = new Map();
  const memberships = new Map();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const metadataPath = join(tilesRoot, entry.name, '.tessl-plugin');
    const manifestPath = join(metadataPath, 'plugin.json');
    let metadataStat;
    try {
      metadataStat = await lstat(metadataPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory()) {
      throw new Error(`plugin metadata must be a regular directory: ${metadataPath}`);
    }

    let manifestStat;
    try {
      manifestStat = await lstat(manifestPath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`plugin manifest is missing: ${manifestPath}`);
      throw error;
    }
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new Error(`plugin manifest must be a regular file: ${manifestPath}`);
    }

    const manifest = await readManifest(manifestPath);
    const localMemberships = new Set();
    for (const skillPath of manifest.skills) {
      validateSkillPath(skillPath, manifestPath);
      if (localMemberships.has(skillPath)) {
        throw new Error(`duplicate skill in plugin ${entry.name}: ${skillPath}`);
      }
      localMemberships.add(skillPath);
      const owner = memberships.get(skillPath);
      if (owner) {
        throw new Error(
          `skill belongs to multiple plugins (${owner}, ${entry.name}): ${skillPath}`
        );
      }
      memberships.set(skillPath, entry.name);
      await assertCanonicalSkill(repoRoot, skillPath);
    }
    plugins.set(entry.name, { manifestPath, manifest });
  }
  return plugins;
}

async function listCanonicalSkillPaths(repoRoot) {
  const entries = await readdir(join(repoRoot, 'skills'), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `skills/${entry.name}`)
    .sort();
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

function containsPath(parent, child) {
  const childFromParent = relative(parent, child);
  return (
    childFromParent === '' ||
    (childFromParent !== '..' &&
      !childFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(childFromParent))
  );
}

async function assertDestinationDoesNotOverlap(destination, repoRoot, skillPaths) {
  for (const skillPath of skillPaths) {
    const source = await realpath(join(repoRoot, skillPath));
    if (containsPath(source, destination) || containsPath(destination, source)) {
      throw new Error(`destination overlaps canonical skill ${skillPath}: ${destination}`);
    }
  }
}

async function copyConcreteTree(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${source}`);
  if (stat.isDirectory()) {
    await mkdir(destination);
    const entries = await readdir(source);
    for (const entry of entries.sort()) {
      await copyConcreteTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`unsupported filesystem entry: ${source}`);
  await copyFile(source, destination);
}

async function assertEmptyDestination(destination) {
  try {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`destination must be a directory: ${destination}`);
    }
    if ((await readdir(destination)).length > 0) {
      throw new Error(`destination must be empty: ${destination}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function stagePlugin({ pluginName, destination, repoRoot = REPO_ROOT }) {
  if (typeof pluginName !== 'string' || !SAFE_PLUGIN_NAME.test(pluginName)) {
    throw new Error(`unsafe plugin name: ${JSON.stringify(pluginName)}`);
  }
  if (!destination) throw new Error('destination is required');

  const resolvedRepoRoot = resolve(repoRoot);
  const plugins = await loadPlugins(resolvedRepoRoot);
  const plugin = plugins.get(pluginName);
  if (!plugin) throw new Error(`unknown plugin: ${pluginName}`);

  const stageRoot = await resolvePhysicalPath(destination);
  const canonicalSkillPaths = await listCanonicalSkillPaths(resolvedRepoRoot);
  await assertDestinationDoesNotOverlap(stageRoot, resolvedRepoRoot, canonicalSkillPaths);
  await assertEmptyDestination(stageRoot);
  await mkdir(join(stageRoot, '.tessl-plugin'), { recursive: true });
  await copyFile(plugin.manifestPath, join(stageRoot, '.tessl-plugin', 'plugin.json'));
  await mkdir(join(stageRoot, 'skills'));
  for (const skillPath of plugin.manifest.skills) {
    await copyConcreteTree(join(resolvedRepoRoot, skillPath), join(stageRoot, skillPath));
  }
  await assertConcreteTree(stageRoot);
  return stageRoot;
}

async function main() {
  const [pluginName, destination, ...extra] = process.argv.slice(2);
  if (!pluginName || !destination || extra.length > 0) {
    throw new Error('usage: node tools/stage-tessl-plugin.mjs <plugin> <destination>');
  }
  console.log(await stagePlugin({ pluginName, destination }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`stage-tessl-plugin: ${error.message}`);
    process.exitCode = 1;
  });
}
