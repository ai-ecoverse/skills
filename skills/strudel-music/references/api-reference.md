# Strudel API Reference

Comprehensive reference for the Strudel music library. Read the main SKILL.md first for the essentials.

## Table of contents

1. [Initialization](#initialization)
2. [Pattern constructors](#pattern-constructors)
3. [Control parameters](#control-parameters)
4. [Mini-notation full reference](#mini-notation-full-reference)
5. [Effects reference](#effects-reference)
6. [Time modifiers reference](#time-modifiers-reference)
7. [Pattern modifiers reference](#pattern-modifiers-reference)
8. [Scales and chords](#scales-and-chords)
9. [Sample banks](#sample-banks)
10. [Continuous signals](#continuous-signals)
11. [Multi-pattern playback](#multi-pattern-playback)

## Initialization

### initStrudel(options?)

One-call setup. Registers all Strudel functions as globals (note, sound, s, n, stack, cat, etc.), initializes audio on first click, registers built-in synths.

```js
initStrudel();  // basic

initStrudel({
  prebake: () => samples('github:tidalcycles/dirt-samples'),
});  // with sample loading
```

Returns `{ evaluate }` — the function to evaluate Strudel code strings.

### evaluate(code, autoplay?)

Transpile and run a Strudel code string. Supports `$:` syntax, mini-notation, and all sugar.

### hush()

Stop all playing patterns immediately.

### setcps(n) / setcpm(n)

Set tempo. Default is 0.5 cps (cycles per second) = 120 BPM at 4 events per cycle.

## Pattern constructors

| Function | Description |
|----------|-------------|
| `sequence(a, b, ...)` / `seq(a, b)` | All items in one cycle |
| `cat(a, b, ...)` / `slowcat(a, b)` | One item per cycle |
| `fastcat(a, b)` | All in one cycle (alias for seq) |
| `stack(a, b, ...)` | Play in parallel |
| `polymeter(a, b)` | Different-length cycles |
| `polyrhythm(a, b)` | Polyrhythmic combination |
| `silence` | Empty pattern |
| `pure(x)` | Constant value |
| `run(n)` | Numbers 0 to n-1 |
| `binary(n)` | Binary pattern from integer |
| `arrange([4, pat1], [2, pat2])` | Multi-cycle arrangement |

## Control parameters

These create patterns from values and attach a control name:

| Function | Description | Example |
|----------|-------------|---------|
| `note(pat)` | Pitch (letter or MIDI) | `note("c3 e3 g3")` |
| `sound(pat)` / `s(pat)` | Sound name | `sound("bd sd")` |
| `n(pat)` | Sample/scale degree number | `n("0 2 4")` |
| `freq(pat)` | Frequency in Hz | `freq("440 660")` |
| `gain(pat)` | Volume 0-1 | `gain("0.5 1")` |
| `pan(pat)` | Stereo 0-1 | `pan("0 1")` |
| `speed(pat)` | Playback speed | `speed("1 2 -1")` |
| `begin(pat)` | Sample start 0-1 | `begin("0 0.5")` |
| `end(pat)` | Sample end 0-1 | `end("0.5 1")` |
| `cut(pat)` | Cut group | `cut(1)` |
| `bank(pat)` | Sample bank | `bank("RolandTR909")` |

## Mini-notation full reference

| Syntax | Meaning | Example |
|--------|---------|---------|
| `space` | Sequence | `"a b c"` = 3 events per cycle |
| `.` | Same as space (separator) | `"a.b.c"` |
| `[x y]` | Subdivide slot | `"a [b c] d"` |
| `<x y>` | Alternate per cycle | `"<a b c>"` |
| `x*n` | Repeat n times in slot | `"a*4"` |
| `x/n` | Span n cycles | `"a/2"` |
| `x,y` | Polyphony | `"[a,b,c]"` |
| `~` | Silence/rest | `"a ~ b ~"` |
| `-` | Rest (alias) | `"a - b -"` |
| `_` | Extend previous | `"a _ b _"` |
| `x@n` | Weight/elongate | `"a@3 b"` |
| `x!n` | Replicate (no squish) | `"a!3 b"` = 4 events |
| `x?` | 50% random mute | `"a*8?"` |
| `x?0.2` | 20% random mute | `"a*8?0.2"` |
| `x\|y` | Random choice | `"[a\|b\|c]"` |
| `x(p,s)` | Euclidean rhythm | `"a(3,8)"` |
| `x(p,s,o)` | Euclidean + offset | `"a(3,8,2)"` |
| `x:n` | Sample number | `"bd:2"` |
| `{a b, x y z}` | Polymeter | `{a b c, x y}` |

## Effects reference

### Filters

| Method | Description | Range |
|--------|-------------|-------|
| `.lpf(freq)` / `.cutoff(freq)` | Low-pass filter | 20-20000 Hz |
| `.hpf(freq)` | High-pass filter | 20-20000 Hz |
| `.bpf(freq)` | Band-pass filter | 20-20000 Hz |
| `.lpq(q)` / `.hpq(q)` / `.bpq(q)` | Filter resonance | 0-50 |
| `.vowel(v)` | Vowel filter | `"a e i o u"` |

### Amplitude

| Method | Description | Range |
|--------|-------------|-------|
| `.gain(g)` | Volume | 0-1+ |
| `.shape(s)` | Waveshaping distortion | 0-1 |

### Spatial

| Method | Description | Range |
|--------|-------------|-------|
| `.pan(p)` | Stereo position | 0 (L) to 1 (R) |
| `.room(r)` | Reverb amount | 0-4+ |
| `.roomsize(s)` | Reverb room size | 0-2 |
| `.roomlp(f)` | Reverb low-pass | Hz |
| `.roomdim(d)` | Reverb dampening | 0-1 |

### Delay

| Method | Description |
|--------|-------------|
| `.delay(d)` | Delay wet amount (0-1) |
| `.delaytime(t)` | Delay time in cycles |
| `.delayfeedback(f)` | Feedback amount |
| `.delay("wet:time:feedback")` | Shorthand |

### Envelope (ADSR)

| Method | Description |
|--------|-------------|
| `.attack(t)` | Attack time (seconds) |
| `.decay(t)` | Decay time |
| `.sustain(l)` | Sustain level (0-1) |
| `.release(t)` | Release time |
| `.adsr("a:d:s:r")` | Shorthand |
| `.clip(f)` / `.legato(f)` | Duration multiplier |

### Synthesis

| Method | Description |
|--------|-------------|
| `.fm(depth)` | FM synthesis modulation depth |
| `.fmh(ratio)` | FM harmonicity ratio |
| `.vib(freq)` | Vibrato frequency |
| `.vibmod(depth)` | Vibrato depth |

### Playback

| Method | Description |
|--------|-------------|
| `.speed(s)` | Playback rate (negative = reverse) |
| `.begin(b)` | Start position 0-1 |
| `.end(e)` | End position 0-1 |
| `.unit("c")` | Use cycles as duration unit |
| `.cut(n)` | Cut group (same group cuts previous) |

## Time modifiers reference

| Method | Description |
|--------|-------------|
| `.slow(n)` | Stretch over n cycles |
| `.fast(n)` | Compress into 1/n cycle |
| `.early(n)` | Shift earlier by n cycles |
| `.late(n)` | Shift later by n cycles |
| `.rev()` | Reverse pattern |
| `.euclid(p, s)` | Euclidean rhythm |
| `.euclid(p, s, o)` | Euclidean with rotation |
| `.ply(n)` | Repeat each event n times |
| `.iter(n)` | Rotate subdivisions each cycle |
| `.iter2(n)` | Reverse iter |
| `.palindrome()` | Reverse alternate cycles |
| `.segment(n)` | Sample signal n times per cycle |
| `.swing(amount)` | Swing feel |
| `.ribbon(offset, cycles)` | Loop portion |

## Pattern modifiers reference

| Method | Description |
|--------|-------------|
| `.jux(fn)` | Stereo split — apply fn to right |
| `.juxBy(amount, fn)` | jux with variable width |
| `.every(n, fn)` | Apply fn every n cycles |
| `.sometimes(fn)` | Apply fn ~50% of events |
| `.often(fn)` | Apply fn ~75% |
| `.rarely(fn)` | Apply fn ~25% |
| `.almostNever(fn)` | Apply fn ~10% |
| `.almostAlways(fn)` | Apply fn ~90% |
| `.someCycles(fn)` | Apply fn ~50% of cycles |
| `.struct(pat)` | Apply rhythmic structure |
| `.mask(pat)` | Silence where pat is silent |
| `.off(time, fn)` | Offset copy with transformation |
| `.add(pat)` | Add values |
| `.sub(pat)` | Subtract values |
| `.mul(pat)` | Multiply values |
| `.div(pat)` | Divide values |
| `.range(min, max)` | Scale 0-1 signal to range |
| `.rangex(min, max)` | Exponential range |
| `.degradeBy(amount)` | Random silence (0-1) |
| `.degrade()` | degradeBy(0.5) |
| `.superimpose(fn)` | Stack with transformed copy |
| `.layer(fn1, fn2, ...)` | Stack with multiple transforms |

## Scales and chords

### Using scales

```js
n("0 1 2 3 4 5 6 7").scale("C:minor").s("piano")
```

Scale format: `"Root:mode"` or `"Root:mode:variation"`.

### Common scales

| Scale | Notes |
|-------|-------|
| `C:major` | C D E F G A B |
| `C:minor` | C D Eb F G Ab Bb |
| `C:dorian` | C D Eb F G A Bb |
| `C:mixolydian` | C D E F G A Bb |
| `C:minor:pentatonic` | C Eb F G Bb |
| `C:major:pentatonic` | C D E G A |
| `C:blues` | C Eb F Gb G Bb |
| `C:chromatic` | all 12 semitones |

### Chords in mini-notation

```js
note("<[c3,e3,g3] [f3,a3,c4] [g3,b3,d4]>")
```

Or with tonal functions:
```js
note("<C3 F3 G3>").chord()  // auto-voice chords
```

## Sample banks

### Drum machines

| Bank name | Machine |
|-----------|---------|
| `RolandTR808` | TR-808 |
| `RolandTR909` | TR-909 |
| `RolandTR707` | TR-707 |
| `RolandTR505` | TR-505 |
| `AkaiLinn` | Akai/Linn |
| `RhythmAce` | Rhythm Ace |
| `ViscoSpaceDrum` | Space Drum |
| `RolandCompurhythm1000` | CR-1000 |
| `CasioRZ1` | Casio RZ-1 |

### Loading external samples

```js
// GitHub sample packs
samples('github:tidalcycles/dirt-samples')

// After loading, use hundreds of sample names:
// jazz, piano, bass, strings, etc.
```

### GM Soundfonts

After loading soundfonts, use `gm_` prefixed names:
```js
sound("gm_acoustic_grand_piano")
sound("gm_electric_bass_finger")
sound("gm_synth_strings_1")
sound("gm_lead_6_voice")
```

## Continuous signals

All signals oscillate from 0 to 1 over one cycle (bipolar variants from -1 to 1):

| Signal | Description |
|--------|-------------|
| `sine` / `sine2` | Sine wave |
| `cosine` / `cosine2` | Cosine |
| `saw` / `saw2` | Sawtooth |
| `tri` / `tri2` | Triangle |
| `square` / `square2` | Square |
| `rand` | Random per event |
| `perlin` | Smooth noise |
| `irand(n)` | Random integer 0 to n-1 |

Use patterns:
```js
.lpf(sine.range(200, 4000).slow(8))   // filter sweep
.gain(saw.range(0.2, 1))              // volume ramp
.pan(sine.slow(4))                     // autopan
.speed(perlin.range(0.5, 2).slow(16)) // random speed drift
```

## Multi-pattern playback

### In evaluate() (REPL syntax)

```js
evaluate(`
$: sound("bd*4, [~ sd]*2, hh*8")
$: note("c2 eb2 f2 g2").s("sawtooth").lpf(800)
$: n("0 2 4 <3 5>").scale("C:minor").s("triangle").room(0.3)
`)
```

Use `_$:` to mute a pattern.

### With .play() (direct API)

Each `.play()` call creates an independent playback. Call `hush()` to stop all.

```js
note("c3 e3 g3").s("triangle").play()
sound("bd*4, [~ sd]*2").play()
```

### With stack()

```js
stack(
  note("c2 eb2 f2 g2").s("sawtooth").lpf(800),
  sound("bd*4, [~ sd]*2, hh*8").bank("RolandTR909"),
  n("0 2 4 6").scale("C:minor").s("triangle").room(0.5)
).play()
```
