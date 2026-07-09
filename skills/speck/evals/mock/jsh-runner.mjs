// Minimal .jsh runtime shim so the REAL speck.jsh runs unmodified.
// The current jsh runtime removed bare globals: script code obtains its
// capabilities via `require('sliccy:<name>')` (Node builtins via
// `require('fs')`). This shim mirrors that — it exposes a `require` resolving
// the two bridges speck.jsh depends on (`sliccy:exec` + `sliccy:browser`) —
// then imports the script source as an ES module (top-level await works).
// External commands (webhook, playwright-cli) are resolved via PATH, which
// the `speck` shim points at the per-eval mock bin dir.
import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import { exec as cpExec, execFile as cpExecFile } from 'node:child_process';

// `require('sliccy:exec')` → callable exec bridge (shells out via PATH).
const execBridge = (cmd) =>
  new Promise((resolve) => {
    cpExec(cmd, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? (err.code == null ? 1 : err.code) : 0,
      });
    });
  });

// `require('sliccy:browser')` → browser bridge. `eval(tab, script)` routes to
// the mock `playwright-cli eval "<script>" --tab <tab>`, returning the
// evaluated value (its stdout) and throwing on a non-zero exit — mirroring the
// real runtime bridge (js-realm-shared.ts createBrowserBridge), which accepts a
// bare targetId string and returns the value / rejects on failure.
const browserBridge = {
  eval: (tab, script) =>
    new Promise((resolve, reject) => {
      cpExecFile(
        'playwright-cli',
        ['eval', String(script), '--tab', String(tab)],
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr || stdout || String(err)).trim()));
            return;
          }
          resolve((stdout || '').trim());
        }
      );
    }),
};

const MODULES = {
  fs: fsp,
  'sliccy:exec': execBridge,
  'sliccy:browser': browserBridge,
};

globalThis.require = (id) => {
  if (Object.prototype.hasOwnProperty.call(MODULES, id)) return MODULES[id];
  throw new Error(`mock jsh-runner: unknown module '${id}'`);
};

const target = process.argv[2];
const scriptArgs = process.argv.slice(3);

// speck.jsh reads process.argv.slice(2); make its args land there.
process.argv = [process.argv[0], target, ...scriptArgs];

const src = readFileSync(target, 'utf8');
await import('data:text/javascript,' + encodeURIComponent(src));
