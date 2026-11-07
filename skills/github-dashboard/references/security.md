# The markdown renderer: threat and policy

Detail behind the "Security" section of SKILL.md. The renderer's own header in
`src/markdown.js` argues each rule at length; this is the summary that used to
sit in SKILL.md.


The panel renders issue bodies and comments — text written by anyone who can
comment on a followed repository. A sprinkle panel is **not** sandboxed from the
filesystem: the bridge can enumerate sibling scoop folders, run shell commands,
and read and write files. So script execution inside this panel is arbitrary
command execution, and `marked(text)` into `innerHTML` would be a
remote-code-execution path.

What the renderer does instead, argued at length in the header of
`src/markdown.js`:

- marked → DOMPurify with an explicit tag/attribute allowlist → a DOM fragment
  that is appended; untrusted HTML is never assigned to `innerHTML`;
- links are restricted to http/https/mailto and forced to
  `target="_blank" rel="noopener noreferrer"`;
- **images render only from `github.com` and `*.githubusercontent.com`, over
  https**, with the host decided by the URL API rather than a regex. `img` is
  deliberately *not* in the sanitiser allowlist: the renderer emits an inert
  placeholder and builds the `<img>` itself, so no unvetted `src` ever reaches an
  image element. A trusted host can still redirect, so the allowlist bounds who
  is asked, not who answers.

The acceptance gate is 66 fixtures — `<script>`, `<img onerror>`, `<svg onload>`,
`javascript:`/`data:`/`vbscript:` URLs, mXSS, host-lookalikes, credentials in the
authority, attributes the policy does not allow:

```sh
./scripts/build.sh                                   # regenerates the gate page
open tests/xss-gate.html                             # verdict on the page and in the tab title
```

It must read `GATE GREEN — 66 passed, 0 failed, window.__xssFired = never set`.
Re-run it after any change to the renderer. The gate has been demonstrated to go
**red** (a naive `innerHTML` build fails 25 of the 29 pre-image fixtures and
executes; trusting any image host fails 14), which is the only reason to believe
it works.
