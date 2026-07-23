// xlsx.src.js — SOURCE for the xlsx skill CLI (non-bundled).
//
// This file requires the SheetJS `xlsx` package as a bare specifier. It is
// bundled by scripts/build.mjs (esbuild) into the sibling `xlsx.jsh`, which
// rolls SheetJS + its sub-deps in-line so the shipped skill needs no install.
//
// Runtime notes:
//  • `require('fs')` resolves to Node's fs during a local `node xlsx.src.js`
//    run, and to the SLICC jsh VFS bridge (which exposes sync fs methods:
//    readFileSync/writeFileSync/existsSync/...) when run as `xlsx.jsh`. Both
//    surfaces are used identically. esbuild keeps `require('fs')` external.
//  • All spreadsheet I/O goes through in-memory buffers — SheetJS never touches
//    fs itself (we pass {type:'buffer'}), so no path-based readFile/writeFile
//    code path fires and there is no async-bridge mismatch.
//  • This entry deliberately avoids `sliccy:*` modules so the esbuild CLI
//    (which cannot mark them external — ai-ecoverse/slicc#1632) bundles cleanly.

const XLSX = require('xlsx');
const fs = require('fs');

// ---- tiny ANSI (self-contained; no sliccy:color to keep the bundle clean) ---
const TTY = !process.env.NO_COLOR && process.stdout && process.stdout.isTTY;
const c = (n) => (s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), green = c(32), cyan = c(36), yellow = c(33);

function die(msg, code = 1) {
  process.stderr.write(red('Error:') + ' ' + msg + '\n');
  process.exit(code);
}

const HELP = `${bold('xlsx')} — read, edit, and create spreadsheets (.xlsx/.xls/.csv/.tsv) in SLICC

${bold('USAGE')}
  xlsx <command> [args] [flags]

${bold('COMMANDS')}
  info   <file>                         Sheet names, dimensions, and format
  read   <file> [flags]                 Print a sheet as CSV (default), TSV, or JSON
  to-csv <file> [flags]                 Alias for: read --csv
  to-json <file> [flags]                Alias for: read --json
  create <out.xlsx> --data <src> [flags]  Build a new workbook from JSON/CSV data
  set-cell <file> <A1> <value> [flags]  Set one cell in place, preserving the rest
  add-sheet <file> <name> --data <src> [flags]  Append a sheet from JSON/CSV data

${bold('READ / TO-* FLAGS')}
  --sheet <name|index>   Target sheet (name or 0-based index; default: first)
  --csv                  Output CSV (default)
  --tsv                  Output TSV
  --json                 Output JSON (array of row-objects using the header row)
  --range <A1:D9>        Limit to a cell range
  --raw                  For --json, array-of-arrays instead of row-objects

${bold('DATA SOURCE (--data)')}
  @path.json   Read JSON from a file        @path.csv   Read CSV from a file
  '<json>'     Inline JSON string
  JSON may be an array-of-arrays ([["Name","Value"],["foo",42]]) or an
  array-of-objects ([{"Name":"foo","Value":42}]).

${bold('CREATE / ADD-SHEET / SET-CELL FLAGS')}
  --sheet <name>         Sheet name (create/add-sheet: default "Sheet1")
  --number               set-cell: coerce value to a number
  --bool                 set-cell: coerce value to a boolean
  --formula              set-cell: treat value as a formula (leading = optional)

${bold('EXAMPLES')}
  xlsx info report.xlsx
  xlsx read report.xlsx --sheet Sales --json
  xlsx read report.xlsx --range A1:C10 --tsv
  xlsx create out.xlsx --data '[["Name","Value"],["foo",42],["bar",100]]'
  xlsx create out.xlsx --data @rows.csv --sheet Data
  xlsx set-cell report.xlsx B2 99 --number
  xlsx set-cell report.xlsx C2 '=SUM(B2:B10)' --formula
  xlsx add-sheet report.xlsx Summary --data @summary.json
`;

// ---------------------------------------------------------------- helpers ----
function readWorkbook(file) {
  if (!file) die('a file argument is required');
  if (!fs.existsSync(file)) die(`no such file: ${file}`);
  return XLSX.read(fs.readFileSync(file), { type: 'buffer', cellFormula: true, cellNF: true });
}

