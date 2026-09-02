# Rendering: out of scope here, on purpose

This skill stops at `stage`. It does not render a composition to pixels, and does not
shell out to another machine to do so on your behalf. See `SKILL.md`'s "Rendering"
section for the two reasons (in-browser trim/composite doesn't exist yet in
`@remotion/webcodecs`, and actually encoding needs a real headless Chromium + native
ffmpeg that this runtime doesn't have).

An earlier version of this skill did shell out over `ssh` to a specific configured
tray follower to run the render there. It was removed on review: it baked one
person's machine topology (a tray-follower id, a home directory, a project path) into
what should be a portable skill, and it papered over a temporary gap (no trim support
in-browser yet) with a workaround that would become dead weight the moment either gap
closes. If you're tempted to re-add something like it, read that reasoning in
`SKILL.md` first.

## What to do instead

1. `remotion stage <edl.json> <dir>` gives you `<dir>/assets/*` (real copies) and
   `<dir>/edl.staged.json` (the same EDL with every `src` rewritten to the
   `assets/<file>` path a Remotion project's `public/` folder expects).
2. Scaffold (or reuse) a Remotion project from `assets/remotion-template/` (see
   `SKILL.md`) on whatever machine you normally render on -- your own laptop, a CI
   runner, a tray follower, doesn't matter to this skill.
3. Copy `<dir>/assets/*` into that project's `public/assets/`.
4. For each segment in the staged EDL, build a props object matching the template's
   schema:
   - `split`: `{ durationInSeconds: segment.durationSec, top: segment.top, bottom: segment.bottom }`
   - `portrait-*`: `{ durationInSeconds: segment.durationSec, source: segment.source }`
5. Render with the official **`remotion-render`** skill (`npx remotion render
   <shot-id> <out.mp4> --props=<file>`), where `<shot-id>` is the segment's `shot`
   value -- the template's three composition ids match the EDL's `shot` values
   exactly, by design.

None of steps 2-5 are this skill's job. `stage` produces exactly the input a render
needs and stops there.
