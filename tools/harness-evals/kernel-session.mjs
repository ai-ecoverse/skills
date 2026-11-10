import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE,
  bootKernel,
  launchKernel,
  REPO_ROOT,
  skillFiles,
} from '../../test/integration/kernel.mjs';

const SAFE_SKILL = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_VFS = /^\/[A-Za-z0-9._/-]+$/;

function defaultFail(message) {
  console.log(`::error::harness boot: ${message}`);
  const err = new Error(message);
  err.harnessFail = true;
  throw err;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function withTimeout(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`ETIMEDOUT`);
          err.code = 'ETIMEDOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function bootKernelSession({
  skills = [],
  skillsDir = join(REPO_ROOT, 'skills'),
  modules = [...BASE],
  artifacts = join(tmpdir(), 'harness-evals-art'),
  launch = launchKernel,
  boot = bootKernel,
  listSkillFiles = skillFiles,
  repoRoot = REPO_ROOT,
  fail = defaultFail,
} = {}) {
  const names = [...new Set(skills.map((s) => String(s).trim()).filter(Boolean))];
  for (const name of names) {
    if (!SAFE_SKILL.test(name)) fail(`bad skill name ${name}`);
    if (!listSkillFiles(name, { repoRoot }).includes('SKILL.md')) {
      fail(`${skillsDir}/${name} has no SKILL.md`);
    }
  }
  mkdirSync(artifacts, { recursive: true });
  const chrome = await launch();
  const hooks = [];
  const test = {
    name: 'harness-evals',
    dir: artifacts,
    after(fn) {
      hooks.push(fn);
    },
    diagnostic() {},
  };
  const k = await boot(chrome, test, {
    modules,
    skills: names,
    repoRoot,
  });
  await k.bash('mkdir -p /workspace/skills /home/bin');
  for (const name of names) {
    const install = await k.bash(`
set -e
rm -rf /workspace/skills/${name}
cp -R /home/skills/${name} /workspace/skills/${name}
rm -rf /workspace/skills/${name}/evals
for f in /workspace/skills/${name}/scripts/*.jsh /workspace/skills/${name}/scripts/*; do
  [ -f "$f" ] || continue
  case "$f" in
    *.jsh)
      base=$(basename "$f" .jsh)
      printf '#!/bin/bash\\nexec jsh %s "$@"\\n' "$f" > /home/bin/$base
      chmod +x /home/bin/$base
      ;;
    *)
      if head -1 "$f" | grep -q '#!/usr/bin/env jsh'; then
        base=$(basename "$f")
        printf '#!/bin/bash\\nexec jsh %s "$@"\\n' "$f" > /home/bin/$base
        chmod +x /home/bin/$base
      fi
      ;;
  esac
done
ls /workspace/skills/${name}/SKILL.md
`);
    if (install.status !== 0 || !install.stdout.includes('SKILL.md')) {
      fail(`${name} is not in /workspace/skills after install: ${install.stderr.slice(-400)}`);
    }
  }
  if (names.length) console.log(`[harness] installed ${names.join(', ')} into /workspace/skills`);

  const pathPrefix = 'export PATH="/home/bin:$PATH"; ';

  async function bash(script, { timeoutMs, ...options } = {}) {
    return withTimeout(k.bash(pathPrefix + script, { cwd: '/home', ...options }), timeoutMs);
  }

  async function run(argv, { timeoutMs, ...options } = {}) {
    return withTimeout(
      k.run(argv, {
        cwd: '/home',
        env: { PATH: `/home/bin:/usr/bin:/bin`, ...(options.env || {}) },
        ...options,
      }),
      timeoutMs
    );
  }

  async function sh(command, timeoutMs = 120_000) {
    const result = await bash(command, { timeoutMs });
    if (result.status !== 0) {
      const err = new Error(
        `kernel exec exited ${result.status}: ${(result.stderr || result.stdout).slice(-500)}`
      );
      err.result = result;
      throw err;
    }
    return result.stdout;
  }

  async function trySh(command, timeoutMs = 120_000) {
    try {
      return { ok: true, out: await sh(command, timeoutMs) };
    } catch (e) {
      return { ok: false, out: String(e.message ?? e) };
    }
  }

  async function runSkill(command, timeoutMs) {
    try {
      const result = await bash(command, { timeoutMs });
      const timedOut = false;
      const ok = result.status === 0;
      const why = `exit ${result.status}`;
      return {
        ok,
        out: result.stdout ?? '',
        timedOut,
        error: ok ? null : `${why}: ${(result.stderr ?? '').trim().slice(-200)}`.trim(),
      };
    } catch (e) {
      if (e?.code === 'ETIMEDOUT') {
        return {
          ok: false,
          out: '',
          timedOut: true,
          error: `timed out after ${timeoutMs / 1000} s`,
        };
      }
      throw e;
    }
  }

  let readSeq = 0;
  async function readBytes(path) {
    if (!SAFE_VFS.test(path) || path.includes('..')) throw new Error(`refusing to read ${path}`);
    readSeq += 1;
    const local = join(artifacts, 'tmp', `read-${readSeq}`);
    mkdirSync(join(artifacts, 'tmp'), { recursive: true });
    const encoded = await bash(
      `if [ -f ${shellQuote(path)} ]; then base64 < ${shellQuote(path)}; else echo MISSING; exit 2; fi`
    );
    if (encoded.status !== 0 || encoded.stdout.trim() === 'MISSING') {
      throw new Error(`missing ${path}`);
    }
    const buf = Buffer.from(encoded.stdout.replace(/\s+/g, ''), 'base64');
    writeFileSync(local, buf);
    return buf;
  }

  const vfsReaders = {
    readText: async (path) => (await readBytes(path)).toString('utf8'),
    readBase64: async (path) => (await readBytes(path)).toString('base64'),
    list: async (dir) => {
      if (!SAFE_VFS.test(dir) || dir.includes('..')) throw new Error(`refusing to list ${dir}`);
      const r = await trySh(`ls -1 ${shellQuote(dir)}`, 60_000);
      return r.ok
        ? r.out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    },
  };

  async function keepFiles(paths, dir, what) {
    for (const path of paths ?? []) {
      if (typeof path !== 'string' || !SAFE_VFS.test(path) || path.includes('..')) continue;
      try {
        const bytes = await readBytes(path);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, path.replace(/^\//, '').replace(/\//g, '__')), bytes);
      } catch (e) {
        console.log(`::warning::${what} ${path}: ${e.message}`);
      }
    }
  }

  async function stop() {
    for (const hook of hooks.splice(0)) {
      try {
        await hook();
      } catch {}
    }
    await chrome.close();
  }

  return {
    chrome,
    bash,
    run,
    sh,
    trySh,
    runSkill,
    keepFiles,
    vfsReaders,
    stop,
    spend: () => ({
      cost: { costUsd: 0, tokens: 0 },
      escalations: { asked: 0, allowed: 0, denied: 0 },
    }),
    spendDelta: () => ({ costUsd: 0, tokens: 0 }),
  };
}

export { defaultFail, shellQuote, withTimeout };
