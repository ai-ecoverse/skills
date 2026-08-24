# Licensing

| Component | License | Notes |
|-----------|---------|-------|
| [pandoc-wasm](https://github.com/pandoc/pandoc-wasm) | GPL-2.0-or-later | WASM build of Pandoc; GPL applies when distributing modified binaries or combined works. |
| [typst-wasm](https://github.com/Myriad-Dreamin/typst.ts) | MIT | PDF backend used by `pandoc pdf` and `pandoc typst compile`. |
| [@typst-wasm/fonts](https://www.npmjs.com/package/@typst-wasm/fonts) | Check package metadata | Bundled Libertinus / New Computer Modern fonts for typst-wasm. |
| [source-serif](https://www.npmjs.com/package/source-serif) / [source-sans](https://www.npmjs.com/package/source-sans) / [source-code-pro](https://www.npmjs.com/package/source-code-pro) | OFL-1.1 | Official Adobe `adobe-fonts/source-*#release` trees. Optional extra OTF for U+2E3A. Not installed by default. |

`pandoc-core.cjs` in this skill is an esbuild bundle of `pandoc-wasm/src/core.js` (GPL-2.0-or-later). Runtime installs `pandoc-wasm@1.1.0` for the `pandoc.wasm` binary.
