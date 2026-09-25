// manifest-diff.js — App Manifest diffing utilities shared by slack-ext.jsh.
//
// Deliberately free of `sliccy:*`, `fs`, and `path` so the tst suite can
// import this module in the SLICC test realm (CLAUDE.md §16). All functions
// here are pure: no I/O, no side effects, no process interaction.
//
// Consumed by slack-ext.jsh via:
//   const { isPlainObject, pointerJoin, manifestLeaves, collectSubtree, diffManifests }
//     = require('./manifest-diff.js');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// RFC 6901 escaping, so a pointer printed here can be pasted into any JSON
// pointer tool and matches the pointers apps.manifest.validate returns.
function pointerJoin(base, key) {
  return base + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

// Flatten a manifest to JSON pointer -> value for every LEAF. An array is a leaf
// because the API replaces arrays wholesale; its individual entries are compared
// as a set by diffManifests so that a shrunk array reads as DELETED ENTRIES
// rather than a modified blob.
function manifestLeaves(value, base, out) {
  const acc = out || {};
  const prefix = base || '';
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      manifestLeaves(value[key], pointerJoin(prefix, key), acc);
    }
    if (Object.keys(value).length === 0) acc[prefix] = value;
    return acc;
  }
  acc[prefix] = value;
  return acc;
}

function collectSubtree(target, value, pointer, extra) {
  const leaves = manifestLeaves(value, pointer, {});
  for (const ptr of Object.keys(leaves)) {
    target.push(Object.assign({ pointer: ptr, value: leaves[ptr] }, extra || {}));
  }
}

// Compare a candidate manifest against the live one, leaf field by leaf field.
//
// Deletions are kept in their OWN bucket, never folded into modifications: a
// field that is present live and absent in the candidate is REMOVED by an
// update, and that is the silent-damage case this whole command exists for.
// Array entries are compared as a set for the same reason — bot_events going
// from ["channel_created","team_join"] to ["channel_created"] is a DELETION of
// team_join, not a modification of bot_events.
function diffManifests(live, candidate) {
  const deletions = [];
  const additions = [];
  const modifications = [];

  const walk = (a, b, pointer) => {
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of Object.keys(a)) {
        const ptr = pointerJoin(pointer, key);
        if (!Object.hasOwn(b, key) || b[key] === undefined) {
          collectSubtree(deletions, a[key], ptr);
          continue;
        }
        walk(a[key], b[key], ptr);
      }
      for (const key of Object.keys(b)) {
        if (Object.hasOwn(a, key) && a[key] !== undefined) continue;
        collectSubtree(additions, b[key], pointerJoin(pointer, key));
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const keyOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
      const bKeys = new Set(b.map(keyOf));
      const aKeys = new Set(a.map(keyOf));
      for (const item of a) {
        if (!bKeys.has(keyOf(item))) {
          deletions.push({ pointer: pointer, value: item, entry: true });
        }
      }
      for (const item of b) {
        if (!aKeys.has(keyOf(item))) {
          additions.push({ pointer: pointer, value: item, entry: true });
        }
      }
      return;
    }

    if (isPlainObject(a) !== isPlainObject(b) || Array.isArray(a) !== Array.isArray(b)) {
      modifications.push({ pointer: pointer, from: a, to: b, retyped: true });
      return;
    }

    if (a !== b) modifications.push({ pointer: pointer, from: a, to: b });
  };

  walk(live, candidate, '');

  return {
    deletions: deletions,
    additions: additions,
    modifications: modifications,
    changed: deletions.length + additions.length + modifications.length > 0,
  };
}

module.exports = { isPlainObject, pointerJoin, manifestLeaves, collectSubtree, diffManifests };
