// interview-me / session-start.js
//
// Everything involved in STARTING an interview: reading the setup form
// (`gatherConfig`), the Start-button flow (`onStartInterview`), building the
// live session (`beginSession`: getUserMedia, the AudioContext graph, the
// mic AudioWorklet, both MediaRecorders, the realtime WebSocket, the mic and
// stream watchdogs and the wrap-up controller), and the realtime event
// wiring (`wireSessionHooks`). Extracted verbatim from interview-me.shtml;
// behaviour unchanged.
//
// THINGS IN HERE THAT ARE LOAD-BEARING (each fixed a real, observed bug):
//   * `localFunctionNames` is derived from the session's own `tools` array
//     (`t.type === "function"`), never hardcoded. It is an ALLOW-list: any
//     function-call event whose name is NOT ours is a SERVER-side tool
//     (`file_search` arrives as `collections_search`) and must never be
//     answered, or the reply settles the in-flight count and triggers an
//     unsolicited `response.create` that pre-empts the user's turn.
//   * The force_message correlation (`state.pendingForceMessageText` ->
//     `claimForceMessageItem`) claims the next brand-new assistant item id
//     as the scripted wrap-up line, which is what keeps an empty forced
//     transcript out of the stream watchdog's empty-response check.
//   * `state.sessionLengthMs` is snapshotted at the top of `beginSession`, so
//     a mid-interview config push can never move a running deadline.
//
// `sessionLengthMs` is a host-scope `let` (a CLI config push mutates it), so
// it crosses as a getter rather than a destructured copy.
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).

import { BASE_DIR } from "./constants.js";

