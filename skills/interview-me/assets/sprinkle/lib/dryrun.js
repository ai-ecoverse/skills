// interview-me / dryrun.js
//
// Verification-only dry run, triggered on demand via:
//   sprinkle send interview-me '{"type":"dryrun"}'
// Extracted verbatim from interview-me.shtml; behaviour unchanged.
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).
//
// Takes the host's live bindings as an explicit context: the whole point of
// a dry run is to drive the REAL pipeline (the real `state`, the real
// `writeSessionArtifacts`), not a reconstruction of it.

export function createDryRun(ctx) {
  const {
    buildTools,
    buildInstructions,
    buildSessionConfig,
    TranscriptStore,
    finalizeSession,
    state,
    collectDiagnosticsEntries,
    writeSessionArtifacts,
    getSessionLengthMs,
  } = ctx;

  // --- Verification-only dry run, triggered on demand via:
  //   sprinkle send interview-me '{"type":"dryrun"}'
  // Exercises the transcript/session-metadata/file-writing pipeline with a
  // synthesized fake conversation, pushed through the REAL TranscriptStore
  // and the REAL writeSessionArtifacts() -- not a parallel reimplementation
  // -- so transcript.json/transcript.md/session.json, [mm:ss] formatting, and
  // the sessions/<ISO8601>/ directory layout can all be proven correct
  // without a microphone. Deliberately does NOT touch human.webm/agent.webm:
  // writeSessionArtifacts() already skips those when humanBlob/agentBlob are
  // null (no real media exists in a dry run), which is exactly the behavior
  // that path should have with nothing recorded -- fabricating fake video
  // bytes would prove nothing and could be mistaken for a real recording.
  async function runDryRun() {
    if (state.session && state.session.isOpen()) {
      window.__imDiag && window.__imDiag("dryrun-skipped", { reason: "a real interview is in progress" });
      return null;
    }

    const previous = {
      t0: state.t0,
      transcript: state.transcript,
      config: state.config,
      lastSessionConfig: state.lastSessionConfig,
      humanBlob: state.humanBlob,
      agentBlob: state.agentBlob,
      humanRecorder: state.humanRecorder,
      agentRecorder: state.agentRecorder,
      sessionDir: state.sessionDir,
      ended: state.ended,
    };

    try {
      const t0 = Date.now() - 21000; // pretend this fake interview started 21s ago
      const transcript = new TranscriptStore(t0);

      // Synthesized conversation, using the SAME store methods production
      // code calls -- cumulative user updates (replace, not append) and
      // incremental assistant deltas (append), a tool call, then a second
      // exchange. `TranscriptStore.now()` is `Date.now() - this.t0`, and this
      // whole function runs in a handful of real milliseconds, so calling the
      // store methods back-to-back would bake in the SAME timestamp for
      // every entry -- not "plausible timestamps". `at(elapsedMs)` fakes the
      // passage of time between synthesized turns by moving `t0` itself, so
      // each call below lands at the elapsed offset it names; `t0` is
      // restored to the real anchor before handoff to writeSessionArtifacts.
      const at = (elapsedMs) => {
        transcript.t0 = Date.now() - elapsedMs;
      };

      const u1 = "item_dryrun_u1";
      at(2200);
      transcript.setUserTranscript(u1, "Hi");
      at(2900);
      transcript.setUserTranscript(u1, "Hi there, I'm");
      at(3600);
      transcript.setUserTranscript(u1, "Hi there, I'm working on");
      at(4400);
      transcript.setUserTranscript(u1, "Hi there, I'm working on the interview-me sprinkle.");
      at(4600);
      transcript.markUserFinal(u1);

      const a1 = "item_dryrun_a1";
      at(5800);
      transcript.appendAssistantDelta(a1, "Nice ");
      at(6100);
      transcript.appendAssistantDelta(a1, "to meet you. ");
      at(6900);
      transcript.appendAssistantDelta(a1, "What got you started on it?");
      at(7000);
      transcript.markAssistantFinal(a1, "Nice to meet you. What got you started on it?");

      at(9200);
      transcript.logTool("lookup_documents", "SLICC vanilla JS philosophy");

      const u2 = "item_dryrun_u2";
      at(15100);
      transcript.setUserTranscript(u2, "Mostly");
      at(15800);
      transcript.setUserTranscript(u2, "Mostly because the user");
      at(16600);
      transcript.setUserTranscript(u2, "Mostly because the user wanted zero dependencies.");
      at(16800);
      transcript.markUserFinal(u2);

      const a2 = "item_dryrun_a2";
      at(18000);
      transcript.appendAssistantDelta(a2, "That tracks with everything else he builds. ");
      at(18900);
      transcript.appendAssistantDelta(a2, "Thanks for the interview!");
      at(19000);
      transcript.markAssistantFinal(a2, "That tracks with everything else he builds. Thanks for the interview!");

      transcript.t0 = t0; // restore the real session anchor before export

      const config = {
        voice: "eve",
        topic: "the interview-me sprinkle (DRY RUN -- synthesized, not a real interview)",
        kbMode: "collection",
        kbPath: null,
        // Synthetic placeholder id (no baked-in default ships). buildTools only
        // embeds it in vector_store_ids; the dry run never hits the network, so
        // this exercises the collection-mode path without a real collection.
        collectionId: "collection_dryrun_example",
        webSearch: true,
        xSearch: true,
      };
      const tools = buildTools(config);
      const instructions = buildInstructions({ topic: config.topic, sourceMaterial: "", sessionMinutes: getSessionLengthMs() / 60000 });
      const sessionConfig = buildSessionConfig({ voice: config.voice, instructions, tools });

      state.t0 = t0;
      state.transcript = transcript;
      state.config = config;
      state.lastSessionConfig = sessionConfig;
      state.humanBlob = null;
      state.agentBlob = null;
      state.humanRecorder = null;
      state.agentRecorder = null;
      state.ended = true; // this "session" is already over -- nothing live to protect

      const endedAt = t0 + 21000; // matches the anchor above -- a short ~21s exchange
      const durationMs = endedAt - t0;

      // The REAL production function -- not a reimplementation.
      await writeSessionArtifacts(endedAt, durationMs, "dryrun");

      const finalizeResult = await finalizeSession(slicc, {
        sessionDir: state.sessionDir,
        endReason: "dryrun",
        durationMs,
        transcriptEntries: transcript.toJSON(),
        diagnosticsEntries: collectDiagnosticsEntries(),
        humanBytes: null,
        agentBytes: null,
        // Same synthetic anchors this dry run already used for
        // writeSessionArtifacts()/session.json above -- diagnostics.json and
        // session.json must agree on the window.
        sessionStartMs: t0,
        sessionEndMs: endedAt,
      });
      window.__imDiag && window.__imDiag("session-finalize-result", finalizeResult);

      const dir = state.sessionDir;
      window.__imDiag && window.__imDiag("dryrun-complete", { dir, entries: transcript.toJSON().length });
      return dir;
    } finally {
      Object.assign(state, previous);
    }
  }

  return { runDryRun };
}
