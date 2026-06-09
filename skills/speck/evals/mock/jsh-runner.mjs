// Minimal .jsh runtime shim so the REAL speck.jsh runs unmodified.
// Provides the two globals speck.jsh relies on — `exec` and `fs` — then
// imports the script source as an ES module (top-level await works).
// External commands (webhook, playwright-cli) are resolved via PATH, which
// the `speck` shim points at the per-eval mock bin dir.
import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import { exec as cpExec } from 'node:child_process';

globalThis.fs = fsp; // speck.jsh uses fs.writeFile / fs.rm

globalThis.exec = (cmd) =>
  new Promise((resolve) => {
    cpExec(cmd, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? (err.code == null ? 1 : err.code) : 0,
      });
    });
  });

const target = process.argv[2];
const scriptArgs = process.argv.slice(3);

// speck.jsh reads process.argv.slice(2); make its args land there.
process.argv = [process.argv[0], target, ...scriptArgs];

const src = readFileSync(target, 'utf8');
await import('data:text/javascript,' + encodeURIComponent(src));