export function createSessionStart(ctx) {
  const {
    LIB_DIR,
    AudioPlayer,
    RealtimeSession,
    buildTools,
    buildInstructions,
    buildSessionConfig,
    TranscriptStore,
    createHumanRecorder,
    createAgentRecorder,
    createChunkFlusher,
    prepareMultiCamRecording,
    PARTS_ROOT,
    getSessionsRoot,
    safeDiag,
    mintEphemeralToken,
    int16ToBase64,
    createMicWatchdog,
    createStreamWatchdog,
    createWrapupController,
    wrapupOffsetMs,
    WRAP_UP_MESSAGE,
    WRAP_UP_TIME_CHECK_CALL_ID,
    WRAP_UP_TIME_CHECK_PAYLOAD,
    WRAP_UP_DIRECTIVE,
    SILENCE_SUSTAIN_MS,
    WRAP_UP_FALLBACK_DELAY_MS,
    appendWrapupDirective,
    MODEL,
    withTimeout,
    el,
    state,
    uiState,
    setSpeaking,
    setMicWarning,
    setStreamWarning,
    addChip,
    renderTranscript,
    safeAttachCameraPreview,
    describePreviewFailure,
    stopLevelMeterTest,
    stopPreviewCameras,
    startCountdown,
    startWaveforms,
    stopInterview,
    showScreen,
    getSessionLengthMs,
  } = ctx;

  function gatherConfig() {
    const parseList = (value, max) =>
      value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, max);

    const kbMode = el.kbMode.value === "local" ? "local" : "collection";
    return {
      topic: el.brief.value,
      kbMode,
      kbPath: el.kbPath.value.trim() || `${BASE_DIR}/kb/`,
      collectionId: kbMode === "collection" ? el.collectionSelect.value || null : null,
      webSearch: el.webSearch.checked,
      xSearch: el.xSearch.checked,
      webAllowedDomains: parseList(el.webDomains.value, 5),
      xAllowedHandles: parseList(el.xHandles.value, 20),
      voice: el.voice.value || "eve",
      micDeviceId: el.micSelect.value || undefined,
      camDeviceId: el.camSelect.value || undefined,
    };
  }

  async function onStartInterview() {
    el.startBtn.disabled = true;
    el.setupStatus.textContent = "Preparing session…";
    const config = gatherConfig();
    state.config = config;
    stopLevelMeterTest();
    // Preview-only cleanup: stop the extra camera streams opened for the grid
    // so they are not left lit while recording. Does NOT touch the recording
    // path -- beginSession() below re-acquires its own hero stream from
    // config.camDeviceId and never reads state.previewCameras.
    if (typeof stopPreviewCameras === "function") stopPreviewCameras();

    try {
      // Re-acquire the shared MIC (audio only) pinned to the chosen device.
      // The CAMERAS are opened inside beginSession() via the shared
      // multi-camera setup -- opening the hero here too would open the same
      // device twice. This mic track is the ONE the realtime session, the
      // mic-watchdog AND every camera recorder share.
      const audioConstraint = config.micDeviceId ? { deviceId: { exact: config.micDeviceId } } : true;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      } catch (err) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (state.rawStream) state.rawStream.getTracks().forEach((t) => t.stop());
      state.rawStream = stream;

      if (config.kbMode === "local") {
        el.setupStatus.textContent = "Loading knowledge base…";
        await state.kb.loadFromDir(
          config.kbPath,
          (p) => slicc.readDir(p),
          (p) => slicc.readFile(p)
        );
        el.kbStatus.textContent = state.kb.isEmpty()
          ? "No documents found at that path — continuing with search tools only."
          : `Loaded ${state.kb.files.length} document(s): ${state.kb.files.map((f) => f.filename).join(", ")}`;
      }

      el.setupStatus.textContent = "Minting ephemeral token…";
      const token = await withTimeout(mintEphemeralToken((cmd) => slicc.exec(cmd), 280), 15000, "mintEphemeralToken");

      el.setupStatus.textContent = "Connecting…";
      await beginSession(config, token.value);
    } catch (err) {
      el.setupStatus.textContent = `Failed to start: ${err.message}`;
      el.startBtn.disabled = false;
      // A timed-out session.connect() abandons our WAIT for the WebSocket,
      // not the WebSocket itself -- it can still open later, with hooks
      // already wired, and start feeding transcript/audio state for a
      // session the UI thinks never started. Tear it down defensively.
      // Detach onClose first so this deliberate cleanup close doesn't cascade
      // into a full stopInterview() for an interview that never began (no
      // recorders were ever created at this point in the failure path).
      if (state.session) {
        state.session.onClose = null;
        state.session.close();
        state.session = null;
      }
      // Deliberate, small deviation from ui-state-INTEGRATION.md's stated
      // assumption that "this path runs before beginSession() ever calls
      // markSessionStarted()": that's only true for failures during token
      // minting (before beginSession() is even invoked). beginSession()
      // itself calls markSessionStarted() as its FIRST line, before
      // session.connect() -- so a connect timeout (exactly the case the
      // comment above this one is about) throws back into THIS catch block
      // with the marker already set, and nothing recorded (recorders are
      // only start()ed after a successful connect). Clearing here
      // unconditionally is a safe no-op when no marker was ever set
      // (clearSession() just re-saves session:null) and prevents a false
      // "recording was interrupted" report next load for an interview that
      // never actually started recording anything.
      uiState.clearSession();
    }
  }

  async function beginSession(config, ephemeralToken) {
    state.t0 = Date.now();
    // Mark a recording as in-flight, as early as possible (before any of
    // the WebSocket/AudioContext/recorder setup below, all of which can
    // fail or the panel can be resized mid-setup) -- this is the durable
    // record that survives a re-render and lets init()'s restore() tell the
    // user plainly "a recording was interrupted" instead of a pristine
    // Setup screen. Directory formula MUST match writeSessionArtifacts()'s
    // `dir` exactly (see that function) -- same source of truth, not a
    // second one.
    const sessionDirForMarker = `${getSessionsRoot()}/${new Date(state.t0).toISOString().replace(/[:.]/g, "-")}`;
    await uiState.markSessionStarted({ sessionDir: sessionDirForMarker, startedAt: state.t0 });
    state.transcript = new TranscriptStore(state.t0);
    state.ended = false;
    state.pendingForceMessageText = null;
    state.forceMessageItemIds = new Set();
    // Snapshot the current (possibly config.json/CLI-configured) session
    // length for THIS session -- see the comment by `let sessionLengthMs`
    // above. A config push arriving mid-interview must never move the
    // deadline of a session already running.
    state.sessionLengthMs = getSessionLengthMs();

    // --- Audio graph: mic capture (worklet -> PCM16) + playback (scheduled queue) ---
    const audioCtx = new AudioContext({ sampleRate: 24000 });
    state.audioCtx = audioCtx;

    // Watchdog for the failure mode that killed the first real interview:
    // the browser suspends this AudioContext on a visibility/occlusion/focus
    // change, the worklet stops posting chunks, and session.appendAudio(...)
    // silently stops being called -- nothing throws, nothing closes. Attached
    // immediately (before audioWorklet.addModule/connect below) so even a
    // suspend during setup gets logged; auto-resume attempts themselves only
    // fire once the watchdog is start()ed, further down.
    const micWatchdog = createMicWatchdog({
      onStall: (info) => {
        addChip("mic stalled", `${Math.round(info.sinceLastFrameMs / 1000)}s no audio`, true);
        setMicWarning(true);
      },
      onRecovered: (info) => {
        addChip("mic recovered", `after ${Math.round(info.stalledForMs / 1000)}s`);
        setMicWarning(false);
      },
      onFatal: (info) => {
        addChip("mic failed", info.reason, true);
        setMicWarning(true);
        stopInterview("mic-watchdog-fatal");
      },
      onDiagnostic: () => {
        state.micWatchdogEvents = micWatchdog.getEvents(); // cheap; kept current for writeSessionArtifacts()
      },
    });
    state.micWatchdog = micWatchdog;
    micWatchdog.attachAudioContext(audioCtx);
    micWatchdog.attachStream(state.rawStream);

    // Receive-direction counterpart to micWatchdog above: watches for the
    // failure that killed the SECOND real interview, where the socket
    // stayed open (no close/error event) but the SERVER stopped sending
    // anything -- see stream-watchdog.js's header for the transcript.json
    // gap measurements behind its threshold. Constructed here (before
    // session.connect() below) so attachSession() can be called as soon as
    // the session object exists; started once the connection is actually
    // live, alongside micWatchdog.start() further down.
    const streamWatchdog = createStreamWatchdog({
      onStall: (info) => {
        addChip("stream stalled", `${Math.round(info.sinceLastEventMs / 1000)}s no server events`, true);
        setStreamWarning(true);
      },
      onRecovered: (info) => {
        addChip("stream recovered", `after ${Math.round(info.stalledForMs / 1000)}s`);
        setStreamWarning(false);
      },
      onFatal: (info) => {
        addChip("stream failed", info.reason, true);
        setStreamWarning(true);
        stopInterview("stream-stalled");
      },
      onEmptyResponse: (info) => {
        addChip("empty response", info.itemId ? `item ${info.itemId}` : "no transcript text", true);
      },
      onDiagnostic: () => {
        state.streamWatchdogEvents = streamWatchdog.getEvents(); // cheap; kept current for collectDiagnosticsEntries()
      },
    });
    state.streamWatchdog = streamWatchdog;

    // Graceful wrap-up instead of a blind timer -- see WRAP_UP_MESSAGE/
    // WRAP_UP_DIRECTIVE/WRAP_UP_FALLBACK_DELAY_MS's own comments and
    // wrapup-controller.js's header for the two real failures this fixes
    // (round 1, a recorded session: a force_message barged
    // in mid-sentence; round 2, a recorded session: the
    // first fix's own directive-deferral lost a race against the model's
    // next turn). Constructed here, before `session` exists, is fine --
    // every callback below reads state.session/state.lastSessionConfig/
    // state.player at CALL time (poll() is only ever invoked from
    // startCountdown()'s tick, itself only started at the very end of this
    // function once everything is live), not at construction time.
    const wrapupController = createWrapupController({
      wrapAtMs: state.sessionLengthMs - wrapupOffsetMs(state.sessionLengthMs),
      fallbackDelayMs: WRAP_UP_FALLBACK_DELAY_MS,
      silenceSustainMs: SILENCE_SUSTAIN_MS,
      sendTimeCheck: () => {
        // the user's preferred framing (verified against the live API): the
        // time check as information the agent RECEIVED, via a genuine
        // conversation.item.create/function_call_output with a synthetic
        // call_id -- no preceding function call. Never touches
        // _inFlightCalls/onToolCallsSettled (RealtimeSession#sendFunctionCallOutput
        // is a raw, one-off send, same call this file already uses for
        // real tool results) -- this is not a real tool call, it's a
        // narrow, deliberate (if undocumented) use of the same wire shape.
        // See WRAP_UP_DIRECTIVE's own comment for why the documented
        // session.update backstop is ALSO always sent alongside this.
        if (state.session && state.session.isOpen()) {
          state.session.sendFunctionCallOutput(WRAP_UP_TIME_CHECK_CALL_ID, WRAP_UP_TIME_CHECK_PAYLOAD);
        }
      },
      sendDirective: () => {
        // Append-only: keep the real interview instructions intact, add
        // the closing directive after them. This is a session.update, so
        // it only takes effect for responses generated from here on --
        // it can never retroactively affect (or interrupt) whatever is
        // already in flight, and (unlike a force_message) it never speaks,
        // so it is called by WrapupController UNCONDITIONALLY at the
        // threshold -- there is nothing here that needs to wait for the
        // user to stop talking. Recorded back onto state.lastSessionConfig
        // so session.json's own copy of the sent config reflects what was
        // ACTUALLY in effect for the rest of the session, not just the
        // original.
        const current = (state.lastSessionConfig && state.lastSessionConfig.instructions) || "";
        const updated = appendWrapupDirective(current, WRAP_UP_DIRECTIVE);
        if (state.lastSessionConfig) state.lastSessionConfig.instructions = updated;
        if (state.session && state.session.isOpen()) {
          state.session.updateSession({ instructions: updated });
        }
        addChip("wrap-up", "asked the model to close after your next answer");
      },
      sendFallbackMessage: () => {
        // Last resort only -- see WRAP_UP_FALLBACK_DELAY_MS's comment.
        // Unlike the directive above, THIS one speaks -- WrapupController's
        // own poll() defers it indefinitely while the user is talking, and
        // never reaches here until they've stopped.
        if (state.session && state.session.isOpen()) {
          state.session.sendForceMessage(WRAP_UP_MESSAGE, true);
          // Sets up claimForceMessageItem() (see wireSessionHooks()) to
          // record the NEXT brand-new assistant item id under this exact
          // text, instead of whatever (possibly empty) transcript event
          // the server sends for it -- see recordForcedMessage()'s doc
          // comment in transcript-store.js for why.
          state.pendingForceMessageText = WRAP_UP_MESSAGE;
        }
        addChip("wrap-up fallback", "closing line sent (no natural close yet)", true);
      },
      onClosingTurnComplete: () => {
        // Fired for EITHER a natural model-driven close or the fallback's
        // own force_message completing -- both mean "the interview has now
        // been wound down". Wait for the agent's own audio to finish
        // actually PLAYING (response.done only means generation finished,
        // not that playback has drained -- see AudioPlayer#waitForDrain,
        // the same pattern onToolCallsSettled already uses below) before
        // ending, and re-check user speech state at that later point (not
        // the state at the moment this callback fired) in case the user
        // started talking again during the wait -- never cut them off.
        addChip("wrap-up", "closing turn complete");
        (state.player ? state.player.waitForDrain() : Promise.resolve()).then(() => {
          if (!state.ended && !wrapupController.getStatus().userSpeaking) {
            stopInterview("wrapped-up");
          }
        });
      },
      onSustainedSilence: () => {
        // The OTHER route to the same clean end -- for a session where the
        // model never produces anything WrapupController recognises as a
        // deliberate closing turn, but the conversation has gone quiet
        // (nobody speaking, nothing generating, nothing still playing) for
        // SILENCE_SUSTAIN_MS regardless. By construction (see poll()) this
        // callback only ever fires once already-drained/not-speaking/
        // nothing-in-flight has held continuously -- there is nothing left
        // to wait on, so this stops immediately rather than re-checking
        // anything the way onClosingTurnComplete above has to.
        addChip("wrap-up", "ended on sustained silence");
        if (!state.ended) {
          stopInterview("wrapped-up");
        }
      },
      onDiagnostic: () => {
        state.wrapupControllerEvents = wrapupController.getEvents(); // cheap; kept current for collectDiagnosticsEntries()
      },
    });
    state.wrapupController = wrapupController;

    // AudioWorklet has its OWN module loader with the same network-resolution
    // problem as the main document (see the loader comment near the top of
    // this file) -- so it also needs a Blob URL, not a network URL.
    const workletBlobUrl = await window.__imLoadModule(`${LIB_DIR}/mic-worklet.js`);
    await audioCtx.audioWorklet.addModule(workletBlobUrl);

    const micSource = audioCtx.createMediaStreamSource(state.rawStream);
    const micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 1024;
    micSource.connect(micAnalyser);
    state.micAnalyser = micAnalyser;

    const workletNode = new AudioWorkletNode(audioCtx, "mic-capture-processor", {
      processorOptions: { sampleRate: audioCtx.sampleRate },
    });
    micSource.connect(workletNode);
    state.micWorkletNode = workletNode;
    state.micSourceNode = micSource;

    const player = new AudioPlayer(audioCtx, 24000);
    state.player = player;

    // --- Cameras + recorders (multi-camera) ------------------------------
    // Open the hero + every additional video-input device through the SHARED
    // multi-camera setup (lib/multicam-record.js) -- the SAME code the
    // capture-verify harness proves. The hero records to human.webm exactly as
    // before; additional angles record to video/angleN.webm. The ONE mic track
    // already on state.rawStream (which the realtime session and mic-watchdog
    // also tap) is muxed into every file -- it is NOT re-opened here, so none
    // of those three consumers is starved. NEVER throws out of beginSession:
    // a camera failure falls back to audio-only, just like the no-camera path.
    const partsRoot = `${PARTS_ROOT}/${new Date(state.t0).toISOString().replace(/[:.]/g, "-")}`;
    state.partsRoot = partsRoot;
    const sharedAudioTrack = state.rawStream ? state.rawStream.getAudioTracks()[0] || null : null;
    state.sharedAudioTrack = sharedAudioTrack;

    let videoDevices = [];
    try {
      const devices = await withTimeout(navigator.mediaDevices.enumerateDevices(), 8000, "enumerateDevices");
      videoDevices = devices.filter((d) => d.kind === "videoinput");
    } catch (err) {
      safeDiag("multicam:enumerate-failed", { message: err && err.message });
    }

    let multicam = null;
    try {
      multicam = await prepareMultiCamRecording({
        videoDevices,
        sharedAudioTrack,
        heroDeviceId: config.camDeviceId,
        partsRoot,
        slicc,
      });
    } catch (err) {
      safeDiag("multicam:setup-failed-audio-only", { message: err && err.message });
      multicam = null;
    }

    if (multicam) {
      state.multicam = multicam;
      state.humanRecorder = multicam.heroRecorder;
      state.cameras = multicam.cameras; // additional angles only (hero -> human.webm)
      state.flushers = multicam.flushers; // { human, angle1, ... }
      state.hasVideo = multicam.opened.length > 0;
      safeDiag("multicam:prepared", { opened: multicam.opened.length, angles: multicam.cameras.length, failures: multicam.failures.length });
    } else {
      // Hard fallback: audio-only hero recorder (mic only), no angles -- the
      // audio-only path, identical to a session with no camera.
      state.multicam = null;
      state.humanRecorder = createHumanRecorder(new MediaStream(sharedAudioTrack ? [sharedAudioTrack] : []));
      state.cameras = [];
      state.flushers = {};
      state.hasVideo = false;
      try {
        state.flushers.human = createChunkFlusher({ slicc, withTimeout, partsDir: `${partsRoot}/human`, name: "human", onDiagnostic: safeDiag });
        state.humanRecorder.attachFlusher(state.flushers.human);
      } catch (err) {
        safeDiag("chunk-flush:setup-failed", { message: err && err.message });
      }
    }

    // Agent recorder (the TTS playback capture) is session-specific, not a
    // camera -- created here and its flusher merged into whatever flusher set
    // the multi-camera setup produced.
    // MEASURED, and the reason recording streams to part files at all: retaining
    // chunk Blobs costs ~0 JS heap (260 MB of Blobs -> +0 MB), whereas
    // `await blob.arrayBuffer()` on a whole recording costs its full size in one
    // step (+260 MB), and five whole-file writes concurrently drove the heap to
    // 3138 MB of a 4192 MB limit. Parts (under PARTS_ROOT, /tmp, never inside
    // sessions/) let writeSessionArtifacts assemble each file without ever
    // materialising it, which is what makes five angles affordable.
    state.agentRecorder = createAgentRecorder(player.stream);
    try {
      state.flushers.agent = createChunkFlusher({ slicc, withTimeout, partsDir: `${partsRoot}/agent`, name: "agent", onDiagnostic: safeDiag });
      state.agentRecorder.attachFlusher(state.flushers.agent);
    } catch (err) {
      safeDiag("chunk-flush:setup-failed", { message: err && err.message, which: "agent" });
    }

    // --- Knowledge base / tools / instructions ---
    // Default path: file_search against the chosen collection (server-side,
    // no local excerpt injection needed). Fallback path (kbMode === "local"):
    // BM25-ranked excerpts injected into instructions + lookup_documents tool.
    const sourceMaterial = config.kbMode === "local" ? state.kb.sourceMaterial(config.topic || "the interview topic") : "";
    // sessionMinutes comes from the same per-session snapshot the countdown
    // and WrapupController use (never the live, CLI-pushable `sessionLengthMs`),
    // so the prompt's stated duration cannot disagree with the deadline this
    // interview is actually running to -- see buildInstructions() in tools.js.
    const instructions = buildInstructions({
      topic: config.topic,
      sourceMaterial,
      sessionMinutes: state.sessionLengthMs / 60000,
    });
    const tools = buildTools(config);
    const sessionConfig = buildSessionConfig({ voice: config.voice, instructions, tools });
    state.lastSessionConfig = sessionConfig;

    // --- Realtime session ---
    // localFunctionNames: the ONLY function-call names that are genuinely
    // ours to answer -- everything else RealtimeSession sees via
    // response.function_call_arguments.done is a SERVER-SIDE tool
    // (file_search/collections_search, web_search, x_search, mcp, etc) that
    // the server continues on its own. Derived directly from `tools` (this
    // session's REAL declared tools, built two lines above) rather than any
    // hardcoded name list -- see RealtimeSession#isLocalFunction's own doc
    // comment for the full failure chain replying to a server tool caused
    // (duplicate/truncated assistant turns, lost user answers, an
    // unexplained response-generation gap).
    const localFunctionNames = tools.filter((t) => t.type === "function").map((t) => t.name);
    const session = new RealtimeSession({ model: MODEL, localFunctionNames });
    state.session = session;
    wireSessionHooks(session);
    streamWatchdog.attachSession(session);

    // WebSocket connect() only resolves/rejects on the browser's own 'open'/
    // 'error' events; a network black hole (silently dropped packets, a dead
    // proxy) fires neither, and this await would otherwise hang forever with
    // "Connecting…" stuck on screen. Every other network-touching call in
    // this file is already timeout-wrapped -- this one was missed.
    await withTimeout(session.connect(ephemeralToken), 15000, "session.connect");
    session.updateSession(sessionConfig);

    // Kick off audio streaming to the server.
    workletNode.port.onmessage = (event) => {
      if (event.data && event.data.type === "chunk") {
        const int16 = new Int16Array(event.data.buffer);
        session.appendAudio(int16ToBase64(int16));
        micWatchdog.noteFrameAppended();
      }
    };
    micWatchdog.start();
    streamWatchdog.start();

    // Start every recorder in ONE synchronous loop and arm each fps meter in
    // that same loop (multicam.startAll), so per-angle offsetMs is measured
    // from the RECORDING phase, not from sequential open latency (that bug
    // produced a bogus 2393 ms spread, fixed to ~63 ms). The agent recorder is
    // included so it starts in the same tick. Audio-only fallback: no meters,
    // just start the two recorders.
    if (state.multicam) {
      const startInfo = state.multicam.startAll([state.agentRecorder]);
      state.recorderStartWall = startInfo.startWall;
      state.recorderStartSpreadMs = startInfo.startSpreadMs;
    } else {
      state.humanRecorder.start();
      state.agentRecorder.start();
    }

    showScreen("live");
    // Countdown and waveforms must start regardless of whether the live
    // self-view preview ever renders -- the SAME hang risk as the Setup
    // screen's preview applies here, and blocking on it would silently
    // break the five-minute hard stop for an actual recording session. The
    // preview attach happens after, isolated and non-blocking.
    startCountdown();
    startWaveforms();
    // Live self-view shows the HERO camera. state.rawStream is now mic-only,
    // so attach the hero's video track (from the multi-camera open) instead;
    // audio-only fallback has no hero, so there is simply no self-view video.
    const heroTrack = state.multicam && state.multicam.heroOpened ? state.multicam.heroOpened.track : null;
    const liveStream = heroTrack ? new MediaStream([heroTrack]) : state.rawStream;
    const previewResult = await safeAttachCameraPreview(el.liveVideo, liveStream, "live-screen");
    if (!previewResult.ok) {
      addChip("preview", describePreviewFailure(previewResult), true);
    }
  }

  function wireSessionHooks(session) {
    // Response-lifecycle diagnostics only (per the user's ask after a real
    // session showed an unexplained 59s gap between a user question and the
    // agent's reply, with the stream watchdog never firing -- i.e. inbound
    // events kept arriving, but response GENERATION itself was slow or
    // stalled, and there isn't enough evidence yet to say why). Not a fix --
    // just logs response.created/response.done with each response's id,
    // output item ids, and (on .done) how long that response took from its
    // own .created to .done, into the same window.__IM_DIAG__ stream
    // everything else in this file uses, which flows into this session's
    // diagnostics.json via collectDiagnosticsEntries(). Local to one
    // wireSessionHooks() call, i.e. reset fresh every beginSession().
    const responseCreatedAt = new Map(); // response_id -> Date.now() at response.created
    const summarizeResponse = (data) => {
      const response = data && data.response;
      const outputItemIds = Array.isArray(response && response.output) ? response.output.map((item) => item && item.id).filter(Boolean) : [];
      return { responseId: (response && response.id) || null, outputItemIds };
    };
    session.onResponseCreated = (data) => {
      const { responseId, outputItemIds } = summarizeResponse(data);
      if (responseId) responseCreatedAt.set(responseId, Date.now());
      window.__imDiag && window.__imDiag("response-created", { responseId, outputItemIds });
      if (state.wrapupController) state.wrapupController.noteResponseCreated();
    };

    session.onError = (err) => {
      addChip("error", (err && err.message) || "error", true);
    };

    // Previously unwired: RealtimeSession defines onClose but nothing here
    // ever assigned it, so a connection that died mid-interview (network
    // drop, server-side close, token expiry) left the UI silently frozen --
    // countdown and speaking indicator kept showing stale state with no
    // signal anything was wrong. `state.ended` distinguishes an unexpected
    // close from the one we ourselves trigger via session.close() in
    // stopInterview() (which already sets state.ended = true first).
    session.onClose = (event) => {
      window.__imDiag && window.__imDiag("session-closed", { code: event && event.code, reason: event && event.reason, wasClean: event && event.wasClean, alreadyEnded: state.ended });
      if (state.ended) return; // our own intentional close during stopInterview
      addChip("connection closed", event && event.reason ? event.reason : "unexpected", true);
      setSpeaking("idle");
      stopInterview("connection-closed");
    };

    session.onSpeechStarted = () => {
      setSpeaking("user");
      if (state.player) state.player.flush(); // barge-in
      if (state.wrapupController) state.wrapupController.noteUserSpeechStarted();
    };
    session.onSpeechStopped = (data) => {
      setSpeaking("idle");
      if (state.wrapupController) state.wrapupController.noteUserSpeechStopped();
      // No dedicated "user transcript final" event exists in this API (only
      // the cumulative .updated) -- speech_stopped's item_id (when present;
      // OpenAI-compatible events carry one) is the closest real signal that a
      // user turn is settled. Previously unwired: markUserFinal existed on
      // TranscriptStore but nothing ever called it, so `final` stayed false
      // for every user entry regardless of what actually happened.
      if (data && data.item_id) {
        state.transcript.markUserFinal(data.item_id);
        renderTranscript();
      }
    };

    session.onUserTranscriptUpdated = (itemId, text) => {
      state.transcript.setUserTranscript(itemId, text); // CUMULATIVE — replace, never append
      renderTranscript();
    };

    session.onAssistantTranscriptDelta = (itemId, delta) => {
      if (claimForceMessageItem(itemId)) return; // see claimForceMessageItem()'s doc comment
      state.transcript.appendAssistantDelta(itemId, delta);
      setSpeaking("agent");
      renderTranscript();
      if (state.streamWatchdog) state.streamWatchdog.noteAssistantDelta(itemId);
    };
    session.onAssistantTranscriptDone = (itemId, text) => {
      if (claimForceMessageItem(itemId)) return; // see claimForceMessageItem()'s doc comment
      state.transcript.markAssistantFinal(itemId, text);
      renderTranscript();
      // Flags the exact shape of the real failure's 4:30 entry: a response
      // that settled with no delta ever received and no final text either.
      // A force_message's own empty .done is excluded from ever reaching
      // here (claimForceMessageItem() above returns before this runs), so
      // this can no longer false-positive on every session's wrap-up nudge.
      if (state.streamWatchdog) state.streamWatchdog.noteAssistantResponseDone(itemId, text);
    };

    session.onAudioDelta = (base64) => {
      if (state.player) state.player.enqueueBase64(base64);
    };

    // Only ever invoked for a genuinely LOCAL function-call name (see
    // localFunctionNames in beginSession() and
    // RealtimeSession#isLocalFunction's doc comment) -- today that is only
    // ever "lookup_documents", and only in local-KB mode. The
    // "Unknown function" fallback is defensive: it can no longer actually
    // be reached for THIS file's current declared tools (a server-side
    // tool call is now gated out entirely before this ever runs, see
    // onServerToolCall below), but is kept in case a future client-side
    // function tool is ever declared without this handler being updated to
    // match.
    session.onFunctionCall = async ({ name, arguments: args }) => {
      const query = args && args.query ? args.query : "";
      state.transcript.logTool(name, query);
      addChip(name, query);
      renderTranscript();
      if (name === "lookup_documents") {
        return state.kb.lookupDocuments(query);
      }
      return { error: `Unknown function: ${name}` };
    };

    // A SERVER-SIDE tool call (file_search/collections_search, web_search,
    // x_search, mcp, etc -- anything not in localFunctionNames). The server
    // executes and continues the response on its own; this must NEVER send
    // a function_call_output or touch onToolCallsSettled (RealtimeSession
    // itself already guarantees that -- see isLocalFunction()). This hook
    // exists purely so the UI still shows a search happened: same
    // chip/transcript treatment as a real client-side tool call, just no
    // response is expected or returned.
    session.onServerToolCall = ({ name, arguments: args }) => {
      const query = args && args.query ? args.query : "";
      state.transcript.logTool(name, query);
      addChip(name, query);
      renderTranscript();
    };

    session.onToolCallsSettled = () => {
      state.awaitingContinuation = true;
      (state.player ? state.player.waitForDrain() : Promise.resolve()).then(() => {
        if (state.awaitingContinuation && session.isOpen()) {
          session.requestResponse();
          state.awaitingContinuation = false;
        }
      });
    };

    session.onResponseDone = (data) => {
      // Response-lifecycle diagnostic (see the header comment near
      // onResponseCreated above) -- logged first, before any of the
      // existing tool-chip/speaking-state handling below, so it is recorded
      // even if something further down ever throws.
      const { responseId, outputItemIds } = summarizeResponse(data);
      const createdAt = responseId ? responseCreatedAt.get(responseId) : null;
      const elapsedMs = createdAt != null ? Date.now() - createdAt : null;
      if (responseId) responseCreatedAt.delete(responseId);
      window.__imDiag && window.__imDiag("response-done", { responseId, outputItemIds, elapsedMs });
      if (state.wrapupController) state.wrapupController.noteResponseDone();

      // Best-effort: surface server-side search tool activity if the payload
      // exposes it (xAI does not document the exact shape for server-side
      // web_search/x_search/file_search calls at the time this was written).
      const output = data && data.response && data.response.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item && typeof item.type === "string" && /search/i.test(item.type)) {
            addChip(item.type, item.query || "");
          }
        }
      }
      setSpeaking("idle");
    };
  }

  /**
   * Correlates a brand-new assistant item id to the wrap-up force_message we
   * just sent (see startCountdown()'s tick(), which sets
   * state.pendingForceMessageText right after calling sendForceMessage()).
   *
   * Heuristic, not a protocol guarantee: a force_message's
   * `conversation.item.create` carries no client-supplied id, so there is no
   * exact correlation available from the protocol itself. Relies on
   * docs/speech-to-speech.md's own framing of force_message -- "Do NOT send
   * response.create -- the force_message IS the turn" -- meaning no other
   * response should be concurrently in flight when we send one, so the very
   * next brand-new assistant item id observed is it.
   *
   * Returns true (and has already done everything needed: recording the
   * real wrap-up text via TranscriptStore#recordForcedMessage, re-rendering,
   * and remembering this item id so every LATER event for it is also
   * swallowed here) when `itemId` is the force_message's. Returns false
   * otherwise, so the caller falls through to its normal handling unchanged.
   */
  function claimForceMessageItem(itemId) {
    if (state.forceMessageItemIds.has(itemId)) return true; // already claimed -- swallow every further event for it (a delta arriving after the claiming .done, or vice versa, can never re-open or duplicate the entry)
    if (!state.pendingForceMessageText) return false;
    if (state.transcript.hasItem(itemId)) return false; // not a NEW item -- can't be the force_message's

    state.forceMessageItemIds.add(itemId);
    state.transcript.recordForcedMessage(itemId, state.pendingForceMessageText);
    state.pendingForceMessageText = null;
    renderTranscript();
    return true;
  }

  return { gatherConfig, onStartInterview, beginSession, wireSessionHooks, claimForceMessageItem };
}
