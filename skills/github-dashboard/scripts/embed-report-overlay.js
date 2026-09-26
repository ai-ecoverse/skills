// Re-embed the REPORT-OVERLAY block of report-overlay-shared.cjs into the
// panel, indented six spaces, replacing the previous copy. Run after editing
// the module; tests/report-overlay.test.js R0 fails until you do.
//   node embed-report-overlay.js [module.cjs] [panel.shtml]
const fs = require('fs');
const dir = __dirname;
const modPath = process.argv[2] || `${dir}/report-overlay-shared.cjs`;
// Deployed layout (panel beside this script) first, then the skill repository's.
const panelPath =
  process.argv[3] ||
  [`${dir}/github-dashboard.shtml`, `${dir}/../assets/sprinkle/github-dashboard.shtml`].find((f) =>
    fs.existsSync(f)
  );
const START = '/* ---- 8< REPORT-OVERLAY';
const END = '/* ---- >8 end REPORT-OVERLAY';
const m = fs.readFileSync(modPath, 'utf8');
const a = m.indexOf(START);
const b = m.indexOf(END);
if (a < 0 || b < a) throw new Error(`${modPath}: no REPORT-OVERLAY block`);
const block = m.slice(a, m.indexOf('\n', b));
const indented = block
  .split('\n')
  .map((l) => (l ? `      ${l}` : l))
  .join('\n');
const p = fs.readFileSync(panelPath, 'utf8');
const pa = p.indexOf(`      ${START}`);
if (pa < 0) throw new Error(`${panelPath}: no embedded REPORT-OVERLAY block to replace`);
const pb = p.indexOf('\n', p.indexOf(END, pa));
fs.writeFileSync(panelPath, p.slice(0, pa) + indented + p.slice(pb));
console.log(`re-embedded ${block.split('\n').length} lines into ${panelPath}`);
