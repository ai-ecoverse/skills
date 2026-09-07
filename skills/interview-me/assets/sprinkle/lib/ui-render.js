// interview-me / ui-render.js
//
// Rendering helpers for the live interview screen: the speaking indicator,
// the mic-stall and stream-stall warning states, tool-call chips, the
// transcript renderer, and the two small formatters. Extracted verbatim from
// interview-me.shtml; behaviour unchanged.
//
// LOAD-BEARING RULE (kept intact from the original): a mic warning or a
// stream warning outranks the ordinary "You/Agent speaking" / "Listening"
// text, so `setSpeaking()` must not clobber an active warning. Both warning
// setters funnel through the private `_syncWarningIndicator()` so that
// precedence is decided in exactly one place rather than at each call site.
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).

export function createUiRender(ctx) {
  const {
    el,
    state,
  } = ctx;

  function setSpeaking(who) {
    // A mic warning OR a stream warning takes priority over the ordinary
    // speaking indicator -- either one means something is actively wrong
    // with a live session and must not be silently overwritten by the next
    // routine "You/Agent speaking"/"Listening" update.
    if (el.speakingIndicator.dataset.micWarning || el.speakingIndicator.dataset.streamWarning) return;
    const el2 = el.speakingIndicator;
    el2.classList.remove("sprinkle-status-light--informative", "sprinkle-status-light--positive", "sprinkle-status-light--notice");
    if (who === "user") {
      el2.textContent = "You are speaking";
      el2.classList.add("sprinkle-status-light--positive");
    } else if (who === "agent") {
      el2.textContent = "Agent is speaking";
      el2.classList.add("sprinkle-status-light--informative");
    } else {
      el2.textContent = "Listening";
      el2.classList.add("sprinkle-status-light--notice");
    }
  }

  // Shared by setMicWarning()/setStreamWarning() below: recomputes
  // #im-speaking-indicator purely from which warning dataset flags are
  // currently set, so clearing ONE warning while the other is still active
  // can never incorrectly drop the negative styling or the wrong warning's
  // text (a bug the first version of this had -- each setter blindly
  // toggled the negative class off on its own `active=false`, which would
  // have erased a still-active OTHER warning's styling).
  function _syncWarningIndicator() {
    const el2 = el.speakingIndicator;
    const micActive = !!el2.dataset.micWarning;
    const streamActive = !!el2.dataset.streamWarning;
    if (micActive || streamActive) {
      el2.classList.add("sprinkle-status-light--negative");
      el2.classList.remove("sprinkle-status-light--informative", "sprinkle-status-light--positive", "sprinkle-status-light--notice");
      // Mic takes text priority when both are active -- it is the more
      // locally-actionable of the two (a hardware/OS-level issue on this
      // machine vs. a server-side connection issue).
      el2.textContent = micActive ? "Mic stalled — recovering…" : "Connection stalled — recovering…";
    } else {
      el2.classList.remove("sprinkle-status-light--negative");
    }
  }

  // Toolbar-level, always-in-view mic-stall warning (the point: last time
  // this failure was completely silent). setSpeaking() defers to this while
  // active, above. onRecovered/onStall in beginSession() drive this; onFatal
  // leaves it set through to stopInterview()'s move to the Review screen, so
  // it is never left showing with nothing behind it.
  function setMicWarning(active) {
    const el2 = el.speakingIndicator;
    if (active) el2.dataset.micWarning = "1";
    else delete el2.dataset.micWarning;
    _syncWarningIndicator();
    // Only fall back to the ordinary speaking indicator once BOTH warnings
    // are clear -- a stream stall active/clearing independently of this one
    // must not be clobbered.
    if (!active && !el2.dataset.micWarning && !el2.dataset.streamWarning) setSpeaking("idle");
  }

  // Same treatment as setMicWarning() above, for the receive-direction
  // counterpart (stream-watchdog.js) -- reuses the identical
  // sprinkle-status-light--negative styling and #im-speaking-indicator
  // element so an inbound-silence fault is exactly as unmissable as a mic
  // stall was. Kept as a distinct dataset flag (streamWarning, not
  // micWarning) so the two failure modes can be told apart in a DOM read,
  // and so clearing one never stomps on the other if both were ever active
  // at once.
  function setStreamWarning(active) {
    const el2 = el.speakingIndicator;
    if (active) el2.dataset.streamWarning = "1";
    else delete el2.dataset.streamWarning;
    _syncWarningIndicator();
    if (!active && !el2.dataset.micWarning && !el2.dataset.streamWarning) setSpeaking("idle");
  }

  function addChip(label, detail, isError) {
    const chip = document.createElement("span");
    chip.className = `sprinkle-badge sprinkle-badge--subtle sprinkle-badge--${isError ? "negative" : "informative"}`;
    chip.textContent = detail ? `${label}: ${detail}` : label;
    el.chipRow.appendChild(chip);
    while (el.chipRow.children.length > 8) el.chipRow.removeChild(el.chipRow.firstChild);
  }

  function renderTranscript() {
    renderTranscriptInto(el.transcript);
  }

  function renderTranscriptInto(container) {
    container.innerHTML = "";
    for (const entry of state.transcript.toJSON()) {
      const row = document.createElement("div");
      if (entry.role === "tool") {
        row.className = "im-transcript-entry im-transcript-entry--tool";
        row.innerHTML = `<span class="im-ts">${fmtMs(entry.t_ms)}</span>TOOL ${escapeHtml(entry.name)}${entry.query ? `: ${escapeHtml(entry.query)}` : ""}`;
      } else {
        row.className = `im-transcript-entry im-transcript-entry--${entry.role}`;
        const who = entry.role === "user" ? "You" : "Agent";
        row.innerHTML = `<span class="im-ts">${fmtMs(entry.t_start_ms)}</span><span class="im-who">${who}:</span> ${escapeHtml(entry.text)}`;
      }
      container.appendChild(row);
    }
    container.scrollTop = container.scrollHeight;
  }

  function fmtMs(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const ss = String(totalSeconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  return { setSpeaking, setMicWarning, setStreamWarning, addChip, renderTranscript, renderTranscriptInto, fmtMs, escapeHtml };
}
