# EDL schema

Contract between an analysis step (word-exact cut points from a transcript, e.g.
ElevenLabs Scribe) and a render step. This skill validates and stages against this
schema but does not render it -- see `SKILL.md`'s "Rendering" section.

```json
{
  "fps": 30,
  "width": 1080,
  "height": 1920,
  "segments": [
    {
      "shot": "portrait-interviewer",
      "durationSec": 4.60,
      "source": { "src": "/path/to/interviewer-clip.mp4", "inSec": 0 }
    },
    {
      "shot": "portrait-interviewee",
      "durationSec": 2.35,
      "source": { "src": "/path/to/interviewee-footage.webm", "inSec": 12.25 }
    },
    {
      "shot": "split",
      "durationSec": 3.85,
      "top": { "src": "/path/to/interviewer-clip.mp4", "inSec": 0 },
      "bottom": { "src": "/path/to/interviewee-footage.webm", "inSec": 76.15 },
      "audioFrom": "bottom"
    }
  ]
}
```

## Rules

- `shot` is the discriminator: `split` | `portrait-interviewer` | `portrait-interviewee`.
- Every source is `{src, inSec}` ONLY -- no per-track `outSec`/duration. Duration
  lives once, at the segment level (`durationSec`), so a `split` shot's top/bottom
  can never drift out of sync. The analysis side computes `durationSec` from
  whichever track's word timings drove the cut (usually the interviewee's) and
  reuses it for the other track.
- `split` needs both `top` and `bottom`; `portrait-*` needs `source`. A segment with
  the wrong fields for its `shot` is a validation error (`remotion validate` catches
  this, plus a stray extra field as a warning).
- `audioFrom` (split only, optional): `"top" | "bottom" | "both"`. Not yet wired into
  the render (both tracks' audio currently mix by default in the template's
  `SplitShot.tsx`) -- documented as a known gap, not a silent bug.
- `src` during `validate`/`inspect`/`stage` is a real path readable from wherever
  you're running this skill (local disk, a mounted share, etc). `stage` rewrites it
  to a `public/`-relative path (`"assets/<file>"`) for the render step.

## Worked example: a 6-segment cut

A hypothetical 23-second cut, alternating portrait shots for dialogue with one
`split` shot to show both faces at once (say, a reaction moment):

| # | shot | durationSec | source(s) |
|---|------|------------|-----------|
| 1 | portrait-interviewer | 4.60 | interviewer clip @ 7.10 |
| 2 | portrait-interviewee | 2.35 | interviewee footage @ 12.25 |
| 3 | portrait-interviewee | 0.90 | interviewee footage @ 31.05 |
| 4 | portrait-interviewee | 4.20 | interviewee footage @ 34.30 |
| 5 | portrait-interviewer | 7.00 | interviewer clip @ 39.90 |
| 6 | split | 3.85 | top: interviewer clip @ 0 / bottom: interviewee footage @ 76.15 |

Row 3+4 demonstrate gap removal: whatever silence/pause sat between those two
interviewee lines in the source footage is simply never referenced -- there is no
"cut out this range" operation, just two segments that don't include it.

## Validating

```bash
remotion validate edl.json
```

Catches, in one pass (not exclusively -- whichever apply):

- unknown `shot` value
- a `split` segment missing `top` or `bottom` (or a `portrait-*` segment with a
  stray `top`/`bottom` instead of `source`)
- a missing/empty `src`, or a missing/negative `inSec`
- (default, real-media check) a source file that does not exist
- (default, real-media check) `inSec + durationSec` exceeding the source's actual
  duration -- computed via `@remotion/media-parser`, not ffmpeg

Skip the real-media check (schema-only, faster, no file I/O) with `--no-check-media`.
