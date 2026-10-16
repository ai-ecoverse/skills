// mermaid — render a Mermaid diagram to SVG.
//
// Mermaid measures text with getBBox, so a worker DOM shim produces a broken
// picture. This command bundles the ipk-installed `mermaid` package with the
// built-in esbuild, opens that page in the leader browser, and reads the SVG
// back through sliccy:browser. The tab is closed when the command finishes.
//
// fs goes through fs.promises / existsSync only: those behave the same in
// SLICC 6 and in slicc-jsh (SLICC 7), measured on a hosted leader 2026-10-17.
//
// Requires: ipk add -g mermaid esbuild-wasm

const fs = require('fs');
const path = require('path');
const exec = require('sliccy:exec');
const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const {
  THEMES,
  RENDER_TIMEOUT_MS,
  awaitRender,
  entrySource,
  parseArgs,
  pageHtml,
  targetIdFrom,
  checkSvg,
} = require('./render-page.js');

const INSTALL = 'ipk add -g mermaid esbuild-wasm';
const GLOBAL_PKG = '/shared/lib/node_modules/mermaid/package.json';
const CACHE_DIR = '/shared/cache';
const PAGE_DIR = '/shared/tmp';
const P = { prefix: 'mermaid' };

const HELP = `
mermaid — render a Mermaid diagram to SVG

USAGE
  mermaid render [file|-] [-o out.svg] [--theme name]
  mermaid [file] [-o out.svg] [--theme name]

  With no file, or with -, the diagram is read from stdin.
  A bare path is the same as "mermaid render <path>".

FLAGS
  -o, --output <path>   Write the SVG here. Otherwise it is printed.
  --theme <name>        default, neutral, dark, forest, or base
  -h, --help            Show this help

REQUIRES
  ${INSTALL}

The diagram runs in the leader browser under Mermaid's strict security
level, then the tab is closed. A diagram that fails to parse exits 1 and
prints Mermaid's own message.
`.trim();

function findPackageJson() {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'node_modules', 'mermaid', 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fs.existsSync(GLOBAL_PKG) ? GLOBAL_PKG : null;
}

async function readDiagram(file) {
  if (file === '-') return (await process.stdin.read()) || '';
  if (!fs.existsSync(file)) cli.die(`no such file: ${file}`, P);
  return await fs.promises.readFile(file, 'utf8');
}

// The bundle is built from a generated entry that imports the found package's
// own entry file, so esbuild bundles exactly the copy whose version names the
// cache, wherever ipk put it. It is written under a temporary name and only
// becomes the cache once it is complete: a killed or failed build never
// leaves a bundle that every later render would trust.
async function bundle(pkgDir, pkg) {
  const version = pkg.version || '0';
  const cache = path.join(CACHE_DIR, `mermaid-${version}.iife.js`);
  if (fs.existsSync(cache)) {
    const cached = await fs.promises.readFile(cache, 'utf8');
    if (cached.includes('__sliccMermaid')) return cached;
  }
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = path.join(CACHE_DIR, `mermaid-entry-${stamp}.js`);
  const out = path.join(CACHE_DIR, `mermaid-${version}.${stamp}.tmp.js`);
  await fs.promises.writeFile(entry, entrySource(pkgDir, pkg));
  try {
    const built = await exec.spawn([
      'esbuild',
      entry,
      '--bundle',
      '--format',
      'iife',
      '--outfile',
      out,
    ]);
    if (built.exitCode !== 0) {
      const detail = (built.stderr || built.stdout || 'esbuild failed').trim();
      cli.die(`${detail}\nInstall the renderer with: ${INSTALL}`, P);
    }
    const js = fs.existsSync(out) ? await fs.promises.readFile(out, 'utf8') : '';
    if (!js.includes('__sliccMermaid')) cli.die('esbuild produced no usable bundle', P);
    await fs.promises.writeFile(cache, js);
    return js;
  } finally {
    await fs.promises.rm(entry, { force: true }).catch(() => {});
    await fs.promises.rm(out, { force: true }).catch(() => {});
  }
}

async function renderInBrowser(htmlPath) {
  const opened = await exec.spawn(['open', htmlPath]);
  if (opened.exitCode !== 0) cli.die((opened.stderr || opened.stdout || 'open failed').trim(), P);
  const targetId = targetIdFrom(`${opened.stdout || ''}\n${opened.stderr || ''}`);
  if (!targetId) cli.die('the browser did not report a targetId, so the diagram cannot be read back', P);
  let result;
  try {
    result = await browser.evalAsync({ targetId }, awaitRender);
  } finally {
    await exec.spawn(['playwright-cli', 'tab-close', `--tab=${targetId}`]).catch(() => {});
  }
  // Serialize once: the page returns a plain object (CLAUDE.md §8.1).
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      /* not JSON: reported below */
    }
  }
  if (!result || typeof result !== 'object') cli.die('the browser returned nothing', P);
  if (result.status === 'pending') {
    cli.die(`the diagram did not finish rendering within ${RENDER_TIMEOUT_MS / 1000}s`, P);
  }
  if (result.status !== 'ok') cli.die(result.text || 'render failed', P);
  const problem = checkSvg(result.text);
  if (problem) cli.die(problem, P);
  return result.text;
}

function inputFile(positional, flags) {
  const first = positional[0];
  if (first === 'help') return { help: true };
  // No file: read stdin. Bare `mermaid` with nothing piped prints help.
  if (!first) return { file: '-', helpWhenEmpty: !flags.output && !flags.theme };
  if (first === 'render') {
    if (positional.length > 2) return { error: 'mermaid: too many arguments' };
    return { file: positional[1] || '-' };
  }
  if (positional.length > 1) return { error: 'mermaid: too many arguments' };
  return { file: first };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags?.help) cli.help(HELP);
  if (parsed.error) cli.die(parsed.error, { prefix: '', exitCode: 2 });
  const { flags, positional } = parsed;
  const input = inputFile(positional, flags);
  if (input.help) cli.help(HELP);
  if (input.error) cli.die(input.error, { prefix: '', exitCode: 2 });

  const theme = flags.theme || 'default';
  if (!THEMES.includes(theme)) {
    cli.die(`unknown theme: ${theme} (use ${THEMES.join(', ')})`, { ...P, exitCode: 2 });
  }

  const source = String(await readDiagram(input.file));
  if (!source.trim() && input.helpWhenEmpty) cli.help(HELP);
  if (!source.trim()) cli.die('no diagram on stdin or in the file', P);

  const pkgPath = findPackageJson();
  if (!pkgPath) cli.die(`mermaid is not installed. ${INSTALL}`, P);
  const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
  const js = await bundle(path.dirname(pkgPath), pkg);
  const html = pageHtml({ source, theme, bundle: js });

  await fs.promises.mkdir(PAGE_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const htmlPath = path.join(PAGE_DIR, `mermaid-${stamp}.html`);
  await fs.promises.writeFile(htmlPath, html);
  try {
    const svg = await renderInBrowser(htmlPath);
    if (flags.output) {
      await fs.promises.writeFile(flags.output, svg);
      console.log(flags.output);
      return;
    }
    console.log(svg);
  } finally {
    await fs.promises.rm(htmlPath, { force: true }).catch(() => {});
  }
}

try {
  await main();
} catch (err) {
  if (err && err.name === 'NodeExitError') throw err;
  cli.die(err && err.message ? err.message : String(err), P);
}
