---
name: mermaid
description: >
  Render Mermaid diagrams to SVG from the shell. Reads a .mmd file or stdin
  (flowchart, sequence, class, state, er, gantt, mindmap, and the other
  diagram types Mermaid supports) and writes an SVG, using the leader browser
  for layout because Mermaid measures text in a real DOM. Use when the user
  asks to render a mermaid diagram, turn a flowchart into an image, make an
  SVG from a sequence diagram, preview a .mmd file, or says "mermaid",
  "flowchart LR", "sequenceDiagram", or "render this diagram".
allowed-tools: bash
command: mermaid
script: scripts/mermaid.jsh
---

# Mermaid

`mermaid` renders a diagram to SVG. Layout happens in the leader browser,
because Mermaid measures label text with `getBBox`. A DOM shim in the
worker produces a broken picture. The command opens a tab, reads the SVG
back, and closes the tab.

## Install

```bash
ipk add -g mermaid esbuild-wasm
```

`mermaid` is the diagram library. `esbuild-wasm` is the built-in bundler
that turns it into one script the page can run. The first render writes
that bundle to `/shared/cache/mermaid-<version>.iife.js` and reuses it.

## Commands

```bash
mermaid render diagram.mmd -o /shared/diagram.svg
mermaid diagram.mmd -o /shared/diagram.svg
cat diagram.mmd | mermaid render -o /shared/diagram.svg
mermaid render --theme dark -o /shared/diagram.svg <<'EOF'
sequenceDiagram
  Alice->>Bob: hello
EOF
```

A bare path is the same as `mermaid render <path>`. `-` or a `render`
with no path reads stdin. With no `-o`, the SVG is printed.

Themes: `default`, `neutral`, `dark`, `forest`, `base`.

Open the result with `open /shared/diagram.svg`.

## What this does not do

- It does not render Graphviz DOT. `dot` is a different language. A wasm
  build of Graphviz already exists as `@hpcc-js/wasm-graphviz` and runs
  without a browser. It is not wired up here.
- It does not emit PNG. The SVG is the picture. Rasterising it is a
  separate step once you have a converter that accepts SVG.
- Diagram source is rendered with Mermaid's `securityLevel: 'strict'`.
  A diagram that fails to parse exits 1 and prints Mermaid's message.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | SVG written or printed |
| 1 | Missing package, missing file, parse error, or the browser returned nothing |
| 2 | Bad flags, unknown theme, or too many arguments |
