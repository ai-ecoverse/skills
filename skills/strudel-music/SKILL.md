---
name: strudel-music
description: Generate live-coded music patterns using the Strudel library (JavaScript port of TidalCycles). Use this skill whenever the user wants to create music, beats, melodies, rhythms, or sound patterns in the browser. Triggers on requests like "make some music", "create a beat", "generate a melody", "live code some audio", "play a pattern", "make a drum loop", "compose something", or any request involving Strudel, TidalCycles, or algorithmic music. Also use when the user asks to modify, remix, or explore existing musical patterns.
---

# Strudel Music

Generate music patterns using [Strudel](https://strudel.cc).

## End-to-end workflow

1. **Set up HTML** — load the Strudel script tag (see Quick start below)
2. **Initialize Strudel** — call `initStrudel()` (with optional `prebake` for samples)
3. **Load samples** — if needed, pass a `prebake` function; await resolution before playing
4. **Verify audio plays** — test with `sound("bd").play()` inside a click handler; check console for errors
5. **Build pattern** — compose with `stack()`, `note()`, `sound()`, etc., triggered by user gesture

## Quick start

Load Strudel from unpkg and call `initStrudel()` to register all functions as globals:

```html
<script src="https://unpkg.com/@strudel/web@1.3.0"></script>
<script>
  initStrudel();
  // note(), sound(), s(), stack(), cat(), hush(), evaluate() etc. are now global
</script>
```

Play a pattern (must be inside a user-gesture handler):

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

> **AudioContext policy.** Always call `.play()` or `evaluate()` from a click/tap handler — never on page load.

## Core concepts

**Mini-notation** — compact DSL inside double-quoted strings:

| Syntax | Meaning | Example |
|--------|---------|--------|
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

## Pattern functions

### Sound sources

```js
sound("bd hh sd hh")          // samples or synths by name
note("c4 e4 g4 b4")           // pitch (letter or MIDI)
n("0 1 2 3").sound("piano")   // sample number
s("sawtooth")                 // shorthand for sound()
```

Built-in synths: `sawtooth`, `square`, `triangle`, `sine`, `white`, `pink`, `brown`, `crackle`.

### Essential effects and modifiers

```js
.lpf(800)         // low-pass filter
.gain(0.8)        // volume
.room(2)          // reverb
.delay(0.5)       // delay effect
.slow(2)          // half speed
.fast(2)          // double speed
.jux(rev)         // split stereo, apply fn to right
.every(4, rev)    // apply fn every n cycles
.scale("C:minor") // map n values to scale
```

For the full effects, time modifiers, pattern modifiers, continuous signals, and drum sound tables, see `references/api-reference.md`.

### Constructors

```js
stack(pat1, pat2)   // play in parallel
cat(pat1, pat2)     // one per cycle
seq(pat1, pat2)     // all in one cycle
silence             // nothing
arrange([n, pat1], [m, pat2], …)  // play pat1 for n cycles, then pat2 for m, …
```

Use `arrange()` for multi-section songs (intro / build / drop / outro). Each tuple is `[cycle-count, pattern]`; the song moves to the next section automatically. `cat()` cycles one pattern per cycle (useful for quick alternation), `<x y z>` in mini-notation alternates *inside* a parameter (e.g. `note("<a c e>")`), and `arrange()` handles long-form structure with explicit durations.

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

**Tempo by mood (rough sweet spots):**

| Style | `setcps` | Feels like |
|--|--|--|
| Ambient / meditation | 0.30 – 0.40 | ~70–95 BPM, four-on-the-floor breathing |
| Lo-fi hip-hop / chillout | 0.38 – 0.46 | ~90–110 BPM, head-nod groove |
| House / techno | 0.50 – 0.60 | ~120–144 BPM, classic dance |
| DnB / jungle | 0.70 – 0.90 | ~168–215 BPM, half-time feel |

## Samples

Built-in synths (`sawtooth`, `triangle`, `sine`, `square`) work without any sample loading. For real drum sounds and instruments, you need the TidalCycles dirt-samples pack.

### Loading samples in a sprinkle

A curated manifest lives at `/shared/sprinkles/strudel-music/samples-manifest.json` (44 categories / ~223 samples, `_base` pointing to GitHub raw URLs).

```js
initStrudel({
  prebake: async function() {
    var json = await slicc.readFile('/shared/sprinkles/strudel-music/samples-manifest.json');
    return samples(JSON.parse(json));
  }
});
```

> **The curated manifest is an optimization, not a requirement.** The bundled sprinkle `prebake` falls back to `samples('https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json')` (the full ~2000-sample manifest, 218 categories) whenever the local file is missing or unreadable. So everything works out of the box without running the install steps — the local manifest just trims down what gets parsed and gives you a stable, version-pinned subset. If you don't see a category you need (`sid`, `psr`, `space`, `hoover`, etc. — see "Synth voices" below), let the GitHub fallback take over rather than editing the manifest.

**Validation checkpoints:**
1. Await `initStrudel({ prebake: ... })` resolution before playing.
2. Test with `sound("bd").play()` inside a click handler.
3. If silent, check the browser console for fetch or network errors.
4. If the network is unavailable, fall back to built-in synths (`sawtooth`, `sine`, etc.).

### Loading samples in a standalone page

```js
// GitHub shorthand (fetches full manifest — ~2000 samples)
initStrudel({
  prebake: () => samples('github:tidalcycles/dirt-samples'),
});
```

**Important notes:**
- **`.bank()` does NOT work** with this setup. Use 808-prefixed names directly: `sound("808bd")` not `sound("bd").bank("RolandTR808")`.
- **Samples are fetched lazily** — first play may pause briefly while the WAV downloads from GitHub.

### Synth voices

Beyond the standard `sawtooth/triangle/sine/square` synths and the curated `arpy/bass/jvbass/casio/moog/juno/pad/pluck/sitar/stab/rave` melodic samples, the dirt-samples repo ships with a wide cast of vintage and chip-style synth voices. Used with `note()` they re-pitch from their root sample.

> **Important — the curated manifest does NOT include these.** The categories below ship with `tidalcycles/Dirt-Samples` but are **not** in `samples-manifest.json`. To use them you must either (a) load the full GitHub manifest directly with `samples('https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json')` (or `samples('github:tidalcycles/dirt-samples')`), or (b) extend `samples-manifest.json` with the categories you want. The bundled sprinkle's `prebake` automatically falls back to the GitHub manifest only when the local file is **missing or unreadable** — so simply having the curated manifest installed will hide these voices. If you need them, skip the local install or extend the manifest.

| Sample | Character | Good for |
|--|--|--|
| `sequential` | Sequential Circuits Pro-One — fat analog | sub-bass, walking bass |
| `moog` | Moog ladder filter sweep | warm bass, lead |
| `juno` | Roland Juno chorused poly | lush pad, chord stab |
| `psr` | Yamaha PSR home keyboard | "cheap-but-charming" pad |
| `koy` | Vintage Korg pluck | melodic counter-line |
| `arpy` | Soft mallet / Rhodes-ish | mallet motif, comping |
| `pluck` | Plucked string | counterpoint, arpeggios |
| `sid` | Commodore 64 SID chip | 8-bit melancholy lead |
| `bleep` | Atari-style game blip | rhythmic accents |
| `bend` | Pitch-bent synth tone | sliding lead |
| `hoover` | The 1992 rave hoover stab | dramatic stab (use ghosted) |
| `space` | Sci-fi atmospheric pad | drone layer |
| `cosmicg` | Cosmic Guerrilla arcade synth | retro game feel |
| `monsterb`, `subroc3d`, `tacscan`, `sundance` | Vintage arcade synths | colour, texture |
| `simplesine` | Pure sine sample | airy top-line, sub |
| `wobble` | Wobble bass | dubstep accent |
| `metal` | Metallic hit | percussion-as-pitch |
| `industrial`, `dist` | Distorted texture | grit layer |
| `bass1`, `bass2`, `bass3` | Bass synth banks | melodic bass alternatives |
| `ades`, `ades2`, `ades3`, `ades4` | Adessio synth pack | varied analog tones |
| `gabba`, `gabbalouder` | Hardcore / gabber kick | aggressive drop |
| `crackle` | Vinyl crackle (built-in) | atmospheric texture |
| `pink`, `brown`, `white` | Coloured noise (built-in) | tape hiss, washes |

For relaxing electronica, `sequential + psr + koy + simplesine` give a complete bass / pad / lead / air stack. For chiptune, layer `sid + bleep + simplesine`. For dubby textures, `hoover` ghosted at low gain plus `space` works well.

For full details on manifest structure, categories, and adding more samples, see `references/api-reference.md`.

## Generative idioms

A static `stack(...)` becomes a living song through a handful of recurring patterns. These are the four highest-leverage idioms — applying any one to a layer makes it stop sounding like a loop.

**Periodic transformation with `every(n, fn)`** — apply a function every n cycles. Great for harmonic interest without writing a longer sequence.

```js
note("<a1 f1 c2 g1>")
  .s("moog")
  .every(8, x => x.add(note(-5)))   // dip down a fourth every 8 cycles
  .every(7, rev)                    // reverse every 7 (prime-vs-prime keeps it irregular)
```

**Probabilistic variation with `sometimes(fn)`** — 50% chance of applying a function each cycle. The cousin `often(fn)` is 75%, `rarely(fn)` is 25%.

```js
n("<0 2 4 7>").scale("A:minor").s("sid")
  .sometimes(rev)
  .sometimes(x => x.fast(1.5))
```

**Offset ghost copies with `off(time, fn)`** — overlay a delayed-and-modified copy onto the main pattern. Classic technique for octave-doubled bells, harmonized leads, soft echoes that lock to the grid (unlike `.delay()` which is time-based).

```js
n("<0 2 4 5 7 9 7 4>").scale("A:minor:pentatonic").s("sine").fm(3)
  .off(1/4, x => x.add(note(7)).gain(0.13))   // a 5th above, quarter-cycle late, quieter
  .off(3/8, x => x.add(note(12)).gain(0.06))  // an octave above, even quieter
```

**Continuous-signal modulation** — feed a slow `sine`, `cosine`, or `perlin` into any parameter via `.range(min, max).slow(n)`. `perlin` feels organic / breathing; `sine` and `cosine` feel mechanical / oscillating.

```js
note("<[a3,c4,e4] [f3,a3,c4] [c4,e4,g4] [g3,b3,d4]>").s("juno")
  .lpf(perlin.range(400, 1800).slow(11))      // organic filter sweep
  .pan(cosine.range(0.2, 0.8).slow(13))       // slow stereo drift
  .vowel("<o a e i>/20")                      // 20-cycle vowel morph (mini-notation /n)
  .gain(sine.range(0.12, 0.20).slow(8))       // gentle volume breathing
```

Combining all four turns a four-chord pad into something that barely repeats over a minute.

### Layering tip — chord voicings

Triads (`[a3,c4,e4]`) sound thin; five-note voicings with extensions (`[a3,c4,e4,b4,d5]` adds the 9th and 11th) sound dramatically warmer and more cinematic at the same gain. Layer a quiet sawtooth doubling at lower gain (`.gain(0.07)`) under a brighter pad sample to fill the midrange without raising perceived volume.

### Saturation tip — `.shape()`

`.shape(0.1)` to `.shape(0.3)` reads as soft tape saturation / analog warmth on basses and kicks. Higher values cross into distortion. Pairs well with low-pass filtering — saturate first, filter second.

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

**Bass + melody + drums:**
```js
stack(
  note("[c2 c2 eb2 g1]").s("sawtooth").lpf(600).gain(0.8),
  n("0 2 4 <3 5>").scale("C:minor").s("triangle").room(0.3),
  sound("bd*4, [~ sd]*2, hh*8?").gain(0.7)
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

More patterns (ambient generative, Euclidean polyrhythm, multi-sample showcase) are in `references/api-reference.md`.

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

## Troubleshooting

**Audio doesn't play.** Ensure `.play()` or `evaluate()` is called inside a click/tap handler.

**Samples silently skip or never play.** Check the browser console for network errors. Confirm `initStrudel({ prebake: ... })` resolved before the pattern started.

**`evaluate()` throws a syntax error.** Mini-notation strings must use double quotes (`"`). Check for unbalanced brackets and valid `.method()` names. Wrap in try/catch to surface the message in your UI.

## Sprinkle integration

When the user wants an interactive music UI, delegate to the `strudel-music` sprinkle scoop. The sprinkle provides a code editor, play/stop controls, pattern presets, and a visualization. See the sprinkle at `/shared/sprinkles/strudel-music/strudel-music.shtml`.

To install the sprinkle and its samples manifest:

1. Copy `sprinkle/strudel-music.shtml` to `/shared/sprinkles/strudel-music/strudel-music.shtml`
2. Copy `sprinkle/samples-manifest.json` to `/shared/sprinkles/strudel-music/samples-manifest.json`
3. Run `sprinkle open strudel-music`

## Reference

For deeper API coverage, read `/workspace/skills/strudel-music/references/api-reference.md`.