function writeWorkbook(wb, out) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: bookTypeFor(out) });
  fs.writeFileSync(out, Buffer.from(buf));
}

function bookTypeFor(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'xls') return 'biff8';
  if (ext === 'csv') return 'csv';
  if (ext === 'txt' || ext === 'tsv') return 'txt';
  return 'xlsx';
}

function pickSheet(wb, sel) {
  if (sel === undefined || sel === null || sel === '') return wb.SheetNames[0];
  if (/^\d+$/.test(String(sel))) {
    const i = Number(sel);
    if (i < 0 || i >= wb.SheetNames.length) die(`sheet index ${i} out of range (0..${wb.SheetNames.length - 1})`);
    return wb.SheetNames[i];
  }
  if (!wb.SheetNames.includes(sel)) die(`no sheet named "${sel}" (have: ${wb.SheetNames.join(', ')})`);
  return sel;
}

// Parse --data into an array-of-arrays (aoa) suitable for aoa_to_sheet.
function loadData(spec) {
  if (!spec) die('--data is required (JSON, @file.json, or @file.csv)');
  let text = spec, isCsv = false;
  if (spec.startsWith('@')) {
    const path = spec.slice(1);
    if (!fs.existsSync(path)) die(`no such data file: ${path}`);
    text = fs.readFileSync(path, 'utf8');
    isCsv = /\.(csv|tsv|txt)$/i.test(path);
  }
  if (isCsv) {
    const delim = /\.tsv$/i.test(spec) ? '\t' : ',';
    const sheet = XLSX.read(text, { type: 'string', FS: delim }).Sheets.Sheet1;
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { die(`--data is not valid JSON: ${e.message}`); }
  if (!Array.isArray(json)) die('--data JSON must be an array (of arrays or of objects)');
  if (json.length === 0) return [];
  if (Array.isArray(json[0])) return json; // already aoa
  // array-of-objects -> aoa with a header row from the union of keys
  const keys = [];
  for (const row of json) for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
  return [keys, ...json.map((r) => keys.map((k) => (r[k] === undefined ? null : r[k])))];
}

function sheetToOutput(ws, flags) {
  // SheetJS ignores the string `range` option in sheet_to_csv/json, so scope the
  // view by temporarily overriding `!ref` (limits both rows AND columns), then
  // restore it. `withRange` runs `fn` against the (possibly) re-scoped sheet.
  const withRange = (fn) => {
    if (!flags.range) return fn();
    const saved = ws['!ref'];
    try { ws['!ref'] = flags.range; return fn(); }
    finally { ws['!ref'] = saved; }
  };
  if (flags.json) {
    return withRange(() => {
      const rows = flags.raw
        ? XLSX.utils.sheet_to_json(ws, { header: 1 })
        : XLSX.utils.sheet_to_json(ws);
      return JSON.stringify(rows, null, 2);
    });
  }
  if (flags.tsv) return withRange(() => XLSX.utils.sheet_to_csv(ws, { FS: '\t' }));
  return withRange(() => XLSX.utils.sheet_to_csv(ws));
}

// ------------------------------------------------------------------ commands --
function cmdInfo(file) {
  const wb = readWorkbook(file);
  process.stdout.write(bold(file) + '\n');
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'] || '(empty)';
    let rows = 0, cols = 0;
    if (ws['!ref']) {
      const r = XLSX.utils.decode_range(ws['!ref']);
      rows = r.e.r - r.s.r + 1; cols = r.e.c - r.s.c + 1;
    }
    process.stdout.write(`  ${cyan(name)}  ${dim(`${rows}×${cols}`)}  ${dim('range ' + ref)}\n`);
  }
}

function cmdRead(file, flags) {
  const wb = readWorkbook(file);
  const ws = wb.Sheets[pickSheet(wb, flags.sheet)];
  process.stdout.write(sheetToOutput(ws, flags).replace(/\n$/, '') + '\n');
}

