// Expand upstream-style bracket notation in `gh api -f` keys into a nested
// request body, so `-f 'tree[0][path]=x' -f 'parents[]=sha'` builds
// `{ tree: [{ path: 'x' }], parents: ['sha'] }` rather than storing the
// bracketed key literally.
//
// references/gotchas.md documents this syntax as the way to commit a
// mode-120000 symlink through the Git Data API, but the `-f` parser used to keep
// `tree[0][path]` as a flat key, so GitHub answered "Invalid tree info".
//
// Keys with no brackets are assigned verbatim, so existing callers are
// unaffected. An empty `[]` appends to an array; a numeric segment addresses an
// array slot; anything else is an object key. The segment *after* a position
// decides whether the container is created as an array or an object.
function assignField(body, rawKey, value) {
  const match = String(rawKey).match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
  if (!match || !match[2]) {
    body[rawKey] = value;
    return body;
  }

  const segments = [match[1]];
  for (const bracket of match[2].matchAll(/\[([^[\]]*)\]/g)) segments.push(bracket[1]);

  let cursor = body;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    const key = segment === ''
      ? (Array.isArray(cursor) ? cursor.length : 0)
      : /^\d+$/.test(segment) ? Number(segment) : segment;

    if (isLast) {
      cursor[key] = value;
      continue;
    }

    const next = segments[i + 1];
    const nextIsIndex = next === '' || /^\d+$/.test(next);
    if (cursor[key] === null || typeof cursor[key] !== 'object') {
      cursor[key] = nextIsIndex ? [] : {};
    }
    cursor = cursor[key];
  }

  return body;
}

module.exports = { assignField };
