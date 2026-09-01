# Running arbitrary WebAssembly from a SLICC skill

Nothing in SLICC has to change for a skill to ship a WASM runtime. There are two
loading patterns; which one you need is decided entirely by the shape of the
package, not by how big or how exotic the wasm is.

| The payload is… | Load it like | Reference skill |
|---|---|---|
| One `.wasm` file plus JS glue you can pre-bundle to CJS | **Raw bytes** — `fs.readFileBinary` + `WebAssembly.compile` | `pandoc` |
| A multi-file ESM distribution with relative imports, module workers, or `import.meta.url`-relative assets | **Preview service worker** — import the entry at `/preview/<vfs-path>` | `vpod` |

Both start the same way: the package is installed into the VFS `node_modules`
with `ipk add <pkg>@<version>`, pinned as a source literal in the `.jsh`, with
an install gate that prints the exact `ipk add` line when the package is
missing. Nothing is bundled into the skill and there is no CDN fallback.

## Pattern A — raw bytes (pandoc)

```js
const fs = require('fs');
const bytes = await fs.readFileBinary('/workspace/node_modules/pkg/thing.wasm');
const buf = new ArrayBuffer(bytes.byteLength);
new Uint8Array(buf).set(bytes);
const module = await WebAssembly.compile(buf);
```

The realm also exposes `globalThis.__slicc_compileWasm(path)`, which compiles
straight from a VFS path; treat it as an optimisation and keep the byte path as
a fallback.

This works whenever the JS side can be reduced to a single CommonJS file you
control — pandoc pre-builds `pandoc-core.cjs` from upstream's glue at skill
build time. It stops working the moment the package needs to resolve URLs
relative to itself.

## Pattern B — the preview service worker (vpod)

`@capsule-run/vpod` cannot be loaded any other way. Its entry imports sibling
chunks by relative URL, it spawns `new Worker(url, { type: 'module' })` from a
URL derived off `import.meta.url`, and its jco-transpiled component fetches a
27 MB core wasm relative to itself. Two consequences:

**It cannot be `require`d.** The realm lowers a literal dynamic-import call in a
`.jsh` to `require` (`packages/webapp/src/shell/ipk/resolver.ts`,
`hasDynamicImport`), which would defeat the whole point. Build the call with
`new Function` instead — the specifier then lives in a string, which the
detector's masker skips, so the entry passes through untranspiled:

```js
const importEsm = new Function('url', 'return imp' + 'ort(url);');
```

**It cannot be wrapped in a blob URL** either. Blob URLs are not hierarchical,
so relative chunk imports have nothing to resolve against — the trick that works
for pyodide, ffmpeg and v86 does not apply here.

What does work is the preview service worker, which serves VFS bytes at real,
same-origin, hierarchical URLs with correct MIME types:

```js
const previewUrl = (vfsPath) => `${globalThis.location.origin}/preview${vfsPath}`;
const sdk = await importEsm(previewUrl('/workspace/node_modules/@capsule-run/vpod/dist/index.js'));
```

Relative imports, worker spawning and the wasm fetch then all resolve natively.
This is the same surface pyodide's wheel loader already uses.

## What the `.jsh` realm actually gives you

Probed live on 2026-09-01 against SLICC 6.99.9 (Chrome 152), from inside a
`.jsh`:

| | |
|---|---|
| `location.href` | `<ui-origin>/assets/js-realm-worker-*.js` — **same origin as the leader**, and SW-controlled |
| `Worker`, `new Worker(url, { type: 'module' })` | yes — nested module workers spawn and post back |
| `SharedArrayBuffer`, `Atomics`, `crossOriginIsolated` | yes, on a leader served with `Document-Isolation-Policy` (PR #2039) |
| `WebAssembly`, `WebAssembly.instantiateStreaming` | yes |
| `navigator.storage.getDirectory` | yes — OPFS, which is where big engines cache their blobs |
| `caches`, `URL.createObjectURL`, `fetch` | yes |
| `navigator.serviceWorker` | **no** (workers cannot reach the SW registration API) — but their fetches still go through it |
| a literal dynamic `import(...)` | rewritten to `require` before execution — see above |

## Gotchas that cost real time

- **Keep backticks out of `//` comments in a `.jsh`.** The transpile detector's
  string masker tracks template literals, and a stray backtick in a comment
  desynchronises it — which then mis-detects `import(`/`export` in ordinary code
  and fails the run with "esbuild-wasm is not installed". Verify a script with
  `hasEsmSyntax` / `hasDynamicImport` from `ipk/resolver.ts` before shipping it.
- **The SPA fallback lies.** Fetching a nonexistent same-origin path returns
  `index.html` with a 200, so a bad module URL fails as a confusing parse error
  rather than a 404. Check `content-type` when a load misbehaves.
- **A wasm engine's exec loop may have no host-side deadline.** vpod's
  `_execSliced` spins until the guest reports an exit code; if the guest wedges,
  the realm spins forever and the kernel shell queues behind it. Race every
  call against a host timer (`withDeadline` in `scripts/vpod.jsh`).
- **Give big loads room.** A first-run engine download plus wasm compile can take
  tens of seconds; a warm one is milliseconds. Budget the deadline for the cold
  path and cache aggressively (OPFS, or the VFS).
