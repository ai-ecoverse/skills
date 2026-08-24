// pandoc.src.js — Pandoc + Typst document conversion CLI for SLICC
//
// Runtime: pandoc-wasm (GPL-2.0-or-later) + typst-wasm (MIT). Load pandoc WASM
// bytes via fs.readFileBinary; import createPandocInstance from the prebuilt
// pandoc-core.cjs via require('./pandoc-core.cjs') — dynamic import() of VFS paths
// is not in the realm module graph; use a static relative require instead.
//
// End with `return main()` — not `await main()` (CJS transpile rejects TLA)
// and not a bare `main().catch(...)` (the AsyncFunction wrapper exits first).

const fs = require('fs');
const zlib = require('zlib');
const cli = require('sliccy:cli');
const exec = require('sliccy:exec');
const color = require('sliccy:color');
const DEPS = ['pandoc-wasm@1.1.0', 'typst-wasm', '@typst-wasm/fonts'];
const PANDOC_WASM = '/workspace/node_modules/pandoc-wasm/src/pandoc.wasm';
const TYPST_ENGINE = '/workspace/node_modules/typst-wasm/dist/engine';
const FONT_DIR = '/workspace/node_modules/@typst-wasm/fonts/dist/files';
const PDF_PPI = 144;

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
  Markdown → typst (pandoc) → PNG pages (typst-wasm) → PDF 1.3 with one Flate
  DeviceRGB image per page. typst-wasm's native PDF embeds CID CFF that extract
  as text but paint as tofu (pdftoppm, DocuSign). Output defaults to <input>.pdf.

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
  const fonts = [];
  for (const name of names) {
    fonts.push(await fs.readFileBinary(`${FONT_DIR}/${name}`));
  }
  await compiler.addFonts(...fonts);
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

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngToRgb(pngBytes) {
  const bytes = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error('not a PNG');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    const len = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new Error('truncated PNG chunk');
    if (type === 'IHDR') {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height) throw new Error('PNG missing IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (colorType !== 2 && colorType !== 6 && colorType !== 0) {
    throw new Error(`unsupported PNG color type ${colorType}`);
  }
  let packed = 0;
  for (const part of idat) packed += part.length;
  const compressed = new Uint8Array(packed);
  let woff = 0;
  for (const part of idat) {
    compressed.set(part, woff);
    woff += part.length;
  }
  const inflated = zlib.inflateSync(compressed);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const rgb = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const raw = inflated.subarray(src, src + stride);
    src += stride;
    if (filter === 0) {
      row.set(raw);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        row[i] = (raw[i] + left) & 255;
      }
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) row[i] = (raw[i] + prev[i]) & 255;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        row[i] = (raw[i] + ((left + prev[i]) >> 1)) & 255;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        const up = prev[i];
        const upLeft = i >= channels ? prev[i - channels] : 0;
        row[i] = (raw[i] + paeth(left, up, upLeft)) & 255;
      }
    } else {
      throw new Error(`unsupported PNG filter ${filter}`);
    }
    prev.set(row);
    const dst = y * width * 3;
    if (colorType === 2) {
      rgb.set(row, dst);
    } else if (colorType === 6) {
      for (let x = 0; x < width; x++) {
        rgb[dst + x * 3] = row[x * 4];
        rgb[dst + x * 3 + 1] = row[x * 4 + 1];
        rgb[dst + x * 3 + 2] = row[x * 4 + 2];
      }
    } else {
      for (let x = 0; x < width; x++) {
        const g = row[x];
        rgb[dst + x * 3] = g;
        rgb[dst + x * 3 + 1] = g;
        rgb[dst + x * 3 + 2] = g;
      }
    }
  }
  return { width, height, rgb };
}

function pdfEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapPngPagesToPdf(pages, ppi) {
  // 1 = Catalog, 2 = Pages, then Image / Contents / Page per raster page.
  const numbered = [];
  numbered.push('<< /Type /Catalog /Pages 2 0 R >>');
  numbered.push(null);
  const kids = [];
  for (const page of pages) {
    const png = page instanceof Uint8Array ? page : page.output;
    const { width, height, rgb } = decodePngToRgb(png);
    const compressed = zlib.deflateSync(rgb);
    const wPt = (width * 72) / ppi;
    const hPt = (height * 72) / ppi;
    const imgId = numbered.length + 1;
    numbered.push({
      header:
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
        `/Length ${compressed.length} >>\nstream\n`,
      stream: compressed,
    });
    const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q\n`;
    const contentsId = numbered.length + 1;
    numbered.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    const pageId = numbered.length + 1;
    numbered.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentsId} 0 R >>`
    );
    kids.push(`${pageId} 0 R`);
  }
  numbered[1] = `<< /Type /Pages /Kids [ ${kids.join(' ')} ] /Count ${kids.length} >>`;

  const encoder = new TextEncoder();
  const chunks = [encoder.encode('%PDF-1.3\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = [0];
  let pos = chunks[0].length;
  for (let i = 0; i < numbered.length; i++) {
    offsets.push(pos);
    const item = numbered[i];
    let block;
    if (item && typeof item === 'object' && item.stream) {
      const head = encoder.encode(`${i + 1} 0 obj\n${item.header}`);
      const tailBytes = encoder.encode('\nendstream\nendobj\n');
      block = new Uint8Array(head.length + item.stream.length + tailBytes.length);
      block.set(head, 0);
      block.set(item.stream, head.length);
      block.set(tailBytes, head.length + item.stream.length);
    } else {
      block = encoder.encode(`${i + 1} 0 obj\n${item}\nendobj\n`);
    }
    chunks.push(block);
    pos += block.length;
  }
  const xrefPos = pos;
  let xref = `xref\n0 ${numbered.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref +=
    `trailer\n<< /Size ${numbered.length + 1} /Root 1 0 R /Info << ` +
    `/Creator (${pdfEscape('pandoc+typst-wasm (raster)')}) /Producer (${pdfEscape('slicc pandoc skill')}) >> >>\n` +
    `startxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(encoder.encode(xref));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function typstCompileSource(typstSource, outPath) {
  const compiler = await createTypstCompiler();
  try {
    await compiler.addSource('main.typ', typstSource);
    await compiler.setMain('main.typ');
    const png = await compiler.compile({ format: 'png', ppi: PDF_PPI });
    const pages = png.pages || [];
    if (!pages.length) throw new Error('typst-wasm produced no PNG pages');
    const pdf = wrapPngPagesToPdf(pages, PDF_PPI);
    await fs.writeFileBinary(outPath, pdf);
    return pdf.byteLength;
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

return main().catch((err) => {
  if (err?.name === 'NodeExitError') throw err;
  cli.die(err && err.message ? err.message : String(err), { prefix: 'pandoc' });
});
