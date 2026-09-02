# Why native `import` doesn't work in a full-document sprinkle

A full-document `.shtml` sprinkle renders inside an `about:srcdoc` iframe.
Per the HTML spec, a `srcdoc` document's base URI inherits the **parent**
frame's URL unless explicitly overridden — so `document.baseURI` resolves
to the SLICC app shell's own origin, not to any VFS-relative location.

Consequence: **no** `import`/`fetch` specifier — relative or absolute —
can ever resolve via native browser networking against your own `lib/`
files. Every such request gets caught by the app shell's own client-side
router fallback and returns its `index.html` with an HTTP 200 (a
"successful" response with completely the wrong body), not a 404 you
could at least detect cleanly.

This is not a one-off configuration problem to fix — it's structural to
how full-document sprinkles render, and will reproduce in any SLICC
environment.

## The fix: an in-page Blob-URL module loader

Ship a small loader (defined early, in a plain non-module `<script>` so
it always runs even if later ESM loading fails) that:

1. Reads each `lib/*.js` file's **source text** via the bridge's own
   message-passing channel (e.g. `slicc.readFile`) — this does not go
   through browser networking at all, so it's unaffected by the base-URI
   problem.
2. Recursively resolves and rewrites each file's own `from "./x.js"`
   import specifiers to point at freshly-created `Blob` URLs for those
   sibling files (rewriting the specifier text, not executing the
   module).
3. Wraps the rewritten source in a `Blob` (`type: "text/javascript"`) and
   returns `URL.createObjectURL(blob)` — a URL that **`import()` can
   actually load**, since it isn't subject to the srcdoc base-URI
   resolution problem at all.

The main `<script type="module">` loads every `lib/*.js` file through this
loader in parallel (e.g. via `Promise.all`) and destructures the exports
it needs before running its own `init()`. An `AudioWorkletNode`'s module
also has an identical resolution problem — use the same loader in place
of `audioWorklet.addModule(new URL(...))`.

## A concurrency trap in the specifier-rewriting regex

If the specifier-rewriting step uses a `RegExp` with the global (`g`)
flag, **it must be a fresh instance per call, not a shared
module-level one.** A `g`-flagged regex is stateful (`lastIndex`) — if
multiple files are loaded in parallel and any of them recursively pulls
in shared sibling files, concurrent `exec()` calls against a shared regex
instance will corrupt each other's `lastIndex`, silently mangling the
rewritten source into a `SyntaxError` that has nothing obviously to do
with concurrency when you first see it. Always construct a new `RegExp`
for each rewrite call.

## Verify the assumption before working around it

Before building any of this, actually confirm native `import`/`fetch`
fails in your environment with a handful of real path shapes (relative,
absolute, with/without a leading `/`) rather than assuming it from
reading the HTML spec — behavior here can vary by exact hosting setup. If
a future SLICC version changes how full-document sprinkles are hosted
(e.g. serving them from their own origin instead of `srcdoc`), this
entire loader could become unnecessary — keep a cheap smoke test around
(try both a native `import` and the loader on the same file, log which
one actually worked) so a future environment fix is detected rather than
silently masked by the workaround still being harmlessly present.
