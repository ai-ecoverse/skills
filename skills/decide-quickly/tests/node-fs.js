// node-fs.js — an in-memory fs with Node's semantics, for tests of scripts that
// must run on slicc-jsh (SLICC 7) as well as SLICC 6 (ai-ecoverse/skills#487).
// Like Node: the callback forms throw without a callback ("cb" must be a
// function), there is no readFileBinary / writeFileBinary / exists / readDir /
// fetchToFile, promises.readFile without an encoding gives bytes, and stat()
// answers isFile()/isDirectory() as methods. A script still on SLICC 6's promise
// dialect fails against it exactly as it fails on slicc-jsh.

function cbError() {
  return Object.assign(
    new TypeError('The "cb" argument must be of type function. Received undefined'),
    {
      code: 'ERR_INVALID_ARG_TYPE',
    }
  );
}

function enoent(syscall, p) {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), {
    code: 'ENOENT',
  });
}

function bytesOf(v) {
  return typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v);
}

export function nodeFs(files = {}) {
  const vfs = {};
  for (const [k, v] of Object.entries(files)) vfs[k] = bytesOf(v);
  const isDir = (p) => Object.keys(vfs).some((k) => k.startsWith(`${p.replace(/\/$/, '')}/`));
  const callbackOnly = (...a) => {
    if (typeof a[a.length - 1] !== 'function') throw cbError();
    throw new Error('callback forms are not implemented in this fake');
  };
  const text = (b, enc) => (enc ? new TextDecoder().decode(b) : Buffer.from(b));
  const encOf = (o) => (typeof o === 'string' ? o : o && o.encoding) || null;
  const stat = (p) => {
    if (p in vfs)
      return { isFile: () => true, isDirectory: () => false, size: vfs[p].length, mtimeMs: 0 };
    if (isDir(p)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
    throw enoent('stat', p);
  };
  const readdir = (d) => {
    const base = d.replace(/\/$/, '');
    const names = new Set(
      Object.keys(vfs)
        .filter((k) => k.startsWith(`${base}/`))
        .map((k) => k.slice(base.length + 1).split('/')[0])
    );
    if (!names.size) throw enoent('scandir', d);
    return [...names].sort();
  };
  const rm = (p, o = {}) => {
    if (p in vfs) {
      delete vfs[p];
      return;
    }
    if (isDir(p)) {
      if (!o.recursive) throw Object.assign(new Error(`EISDIR: ${p}`), { code: 'ERR_FS_EISDIR' });
      for (const k of Object.keys(vfs)) if (k.startsWith(`${p}/`)) delete vfs[k];
      return;
    }
    if (!o.force) throw enoent('rm', p);
  };
  return {
    files: vfs,
    text: (p) => (p in vfs ? new TextDecoder().decode(vfs[p]) : undefined),
    readFile: callbackOnly,
    writeFile: callbackOnly,
    appendFile: callbackOnly,
    exists: callbackOnly,
    mkdir: callbackOnly,
    stat: callbackOnly,
    readdir: callbackOnly,
    rm: callbackOnly,
    unlink: callbackOnly,
    existsSync: (p) => p in vfs || isDir(p),
    readFileSync: (p, o) => {
      if (!(p in vfs)) throw enoent('open', p);
      return text(vfs[p], encOf(o));
    },
    writeFileSync: (p, d) => {
      vfs[p] = bytesOf(d);
    },
    mkdirSync: () => {},
    statSync: stat,
    readdirSync: readdir,
    rmSync: rm,
    promises: {
      readFile: async (p, o) => {
        if (!(p in vfs)) throw enoent('open', p);
        return text(vfs[p], encOf(o));
      },
      writeFile: async (p, d) => {
        vfs[p] = bytesOf(d);
      },
      appendFile: async (p, d) => {
        const old = vfs[p] || new Uint8Array();
        const add = bytesOf(d);
        const both = new Uint8Array(old.length + add.length);
        both.set(old);
        both.set(add, old.length);
        vfs[p] = both;
      },
      mkdir: async () => {},
      stat: async (p) => stat(p),
      readdir: async (d) => readdir(d),
      rm: async (p, o) => rm(p, o),
      unlink: async (p) => rm(p),
      rename: async (a, b) => {
        if (!(a in vfs)) throw enoent('rename', a);
        vfs[b] = vfs[a];
        delete vfs[a];
      },
    },
  };
}
