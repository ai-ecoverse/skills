// extract.js — run functions cut out of a shipped .jsh, for tests.
// load(source, names, scope): every free name the functions use resolves
// through `scope`; anything scope lacks resolves to a global. Assignments to
// free names land in `scope`, so module-level `let` state can be seeded.

export function load(source, names, scope) {
  const body = names
    .map((name) => {
      const sig = new RegExp(`^[ \\t]*(async )?function ${name}\\(`, 'm').exec(source);
      if (!sig) throw new Error(`not found: ${name}`);
      const indent = /^[ \t]*/.exec(sig[0])[0];
      const end = source.indexOf(`\n${indent}}\n`, sig.index);
      return source.slice(sig.index, end + indent.length + 2);
    })
    .join('\n');
  const proxy = new Proxy(scope, {
    has: (t, k) => k in t || !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return new Function('scope', `with (scope) { ${body}\nreturn { ${names.join(', ')} }; }`)(proxy);
}

export function exitStub() {
  const dies = [];
  return {
    dies,
    die: (m) => {
      dies.push(String(m));
      throw Object.assign(new Error(String(m)), { name: 'NodeExitError' });
    },
  };
}
