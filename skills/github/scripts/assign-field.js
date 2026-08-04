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
// unaffected. An empty `[]` appends; a numeric segment addresses an array slot;
// anything else is an object key. The segment *after* a position decides whether
// a missing container is created as an array or an object.
//
// Two rules keep hostile or contradictory `-f` keys from doing damage. Both
// matter because these keys come straight from the command line.
//
//  1. Traversal only ever follows OWN properties, and `__proto__` is written
//     with defineProperty. Without this, `-f '__proto__[x]=1'` walks into
//     `Object.prototype` and pollutes every object in the process.
//  2. On a container-type conflict the body degrades to an object instead of
//     being replaced, so no value is ever silently dropped. Replacing would
//     discard earlier fields, and keeping an array while writing a non-index key
//     is worse still: `JSON.stringify` omits non-index array properties, so the
//     value would disappear from the request body without warning.

const hasOwn = (target, key) => Object.prototype.hasOwnProperty.call(target, key);

// `__proto__` is the one key that resolves to a setter on Object.prototype, so
// it needs defineProperty to land as plain data. Everything else is a normal
// assignment, which keeps array `length` semantics intact.
function setOwn(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value, writable: true, enumerable: true, configurable: true,
    });
    return;
  }
  target[key] = value;
}

// Where an empty `[]` appends: the end of an array, or one past the highest
// integer key of an object that is standing in for one.
function nextIndex(container) {
  if (Array.isArray(container)) return container.length;
  let max = -1;
  for (const key of Object.keys(container)) {
    if (/^\d+$/.test(key)) max = Math.max(max, Number(key));
  }
  return max + 1;
}

function arrayToObject(array) {
  const out = {};
  array.forEach((value, index) => { out[index] = value; });
  return out;
}

function assignField(body, rawKey, value) {
  const match = String(rawKey).match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
  if (!match || !match[2]) {
    setOwn(body, rawKey, value);
    return body;
  }

  const segments = [match[1]];
  for (const bracket of match[2].matchAll(/\[([^[\]]*)\]/g)) segments.push(bracket[1]);

  let cursor = body;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const key = segment === ''
      ? nextIndex(cursor)
      : /^\d+$/.test(segment) ? Number(segment) : segment;

    if (i === segments.length - 1) {
      setOwn(cursor, key, value);
      continue;
    }

    const next = segments[i + 1];
    const wantArray = next === '' || /^\d+$/.test(next);
    const existing = hasOwn(cursor, key) ? cursor[key] : undefined;

    if (existing === null || typeof existing !== 'object') {
      setOwn(cursor, key, wantArray ? [] : {});
    } else if (!wantArray && Array.isArray(existing)) {
      // An index key is about to be written into an array. Keep the values by
      // reshaping to an object rather than letting JSON.stringify drop them.
      setOwn(cursor, key, arrayToObject(existing));
    }
    // wantArray with a plain object already present: keep the object. It holds
    // integer keys losslessly, whereas swapping in an array would discard the
    // non-integer ones.

    cursor = cursor[key];
  }

  return body;
}

module.exports = { assignField };
