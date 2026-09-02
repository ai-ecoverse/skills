// transcript-store.js
// Records every transcript event (user + assistant + tool) with
// millisecond offsets from a shared t0. Critically: the xAI user-transcript
// event (conversation.item.input_audio_transcription.updated) is CUMULATIVE,
// so `setUserTranscript` REPLACES the stored text for that item id — it
// never appends. Assistant transcript deltas ARE incremental and are
// appended.

export class TranscriptStore {
  constructor(t0 = Date.now()) {
    this.t0 = t0;
    this._byItemId = new Map(); // item_id -> entry (for replace-in-place updates)
    this.entries = []; // ordered log; includes user, assistant, and tool entries
  }

  now() {
    return Date.now() - this.t0;
  }

  _upsert(itemId, role) {
    let entry = this._byItemId.get(itemId);
    if (!entry) {
      entry = { role, text: "", t_start_ms: this.now(), t_end_ms: this.now(), item_id: itemId, final: false };
      this._byItemId.set(itemId, entry);
      this.entries.push(entry);
    }
    return entry;
  }

  /** conversation.item.input_audio_transcription.updated — REPLACE, never append. */
  setUserTranscript(itemId, cumulativeText) {
    const entry = this._upsert(itemId, "user");
    entry.text = cumulativeText;
    entry.t_end_ms = this.now();
    return entry;
  }

  markUserFinal(itemId) {
    const entry = this._byItemId.get(itemId);
    if (entry) entry.final = true;
  }

  /** Whether an entry already exists for this item_id (any role). */
  hasItem(itemId) {
    return this._byItemId.has(itemId);
  }

  /**
   * Records a `force_message` turn (a hard-coded, TTS-synthesized line the
   * client sent verbatim -- see RealtimeSession#sendForceMessage and
   * docs/speech-to-speech.md's "Force Message" section) using the EXACT
   * text the client sent, rather than whatever transcript event the
   * server does or doesn't emit for it.
   *
   * Real evidence, observed in a live session: the server's own response
   * lifecycle for a force_message fires
   * response.output_audio_transcript.done, but with an EMPTY transcript
   * string -- recording that verbatim produced a silent, content-free
   * assistant entry (len=0) AND a false-positive from the "response
   * produced no transcript" stream-watchdog check, which has no way to
   * know this was a scripted message rather than a dead turn. This also
   * corrected an earlier misdiagnosis in a separate session, where an
   * empty transcript entry near a wrap-up boundary had been attributed to
   * a stream stall -- it was actually this same wrap-up force_message.
   *
   * Correlating an item_id to the force_message that produced it has to
   * happen in the CALLER (interview-me.shtml) -- a force_message's
   * `conversation.item.create` carries no client-supplied id, so there is
   * nothing here to correlate against. This method only records; it
   * never decides which item_id is a force_message's.
   *
   * `forced: true` on the entry lets a consumer tell this apart from a
   * real generated turn -- see toMarkdown()'s "(scripted)" annotation.
   */
  recordForcedMessage(itemId, text) {
    const entry = this._upsert(itemId, "assistant");
    entry.text = typeof text === "string" ? text : "";
    entry.final = true;
    entry.forced = true;
    entry.t_end_ms = this.now();
    return entry;
  }

  /** response.output_audio_transcript.delta — incremental, append. */
  appendAssistantDelta(itemId, deltaText) {
    const entry = this._upsert(itemId, "assistant");
    entry.text += deltaText;
    entry.t_end_ms = this.now();
    return entry;
  }

  /** response.output_audio_transcript.done — final text (used if longer than the accumulated deltas). */
  markAssistantFinal(itemId, finalText) {
    const entry = this._upsert(itemId, "assistant");
    if (typeof finalText === "string" && finalText.length > entry.text.length) {
      entry.text = finalText;
    }
    entry.final = true;
    entry.t_end_ms = this.now();
    return this._maybeMergeContinuation(entry) || entry;
  }

