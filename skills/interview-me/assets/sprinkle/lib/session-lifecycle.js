// interview-me / session-lifecycle.js
//
// Everything that runs a session's clock and takes it down again: the
// countdown tick (which also drives the wrap-up controller and enforces the
// hard backstop), the two live waveform canvases, `stopInterview()` and the
// artifact-writing / review-screen / download plumbing behind it. Extracted
// verbatim from interview-me.shtml; behaviour unchanged.
//
// `sessionLengthMs` and `waveStrokeColor` are host-scope `let`s that change
// at runtime (a CLI config push, and a theme toggle respectively), so they
// cross this boundary as getters -- a destructured copy would freeze the
// value this module read at wiring time, which is exactly the staleness bug
// the host's MutationObserver and config-push path exist to prevent.
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).

export function createSessionLifecycle(ctx) {
  const {
    blobToUint8Array,
    finalizeSession,
    HARD_BACKSTOP_GRACE_MS,
    MODEL,
    withTimeout,
    el,
    state,
    uiState,
    renderTranscriptInto,
    fmtMs,
    safeDiag,
    writeTimeoutForBytes,
    getSessionsRoot,
    buildCameraSyncInfo,
    getSessionLengthMs,
    getWaveStrokeColor,
  } = ctx;

  function startCountdown() {
    // setInterval, not requestAnimationFrame: rAF callbacks can be throttled
    // or fully paused when the panel isn't the visible/focused surface (a
    // very real scenario for a side-rail sprinkle during a "video call"-style
    // interview), and the five-minute hard stop must fire on a wall-clock
    // deadline regardless of visibility. A 250ms tick is plenty for a
    // once-a-second countdown display; the actual cutoff is computed from
    // `Date.now() - state.t0`, not from tick count, so even a throttled timer
    // still fires the stop at the right wall-clock moment, just observed a
    // little late rather than not at all.
    const tick = () => {
      if (state.ended) {
        clearInterval(state.countdownHandle);
        return;
      }
      const lengthMs = state.sessionLengthMs || getSessionLengthMs();
      const elapsed = Date.now() - state.t0;
      const remaining = Math.max(0, lengthMs - elapsed);
      el.countdown.textContent = fmtMs(remaining);
      el.countdown.classList.toggle("im-countdown--warn", remaining <= 60000 && remaining > 20000);
      el.countdown.classList.toggle("im-countdown--danger", remaining <= 20000);

      // Wrap-up is now a whole state machine (WrapupController), not a
      // blind fire-at-threshold timer -- see beginSession()'s construction
      // of it, and wrapup-controller.js's header, for the real failures
      // this fixes. poll() decides for itself whether it is time to send
      // the time-check/directive, end on sustained silence, or (last
      // resort) send the fallback -- this call site just feeds it the
      // elapsed value already computed above, plus a cheap synchronous
      // "is agent audio done playing right now" read from the real
      // AudioPlayer (the one piece of live state this module cannot get
      // for itself -- see poll()'s own doc comment), every tick.
      if (state.wrapupController) {
        state.wrapupController.poll(elapsed, state.player ? !state.player.isDraining() : true);
      }

      // The ultimate backstop -- see HARD_BACKSTOP_GRACE_MS's own comment
      // for why this is now WELL BEYOND the nominal length rather than
      // exactly at it: ending is silence-driven now (see
      // onSustainedSilence/onClosingTurnComplete in beginSession()), so the
      // nominal length only decides when wind-down BEGINS. This is what
      // still guarantees a session cannot run forever if the user simply
      // never stops talking (in which case the fallback and stop-on-silence
      // both keep deferring, by design, and never fire).
      if (elapsed >= lengthMs + HARD_BACKSTOP_GRACE_MS) {
        clearInterval(state.countdownHandle);
        stopInterview("timeout");
        return;
      }
    };
    state.countdownHandle = setInterval(tick, 250);
    tick();
  }

  function startWaveforms() {
    const userCtx = el.waveUser.getContext("2d");
    const agentCtx = el.waveAgent.getContext("2d");
    const userData = new Uint8Array(state.micAnalyser ? state.micAnalyser.fftSize : 1024);
    const agentData = new Uint8Array(state.player ? state.player.analyser.fftSize : 1024);

    const draw = (ctx, canvas, analyser, data) => {
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      const sliceWidth = canvas.width / data.length;
      let x = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = getWaveStrokeColor(); // pre-resolved -- see resolveWaveStrokeColor() above
      ctx.stroke();
    };

    const tick = () => {
      if (state.ended) return;
      draw(userCtx, el.waveUser, state.micAnalyser, userData);
      draw(agentCtx, el.waveAgent, state.player && state.player.analyser, agentData);
      state.waveHandle = requestAnimationFrame(tick);
    };
    tick();
  }

  async function stopInterview(reason) {
    if (state.ended) return; // a second Stop press (or a second stopInterview trigger racing this one) -- see showSavingScreen()'s comment for why the button itself can't realistically be pressed again by the time this guard would matter.
    state.ended = true;
    // Immediately, synchronously, before ANY of the teardown/await work
    // below (which real evidence showed can take several seconds for a
    // full-length session's human.webm write) -- this is the actual fix for
    // "the recording didn't stop on its own, I pressed the button": the
    // session HAD stopped, but nothing on screen said so.
    showSavingScreen();

    // Before audioCtx.close(): stop() detaches the onstatechange handler and
    // clears the poll timer, so teardown never triggers a spurious resume
    // attempt against a context that is intentionally being closed.
    if (state.micWatchdog) {
      state.micWatchdog.stop();
    }
    if (state.streamWatchdog) {
      state.streamWatchdog.stop();
    }

    if (state.countdownHandle) clearInterval(state.countdownHandle); // setInterval id, not rAF -- see startCountdown()
    if (state.waveHandle) cancelAnimationFrame(state.waveHandle);

    if (state.session) {
      state.session.close();
    }
    if (state.micWorkletNode) {
      try {
        state.micWorkletNode.port.postMessage({ type: "stop" });
      } catch (err) {
        /* ignore */
      }
    }

    const endedAt = Date.now();
    const durationMs = state.t0 ? endedAt - state.t0 : 0;

    // MediaRecorder.stop()'s promise (see recorder.js) resolves via the
    // `onstop` event, which fires reliably in practice but is still a browser
    // event this code does not control -- the hard-stop-at-5:00 requirement
    // depends on this NOT being able to hang the whole shutdown/file-write
    // path indefinitely. Falls back to whatever chunks were already
    // collected (`.blob()`) rather than blocking forever.
    const stopWithFallback = (recorder) => {
      if (!recorder) return Promise.resolve(null);
      return withTimeout(recorder.stop(), 8000, "recorder.stop").catch((err) => {
        window.__imDiag && window.__imDiag("recorder-stop-timeout", { message: err.message });
        return recorder.blob();
      });
    };
    const [humanBlob, agentBlob] = await Promise.all([stopWithFallback(state.humanRecorder), stopWithFallback(state.agentRecorder)]);
    state.humanBlob = humanBlob;
    state.agentBlob = agentBlob;

    // Multi-camera: stop the additional angle recorders and collect their
    // blobs. Blobs are cheap refs (~0 heap); the expensive whole-file
    // materialisation happens later, serially, in writeSessionArtifacts. With
    // no cameras this is a no-op (single-camera / audio-only unchanged).
    const cameras = Array.isArray(state.cameras) ? state.cameras : [];
    if (cameras.length) {
      await Promise.all(
        cameras.map(async (cam) => {
          cam.blob = await stopWithFallback(cam.recorder);
        })
      );
    }
    // Stop the camera video tracks (the shared mic is stopped below via
    // rawStream). Releases the camera devices / turns off indicator lights.
    if (state.multicam && Array.isArray(state.multicam.opened)) {
      for (const o of state.multicam.opened) {
        try {
          if (o.meter) o.meter.stopped = true;
          if (o.stream) o.stream.getTracks().forEach((t) => t.stop());
        } catch (err) {
          /* ignore */
        }
      }
    }
    // Build sync.json metadata ONLY when there are additional angles -- a lone
    // hero (single-camera) writes just human.webm with no sync.json, exactly
    // as before. Guarded so a build failure can never block artifact writing.
    if (cameras.length && state.multicam && typeof buildCameraSyncInfo === "function") {
      try {
        const { syncInfo } = buildCameraSyncInfo({
          opened: state.multicam.opened,
          cameras,
          humanBlob: state.humanBlob,
          startWall: state.recorderStartWall,
          startSpreadMs: state.recorderStartSpreadMs,
          sharedAudioTrack: state.sharedAudioTrack,
          endedAt,
        });
        state.syncInfo = syncInfo;
      } catch (err) {
        window.__imDiag && window.__imDiag("multicam:syncinfo-failed", { message: err && err.message });
      }
    }

    if (state.rawStream) state.rawStream.getTracks().forEach((t) => t.stop());
    if (state.audioCtx) {
      try {
        await state.audioCtx.close();
      } catch (err) {
        /* ignore */
      }
    }

    await writeSessionArtifacts(endedAt, durationMs, reason);

    // Artifacts are on disk now, so clearing the interrupted-session marker
    // here cannot lose evidence of an interruption that already resolved
    // normally -- this is every normal end-of-session path (manual stop,
    // the timeout cap, a watchdog fatal, connection-closed), since they all
    // funnel through this one stopInterview() function.
    await uiState.clearSession();

    // Finalisation: diagnostics.json (this session's own copy of the
    // diagnostics log, which survives a reload unlike the shared,
    // always-rewritten-from-scratch debug.json) and the recording-complete
    // lick. Ordered internally as artifacts (already written above) ->
    // diagnostics -> lick; either later step failing can never undo the
    // artifacts or block the other step -- see finalizeSession's own doc
    // comment in session-end.js.
    const finalizeResult = await finalizeSession(slicc, {
      sessionDir: state.sessionDir,
      endReason: reason,
      durationMs,
      transcriptEntries: state.transcript.toJSON(),
      diagnosticsEntries: collectDiagnosticsEntries(),
      humanBytes: state.humanBlob ? state.humanBlob.size : null,
      agentBytes: state.agentBlob ? state.agentBlob.size : null,
      // Scopes diagnostics.json's warningCount to entries that actually
      // happened during THIS interview (window.__IM_DIAG__, folded in via
      // collectDiagnosticsEntries() above, accumulates for the whole page's
      // lifetime -- see buildDiagnosticsDocument()'s doc comment in
      // session-end.js for the real bug this fixes). Same t0/endedAt
      // session.json itself records a few lines up in writeSessionArtifacts,
      // so diagnostics.json and session.json always agree on the window.
      sessionStartMs: state.t0,
      sessionEndMs: endedAt,
    });
    window.__imDiag && window.__imDiag("session-finalize-result", finalizeResult);

    showReview(endedAt, durationMs, reason);
  }

  // Diagnostics fed into session-end.js's writeDiagnostics(): the load-time
  // __imDiag() harness log plus (if a mic and/or stream watchdog ran this
  // session) their own event logs, merged and re-sorted by timestamp. This
  // is what lets diagnostics.json replace the separate mic-watchdog.json
  // write below, and is also where the new stream-watchdog.js events (the
  // receive-direction counterpart) land -- a post-mortem only needs to open
  // one file for either failure mode.
  function collectDiagnosticsEntries() {
    const base = window.__IM_DIAG__ || [];
    const micEvents = state.micWatchdog
      ? state.micWatchdog.getEvents().map((e) => ({ t: e.t, stage: `mic-watchdog:${e.type}`, detail: e.detail }))
      : [];
    const streamEvents = state.streamWatchdog
      ? state.streamWatchdog.getEvents().map((e) => ({ t: e.t, stage: `stream-watchdog:${e.type}`, detail: e.detail }))
      : [];
    const wrapupEvents = state.wrapupController
      ? state.wrapupController.getEvents().map((e) => ({ t: e.t, stage: `wrapup-controller:${e.type}`, detail: e.detail }))
      : [];
    return [...base, ...micEvents, ...streamEvents, ...wrapupEvents].sort((a, b) => (a.t || 0) - (b.t || 0));
  }

  async function writeSessionArtifacts(endedAt, durationMs, reason) {
    const iso = new Date(state.t0).toISOString().replace(/[:.]/g, "-");
    const dir = `${getSessionsRoot()}/${iso}`;
    state.sessionDir = dir;

    try {
      await slicc.mkdir(dir);

      // --- Media: assembled from flushed parts, or written whole as a fallback
      // Names and locations are UNCHANGED (human.webm / agent.webm in the
      // session dir) -- only how the bytes get there changed. Assembling
      // ordered part files by byte-wise concatenation produces exactly the
      // bytes `new Blob(chunks)` produced before, because that is what the old
      // path also did; selftest.js asserts that equivalence.
      //
      // Deliberately SERIAL, never Promise.all: MEASURED, five concurrent
      // whole-file writes drove the heap to 3138 MB of a 4192 MB limit (75%)
      // versus 1656 MB serial, and concurrency only bought 9.2 s -> 6.3 s.
      // At multi-camera scale that headroom matters more than the seconds.
      state.mediaWrites = [];
      const saveMedia = async (label, blob, filename) => {
        const flusher = state.flushers && state.flushers[label];
        const destPath = `${dir}/${filename}`;
        const record = (detail) => {
          state.mediaWrites.push({ label, file: filename, ...detail });
          safeDiag(`media-write:${label}`, { file: filename, ...detail });
        };

        // Preferred path: the bytes are already on disk as parts, so assembly
        // never puts the whole file on the JS heap at all.
        if (flusher && flusher.isUsable()) {
          const t = performance.now();
          const asm = await flusher.assemble(destPath);
          const stats = flusher.getStats();
          if (asm && asm.ok) {
            record({
              path: "assembled-from-parts",
              method: asm.method,
              bytes: asm.actualBytes,
              parts: asm.parts,
              ms: Math.round(performance.now() - t),
              retries: stats.retries,
              degraded: !!asm.degraded,
            });
            await flusher.cleanup();
            return true;
          }
          // Assembly failed -> fall through to the whole-blob write below,
          // which still has every byte in memory. Report, never swallow.
          record({ path: "assembly-failed-falling-back", reason: asm && asm.reason, retries: stats.retries });
        } else if (flusher) {
          const stats = flusher.getStats();
          record({
            path: "parts-unusable-falling-back",
            failedParts: stats.failedParts,
            droppedForBackpressure: stats.droppedForBackpressure,
            retries: stats.retries,
          });
        }

        // Fallback: the original whole-file write, now BOUNDED. This is the
        // path that materialises the file on the heap; it is only reached when
        // flushing was unavailable or produced an incomplete part sequence.
        if (!blob) {
          record({ path: "skipped-no-blob" });
          return false;
        }
        try {
          const bytes = await blobToUint8Array(blob);
          const t = performance.now();
          await withTimeout(
            slicc.writeFileBinary(destPath, bytes),
            writeTimeoutForBytes(bytes.length),
            `writeFileBinary:${filename}`
          );
          record({ path: "whole-blob", bytes: bytes.length, ms: Math.round(performance.now() - t) });
          return true;
        } catch (err) {
          // One angle lost must never mean the session is lost: report it and
          // let the remaining files, the transcript and session.json be saved.
          record({ path: "failed", error: err.message });
          return false;
        }
      };

      const humanExt = state.humanRecorder ? state.humanRecorder.extension() : "webm";
      const agentExt = state.agentRecorder ? state.agentRecorder.extension() : "webm";
      // Hero camera keeps the name `human.webm` at the top level and the agent
      // keeps `agent.webm`, unchanged, because the vertical-cut tooling depends
      // on both. Additional angles are ADDITIVE, under video/.
      await saveMedia("human", state.humanBlob, `human.${humanExt}`);
      await saveMedia("agent", state.agentBlob, `agent.${agentExt}`);

      // --- additional camera angles, SERIAL ------------------------------
      // Deliberately not Promise.all, and the reason is measured, not stylistic:
      // five concurrent whole-file writes peaked at 3138 MB of a 4192 MB heap
      // (75%) versus 1656 MB serial, for a 47% throughput gain. The faster path
      // is the one that crashes a real interview.
      const cameras = Array.isArray(state.cameras) ? state.cameras : [];
      if (cameras.length) {
        await slicc.mkdir(`${dir}/video`).catch(() => {});
        for (const cam of cameras) {
          await saveMedia(cam.name, cam.blob, `video/${cam.name}.webm`);
        }
      }

      // --- sync.json ------------------------------------------------------
      // Containers carry no absolute time, so alignment needs an explicit
      // manifest: per-stream first-frame timestamp, derived offsetMs, and the
      // MEASURED fps (getSettings() lies -- the Studio Display cameras have
      // been measured delivering 24.2 fps while reporting 30, and the webcam
      // 50 in some modes). Written whenever there is stream metadata, so a
      // single-camera session gets one too rather than a special case.
      if (state.syncInfo && Array.isArray(state.syncInfo.cameras) && state.syncInfo.cameras.length) {
        await slicc.writeFile(`${dir}/sync.json`, JSON.stringify(state.syncInfo, null, 2));
      }

      const transcriptJson = JSON.stringify(state.transcript.toJSON(), null, 2);
      await slicc.writeFile(`${dir}/transcript.json`, transcriptJson);
      await slicc.writeFile(`${dir}/transcript.md`, state.transcript.toMarkdown());

      const sessionMeta = {
        model: MODEL,
        voice: state.config.voice,
        topic: state.config.topic,
        kbMode: state.config.kbMode,
        kbPath: state.config.kbMode === "local" ? state.config.kbPath : null,
        kbFiles: state.kb.files.map((f) => f.filename),
        collectionId: state.config.collectionId || null,
        webSearch: state.config.webSearch,
        xSearch: state.config.xSearch,
        sessionConfig: state.lastSessionConfig,
        startedAt: new Date(state.t0).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs,
        endReason: reason,
      };
      await slicc.writeFile(`${dir}/session.json`, JSON.stringify(sessionMeta, null, 2));

      // No separate mic-watchdog.json here anymore -- its events are folded
      // into diagnostics.json by finalizeSession() (see
      // collectDiagnosticsEntries()), which runs right after this function
      // returns, so a post-mortem needs only one file for both.

      el.filesNote.textContent = `Written to ${dir}/ (human.${state.humanRecorder ? state.humanRecorder.extension() : "webm"}, agent.${state.agentRecorder ? state.agentRecorder.extension() : "webm"}, transcript.json, transcript.md, session.json)`;
    } catch (err) {
      el.filesNote.textContent = `Could not write session files: ${err.message}`;
    }
  }

  function showReview(endedAt, durationMs, reason) {
    showScreen("review");
    el.reviewSub.textContent = `${fmtMs(durationMs)} interview about "${state.config.topic || "(no topic set)"}" — ended (${reason}).`;

    if (state.humanBlob) el.reviewHuman.src = URL.createObjectURL(state.humanBlob);
    if (state.agentBlob) el.reviewAgent.src = URL.createObjectURL(state.agentBlob);

    renderTranscriptInto(el.reviewTranscript);

    el.reviewKv.innerHTML = "";
    const kv = [
      ["Voice", state.config.voice],
      ["Model", MODEL],
      ["Web search", state.config.webSearch ? "on" : "off"],
      ["X search", state.config.xSearch ? "on" : "off"],
      ["Knowledge base", state.config.collectionId ? `file_search (${state.config.collectionId})` : `local (${state.kb.files.length} doc(s))`],
      ["Duration", fmtMs(durationMs)],
      ["Session folder", state.sessionDir || "(not written)"],
    ];
    for (const [k, v] of kv) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      el.reviewKv.appendChild(dt);
      el.reviewKv.appendChild(dd);
    }
  }

  function showScreen(name) {
    // Persist the screen transition (ui-state.js): "setup"/"live"/"review"
    // are the only values it recognises and stores -- "saving" (see
    // showSavingScreen() below) is intentionally not part of that enum,
    // same reasoning as never restoring straight into "live"/"review": it
    // is not safe to jump back into on a re-render, so there is nothing to
    // persist for it. update() silently no-ops on an unrecognised value,
    // so this line is harmless for "saving" and simply leaves the
    // previously-persisted screen in place. flush() (not the debounced
    // path) because a screen transition is infrequent and important enough
    // that a resize a few hundred ms later must not be able to lose it.
    uiState.update({ screen: name });
    uiState.flush();

    // Inline style, not just the .im-hidden class: slicc.screenshot() clones
    // the DOM through an SVG foreignObject and does not reliably honor rules
    // from a <style> block (see style-guide.md's "use inline styles on
    // elements you intend to screenshot" note) -- inline display is what
    // that renderer actually respects, and it costs nothing for the real
    // browser render either.
    el.screenSetup.classList.toggle("im-hidden", name !== "setup");
    el.screenSetup.style.display = name === "setup" ? "" : "none";
    el.screenLive.classList.toggle("im-hidden", name !== "live");
    el.screenLive.style.display = name === "live" ? "" : "none";
    el.screenSaving.classList.toggle("im-hidden", name !== "saving");
    el.screenSaving.style.display = name === "saving" ? "" : "none";
    el.screenReview.classList.toggle("im-hidden", name !== "review");
    el.screenReview.style.display = name === "review" ? "" : "none";
  }

  // Called the instant a session ends, BEFORE the potentially slow
  // recorder-stop/artifact-write sequence in stopInterview() -- see that
  // function's first lines. Makes both halves of the real bug fix visible in
  // one place: the screen transition itself (so "already ended, saving" is
  // obvious rather than reading as a frozen Live screen) and the Stop button
  // becoming unmistakably inert (disabled AND relabelled, not just disabled
  // -- a disabled button also stops dispatching click events at all, so a
  // second press right at this instant has nothing to hit, not a silently
  // swallowed click).
  function showSavingScreen() {
    showScreen("saving");
    el.stopBtn.disabled = true;
    el.stopBtn.textContent = "Stopping…";
  }

  function downloadBlob(blob, filename) {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadTranscript() {
    if (!state.transcript) return;
    const blob = new Blob([JSON.stringify(state.transcript.toJSON(), null, 2)], { type: "application/json" });
    downloadBlob(blob, "transcript.json");
  }

  return { startCountdown, startWaveforms, stopInterview, collectDiagnosticsEntries, writeSessionArtifacts, showReview, showScreen, showSavingScreen, downloadBlob, downloadTranscript };
}
