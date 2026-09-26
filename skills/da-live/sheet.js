// Pure sheet helpers for da-live.jsh. Kept free of sliccy:/fs so tst can import them.

function deriveSchema(data) {
  if (!data || data.length === 0) return null;
  return Object.keys(data[0]);
}

function firstRowError(rows, schema, sheetName) {
  const label = sheetName ? `sheet "${sheetName}"` : 'sheet';
  const schemaSet = new Set(schema);
  for (let i = 0; i < rows.length; i++) {
    const rowKeys = Object.keys(rows[i]);
    const missing = schema.filter((k) => !rowKeys.includes(k));
    const extra = rowKeys.filter((k) => !schemaSet.has(k));
    if (missing.length || extra.length) {
      const parts = [];
      if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
      if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
      return `Row ${i} in ${label} is invalid — ${parts.join('; ')}\nExpected keys: ${schema.join(', ')}`;
    }
  }
  return null;
}

function setDerived(sheetObj) {
  sheetObj.total = sheetObj.data.length;
  sheetObj.limit = sheetObj.data.length;
  sheetObj.offset = 0;
  return sheetObj;
}

module.exports = { deriveSchema, firstRowError, setDerived };