function cmdCreate(out, flags) {
  if (!out) die('an output filename is required: xlsx create <out.xlsx> --data <src>');
  const aoa = loadData(flags.data);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, flags.sheet || 'Sheet1');
  writeWorkbook(wb, out);
  process.stdout.write(green('✓') + ` wrote ${out} (${aoa.length} row${aoa.length === 1 ? '' : 's'})\n`);
}

function cmdAddSheet(file, name, flags) {
  if (!name) die('a sheet name is required: xlsx add-sheet <file> <name> --data <src>');
  const wb = readWorkbook(file);
  if (wb.SheetNames.includes(name)) die(`sheet "${name}" already exists`);
  const ws = XLSX.utils.aoa_to_sheet(loadData(flags.data));
  XLSX.utils.book_append_sheet(wb, ws, name);
  writeWorkbook(wb, file);
  process.stdout.write(green('✓') + ` added sheet "${name}" to ${file}\n`);
}

function cmdSetCell(file, addr, value, flags) {
  if (!addr) die('a cell address is required: xlsx set-cell <file> <A1> <value>');
  if (value === undefined) die('a value is required: xlsx set-cell <file> <A1> <value>');
  if (!/^[A-Za-z]+\d+$/.test(addr)) die(`"${addr}" is not a valid cell address (e.g. B2)`);
  const wb = readWorkbook(file);
  const name = pickSheet(wb, flags.sheet);
  const ws = wb.Sheets[name];
  const A1 = addr.toUpperCase();
  let cell;
  if (flags.formula) {
    // Cache a placeholder value (v:0): SheetJS's reader DROPS formula cells that
    // have <f> but no cached <v>, so without this the formula is lost on the next
    // read→write. The spreadsheet app recomputes the real value when it opens.
    cell = { t: 'n', f: String(value).replace(/^=/, ''), v: 0 };
  } else if (flags.number) {
    const n = Number(value);
    if (Number.isNaN(n)) die(`--number given but "${value}" is not numeric`);
    cell = { t: 'n', v: n };
  } else if (flags.bool) {
    cell = { t: 'b', v: /^(true|1|yes)$/i.test(String(value)) };
  } else if (typeof value !== 'string' || value === '' ? false : !Number.isNaN(Number(value)) && /^-?\d/.test(value)) {
    cell = { t: 'n', v: Number(value) };
  } else {
    cell = { t: 's', v: String(value) };
  }
  ws[A1] = cell;
  // widen !ref if the edited cell is outside the current used range
  const rng = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  const cc = XLSX.utils.decode_cell(A1);
  rng.s.r = Math.min(rng.s.r, cc.r); rng.s.c = Math.min(rng.s.c, cc.c);
  rng.e.r = Math.max(rng.e.r, cc.r); rng.e.c = Math.max(rng.e.c, cc.c);
  ws['!ref'] = XLSX.utils.encode_range(rng);
  writeWorkbook(wb, file);
  process.stdout.write(green('✓') + ` set ${name}!${A1} in ${file}\n`);
}

// --------------------------------------------------------------------- main ---
function main() {
  const { positional, flags } = process.argv.parseFlags
    ? process.argv.parseFlags()
    : fallbackParse(process.argv.slice(2));
  const [cmd] = positional;
  if (!cmd || flags.help || flags.h || cmd === 'help') { process.stdout.write(HELP); return; }
  switch (cmd) {
    case 'info': return cmdInfo(positional[1]);
    case 'read': return cmdRead(positional[1], flags);
    case 'to-csv': return cmdRead(positional[1], { ...flags, json: false, tsv: false });
    case 'to-json': return cmdRead(positional[1], { ...flags, json: true });
    case 'create': return cmdCreate(positional[1], flags);
    case 'add-sheet': return cmdAddSheet(positional[1], positional[2], flags);
    case 'set-cell': return cmdSetCell(positional[1], positional[2], positional[3], flags);
    default: die(`unknown command "${cmd}" (run \`xlsx help\`)`);
  }
}

// Minimal parseFlags shim for plain `node xlsx.src.js` runs (jsh provides its own).
function fallbackParse(argv) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { flags[a.slice(2)] = argv[++i]; }
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

main();
