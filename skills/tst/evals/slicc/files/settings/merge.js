// Merge a user's settings over the defaults.
// Nested objects are merged key by key, so overriding theme.color keeps theme.font.
// `undefined` overrides are ignored. The defaults object is never mutated.

export function mergeSettings(defaults, overrides) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
