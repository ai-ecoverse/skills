// Re-embed the THREAD-STAGE block of thread-stage-shared.cjs into the panel,
// indented six spaces, replacing the previous copy. Run after editing the
// module; tests/thread-stage-drift.test.js D1 fails until you do.
//   node embed-thread-stage.js [module.cjs] [panel.shtml]
const fs = require('fs');
const dir = __dirname;
const modPath = process.argv[2] || `${dir}/thread-stage-shared.cjs`;
const panelPath = process.argv[3] || `${dir}/github-dashboard.shtml`;
const START = '/* ---- 8< THREAD-STAGE';
const END = '/* ---- >8 end THREAD-STAGE';
const m = fs.readFileSync(modPath, 'utf8');
const a = m.indexOf(START);
const b = m.indexOf(END);
if (a < 0 || b < a) throw new Error(`${modPath}: no THREAD-STAGE block`);
const block = m.slice(a, m.indexOf('\n', b));
const indented = block.split('\n').map((l) => (l ? '      ' + l : l)).join('\n');
const p = fs.readFileSync(panelPath, 'utf8');
const pa = p.indexOf('      ' + START);
if (pa < 0) throw new Error(`${panelPath}: no embedded THREAD-STAGE block to replace`);
const pb = p.indexOf('\n', p.indexOf(END, pa));
fs.writeFileSync(panelPath, p.slice(0, pa) + indented + p.slice(pb));
console.log(`re-embedded ${block.split('\n').length} lines into ${panelPath}`);
