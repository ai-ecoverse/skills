# Fountain renderer and Review integration

`fountain render <path> --json` returns `{format, renderer, title, path, html}`.
`html` is a complete static HTML document. `fountain render <path> --out <html>`
writes it to the VFS and refuses to overwrite the source file. With no output
flag, HTML goes to stdout. Relative paths resolve from the shell's working
directory. The parser is bundled under `assets/vendor/fountain-js` with its
license; `assets/render-fountain.js` adds layout and review anchors.

`fountain review <path> [--title <title>]` sends `ensure-item`, then `open-file`,
to the Review sprinkle. Its stable card ID is `review:<absolute source path>`.
The original `.fountain` file remains the review target. The renderer does not
write it or dispatch feedback. Delivery failures exit nonzero.

The preview adapts its paper, text, borders, and focus indicators to Review's
light/dark theme. Dialogue stays indented on narrow rails; dual dialogue stacks
there to remain readable. In a wide rail it appears side by side. Page breaks
are dividers on screen and page breaks when printed. This is a reading preview,
not a production pagination or page-count tool. Fountain notes, sections,
synopses, and boneyard text are excluded from the rendered screenplay.

Each visible token gets `id="fountain-N"`, `data-fountain-token`,
`data-fountain-type`, and the nearest `data-scene`. Review records these with a
DOM selector, original quote, and surrounding context. IDs are stable for an
unchanged source; the agent must verify the quote and scene after edits.
Never apply a comment solely by a stale token number.

Validation: `node --test skills/save-the-cat/tests/fountain.test.js` covers
screenplay structure, escaping, anchors, command delivery, and source overwrite
protection. Verify a real rendered preview and a saved comment before claiming
the complete Review flow works.
