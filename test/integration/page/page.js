import { createKernel, fetchTransport } from '/kernel/index.js';

async function walk(path) {
  let dir = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

const encoded = (path) => path.split('/').map(encodeURIComponent).join('/');

window.installTree = async (from, to, names) => {
  let next = 0;
  const copy = async () => {
    while (next < names.length) {
      const name = names[next++];
      const response = await fetch(`${from}${encoded(name)}`);
      if (!response.ok) throw new Error(`fetching ${from}${name}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const parts = `${to}${name}`.split('/');
      const base = parts.pop();
      const handle = await (await walk(parts.join('/'))).getFileHandle(base, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }
  };
  await Promise.all(Array.from({ length: 8 }, copy));
  return names.length;
};

window.boot = async ({ append = [] } = {}) => {
  window.kernel = await createKernel({
    root: await navigator.storage.getDirectory(),
    network: { transport: fetchTransport() },
    ...(append.length ? { commands: { append } } : {}),
  });
  return true;
};

window.run = (argv, options) => window.kernel.run(argv, options);
