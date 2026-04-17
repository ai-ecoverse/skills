---
name: strudel-music
description: Generate live-coded music patterns using the Strudel library (JavaScript port of TidalCycles). Use this skill whenever the user wants to create music, beats, melodies, rhythms, or sound patterns in the browser. Triggers on requests like "make some music", "create a beat", "generate a melody", "live code some audio", "play a pattern", "make a drum loop", "compose something", or any request involving Strudel, TidalCycles, or algorithmic music. Also use when the user asks to modify, remix, or explore existing musical patterns.
---

# Strudel Music

Generate music patterns using [Strudel](https://strudel.cc), a JavaScript live-coding music library based on TidalCycles. Strudel runs entirely in the browser using Web Audio — no server, no installs.

## Quick start

Load Strudel from unpkg and call `initStrudel()` to register all functions as globals:

```html
<script src="https://unpkg.com/@strudel/web@1.3.0"></script>
<script>
  initStrudel();
  // Now note(), sound(), s(), stack(), cat(), hush(), evaluate() etc. are all global
</script>
```

Play a pattern (must happen inside a user-gesture handler):

```js
note('<c a f e>(3,8)').s('sawtooth').lpf(800).room(0.5).play()
```

Stop all audio:

```js
hush()
```

Evaluate a code string (like the REPL):

```js
evaluate('note("c a f e").jux(rev)')
```

## Core concepts

**Cycle-based timing.** A pattern fills one cycle (default 2 seconds at 0.5 cps). Adding more events makes each shorter — it doesn't extend the total. This is the fundamental difference from traditional sequencers.

**Mini-notation** is a compact DSL inside double-quoted strings:

| Syntax | Meaning | Example |
|--------|---------|---------|
| `space` | Sequence events in one cycle | `"bd hh sd hh"` |
| `[x y]` | Subdivide one slot | `"bd [hh hh] sd"` |
| `<x y>` | Alternate per cycle | `"<bd sd cp>"` |
| `x*n` | Repeat/speed up | `"hh*8"` |
| `x/n` | Slow over n cycles | `"[c d e f]/2"` |
| `x,y` | Polyphony (parallel) | `"[c3,e3,g3]"` |
| `~` | Rest | `"bd ~ sd ~"` |
| `x(p,s)` | Euclidean rhythm | `"bd(3,8)"` |
| `x@n` | Elongate (weight) | `"c@3 e"` |
| `x?` | 50% random mute | `"hh*8?"` |

**AudioContext policy.** Browsers require a user gesture (click/tap) before audio plays. Always trigger `.play()` or `evaluate()` from a click handler.

## Pattern functions

### Sound sources

```js
sound("bd hh sd hh")          // samples or synths by name
note("c4 e4 g4 b4")           // pitch (letter or MIDI)
n("0 1 2 3").sound("piano")   // sample number
s("sawtooth")                 // shorthand for sound()
```

Built-in synths: `sawtooth`, `square`, `triangle`, `sine`, `white`, `pink`, `brown`, `crackle`.

### Effects

```js
.lpf(800)         // low-pass filter
.hpf(400)         // high-pass filter
.vowel("a e i o") // vowel filter
.gain(0.8)        // volume
.pan(0.3)         // stereo position (0-1)
.delay(0.5)       // delay effect
.room(2)          // reverb
.speed(2)         // playback speed
.shape(0.5)       // waveshaping distortion
.fm(4)            // FM synthesis depth
.adsr(".01:.1:.5:.2") // envelope
```

### Time modifiers

```js
.slow(2)          // half speed
.fast(2)          // double speed
.rev()            // reverse
.euclid(3, 8)     // Euclidean rhythm
.ply(2)           // repeat each event
.iter(4)          // rotate subdivisions
.palindrome()     // reverse every other cycle
.swing(0.1)       // swing feel
```

### Pattern modifiers

```js
.jux(rev)                    // split stereo, apply fn to right
.every(4, rev)               // apply fn every n cycles
.sometimes(add(note("12")))  // 50% chance apply fn
.off(1/8, x => x.add(note("7"))) // offset copy + modify
.scale("C:minor")            // map n values to scale
.struct("x x*2 x x*3")      // apply rhythmic structure
.add(note("<0 7 12>"))       // add to values
.range(200, 4000)            // scale signals to range
```

### Constructors

```js
stack(pat1, pat2)   // play in parallel
cat(pat1, pat2)     // one per cycle
seq(pat1, pat2)     // all in one cycle
silence             // nothing
```

### Continuous signals

```js
sine    // 0–1 sine wave (one cycle)
cosine  // 0–1 cosine
saw     // 0–1 sawtooth
tri     // 0–1 triangle
rand    // 0–1 random
perlin  // 0–1 smooth noise
irand(n) // random integer 0 to n-1
```

Use with `.range()` and `.slow()` for modulation:
```js
note("c3 e3 g3").s("sawtooth").lpf(sine.range(200, 4000).slow(4))
```

### Scales

```js
n("0 2 4 6").scale("C:minor").sound("piano")
```

Common scales: `C:major`, `A:minor`, `D:dorian`, `G:mixolydian`, `C:minor:pentatonic`, `F:major:pentatonic`.

### Tempo

```js
setcps(0.5)   // cycles per second (default)
setcpm(120)   // cycles per minute
```

Default is 0.5 cps = 120 BPM at 4 events per cycle.

### Drum sounds

| Code | Drum | Code | Drum |
|------|------|------|------|
| `bd` | Bass drum | `oh` | Open hi-hat |
| `sd` | Snare | `cp` | Clap |
| `hh` | Hi-hat | `rim` | Rimshot |
| `lt` | Low tom | `mt` | Mid tom |
| `ht` | High tom | `rd` | Ride |
| `cr` | Crash | | |

808 variants: `808bd`, `808sd`, `808cy`, `808hc`, `808ht`, `808lt`, `808mt`, `808oh` — these are separate sample names, not banks.

```js
stack(
  sound("808bd*4"),
  sound("[~ cp]*2"),
  sound("808hc*8").gain(0.5)
)
```

## Samples

Strudel's built-in synths (`sawtooth`, `triangle`, `sine`, `square`) work without any sample loading. For real drum sounds and instruments, you need the TidalCycles dirt-samples pack.

### How samples work

Strudel's `samples()` function takes a JSON manifest that maps category names to arrays of WAV file paths, plus a `_base` URL prefix. When a pattern references a sound name like `bd` or `808bd`, Strudel fetches the WAV from `_base + path` on demand.

### The samples manifest

A curated manifest lives at `/shared/sprinkles/strudel-music/samples-manifest.json` (also bundled at `sprinkle/samples-manifest.json` in the skill directory). It contains 44 categories / ~223 samples from [tidalcycles/dirt-samples](https://github.com/tidalcycles/dirt-samples), with `_base` pointing to GitHub raw URLs.

**Included categories:**

| Type | Categories |
|------|-----------|
| Standard drums | `bd`, `sd`, `hh`, `cp`, `oh`, `ho`, `hc`, `lt`, `mt`, `ht`, `cr`, `rm`, `rs`, `cb` |
| 808 drum machine | `808`, `808bd`, `808sd`, `808cy`, `808hc`, `808ht`, `808lt`, `808mt`, `808oh` |
| 909 | `909` |
| Drum kits | `drumtraks`, `electro1`, `gretsch`, `house`, `jazz`, `jungle`, `tech`, `feel`, `clubkick` |
| Melodic/tonal | `arpy`, `bass`, `jvbass`, `casio`, `moog`, `juno`, `pad`, `pluck`, `sitar`, `stab`, `rave` |
| Percussion | `tabla` |

### Loading samples in a sprinkle

The strudel-music sprinkle loads the manifest from VFS via `slicc.readFile()` in the `prebake` function:

```js
initStrudel({
  prebake: async function() {
    var json = await slicc.readFile('/shared/sprinkles/strudel-music/samples-manifest.json');
    return samples(JSON.parse(json));
  }
});
```

### Loading samples in a standalone page

For standalone HTML (outside the sprinkle), use the GitHub shorthand or a direct URL:

```js
// Option 1: GitHub shorthand (fetches full manifest — ~2000 samples)
initStrudel({
  prebake: () => samples('github:tidalcycles/dirt-samples'),
});

// Option 2: Direct manifest URL
initStrudel({
  prebake: () => samples('https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json'),
});
```

### Adding more samples

To expand the curated manifest, download the full manifest and add categories:

```bash
# Download the complete dirt-samples manifest
curl -sL "https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/strudel.json" > /tmp/strudel-samples.json

# Then use node to merge new categories into the curated manifest:
node -e "
const full = JSON.parse(await fs.readFile('/tmp/strudel-samples.json'));
const curated = JSON.parse(await fs.readFile('/shared/sprinkles/strudel-music/samples-manifest.json'));

// Add new categories (up to 6 samples each)
var newCats = ['piano', 'flick', 'mouth', 'wind', 'birds', 'metal'];
for (var k of newCats) {
  if (full[k]) curated[k] = full[k].slice(0, 6);
}

await fs.writeFile('/shared/sprinkles/strudel-music/samples-manifest.json', JSON.stringify(curated));
console.log('Updated manifest');
"
```

The full dirt-samples repo has 218 categories / 2038 samples. The curated manifest keeps only the most useful subset to avoid unnecessary network requests.

### Important notes on samples

- **`.bank()` does NOT work** with our setup. The `.bank("RolandTR909")` syntax requires a separate sample registry that isn't loaded. Use the 808-prefixed names directly instead: `sound("808bd")` not `sound("bd").bank("RolandTR808")`.
- **Samples are fetched lazily** — the first time a sound plays, there may be a brief pause while the WAV downloads from GitHub.
- **Built-in synths always work** — `sawtooth`, `triangle`, `sine`, `square` need no samples.
- **The manifest must be accessible** — if using the sprinkle, the manifest is read via `slicc.readFile()`. For standalone pages, use the GitHub URL directly.

## Example patterns

**808 drum groove:**
```js
stack(
  sound("808bd*4"),
  sound("[~ cp]*2"),
  sound("808hc*8").gain(0.5),
  sound("[~ 808oh]*4").gain(0.4)
)
```

**Melodic arpeggio with filter sweep:**
```js
note("<c3 eb3 g3 bb3>(3,8)")
  .s("sawtooth")
  .lpf(sine.range(200, 4000).slow(4))
  .room(0.5)
  .delay(0.25)
```

**Bass + melody + drums:**
```js
stack(
  note("[c2 c2 eb2 g1]").s("sawtooth").lpf(600).gain(0.8),
  n("0 2 4 <3 5>").scale("C:minor").s("triangle").room(0.3),
  sound("bd*4, [~ sd]*2, hh*8?").gain(0.7)
)
```

**Ambient generative:**
```js
note("c3 [eb3 g3] <bb3 ab3> f3")
  .s("sine")
  .room(4)
  .delay(0.6)
  .lpf(1200)
  .slow(2)
  .jux(x => x.add(note("7")).slow(1.5))
```

**Euclidean polyrhythm:**
```js
stack(
  sound("808bd(3,8)"),
  sound("sd(5,8,2)").gain(0.6),
  sound("hh(7,16)").gain(0.4)
)
```

**Multi-sample showcase (arpy, moog, jvbass, juno, pluck):**
```js
stack(
  note("e4 e4 f#4 g4").sound("arpy").room(0.3).gain(0.7),
  note("e3 ~ f#3 ~").sound("moog").lpf(1200).gain(0.3),
  note("d2 g2 a2 d2").sound("jvbass").gain(0.5).lpf(500),
  note("[d3,f#3,a3]").sound("juno").gain(0.15).room(2),
  note("[~ d5 ~ a4]").sound("pluck").gain(0.2).delay(0.3),
  sound("808bd(3,8)").gain(0.5),
  sound("[~ gretsch:2]*2").gain(0.4),
  sound("808hc*8").gain(0.25)
)
```

## Using evaluate() for dynamic code

When building a UI where the user types Strudel code:

```js
initStrudel();
// In a click handler:
evaluate(userCode);  // plays the pattern
// To stop:
hush();
```

The `evaluate()` function transpiles and runs Strudel syntax (including `$:` for multiple patterns, mini-notation in double quotes, and all sugar syntax).

## Loading via ESM import

For ESM module environments:

```js
import { initStrudel } from 'https://esm.sh/@strudel/web@1.3.0';
const { evaluate } = await initStrudel();
```

## Sprinkle integration

When the user wants an interactive music UI, delegate to the `strudel-music` sprinkle scoop. The sprinkle provides a code editor, play/stop controls, pattern presets, and a visualization. See the sprinkle at `/shared/sprinkles/strudel-music/strudel-music.shtml`.

To install the sprinkle and its samples manifest:

1. Copy `sprinkle/strudel-music.shtml` to `/shared/sprinkles/strudel-music/strudel-music.shtml`
2. Copy `sprinkle/samples-manifest.json` to `/shared/sprinkles/strudel-music/samples-manifest.json`
3. Run `sprinkle open strudel-music`

## Reference

For deeper API coverage, read `/workspace/skills/strudel-music/references/api-reference.md`.
