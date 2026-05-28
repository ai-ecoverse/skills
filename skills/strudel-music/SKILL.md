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

For full details on manifest structure, categories, and adding more samples, see `references/api-reference.md`.

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
