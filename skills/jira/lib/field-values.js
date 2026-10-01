// Shape a CLI-supplied string into what the Jira REST API accepts for that field.
//
// Fields with a closed set of allowed values — security level, single-select custom fields
// such as Team, versions, components — reject a bare string with "Could not find valid 'id'
// or 'value'", so a name the user typed has to be resolved against createmeta and sent as an
// object. Fields without allowedValues are left exactly as supplied.
//
// Two wire shapes matter, and createmeta says which one a field takes:
//
//   schema.type !== 'array'  ->  { id: '11900' }      (securitylevel, option, priority, …)
//   schema.type === 'array'  ->  [{ id: '95319' }]    (components, fixVersions, multi-selects)
//
// Jira requires the array form even for a single selection, so an array-typed field given one
// value still has to be wrapped. Array-typed fields accept several values comma-separated,
// matching how --labels and --components already behave.
//
// An unmatched name is returned unchanged on purpose: Jira then reports it, which is far
// easier to act on than a value that was silently dropped. For an array-typed field that
// applies to the whole string — resolving some names and passing others through would send a
// mixed-shape array that Jira rejects with a far more confusing message.

function matchAllowedValue(allowed, want) {
  const needle = want.trim().toLowerCase();
  return allowed.find((a) => [a.name, a.value, a.id]
    .some((cand) => typeof cand === 'string' && cand.toLowerCase() === needle));
}

function toWireShape(option) {
  if (option.id) return { id: String(option.id) };
  return option.value !== undefined ? { value: option.value } : { name: option.name };
}

function coerceFieldValue(rawFields, id, v) {
  if (typeof v !== 'string') return v;
  const meta = rawFields?.[id];
  const allowed = meta?.allowedValues;
  if (!Array.isArray(allowed) || allowed.length === 0) return v;

  if (meta?.schema?.type === 'array') {
    const wants = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (wants.length === 0) return v;
    const hits = wants.map((want) => matchAllowedValue(allowed, want));
    if (hits.some((hit) => !hit)) return v;
    return hits.map(toWireShape);
  }

  const hit = matchAllowedValue(allowed, v);
  return hit ? toWireShape(hit) : v;
}

module.exports = { coerceFieldValue };
