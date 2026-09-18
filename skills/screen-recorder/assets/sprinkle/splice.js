// Splice src/bundle.js into recording-setup.shtml between the generated markers.
// Run via build.sh; not meant to be called directly.
const fs = require('fs');

const DIR = '/shared/sprinkles/recording-setup';
const SHTML = DIR + '/recording-setup.shtml';
const BUNDLE = DIR + '/src/bundle.js';

const BEGIN = '    <!-- BEGIN GENERATED BUNDLE -- do not edit; run build.sh -->';
const END = '    <!-- END GENERATED BUNDLE -->';

const bundle = fs.readFileSync(BUNDLE, 'utf8').trimEnd();
let shtml = fs.readFileSync(SHTML, 'utf8');

const block =
  BEGIN +
  '\n' +
  '    <!-- Built from src/entry.js by build.sh (esbuild --bundle --format=iife).\n' +
  '         Bundles chunk-flusher.js IN PLACE from\n' +
  '         /workspace/skills/interview-me/assets/sprinkle/lib/chunk-flusher.js\n' +
  '         (not copied, not edited). Exposes window.__rec.\n' +
  '         A full-document sprinkle cannot load external JS -- see\n' +
  '         interview-me/references/sprinkle-module-loading.md. -->\n' +
  '    <script>\n' +
  bundle +
  '\n    </script>\n' +
  END;

if (shtml.includes('@@FLUSHER_BUNDLE@@')) {
  shtml = shtml.replace('@@FLUSHER_BUNDLE@@', block);
} else {
  const i = shtml.indexOf(BEGIN);
  const j = shtml.indexOf(END);
  if (i < 0 || j < 0) {
    console.error('splice: no @@FLUSHER_BUNDLE@@ placeholder and no existing markers');
    process.exit(1);
  }
  shtml = shtml.slice(0, i) + block + shtml.slice(j + END.length);
}

fs.writeFileSync(SHTML, shtml);
console.log('spliced bundle into recording-setup.shtml (' + bundle.length + ' bytes of JS)');
