// Runs the shipped wiki.jsh with node (as its jsh shebang would) in a sandbox:
// a throwaway HOME, config file and bundle, and tests/fake-okf.js as okf.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = fileURLToPath(new URL('../scripts/wiki.jsh', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-okf.js', import.meta.url));

export function sandbox() {
  const dir = path.join(
    '/tmp',
    `llm-wiki-tst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  const home = path.join(dir, 'home');
  const kb = path.join(dir, 'kb');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(kb, { recursive: true });
  const okf = path.join(dir, 'okf');
  fs.copyFileSync(FAKE, okf);
  fs.chmodSync(okf, 0o755);
  const box = {
    dir,
    home,
    kb,
    okf,
    config: path.join(home, '.config', 'wiki', 'config.json'),
    okfLog: path.join(dir, 'okf-argv.log'),
    write(rel, text) {
      const p = path.join(kb, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
      return p;
    },
    okfCalls() {
      try {
        return fs
          .readFileSync(box.okfLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    run(args, env = {}) {
      const r = spawnSync('node', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: home,
          WIKI_CONFIG: box.config,
          OKF_BIN: okf,
          FAKE_OKF_LOG: box.okfLog,
          ...env,
        },
      });
      return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
  return box;
}

export async function withBox(fn) {
  const box = sandbox();
  try {
    await fn(box);
  } finally {
    box.cleanup();
  }
}

/** A CGI answer split into its status, headers and JSON body. */
export function parseCgi(stdout) {
  const at = stdout.indexOf('\r\n\r\n');
  const head = stdout.slice(0, at).split('\r\n');
  const headers = {};
  for (const line of head) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    status: Number(headers.status.split(' ')[0]),
    headers,
    body: JSON.parse(stdout.slice(at + 4)),
  };
}
