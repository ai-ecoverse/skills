// Pure helpers for mermaid.jsh. No sliccy: imports, so node --test can load it.

const THEMES = ['default', 'neutral', 'dark', 'forest', 'base'];

// One expression. playwright-cli eval prints it and appends a newline.
const POLL_EXPR =
  '(() => { const r = (document.body && document.body.dataset && document.body.dataset.ready) || ""; if (!r) return "PENDING"; const t = document.getElementById("out"); return r + "\\n" + (t ? t.textContent : ""); })()';

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

function splitRenderResult(stdout) {
  let text = String(stdout);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text === 'PENDING') return { pending: true };
  const nl = text.indexOf('\n');
  if (nl < 0) return { error: text || 'empty render result' };
  const status = text.slice(0, nl);
  const body = text.slice(nl + 1);
  if (status === 'ok') return { svg: body };
  if (status === 'err') return { error: body || 'render failed' };
  return { error: `unexpected render status: ${status}` };
}

module.exports = {
  THEMES,
  POLL_EXPR,
  parseArgs,
  sourceJson,
  pageHtml,
  targetIdFrom,
  splitRenderResult,
};
