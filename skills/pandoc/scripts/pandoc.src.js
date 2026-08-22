// pandoc.src.js — Pandoc + Typst document conversion CLI for SLICC
//
// Runtime: pandoc-wasm (GPL-2.0-or-later) + typst-wasm (MIT). Load pandoc WASM
// bytes via fs.readFileBinary; import createPandocInstance from the prebuilt
// pandoc-core.cjs via require('./pandoc-core.cjs') — dynamic import() of VFS paths
// is not in the realm module graph; use a static relative require instead.

const fs = require('fs');
const cli = require('sliccy:cli');
const exec = require('sliccy:exec');
const color = require('sliccy:color');
const DEPS = ['pandoc-wasm@1.1.0', 'typst-wasm', '@typst-wasm/fonts'];
const PANDOC_WASM = '/workspace/node_modules/pandoc-wasm/src/pandoc.wasm';
const TYPST_ENGINE = '/workspace/node_modules/typst-wasm/dist/engine';
const FONT_DIR = '/workspace/node_modules/@typst-wasm/fonts/dist/files';

const HELP = `
pandoc — convert documents with pandoc-wasm; PDF via typst-wasm

USAGE
  pandoc convert -f <from> -t <to> <input> [-o out]
  pandoc pdf <input.md> [-o out.pdf]
  pandoc typst compile <input.typ> [-o out.pdf]
  pandoc query version [--json]
  pandoc install
  pandoc --help

CONVERT
  Transforms <input> using pandoc-wasm. Common: markdown→html, markdown→typst,
  docx→markdown. When -t pdf (or format name pdf), routes through typst-wasm.

PDF
  Markdown → typst (pandoc) → PDF (typst). Output defaults to <input>.pdf.

INSTALL
  One-time: ipk add pandoc-wasm@1.1.0 typst-wasm @typst-wasm/fonts (~90MB WASM).

FLAGS
  -f, --from <fmt>   Input format (convert)
  -t, --to <fmt>     Output format (convert)
  -o, --output <path> Write result to file instead of stdout
  --json             Raw JSON for query subcommands

EXAMPLES
  pandoc install
  pandoc query version
  pandoc convert -f markdown -t html README.md -o README.html
  pandoc convert -f markdown -t typst doc.md -o doc.typ
  pandoc pdf report.md -o /shared/report.pdf
  pandoc typst compile paper.typ -o /shared/paper.pdf

LICENSE
  pandoc-wasm is GPL-2.0-or-later; typst-wasm is MIT. See references/licensing.md.
`.trim();

// process.argv.parseFlags() treats `-o path` as boolean `-o` (short-flag cluster).
function rawFlagValue(short, long) {
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === short || arg === long) {
      const next = raw[i + 1];
      if (next && !next.startsWith('-')) return next;
    }
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
    if (short.length === 2 && arg.startsWith(`${short}=`)) return arg.slice(short.length + 1);
  }
  return undefined;
}