  /**
   * xAI sometimes re-emits an assistant turn's transcript under a brand-new
   * item id after tool calls resolve (same conversational turn, same text,
   * different item_id) — observed in a real session where an opening
   * greeting was finalized twice, 9s apart, with two collections_search
   * calls in between. Recorded verbatim, that reads as the interviewer
   * repeating itself, which it did not do.
   *
   * The re-emission is not always byte-identical, either — observed live,
   * mid-interview, in another real session: a 319-char question finalized
   * under one item id, then TWO collections_search calls, then the "same"
   * question re-emitted under a brand-new item id but cut off mid-word at
   * 105 chars. Recorded verbatim, that is the agent audibly asking the
   * same question twice, the second time truncated — exactly what was
   * heard live and flagged.
   *
   * Detect both shapes at record time: once an assistant entry finishes,
   * look back across any purely-tool entries (no intervening user turn)
   * for the most recent *other*, already-final assistant entry. If the
   * two texts are identical, OR one is a (trimmed) prefix of the other,
   * this is a continuation/re-emission of the same utterance, not a new
   * one — merge them, keeping whichever text is actually longer/more
   * complete (regardless of which item id it arrived under) and the
   * EARLIER entry's t_start_ms/item_id, since that is when the agent
   * actually started speaking and the identity the rest of the app
   * already knows this turn by.
   *
   * Deliberately narrow: any intervening user entry stops the backward scan
   * immediately, so genuine short repeats ("Go on." ... user ... "Go on.")
   * are never touched — they are two distinct turns, not one re-emitted turn.
   * The prefix check also requires BOTH trimmed texts to be non-empty, so
   * an unrelated empty entry (e.g. a force_message — see
   * recordForcedMessage() — trivially "prefixes" everything as an empty
   * string) can never be misread as a truncated repeat of whatever
   * preceded it.
   */
  _maybeMergeContinuation(entry) {
    const idx = this.entries.indexOf(entry);
    if (idx <= 0) return null;
    let i = idx - 1;
    while (i >= 0 && this.entries[i].role === "tool") i--;
    if (i < 0) return null;
    const prev = this.entries[i];
    if (prev === entry || prev.role !== "assistant") return null;
    if (prev.item_id === entry.item_id) return null;
    if (!prev.final) return null;

    const prevText = prev.text.trim();
    const entryText = entry.text.trim();
    const isExactMatch = prevText === entryText;
    const isPrefixMatch = !isExactMatch && !!prevText && !!entryText && (prevText.startsWith(entryText) || entryText.startsWith(prevText));
    if (!isExactMatch && !isPrefixMatch) return null;

    // Keep whichever text is actually longer/more complete. For an exact
    // match this is a no-op (identical either way); for a prefix match,
    // the fuller version is what a human should see, whichever item id it
    // happened to land under.
    const survivorText = entry.text.length > prev.text.length ? entry.text : prev.text;

    this.entries.splice(idx, 1);
    this._byItemId.delete(entry.item_id);
    // If any further event ever arrives for the merged-away item id (it
    // shouldn't, once .done has fired), route it to the surviving entry
    // rather than resurrecting a duplicate.
    this._byItemId.set(entry.item_id, prev);
    prev.text = survivorText;
    prev.t_end_ms = Math.max(prev.t_end_ms, entry.t_end_ms);
    prev.merged_item_ids = prev.merged_item_ids || [prev.item_id];
    prev.merged_item_ids.push(entry.item_id);
    return prev;
  }

  /** Tool invocation log: {role:"tool", name, query, t_ms}. */
  logTool(name, query, extra) {
    const entry = Object.assign({ role: "tool", name, query, t_ms: this.now() }, extra || {});
    this.entries.push(entry);
    return entry;
  }

  toJSON() {
    return this.entries.slice();
  }

  toMarkdown() {
    // Tool-call events for a server-side search (file_search etc) arrive
    // right around when the assistant turn they INFORMED finishes -- see
    // realtime-session.js's own header note: "tool calls arrive at/around
    // response.done, after all audio deltas". Recorded in entries[] in
    // that arrival order, which reads backwards in a human transcript:
    // "assistant answers a question... THEN searches for it", when the
    // search is what actually informed that very answer (real evidence:
    // a "collections_search" tool entry timestamped to the exact
    // millisecond the preceding assistant entry's t_end_ms landed on).
    // Build a DISPLAY order for Markdown
    // ONLY here -- transcript.json (this.entries, untouched) stays the
    // faithful, real event-arrival-order record -- that moves a tool
    // entry immediately following an assistant entry to render just
    // BEFORE that assistant entry, whenever the tool's own timestamp is
    // at-or-before that assistant entry's t_end_ms (i.e. it is not
    // clearly a later, unrelated event with no real connection to that
    // turn).
    const displayEntries = [];
    for (const e of this.entries) {
      if (e.role === "tool") {
        const prevDisplay = displayEntries[displayEntries.length - 1];
        if (prevDisplay && prevDisplay.role === "assistant" && e.t_ms <= prevDisplay.t_end_ms) {
          displayEntries.splice(displayEntries.length - 1, 0, e); // insert just before that assistant entry
          continue;
        }
      }
      displayEntries.push(e);
    }

    const lines = [];
    for (let i = 0; i < displayEntries.length; i++) {
      const e = displayEntries[i];
      if (e.role === "tool") {
        const prev = displayEntries[i - 1];
        // Two identical tool calls fired back-to-back for the same turn
        // (observed: collections_search called twice, same empty query, 3ms
        // apart) are collapsed here for readability. transcript.json is left
        // untouched — it stays a faithful record of what actually happened.
        if (prev && prev.role === "tool" && prev.name === e.name && (prev.query || "") === (e.query || "")) {
          continue;
        }
        lines.push(`[${fmt(e.t_ms)}] TOOL ${e.name}${e.query ? `: ${e.query}` : ""}`);
        continue;
      }
      const label = e.role === "user" ? "USER" : "AGENT";
      // Marks a recordForcedMessage() entry (a force_message, e.g. the
      // wrap-up fallback line) as scripted rather than a real generated
      // turn -- so a human reading transcript.md can tell them apart
      // without cross-referencing transcript.json's `forced` field.
      const forcedNote = e.role === "assistant" && e.forced ? " (scripted)" : "";
      lines.push(`[${fmt(e.t_start_ms)}] ${label}${forcedNote}: ${e.text}`);
    }
    return lines.join("\n");
  }
}

function fmt(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
