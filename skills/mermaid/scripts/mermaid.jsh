// mermaid — render a Mermaid diagram to SVG.
//
// Mermaid measures text with getBBox, so a worker DOM shim produces a broken
// picture. This command bundles the ipk-installed `mermaid` package with the
// built-in esbuild, opens that page in the leader browser, and reads the SVG
// back. The tab is closed when the command finishes.
//
// Requires: ipk add -g mermaid esbuild-wasm

const fs = require('fs');
const path = require('path');
const exec = require('sliccy:exec');
const cli = require('sliccy:cli');
const {
  THEMES,
  POLL_EXPR,
  SLICE,
  sliceExpr,
  evalText,
  checkSvg,
  parseArgs,
  pageHtml,
  targetIdFrom,
  splitRenderResult,
} = require('./render-page.js');

const INSTALL = 'ipk add -g mermaid esbuild-wasm';
const POLL_LIMIT = 40;
const POLL_MS = 250;

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
level, then the tab is closed. A scanned or broken diagram exits 1 and
prints Mermaid's own message.
`.trim();

async function exists(file) {
  if (typeof fs.exists === 'function') return fs.exists(file);
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function findPackageJson() {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'node_modules', 'mermaid', 'package.json');
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const globalPkg = '/shared/lib/node_modules/mermaid/package.json';
  if (await exists(globalPkg)) return globalPkg;
  return null;
}

async function readDiagram(file) {
  if (!file || file === '-') {
    const text = typeof process.stdin.read === 'function' ? await process.stdin.read() : '';
    return text || '';
  }
  if (!(await exists(file))) cli.die(`no such file: ${file}`, { prefix: 'mermaid' });
  // SLICC's fs.readFile hands back bytes as characters; decode the UTF-8
  // ourselves so labels with accents, dashes, or emoji survive.
  if (typeof fs.readFileBinary === 'function') {
    return new TextDecoder('utf-8').decode(await fs.readFileBinary(file));
  }
  return await fs.readFile(file, 'utf8');
}

async function bundle(entry, version) {
  const cacheDir = '/shared/cache';
  const cache = path.join(cacheDir, `mermaid-${version}.iife.js`);
  if (await exists(cache)) return await fs.readFile(cache);
  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
  const built = await exec.spawn([
    'esbuild',
    entry,
    '--bundle',
    '--format',
    'iife',
    '--outfile',
    cache,
  ]);
  if (built.exitCode !== 0) {
    const detail = (built.stderr || built.stdout || 'esbuild failed').trim();
    cli.die(`${detail}\nInstall the renderer with: ${INSTALL}`, { prefix: 'mermaid' });
  }
  if (!(await exists(cache))) {
    cli.die('esbuild produced no bundle', { prefix: 'mermaid' });
  }
  return await fs.readFile(cache);
}

async function renderInBrowser(htmlPath) {
  const opened = await exec.spawn(['open', htmlPath]);
  if (opened.exitCode !== 0) {
    cli.die((opened.stderr || opened.stdout || 'open failed').trim(), { prefix: 'mermaid' });
  }
  const tab = targetIdFrom(`${opened.stdout || ''}\n${opened.stderr || ''}`);
  if (!tab) {
    cli.die('the browser did not report a targetId, so the diagram cannot be read back', {
      prefix: 'mermaid',
    });
  }
  const evalInTab = async (expr) => {
    const r = await exec.spawn(['playwright-cli', 'eval', `--tab=${tab}`, expr]);
    if (r.exitCode !== 0) {
      cli.die((r.stderr || r.stdout || 'playwright eval failed').trim(), { prefix: 'mermaid' });
    }
    return r.stdout || '';
  };
  try {
    for (let i = 0; i < POLL_LIMIT; i++) {
      const result = splitRenderResult(await evalInTab(POLL_EXPR));
      if (result.pending) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (result.error) cli.die(result.error, { prefix: 'mermaid' });
      let svg = '';
      for (let start = 0; start < result.length; start += SLICE) {
        svg += evalText(await evalInTab(sliceExpr(start, start + SLICE)));
      }
      const problem = checkSvg(svg, result.length);
      if (problem) cli.die(problem, { prefix: 'mermaid' });
      return svg;
    }
    cli.die('the diagram did not finish rendering in the browser', { prefix: 'mermaid' });
  } finally {
    await exec.spawn(['playwright-cli', 'tab-close', `--tab=${tab}`]).catch(() => {});
  }
}

function inputFile(positional) {
  const first = positional[0];
  if (first === 'help') return { help: true };
  // No file: read stdin. Help only when stdin is empty too.
  if (!first) return { file: '-', helpWhenEmpty: true };
  if (first === 'render') {
    if (positional.length > 2) return { error: 'mermaid: too many arguments' };
    return { file: positional[1] || '-' };
  }
  if (positional.length > 1) return { error: 'mermaid: too many arguments' };
  return { file: first };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) cli.die(parsed.error, { prefix: '', exitCode: 2 });
  const { flags, positional } = parsed;
  const input = inputFile(positional);
  if (input.error) cli.die(input.error, { prefix: '', exitCode: 2 });
  if (flags.help || input.help) cli.help(HELP);

  const theme = flags.theme || 'default';
  if (!THEMES.includes(theme)) {
    cli.die(`unknown theme: ${theme} (use ${THEMES.join(', ')})`, {
      prefix: 'mermaid',
      exitCode: 2,
    });
  }

  const source = await readDiagram(input.file);
  if (!String(source).trim() && input.helpWhenEmpty) cli.help(HELP);
  if (!String(source).trim()) cli.die('no diagram on stdin or in the file', { prefix: 'mermaid' });

  const pkgPath = await findPackageJson();
  if (!pkgPath) cli.die(`mermaid is not installed. ${INSTALL}`, { prefix: 'mermaid' });
  const pkg = JSON.parse(await fs.readFile(pkgPath));
  const version = pkg.version || '0';
  const entry = path.join(__dirname, 'mermaid-entry.js');
  const js = await bundle(entry, version);
  const html = pageHtml({ source: String(source), theme, bundle: String(js) });

  const tmp = process.env.TMPDIR || '/tmp';
  const htmlPath = path.join(tmp, `mermaid-${Date.now()}.html`);
  await fs.mkdir(tmp, { recursive: true }).catch(() => {});
  await fs.writeFile(htmlPath, html);
  try {
    const svg = await renderInBrowser(htmlPath);
    if (flags.output) {
      await fs.writeFile(flags.output, svg);
      console.log(flags.output);
      return;
    }
    console.log(svg);
  } finally {
    await fs.rm(htmlPath).catch(() => {});
  }
}

try {
  await main();
} catch (err) {
  if (err && err.name === 'NodeExitError') throw err;
  cli.die(err && err.message ? err.message : String(err), { prefix: 'mermaid' });
}