function flagString(flags, ...keys) {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function resolveOutput(flags, fallback) {
  return flagString(flags, 'output', 'o') || rawFlagValue('-o', '--output') || fallback;
}

function resolveFrom(flags) {
  return flagString(flags, 'from', 'f') || rawFlagValue('-f', '--from');
}

function resolveTo(flags) {
  return flagString(flags, 'to', 't') || rawFlagValue('-t', '--to');
}

async function loadWasmBytes(path) {
  const bytes = await fs.readFileBinary(path);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

async function compileWasm(path) {
  if (typeof globalThis.__slicc_compileWasm === 'function') {
    try {
      return await globalThis.__slicc_compileWasm(path);
    } catch (_) {
      /* fall through */
    }
  }
  const bytes = await fs.readFileBinary(path);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return WebAssembly.compile(buf);
}

async function depsInstalled() {
  try {
    await fs.readFile('/workspace/node_modules/pandoc-wasm/package.json');
    await fs.readFile('/workspace/node_modules/typst-wasm/package.json');
    await fs.readFile('/workspace/node_modules/@typst-wasm/fonts/package.json');
    return true;
  } catch {
    return false;
  }
}

async function ensureDeps() {
  if (await depsInstalled()) return;
  cli.die(
    `runtime packages not installed — run: pandoc install\n  (or: ipk add ${DEPS.join(' ')})`,
    { prefix: 'pandoc' }
  );
}

async function cmdInstall() {
  if (await depsInstalled()) {
    console.log(
      color.green('✓') + ' pandoc-wasm, typst-wasm, and @typst-wasm/fonts already installed'
    );
    return;
  }
  const r = await exec.spawn(['ipk', 'add', ...DEPS]);
  if (r.exitCode !== 0) {
    cli.die(`ipk add failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`, { prefix: 'pandoc' });
  }
  console.log(color.green('✓') + ' installed pandoc-wasm@1.1.0, typst-wasm, @typst-wasm/fonts');
}

async function getPandoc() {
  await ensureDeps();
  const { createPandocInstance } = require('./pandoc-core.cjs');
  const wasm = await loadWasmBytes(PANDOC_WASM);
  return await createPandocInstance(wasm);
}

async function loadTypstCoreModules() {
  const base = TYPST_ENGINE;
  return {
    'engine.core.wasm': compileWasm(`${base}/engine.core.wasm`),
    'engine.core2.wasm': compileWasm(`${base}/engine.core2.wasm`),
    'engine.core3.wasm': compileWasm(`${base}/engine.core3.wasm`),
  };
}

async function loadDefaultFonts(compiler) {
  const names = [
    'LibertinusSerif-Regular.otf',
    'LibertinusSerif-Bold.otf',
    'LibertinusSerif-Italic.otf',
    'NewCM10-Regular.otf',
    'NewCMMath-Regular.otf',
    'DejaVuSansMono.ttf',
  ];
  for (const name of names) {
    const bytes = await fs.readFileBinary(`${FONT_DIR}/${name}`);
    await compiler.addFonts(bytes);
  }
}

async function createTypstCompiler() {
  await ensureDeps();
  const { createTypstCompiler: factory } = await import('typst-wasm');
  const compiler = await factory({
    backend: 'jspi',
    coreModules: await loadTypstCoreModules(),
  });
  await loadDefaultFonts(compiler);
  return compiler;
}

async function typstCompileSource(typstSource, outPath) {
  const compiler = await createTypstCompiler();
  try {
    await compiler.addSource('main.typ', typstSource);
    await compiler.setMain('main.typ');
    const pdf = await compiler.compile({ format: 'pdf' });
    const bytes = pdf.output;
    await fs.writeFileBinary(outPath, bytes);
    return bytes.byteLength;
  } finally {
    await compiler.dispose();
  }
}

// SLICC fs.readFile(..., 'utf8') is byte-valued, not UTF-8 decoded — use readFileBinary.
const BINARY_FROM = new Set(['docx', 'odt', 'epub', 'doc', 'pptx', 'rtf', 'odp', 'xlsx', 'fb2']);

async function readInputForConvert(path, fromFmt) {
  const bytes = await fs.readFileBinary(path);
  const from = String(fromFmt).toLowerCase();
  if (BINARY_FROM.has(from)) {
    const base = path.split('/').pop() || `input.${from}`;
    return { stdin: '', files: { [base]: bytes } };
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { stdin: text, files: {} };
}

async function readTextInput(path) {
  const bytes = await fs.readFileBinary(path);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function defaultOutPath(input, ext) {
  const base = input.replace(/\.[^./]+$/, '');
  return `${base}.${ext}`;
}

function resolveInputPath(positional, from, to) {
  const skip = new Set([from, to].filter(Boolean).map((s) => String(s).toLowerCase()));
  const candidates = positional.filter((p) => !skip.has(String(p).toLowerCase()));
  if (!candidates.length) return undefined;
  return candidates[0];
}

async function cmdConvert(positional, flags) {
  const from = resolveFrom(flags);
  const to = resolveTo(flags);
  if (!from) cli.die('--from/-f is required', { prefix: 'pandoc' });
  if (!to) cli.die('--to/-t is required', { prefix: 'pandoc' });
  const input = resolveInputPath(positional, from, to);
  if (!input) {
    cli.die('usage: pandoc convert -f <from> -t <to> <input> [-o out]', { prefix: 'pandoc' });
  }

  const { stdin, files } = await readInputForConvert(input, from);
  const toNorm = String(to).toLowerCase();

  if (toNorm === 'pdf') {
    const { convert } = await getPandoc();
    const typstOut = await convert({ from, to: 'typst', standalone: true }, stdin, files);
    const outPath = resolveOutput(flags, defaultOutPath(input, 'pdf'));
    const bytes = await typstCompileSource(typstOut.stdout, outPath);
    console.log(color.green('✓') + ` wrote ${outPath} (${bytes} bytes)`);
    return;
  }

  const { convert } = await getPandoc();
  const result = await convert({ from, to, standalone: true }, stdin, files);
  const out = result.stdout;
  const outPath = resolveOutput(flags);

  if (outPath) {
    await fs.writeFile(outPath, out, 'utf8');
    console.log(color.green('✓') + ` wrote ${outPath} (${out.length} chars)`);
  } else {
    process.stdout.write(out);
    if (!out.endsWith('\n')) process.stdout.write('\n');
  }
}

async function cmdPdf(positional, flags) {
  const input = positional[0];
  if (!input) cli.die('usage: pandoc pdf <input.md> [-o out.pdf]', { prefix: 'pandoc' });
  const text = await readTextInput(input);
  const { convert } = await getPandoc();
  const typstOut = await convert({ from: 'markdown', to: 'typst', standalone: true }, text, {});
  const outPath = resolveOutput(flags, defaultOutPath(input, 'pdf'));
  const bytes = await typstCompileSource(typstOut.stdout, outPath);
  console.log(color.green('✓') + ` wrote ${outPath} (${bytes} bytes)`);
}

async function cmdQuery(positional, flags) {
  const what = positional[0];
  if (!what) cli.die('usage: pandoc query version', { prefix: 'pandoc' });
  if (what !== 'version') cli.die(`unknown query "${what}" (try: version)`, { prefix: 'pandoc' });
  const { query } = await getPandoc();
  const version = await query({ query: 'version' });
  if (flags.json) {
    cli.out(version);
    return;
  }
  console.log(`pandoc ${version}`);
}

async function cmdTypstCompile(positional, flags) {
  const input = positional[0];
  if (!input) {
    cli.die('usage: pandoc typst compile <input.typ> [-o out.pdf]', { prefix: 'pandoc' });
  }
  const text = await readTextInput(input);
  const outPath = resolveOutput(flags, defaultOutPath(input, 'pdf'));
  const bytes = await typstCompileSource(text, outPath);
  console.log(color.green('✓') + ` wrote ${outPath} (${bytes} bytes)`);
}

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);
const flags = parsed.flags;

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') {
    cli.help(HELP);
  }
  try {
    if (subcommand === 'install') await cmdInstall();
    else if (subcommand === 'convert') await cmdConvert(positional, flags);
    else if (subcommand === 'pdf') await cmdPdf(positional, flags);
    else if (subcommand === 'query') await cmdQuery(positional, flags);
    else if (subcommand === 'typst') {
      const nested = positional[0];
      const rest = positional.slice(1);
      if (nested === 'compile') await cmdTypstCompile(rest, flags);
      else cli.die('usage: pandoc typst compile <input.typ> [-o out.pdf]', { prefix: 'pandoc' });
    } else {
      cli.die(`unknown command "${subcommand}" (run pandoc --help)`, { prefix: 'pandoc' });
    }
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message, { prefix: 'pandoc' });
  }
}

await main();
