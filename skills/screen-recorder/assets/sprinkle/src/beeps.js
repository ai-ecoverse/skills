// Countdown beeps via WebAudio.
//
// One short beep per second while the countdown runs, then three faster, higher
// beeps at zero/GO.
//
// THE BEEPS ARE RECORDED, ON PURPOSE. They land inside the countdown region,
// which `countdownMs` marks as the trim-in point, so they are cut away with it.
// A mic track will pick them up acoustically, and the screen track will too if
// the user shared tab/system audio. That is expected -- do NOT "fix" audible
// beeps in the trimmed region by muting them; the whole point is that the
// performer hears the count during the take.
//
// GESTURE REQUIREMENT: an AudioContext created outside a user gesture starts
// `suspended` and produces silence with no error. It must be constructed (and
// resumed) inside the start click handler, and ctx.state checked.

export function createBeeper() {
  let ctx = null;
  let unavailable = false;
  // DIAGNOSTIC COUNTERS ONLY -- no behaviour change. A 30s take showed no
  // periodic transients in the mic during the countdown, which is equally
  // consistent with "beeps played to headphones/muted output" and "beeps never
  // fired". A mic recording cannot distinguish those, so the beeper records its
  // OWN outcome into the manifest and the next take is decided from data.
  const counters = { ticksScheduled: 0, ticksPlayed: 0, gosScheduled: 0, gosPlayed: 0, lastError: null };

  /**
   * Construct + resume the context. MUST be called from a user-gesture handler.
   * Returns the AudioContext state string, or null when WebAudio is unavailable.
   */
  async function arm() {
    if (unavailable) return null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        unavailable = true;
        return null;
      }
      if (!ctx) ctx = new AC();
      // Chrome may still hand back a suspended context; resume() inside the
      // gesture is what actually unlocks it.
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (e) {
          /* fall through and report whatever state we ended in */
        }
      }
      return ctx.state;
    } catch (err) {
      unavailable = true;
      return null;
    }
  }

  /**
   * One enveloped beep. Envelope (3ms attack, exponential decay) exists so the
   * tone does not click: a bare gain step is an audible discontinuity.
   * Never throws -- audio must never be able to break a recording.
   */
  function beep(freq, durationSec, when, peak) {
    if (!ctx || unavailable) {
      counters.lastError = unavailable ? 'audio unavailable' : 'context not armed';
      return false;
    }
    try {
      const t = when == null ? ctx.currentTime : when;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      const p = peak == null ? 0.22 : peak;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(p, t + 0.003); // attack
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durationSec); // decay
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + durationSec + 0.02);
      return true; // an oscillator was actually started on a live context
    } catch (err) {
      counters.lastError = (err && err.message) || String(err);
      return false;
    }
  }

  /** A per-second tick: lower pitch, longer. */
  function tick() {
    counters.ticksScheduled++;
    if (beep(660, 0.09)) counters.ticksPlayed++;
  }

  /** Zero/GO: three shorter, higher beeps in quick succession. */
  function go() {
    counters.gosScheduled += 3;
    if (!ctx || unavailable) {
      counters.lastError = unavailable ? 'audio unavailable' : 'context not armed';
      return;
    }
    const t0 = ctx.currentTime;
    for (let i = 0; i < 3; i++) if (beep(1040, 0.07, t0 + i * 0.12, 0.26)) counters.gosPlayed++;
  }

  function state() {
    return unavailable ? 'unavailable' : ctx ? ctx.state : 'not-armed';
  }

  function close() {
    if (ctx && ctx.close) {
      try {
        ctx.close();
      } catch (e) {
        /* ignore */
      }
    }
    ctx = null;
  }

  /**
   * Everything needed to tell "played but inaudible to the mic" from "never
   * fired", from the manifest alone:
   *  - state 'running' + ticksPlayed === ticksScheduled  => WebAudio did emit;
   *    silence in the mic then means output routing (headphones/muted), not us.
   *  - state 'suspended'                                 => no gesture unlock.
   *  - ticksPlayed < ticksScheduled                      => scheduling failed.
   */
  function report() {
    return {
      state: state(),
      contextState: ctx ? ctx.state : null,
      sampleRate: ctx ? ctx.sampleRate : null,
      outputLatency: ctx && ctx.outputLatency != null ? ctx.outputLatency : null,
      ticksScheduled: counters.ticksScheduled,
      ticksPlayed: counters.ticksPlayed,
      finalBeepsScheduled: counters.gosScheduled,
      finalBeepsPlayed: counters.gosPlayed,
      lastError: counters.lastError,
    };
  }

  return { arm, tick, go, state, report, close };
}
