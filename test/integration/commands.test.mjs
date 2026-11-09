import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { BASE, bootKernel, launchKernel, PNPM, packUrl, REPO_ROOT } from './kernel.mjs';
import { packagedSkills } from './skills.mjs';

const USER_ROOT = '/opt/user';
const HOST_JSH = join(
  REPO_ROOT,
  'node_modules',
  '@ai-ecoverse',
  'slicc-jsh',
  'dist',
  'host',
  'jsh.mjs'
);

function hostRun(file, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOST_JSH, file, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 124, stdout, stderr });
    });
  });
}

const packaged = packagedSkills();
const pack = mkdtempSync(join(tmpdir(), 'skills-pack-'));
const host = mkdtempSync(join(tmpdir(), 'skills-host-'));
const tarballs = new Map();
let chrome;

before(async () => {
  for (const { skill } of packaged) {
    const out = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', pack],
      {
        cwd: join(REPO_ROOT, 'skills', skill),
        encoding: 'utf8',
      }
    );
    tarballs.set(skill, JSON.parse(out)[0].filename);
  }
  if (packaged.length) {
    execFileSync(
      'npm',
      [
        'install',
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        ...packaged.map(({ skill }) => join(pack, tarballs.get(skill))),
      ],
      { cwd: host, stdio: 'pipe', env: { ...process.env, npm_config_prefix: host } }
    );
  }
  chrome = await launchKernel({ pack: `${pack}/` });
});

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
  rmSync(host, { recursive: true, force: true });
});

test('every packaged skill installs with pnpm in /opt/user, and its commands answer --help as on the host jsh', async (t) => {
  if (!packaged.length) {
    t.skip('no skill has a package.json with bin');
    return;
  }
  const k = await bootKernel(chrome, t, {
    modules: [...BASE, PNPM],
    append: [`${USER_ROOT}/node_modules`],
  });
  const specs = packaged.map(({ skill }) => `${packUrl(chrome)}${tarballs.get(skill)}`);
  const setup = await k.bash(
    `mkdir -p ${USER_ROOT} && cd ${USER_ROOT} && printf '{ "private": true }\\n' > package.json && printf 'packages: []\\n' > pnpm-workspace.yaml`
  );
  assert.equal(setup.status, 0, setup.stderr);
  const add = await k.run(['pnpm', 'add', ...specs], { cwd: USER_ROOT });
  assert.equal(add.status, 0, `pnpm add: ${add.stdout}\n${add.stderr}`);

  for (const { skill, package: name, bins } of packaged) {
    for (const [command, target] of bins) {
      await t.test(`${skill}: ${command} --help`, async () => {
        const kernel = await k.run([command, '--help'], { env: { NO_COLOR: '1' } });
        assert.notEqual(
          kernel.status,
          127,
          `${command} is not a command in the kernel: ${kernel.stderr}`
        );
        assert.equal(
          kernel.status,
          0,
          `${command} --help exited ${kernel.status}: ${kernel.stderr}`
        );
        assert.ok(kernel.stdout.trim(), `${command} --help printed nothing`);
        const installed = join(host, 'node_modules', ...name.split('/'), target);
        const onHost = await hostRun(installed, ['--help'], host);
        assert.deepEqual(
          { status: kernel.status, stdout: kernel.stdout },
          { status: onHost.status, stdout: onHost.stdout }
        );
      });
    }
  }

  const listed = readdirSync(pack);
  assert.equal(listed.length, packaged.length);
});
