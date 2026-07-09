// da-live.jsh — Adobe Document Authoring sheet utility
// Usage: da-live write <path> [--sheet <name>] '<rows-json>'
//        da-live schema <path> [--sheet <name>]
//        da-live recalc <path>

// Runtime bridges: former bare globals are now require('sliccy:<name>') (issue #168).
const cli = require('sliccy:cli');
const c = require('sliccy:color'); // former bare `c` color global
const fs = require('fs'); // plain node-ish builtin, not a sliccy: module

const { positional, flags } = process.argv.parseFlags();
const [cmd, filePath, rowsArg] = positional;

function deriveSchema(data) {
  if (!data || data.length === 0) return null;
  return Object.keys(data[0]);
}

function validateRows(rows, schema, sheetName) {
  const label = sheetName ? `sheet "${sheetName}"` : 'sheet';
  const schemaSet = new Set(schema);
  for (let i = 0; i < rows.length; i++) {
    const rowKeys = Object.keys(rows[i]);
    const missing = schema.filter(k => !rowKeys.includes(k));
    const extra = rowKeys.filter(k => !schemaSet.has(k));
    if (missing.length || extra.length) {
      const parts = [];
      if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
      if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
      cli.die(`Row ${i} in ${label} is invalid — ${parts.join('; ')}\nExpected keys: ${schema.join(', ')}`);
    }
  }
}

function setDerived(sheetObj) {
  sheetObj.total = sheetObj.data.length;
  sheetObj.limit = sheetObj.data.length;
  sheetObj.offset = 0;
}

const HELP = `
da-live — Adobe Document Authoring sheet utility

Usage: da-live <command> [args]

Commands:
  write <path> '<rows-json>'                   Write rows to a single-sheet file
  write <path> --sheet <name> '<rows-json>'    Write rows to one sheet in a multi-sheet file
  schema <path> [--sheet <name>]               Print the expected row keys for a sheet
  recalc <path>                                Recalculate total/limit/offset in place

Notes:
  Rows must exactly match the existing schema (same keys, no extras, no omissions).
  The sheet must have at least one existing row to derive the schema from.
  write reads → validates → recalculates → writes in a single operation.
`.trim();

if (!cmd || cmd === 'help' || cmd === '--help') {
  cli.help(HELP);
}

if (cmd === 'write') {
  if (!filePath || !rowsArg) cli.die('Usage: da-live write <path> [--sheet <name>] \'<rows-json>\'');

  let newRows;
  try {
    newRows = JSON.parse(rowsArg);
  } catch (e) {
    cli.die(`Invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(newRows)) cli.die('Rows must be a JSON array.');

  const raw = await fs.readFile(filePath);
  const sheet = JSON.parse(raw);
  const sheetName = flags.sheet;

  if (sheet[':type'] === 'multi-sheet') {
    if (!sheetName) cli.die(`Multi-sheet file — specify which sheet with --sheet\nAvailable: ${sheet[':names'].join(', ')}`);
    if (!sheet[':names'].includes(sheetName)) cli.die(`Sheet "${sheetName}" not found\nAvailable: ${sheet[':names'].join(', ')}`);

    const schema = deriveSchema(sheet[sheetName].data);
    if (!schema) cli.die(`Sheet "${sheetName}" has no existing rows — cannot derive schema for validation.`);
    validateRows(newRows, schema, sheetName);

    sheet[sheetName].data = newRows;
    for (const name of sheet[':names']) setDerived(sheet[name]);
  } else {
    if (sheetName) cli.die('--sheet is only valid for multi-sheet files.');

    const schema = deriveSchema(sheet.data);
    if (!schema) cli.die('Sheet has no existing rows — cannot derive schema for validation.');
    validateRows(newRows, schema);

    sheet.data = newRows;
    setDerived(sheet);
  }

  await fs.writeFile(filePath, JSON.stringify(sheet, null, 2));
  console.log(c.green('✓') + ` Wrote ${newRows.length} row(s) to ${filePath}${sheetName ? ` (sheet: ${sheetName})` : ''}`);

} else if (cmd === 'schema') {
  if (!filePath) cli.die('Usage: da-live schema <path> [--sheet <name>]');

  const raw = await fs.readFile(filePath);
  const sheet = JSON.parse(raw);
  const sheetName = flags.sheet;

  if (sheet[':type'] === 'multi-sheet') {
    const names = sheetName ? [sheetName] : sheet[':names'];
    for (const name of names) {
      if (!sheet[':names'].includes(name)) cli.die(`Sheet "${name}" not found\nAvailable: ${sheet[':names'].join(', ')}`);
      const schema = deriveSchema(sheet[name].data);
      console.log(`${c.bold(name)}: ${schema ? schema.join(', ') : c.dim('(no rows)')}`);
    }
  } else {
    const schema = deriveSchema(sheet.data);
    console.log(`keys: ${schema ? schema.join(', ') : c.dim('(no rows)')}`);
  }

} else if (cmd === 'recalc') {
  if (!filePath) cli.die('Usage: da-live recalc <path>');

  const raw = await fs.readFile(filePath);
  const sheet = JSON.parse(raw);

  if (sheet[':type'] === 'multi-sheet') {
    for (const name of sheet[':names']) setDerived(sheet[name]);
    console.log(`Updated ${sheet[':names'].length} sheet(s): ${sheet[':names'].join(', ')}`);
  } else {
    setDerived(sheet);
    console.log(`Updated total/limit: ${sheet.total}`);
  }

  await fs.writeFile(filePath, JSON.stringify(sheet, null, 2));
  console.log(c.green('✓') + ' ' + filePath);

} else {
  cli.die(`Unknown command: ${cmd}\nRun "da-live help" for usage.`);
}
