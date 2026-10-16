// Pure helpers for mermaid.jsh. No sliccy: imports, so a tst suite can load it.

const THEMES = ['default', 'neutral', 'dark', 'forest', 'base'];

// How long the page may take to lay a diagram out before the command gives up.
const RENDER_TIMEOUT_MS = 20000;

// Runs IN THE PAGE through sliccy:browser.evalAsync, so it must stand alone: no
// closure, the timeout written out (a test pins it to RENDER_TIMEOUT_MS). It
// waits for the bootstrap script to set data-ready and returns a plain object;
// the bridge serializes it once.
async function awaitRender() {
  const deadline = Date.now() + 20000;
  while (!document.body?.dataset?.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = document.body?.dataset?.ready || 'pending';
  const out = document.getElementById('out');
  return { status, text: out ? out.textContent : '' };
}

// The esbuild entry. It imports the ESM entry file of the package.json that was
// found, so the bundle is built from exactly that copy wherever ipk put it.
// SLICC's esbuild bundles a file path or a bare name, but a bare DIRECTORY path
// comes out as an empty wrapper (1.7 kB instead of 13 MB; measured on a hosted
// leader, mermaid 12.2.0, 2026-10-17). SLICC's esbuild has no --global-name:
// the page reads globalThis.__sliccMermaid.
function entrySource(pkgDir, pkg) {
  const rel = (pkg && (pkg.module || pkg.main)) || 'dist/mermaid.core.mjs';
  const file = `${pkgDir}/${String(rel).replace(/^\.\//, '')}`;
  return `import mermaid from ${JSON.stringify(file)};\nglobalThis.__sliccMermaid = mermaid;\n`;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg === '--theme') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) return { error: 'mermaid: --theme needs a name' };
      flags.theme = value;
      continue;
    }
    if (arg.startsWith('--theme=')) {
      flags.theme = arg.slice('--theme='.length);
      if (!flags.theme) return { error: 'mermaid: --theme needs a name' };
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) return { error: 'mermaid: -o needs a path' };
      flags.output = value;
      continue;
    }
    if (arg.startsWith('--output=')) {
      flags.output = arg.slice('--output='.length);
      if (!flags.output) return { error: 'mermaid: -o needs a path' };
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') return { error: `mermaid: unknown option: ${arg}` };
    positional.push(arg);
  }
  return { flags, positional };
}

function sourceJson(source) {
  return JSON.stringify(source).replace(/</g, '\\u003c');
}

function pageHtml({ source, theme, bundle }) {
  const safeBundle = String(bundle).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>mermaid</title></head>
<body>
<script type="application/json" id="src">${sourceJson(source)}</script>
<script type="application/json" id="theme">${JSON.stringify(theme)}</script>
<pre id="out" hidden></pre>
<script>
${safeBundle}
</script>
<script>
(function () {
  var api = globalThis.__sliccMermaid;
  var src = JSON.parse(document.getElementById('src').textContent);
  var theme = JSON.parse(document.getElementById('theme').textContent);
  function fail(msg) {
    document.getElementById('out').textContent = msg;
    document.body.dataset.ready = 'err';
  }
  if (!api || typeof api.render !== 'function') {
    fail('mermaid bundle did not expose render');
    return;
  }
  try {
    api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme });
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
    return;
  }
  api.render('diagram', src).then(function (res) {
    document.getElementById('out').textContent = res.svg;
    document.body.dataset.ready = 'ok';
  }).catch(function (err) {
    fail(err && (err.str || err.message) ? (err.str || err.message) : String(err));
  });
})();
</script>
</body>
</html>
`;
}

function targetIdFrom(stdout) {
  const match = String(stdout).match(/\(targetId:\s*([^)\s]+)\)/);
  return match ? match[1] : null;
}

// A complete SVG document, or what is wrong with it.
function checkSvg(svg) {
  const text = String(svg || '').trim();
  if (!text.startsWith('<svg') || !text.endsWith('</svg>')) {
    return 'the browser returned no complete SVG';
  }
  return null;
}

module.exports = {
  THEMES,
  RENDER_TIMEOUT_MS,
  awaitRender,
  entrySource,
  parseArgs,
  sourceJson,
  pageHtml,
  targetIdFrom,
  checkSvg,
};
