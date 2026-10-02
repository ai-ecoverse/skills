// Tests for uploadMediaBytes() in skills/linkedin/scripts/linkedin.jsh
//
// Run with:
//   tst <path-to-this-file>
//
// Strategy (same as skills/slack/tests): compile the REAL source up to the CLI
// dispatch, with a mocked require(), and call uploadMediaBytes() directly. No
// network, no LinkedIn tab: the browser bridge is a stub that records the page
// script, and the test decodes the base64 payload that script would upload.
//
// The mock fs reproduces the runtime: fs.readFile returns DECODED text for a
// binary file, fs.readFileBinary returns the raw Uint8Array. Against the code
// that read with fs.readFile, the first test fails (btoa throws
// InvalidCharacterError on the decoded text); with fs.readFileBinary it passes.

import test, { is, ok } from 'tst';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/linkedin.jsh', import.meta.url));
const DISPATCH_MARKER = '// ─── CLI Dispatch';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

// Not valid UTF-8 (PNG magic, every byte value 0-255) and longer than one
// 8 KB chunk, so both the decoding bug and the chunk boundaries are covered.
function sampleBytes(n) {
  const b = new Uint8Array(n);
  b.set(PNG_MAGIC);
  for (let i = PNG_MAGIC.length; i < n; i++) b[i] = (i * 31 + 7) & 255;
  return b;
}

async function load(bytes) {
  const src = readFileSync(SCRIPT, 'utf8');
  const cut = src.indexOf(DISPATCH_MARKER);
  if (cut < 0) throw new Error('CLI Dispatch marker not found in linkedin.jsh');
  const evals = [];
  const reads = [];
  const fsMock = {
    readFile: async (p) => { reads.push(['readFile', p]); return new TextDecoder('utf-8').decode(bytes); },
    readFileBinary: async (p) => { reads.push(['readFileBinary', p]); return bytes; },
    writeFile: async () => {},
    exists: async () => false,
  };
  const browser = {
    evalAsync: async (tabId, script) => { evals.push({ tabId, script }); return { status: 201, ok: true }; },
  };
  const exec = async () => ({ stdout: '', stderr: 'not found', exitCode: 1 });
  const color = new Proxy({}, { get: () => (s) => s });
  const req = (name) => {
    if (name === 'fs') return fsMock;
    if (name === 'sliccy:browser') return browser;
    if (name === 'sliccy:exec') return exec;
    if (name === 'sliccy:color') return color;
    throw new Error('unexpected require: ' + name);
  };
  const proc = { argv: ['node', 'linkedin.jsh'], env: {}, exit: (c) => { throw new Error('process.exit ' + c); } };
  const quiet = { log() {}, error() {}, warn() {}, info() {} };
  const body = src.slice(0, cut) + '\nreturn { uploadMediaBytes };';
  const mod = await new AsyncFunction('require', 'process', 'console', body)(req, proc, quiet);
  return { mod, evals, reads };
}

function sentBytes(script) {
  const m = script.match(/const B64 = ("[^"\n]*");/);
  if (!m) throw new Error('B64 constant not found in the page script');
  const bin = atob(JSON.parse(m[1]));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

test('uploadMediaBytes uploads binary file bytes unchanged', async () => {
  const bytes = sampleBytes(20000);
  const { mod, evals } = await load(bytes);
  const res = await mod.uploadMediaBytes('tab-1', 'csrf-1', 'https://upload.invalid/put', '/shared/chart.png', { 'media-type-family': 'STILLIMAGE' }, 'image/png');
  is(res.ok, true);
  is(evals.length, 1);
  const sent = sentBytes(evals[0].script);
  is(sent.length, bytes.length);
  is(Array.from(sent.subarray(0, 8)), PNG_MAGIC);
  is(Array.from(sent), Array.from(bytes));
});

test('uploadMediaBytes reads the media file as binary', async () => {
  const { mod, reads } = await load(sampleBytes(10));
  await mod.uploadMediaBytes('tab-1', 'csrf-1', 'https://upload.invalid/put', '/shared/clip.mp4', {}, 'video/mp4');
  is(reads, [['readFileBinary', '/shared/clip.mp4']]);
});

test('uploadMediaBytes keeps the upload headers, CSRF token and content type', async () => {
  const { mod, evals } = await load(sampleBytes(10));
  await mod.uploadMediaBytes('tab-9', 'csrf-xyz', 'https://upload.invalid/put', '/shared/a.jpg', { 'media-type-family': 'STILLIMAGE' }, 'image/jpeg');
  is(evals[0].tabId, 'tab-9');
  ok(evals[0].script.includes('const CSRF = "csrf-xyz";'));
  ok(evals[0].script.includes('const TYPE = "image/jpeg";'));
  ok(evals[0].script.includes('"media-type-family":"STILLIMAGE"'));
});
