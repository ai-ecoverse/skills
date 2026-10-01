// Shape a CLI-supplied string into what the Jira REST API accepts for that field.
//
// Fields with a closed set of allowed values — security level, single-select custom fields
// such as Team, versions — reject a bare string with "Could not find valid 'id' or 'value'",
// so a name the user typed has to be resolved against createmeta and sent as {id}. Fields
// without allowedValues are left exactly as supplied.
//
// An unmatched name is returned unchanged on purpose: Jira then reports it, which is far
// easier to act on than a value that was silently dropped.
function coerceFieldValue(rawFields, id, v) {
  if (typeof v !== 'string') return v;
  const allowed = rawFields?.[id]?.allowedValues;
  if (!Array.isArray(allowed) || allowed.length === 0) return v;
  const want = v.trim().toLowerCase();
  const hit = allowed.find((a) => [a.name, a.value, a.id]
    .some((cand) => typeof cand === 'string' && cand.toLowerCase() === want));
  if (!hit) return v;
  if (hit.id) return { id: String(hit.id) };
  return hit.value !== undefined ? { value: hit.value } : { name: hit.name };
}

module.exports = { coerceFieldValue };
