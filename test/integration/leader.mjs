import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(REPO_ROOT, 'node_modules', '.cache', 'slicc-gw');
export const CONNECT_FAILURE =
  /tray connect timed out|tray attach|signaling|dial|connection closed/i;

export function redact(text) {
  return String(text ?? '').replace(/\/(join|controller|webhook)\/[^\s/"'?]+/g, '/$1/<token>');
}

export function latestSlicc() {
  return execFileSync('npm', ['view', 'sliccy@latest', 'version'], { encoding: 'utf8' }).trim();
}

export function checkoutToken() {
  const direct = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (direct) return direct;
  const config = spawnSync('git', ['config', '--get-regexp', '^http\\..*\\.extraheader$'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const header = /authorization: basic (\S+)/i.exec(config.stdout ?? '');
  if (!header) return '';
  const decoded = Buffer.from(header[1], 'base64').toString('utf8');
  return /^x-access-token:(.+)$/.exec(decoded)?.[1] ?? '';
}

export function workflowScripts(version) {
  const dir = join(CACHE, `v${version}`);
  const scripts = join(dir, 'packages', 'github-workflow', 'scripts');
  if (existsSync(join(scripts, 'start-leader.mjs'))) return scripts;
  mkdirSync(CACHE, { recursive: true });
  const stage = mkdtempSync(join(CACHE, 'clone-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'inherit' });
  git(
    [
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      '--branch',
      `v${version}`,
      'https://github.com/ai-ecoverse/slicc',
      stage,
    ],
    CACHE
  );
  git(['sparse-checkout', 'set', 'packages/github-workflow'], stage);
  try {
    renameSync(stage, dir);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (!existsSync(join(scripts, 'start-leader.mjs'))) throw error;
  }
  return scripts;
}

async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { findBrowser } = await import('@ai-ecoverse/slicc-cdp');
  const found = await findBrowser();
  return found?.executable ?? '';
}

function runScript(script, env, log) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const keep = (chunk) => {
      out.push(chunk);
      appendFileSync(log, redact(chunk.toString('utf8')));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', fail);
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      if (code === 0) done(text);
      else fail(new Error(`${script} exited ${code}: ${redact(text).slice(-2000)}`));
    });
  });
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export async function startLeader({ name, port, mounts, artifacts }) {
  const version = latestSlicc();
  const scripts = workflowScripts(version);
  const home = mkdtempSync(join(tmpdir(), `slicc-gw-${name}-`));
  mkdirSync(artifacts, { recursive: true });
  const log = join(artifacts, 'leader-setup.log');
  writeFileSync(log, '');
  const commandFiles = {
    GITHUB_OUTPUT: join(home, 'github-output'),
    GITHUB_ENV: join(home, 'github-env'),
    GITHUB_PATH: join(home, 'github-path'),
  };
  for (const file of Object.values(commandFiles)) writeFileSync(file, '');
  const base = { ...process.env, ...commandFiles, SLICC_GW_HOME: home };
  delete base.NODE_OPTIONS;
  delete base.NODE_TEST_CONTEXT;
  const cli = join(home, 'cli', 'slicc');
  await runScript(
    join(scripts, 'install-cli.mjs'),
    {
      ...base,
      INPUT_SOURCE: 'release',
      INPUT_VERSION: 'latest',
      INPUT_INSTALL_DIR: dirname(cli),
      INPUT_TOKEN: checkoutToken(),
      INPUT_TELEMETRY: 'false',
    },
    log
  );
  if (!existsSync(cli)) throw new Error(`install-cli left no binary at ${cli}`);
  const chrome = await chromePath();
  const env = {
    ...base,
    ...(chrome ? { CHROME_PATH: chrome } : {}),
    SLICC_CLI: cli,
    SLICC_NO_UPDATE_CHECK: '1',
    SLICC_NO_TELEMETRY: '1',
  };
  await runScript(
    join(scripts, 'start-leader.mjs'),
    {
      ...env,
      INPUT_SLICC_VERSION: version,
      INPUT_PORT: String(port),
      INPUT_DURATION: '40m',
      INPUT_MOUNTS: mounts.map(([host, path]) => `${host}:${path}`).join('\n'),
      INPUT_PIN_WEBAPP: 'false',
      INPUT_BOOT_TIMEOUT: '240s',
      INPUT_CDP_LAUNCH_TIMEOUT: '90s',
      INPUT_MASK_JOIN_URL: 'true',
    },
    log
  );
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  if (!state.joinUrl) throw new Error('start-leader left no join URL');
  const url = state.joinUrl;

  function exec(command, { timeoutMs = 300_000 } = {}) {
    return new Promise((done, fail) => {
      const child = spawn(cli, [url, 'exec', command], {
        env: { ...env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done({
          status: timedOut ? 124 : (code ?? 1),
          timedOut,
          stdout: redact(Buffer.concat(out).toString('utf8')),
          stderr: redact(Buffer.concat(err).toString('utf8')),
        });
      });
    });
  }

  async function run(command, options) {
    let result;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      result = await exec(command, options);
      const dialFailed = result.status !== 0 && CONNECT_FAILURE.test(result.stderr);
      if (!dialFailed) return result;
      await sleep(5_000 * attempt);
    }
    return result;
  }

  async function stop() {
    try {
      await runScript(join(scripts, 'stop-leader.mjs'), env, join(artifacts, 'leader-stop.log'));
    } finally {
      if (existsSync(state.logPath)) {
        writeFileSync(join(artifacts, 'leader.log'), redact(readFileSync(state.logPath, 'utf8')));
      }
      rmSync(home, { recursive: true, force: true });
    }
  }

  return { version: state.sliccVersion ?? version, run, stop };
}
