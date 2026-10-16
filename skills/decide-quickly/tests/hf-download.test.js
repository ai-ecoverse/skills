import test, { is, ok } from 'tst';
import * as hostMod from '../scripts/host.js';

const host = hostMod.default || hostMod;

// slicc 6's builtin `hf download --help` (packages/webapp/.../hf-command.ts).
const SLICC_HELP = `Usage:
  hf download <repo> [files...] [--to <dir>] [--revision <rev>] [--force]

Defaults:
  --to                 /workspace/models/<repo>/`;
// huggingface_hub's `hf download --help` (typer/rich box layout, abridged).
const HUB_HELP = `Usage: hf download [OPTIONS] REPO_ID [FILENAMES]...
╭─ Options ───────────────────────────────────────────────╮
│ --revision          TEXT  Git revision id.               │
│ --local-dir         TEXT  Download into this directory.  │
│ --token             TEXT  Hugging Face token.            │
╰─────────────────────────────────────────────────────────╯`;

function fakeExec(help) {
  const calls = [];
  return {
    calls,
    async spawn(argv) {
      calls.push(argv);
      if (argv.includes('--help')) return help;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

const downloads = (exec) => exec.calls.filter((a) => !a.includes('--help'));

test('slicc 6 builtin hf: downloads pass --to', async () => {
  const exec = fakeExec({ exitCode: 0, stdout: SLICC_HELP, stderr: '' });
  await host.hfDownload(exec, 'org/model', ['a.onnx'], '/workspace/models/org/model');
  is(downloads(exec), [
    ['hf', 'download', 'org/model', 'a.onnx', '--to', '/workspace/models/org/model'],
  ]);
});

test('huggingface_hub hf: downloads pass --local-dir, not --to (or --token)', async () => {
  const exec = fakeExec({ exitCode: 0, stdout: HUB_HELP, stderr: '' });
  await host.hfDownload(exec, 'org/model', ['a.onnx', 'b.json'], '/models/m');
  is(downloads(exec), [
    ['hf', 'download', 'org/model', 'a.onnx', 'b.json', '--local-dir', '/models/m'],
  ]);
});

test('the help probe runs once per exec, even for overlapping downloads', async () => {
  const exec = fakeExec({ exitCode: 0, stdout: HUB_HELP, stderr: '' });
  await Promise.all([
    host.hfDownload(exec, 'org/a', ['x'], '/m/a'),
    host.hfDownload(exec, 'org/b', ['y'], '/m/b'),
  ]);
  await host.hfDownload(exec, 'org/c', ['z'], '/m/c');
  is(exec.calls.filter((a) => a.includes('--help')).length, 1);
  is(downloads(exec).length, 3);
});

test('a failed probe downloads nothing, names the problem, and is asked again', async () => {
  const exec = fakeExec({ exitCode: 127, stdout: '', stderr: 'hf: command not found' });
  let error = null;
  try {
    await host.hfDownload(exec, 'org/model', ['a.onnx'], '/m');
  } catch (e) {
    error = e;
  }
  ok(error && /lists neither --local-dir nor --to/.test(error.message), String(error));
  ok(/command not found/.test(error.message), 'the probe output is in the error');
  is(downloads(exec).length, 0);
  await new Promise((r) => setTimeout(r, 0));
  try {
    await host.hfDownload(exec, 'org/model', ['a.onnx'], '/m');
  } catch {}
  is(exec.calls.filter((a) => a.includes('--help')).length, 2);
});
