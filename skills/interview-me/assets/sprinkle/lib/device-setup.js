// interview-me / device-setup.js
//
// Camera/microphone enablement for the setup screen: getUserMedia, device
// enumeration, the mic level-meter test, preview stream restarts, and the
// video-attach diagnostics that made a silently-failing camera preview
// debuggable without devtools. Extracted verbatim from interview-me.shtml;
// behaviour unchanged.
//
// LOAD-BEARING INVARIANT (do not reorder): `onEnableDevices` runs device
// enumeration, the level meter and the Start-button enable BEFORE it
// attaches the camera preview, and never awaits the attach in a way that
// could gate them. A hung `video.play()` on some devices used to block the
// whole setup flow; `safeAttachCameraPreview` is timeout-bounded precisely
// so a broken preview degrades to "no preview" instead of "no interview".
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).

export function createDeviceSetup(ctx) {
  const {
    withTimeout,
    el,
    state,
    openCameraWithWatchdog,
  } = ctx;

  // --- Video attach + diagnostics --------------------------------------
  // Two known black-preview causes this guards against:
  //  1. Assigning `srcObject` alone can leave a <video> unrendered inside a
  //     sandboxed about:srcdoc iframe, where autoplay is unreliable even with
  //     the autoplay/playsinline/muted attributes present in markup. An
  //     explicit `.play()` (with the same three properties ALSO set
  //     imperatively, since attribute-vs-property handling differs across
  //     engines, and `muted` in particular must be true for autoplay to be
  //     permitted) is required, and any rejection (AbortError/NotAllowedError)
  //     is diagnostic gold, not something to swallow.
  //  2. A live MediaStreamTrack that never actually delivers frames (ended,
  //     or 0x0 after loadedmetadata) looks IDENTICAL to a rendering failure
  //     from the outside -- a black rectangle either way. logStreamDiagnostics
  //     below distinguishes "no frames arriving from the device" from
  //     "frames arriving but not rendered" and reports both to debug.json.
  // window.__imDiag is defined in the FIRST <script> block and is meant to be
  // resilient, but it was directly implicated in a real incident: a failure
  // during onEnableDevices left debug.json completely un-rewritten (still
  // showing the load-time entries from three minutes earlier), meaning either
  // the failure happened before any diagnostic call, or a diagnostic call
  // itself never returned. Every call site below now goes through this
  // wrapper so __imDiag can NEVER be the reason a caller stalls or throws,
  // regardless of which of those turns out to be true.
  function safeDiag(stage, detail) {
    try {
      window.__imDiag && window.__imDiag(stage, detail);
    } catch (err) {
      /* __imDiag must never be able to break its caller */
    }
  }

  async function attachStreamToVideo(videoEl, stream, label) {
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.srcObject = stream;

    videoEl.addEventListener(
      "loadedmetadata",
      () => {
        safeDiag(`video-loadedmetadata:${label}`, {
          videoWidth: videoEl.videoWidth,
          videoHeight: videoEl.videoHeight,
          zeroDimensions: videoEl.videoWidth === 0 || videoEl.videoHeight === 0,
        });
      },
      { once: true }
    );

    // videoEl.play()'s returned promise is NOT guaranteed to settle here: it
    // can hang indefinitely (neither resolve nor reject) in this heavily
    // sandboxed about:srcdoc context -- this is the confirmed root cause of a
    // real regression where the awaited call here blocked device-list
    // population and the level meter entirely, with zero diagnostics ever
    // recorded because execution never reached a point that could log one.
    // The caller (safeAttachCameraPreview) now bounds how long it waits for
    // this whole function via withTimeout; this function no longer being
    // awaited-through by anything device-list-related is the actual fix.
    try {
      await videoEl.play();
      safeDiag(`video-play-ok:${label}`, {});
    } catch (err) {
      safeDiag(`video-play-failed:${label}`, { name: err.name, message: err.message });
    }
  }

  // Audio-only safety, verified: getVideoTracks() always returns an array
  // (empty for an audio-only stream, never throws), the `if (videoTracks.length)`
  // guard means `[0]` is never indexed on an empty array, and `getSettings`
  // is feature-detected before use. describeCameraDiagnostics()'s own
  // `if (!diag.track) return "";` guard covers the case where this returns
  // no `.track` at all (audio-only). None of this throws for an audio-only
  // stream -- confirmed by re-reading, not just asserted.
  function logStreamDiagnostics(stream, label) {
    const videoTracks = stream.getVideoTracks();
    const detail = { videoTrackCount: videoTracks.length };
    if (videoTracks.length) {
      const track = videoTracks[0];
      const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
      detail.track = {
        label: track.label,
        readyState: track.readyState, // "live" vs "ended" -- distinguishes a dead device from a render problem
        muted: track.muted,
        enabled: track.enabled,
        settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate, deviceId: settings.deviceId },
      };
      track.onended = () => safeDiag(`video-track-ended:${label}`, { trackLabel: track.label });
      track.onmute = () => safeDiag(`video-track-muted:${label}`, { trackLabel: track.label });
      track.onunmute = () => safeDiag(`video-track-unmuted:${label}`, { trackLabel: track.label });
    }
    safeDiag(`stream-diagnostics:${label}`, detail);
    return detail;
  }

  function describeCameraDiagnostics(diag) {
    if (!diag.track) return "";
    const { label, readyState, settings } = diag.track;
    const dims = settings.width && settings.height ? `${settings.width}x${settings.height}` : "unknown size";
    return ` — ${label || "camera"} ${dims} (track ${readyState})`;
  }

  /**
   * Runs attach -> diagnostics -> description as one bounded, non-throwing
   * operation. Each step is isolated in its own try/catch (a failure in
   * logStreamDiagnostics or describeCameraDiagnostics must not be able to
   * hide a successful attach, or vice versa) and the whole attach step is
   * timeout-wrapped, because attachStreamToVideo's internal `videoEl.play()`
   * await is NOT guaranteed to ever settle in this sandboxed context --
   * that hang, unbounded, is the confirmed cause of a real regression where
   * it silently blocked device-list population entirely. Never throws;
   * always returns { ok, diag, description, errors }, so a caller can
   * ALWAYS proceed with whatever else it needs to do (populate dropdowns,
   * start the level meter, enable the Start button) and separately decide
   * what to show the user about the preview specifically.
   */
  // `diagExtra` (optional): merged into every safeDiag() detail this call
  // makes. Exists so a caller that is DELIBERATELY provoking a failure --
  // today, only the self-test's "hung-play-does-not-block" check, via
  // label "selftest-hang-sim" -- can mark its own diagnostic entries as
  // such (`{ simulated: true }`) EXPLICITLY, rather than the warning
  // classifier in session-end.js having to pattern-match on the label
  // string. This function stays generic: it has no idea "selftest-hang-sim"
  // means anything special, and never will -- see that check's own call
  // site for where the marker actually gets set, and
  // buildDiagnosticsDocument()'s doc comment in session-end.js for why an
  // explicit marker beats guessing from a name.
  async function safeAttachCameraPreview(videoEl, stream, label, timeoutMs = 2500, diagExtra) {
    const result = { ok: true, diag: null, description: "", errors: [] };

    try {
      await withTimeout(attachStreamToVideo(videoEl, stream, label), timeoutMs, `attachStreamToVideo:${label}`);
    } catch (err) {
      result.ok = false;
      result.errors.push({ stage: "attach", name: err && err.name, message: err && err.message });
      safeDiag(`camera-preview-attach-failed:${label}`, { name: err && err.name, message: err && err.message, ...diagExtra });
    }

    try {
      result.diag = logStreamDiagnostics(stream, label);
    } catch (err) {
      result.ok = false;
      result.errors.push({ stage: "diagnostics", name: err && err.name, message: err && err.message });
      safeDiag(`camera-preview-diagnostics-failed:${label}`, { name: err && err.name, message: err && err.message, ...diagExtra });
    }

    try {
      result.description = result.diag ? describeCameraDiagnostics(result.diag) : "";
    } catch (err) {
      result.errors.push({ stage: "describe", name: err && err.name, message: err && err.message });
      safeDiag(`camera-preview-describe-failed:${label}`, { name: err && err.name, message: err && err.message, ...diagExtra });
      result.description = "";
    }

    return result;
  }

  function describePreviewFailure(result) {
    const first = result.errors[0];
    if (!first) return "unknown error";
    return `${first.stage}: ${first.name || "Error"} — ${first.message || "no message"}`;
  }

  // --- Live preview grid -----------------------------------------------
  // Renders one .im-video-wrap tile per camera into #im-preview-grid. The
  // hero tile (#im-hero-tile / #im-preview-video) is STATIC so el.previewVideo
  // stays valid across renders and the live-screen self-view reuses it; only
  // the EXTRA tiles (.im-preview-extra) are created/removed here. A failed
  // camera becomes a .im-video-wrap--failed tile (a FAILURE notice, allowed),
  // never a missing one, and never throws -- the other tiles still render.
  // `cameras` is an ordered list; cameras[0] is the hero. Each entry is
  // { failed:boolean, stream:MediaStream|null, label?:string }.
  function renderPreviewGrid(cameras) {
    const grid = el.previewGrid;
    if (!grid) return { tileCount: 0, failedCount: 0 };
    grid.querySelectorAll(".im-preview-extra").forEach((n) => n.remove());
    const heroTile = document.getElementById("im-hero-tile");
    const list = Array.isArray(cameras) ? cameras : [];

    if (heroTile) {
      // Reset the hero tile to its clean state first.
      heroTile.classList.remove("im-video-wrap--failed");
      heroTile.querySelectorAll(".im-video-wrap__fail").forEach((n) => n.remove());
      if (el.previewVideo) el.previewVideo.style.display = "";
      const hero = list[0];
      if (hero && !hero.failed) {
        if (hero.stream && el.previewVideo) {
          el.previewVideo.muted = true;
          el.previewVideo.autoplay = true;
          el.previewVideo.playsInline = true;
          el.previewVideo.srcObject = hero.stream;
          // NEVER await video.play() -- 90s+ hangs measured in this sandbox.
          el.previewVideo.play().catch(() => {});
        }
      } else if (hero && hero.failed) {
        heroTile.classList.add("im-video-wrap--failed");
        if (el.previewVideo) el.previewVideo.style.display = "none";
        const span = document.createElement("span");
        span.className = "im-video-wrap__fail";
        span.textContent = "Angle unavailable";
        heroTile.appendChild(span);
      }
    }

    for (let i = 1; i < list.length; i++) {
      const cam = list[i];
      const tile = document.createElement("div");
      tile.className = "im-video-wrap im-preview-extra";
      if (cam && cam.failed) {
        tile.classList.add("im-video-wrap--failed");
        const span = document.createElement("span");
        span.className = "im-video-wrap__fail";
        span.textContent = "Angle unavailable";
        tile.appendChild(span);
      } else {
        const v = document.createElement("video");
        v.autoplay = true;
        v.playsInline = true;
        v.muted = true;
        if (cam && cam.stream) {
          v.srcObject = cam.stream;
          v.play().catch(() => {}); // NEVER await
        }
        tile.appendChild(v);
      }
      grid.appendChild(tile);
    }

    const tileCount = grid.querySelectorAll(".im-video-wrap").length;
    const failedCount = list.filter((c) => c && c.failed).length;
    return { tileCount, failedCount };
  }

  // Stops every extra preview camera stream (and the hero's, all of which are
  // held in state.previewCameras). Preview-only cleanup: called when the
  // interview starts so the extra angles are not left lit while recording.
  // The RECORDING path re-acquires its own hero stream from config.camDeviceId
  // and does not read state.previewCameras.
  function stopPreviewCameras() {
    const cams = Array.isArray(state.previewCameras) ? state.previewCameras : [];
    for (const c of cams) {
      if (c && c.stream) {
        try {
          c.stream.getTracks().forEach((t) => t.stop());
        } catch (e) {
          /* ignore */
        }
      }
    }
    state.previewCameras = [];
  }

  // Opens EVERY video-input device through openCameraWithWatchdog (which reads
  // a frame and retries the ~4% of opens that come up "live" but deliver no
  // frame), hero first. Returns an ordered list of camera descriptors;
  // failures are captured, not thrown, so one dead camera cannot stop the rest.
  async function openAllCameras(videoDevices, heroDeviceId) {
    const hero = videoDevices.find((d) => d.deviceId && d.deviceId === heroDeviceId) || videoDevices[0];
    const ordered = [];
    if (hero) ordered.push(hero);
    for (const d of videoDevices) {
      if (d !== hero) ordered.push(d);
    }
    const cameras = [];
    for (const d of ordered) {
      const label = d.label || "Camera";
      try {
        const opened = await openCameraWithWatchdog(d.deviceId || undefined, 640, 480, safeDiag);
        cameras.push({ deviceId: d.deviceId, label, stream: opened.stream, opened, failed: false });
      } catch (err) {
        safeDiag("preview-camera-open-failed", { deviceId: d.deviceId, label, message: err && err.message });
        cameras.push({ deviceId: d.deviceId, label, stream: null, failed: true, error: err && err.message });
      }
    }
    // Make sure the hero tile shows a WORKING camera whenever any opened: if
    // the intended hero failed but another succeeded, promote the first
    // success to index 0.
    if (cameras.length && cameras[0].failed) {
      const firstOk = cameras.findIndex((c) => !c.failed);
      if (firstOk > 0) {
        const [ok] = cameras.splice(firstOk, 1);
        cameras.unshift(ok);
      }
    }
    return cameras;
  }

  async function onEnableDevices() {
    el.enableBtn.disabled = true;
    el.setupStatus.textContent = "Requesting microphone and camera access…";

    // The shared mic is one stream (also the permission gesture). Every CAMERA
    // is opened separately, through openCameraWithWatchdog, so the zero-frame
    // watchdog covers all angles including the hero. state.rawStream holds the
    // mic only; the recording path re-acquires its own hero stream at start.
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      el.setupStatus.textContent = `Could not access microphone: ${err.message}`;
      el.enableBtn.disabled = false;
      return;
    }
    state.rawStream = micStream;

    // Device enumeration, the level meter and enabling Start MUST happen
    // regardless of any camera outcome (a hung/failed camera must never block
    // them -- the original regression this file guards against).
    await populateDeviceLists();
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      devices = [];
    }
    const videoDevices = devices.filter((d) => d.kind === "videoinput");
    const heroDeviceId = el.camSelect.value || (videoDevices[0] && videoDevices[0].deviceId);

    const cameras = videoDevices.length ? await openAllCameras(videoDevices, heroDeviceId) : [];
    state.previewCameras = cameras;
    const opened = cameras.filter((c) => !c.failed);
    state.hasVideo = opened.length > 0;

    el.previewRow.classList.remove("im-hidden");
    el.previewRow.style.display = "";
    try {
      renderPreviewGrid(cameras);
    } catch (err) {
      safeDiag("preview-grid-render-failed", { message: err && err.message });
    }

    startLevelMeterTest(micStream);
    el.startBtn.disabled = false;
    // The button-slot swap replaces "Enable mic & camera" with "Start
    // interview" IN PLACE -- that swap, plus the previews appearing, IS the
    // "devices are enabled" signal. No status readout for it.
    el.btnSlot.dataset.state = "ready";
    el.setupStatus.textContent = "";

    if (!videoDevices.length) {
      // FAILURE notice, not a readout: the grid cannot say "there is no camera".
      el.setupStatus.textContent = "Camera unavailable or denied — continuing audio-only.";
      return;
    }
    if (!opened.length) {
      // Every camera failed to deliver frames: the grid shows failure tiles,
      // but a grid of blanks is ambiguous, so say it out loud too.
      el.setupStatus.textContent = "No camera could be opened — continuing audio-only.";
    }
  }

  // The camera <select> now only chooses which angle beginSession() RECORDS --
  // every camera is already shown in the grid, so a camera change needs no
  // preview restart. Only a genuine MIC change re-acquires the shared mic (for
  // the level meter / border), and only when the selected device differs from
  // the one already open. Wired to both selects' `change` events; a change
  // before devices are enabled returns immediately (self-test relies on this).
  async function restartPreviewStream() {
    if (!state.rawStream) return; // devices not enabled yet -- nothing to restart
    const micDeviceId = el.micSelect.value || undefined;
    const currentMic = state.rawStream.getAudioTracks()[0];
    const currentMicId = currentMic && typeof currentMic.getSettings === "function" ? currentMic.getSettings().deviceId : undefined;
    if (micDeviceId && currentMicId && micDeviceId === currentMicId) return; // same mic -- nothing to do

    el.setupStatus.textContent = "Switching microphone…";
    try {
      const newMic = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
      });
      if (state.rawStream) state.rawStream.getTracks().forEach((t) => t.stop());
      state.rawStream = newMic;
      stopLevelMeterTest();
      startLevelMeterTest(newMic);
      el.setupStatus.textContent = "";
    } catch (err) {
      el.setupStatus.textContent = `Could not switch microphone: ${err.message}`;
      window.__imDiag && window.__imDiag("restart-mic-failed", { message: err.message, name: err.name });
    }
  }

  async function populateDeviceLists() {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      devices = [];
    }
    fillSelect(el.micSelect, devices.filter((d) => d.kind === "audioinput"), "Microphone");
    fillSelect(el.camSelect, devices.filter((d) => d.kind === "videoinput"), "Camera");
  }

  function fillSelect(select, devices, label) {
    select.innerHTML = "";
    if (!devices.length) {
      const opt = document.createElement("option");
      opt.textContent = `No ${label.toLowerCase()} found`;
      select.appendChild(opt);
      return;
    }
    devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `${label} ${i + 1}`;
      select.appendChild(opt);
    });
  }

  function stopLevelMeterTest() {
    if (state.testMeterHandle) cancelAnimationFrame(state.testMeterHandle);
    state.testMeterHandle = null;
    if (state.testAudioCtx) {
      state.testAudioCtx.close().catch(() => {});
      state.testAudioCtx = null;
    }
  }

  function startLevelMeterTest(stream) {
    stopLevelMeterTest();
    const ctx = new AudioContext();
    state.testAudioCtx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      // Drive the preview grid's BORDER colour (via --mic-pct), not a separate
      // meter -- one shared mic, one border around the whole preview area.
      if (el.previewGrid) el.previewGrid.style.setProperty("--mic-pct", `${Math.round(level * 100)}%`);
      state.testMeterHandle = requestAnimationFrame(tick);
    };
    tick();
  }

  return { safeDiag, attachStreamToVideo, logStreamDiagnostics, describeCameraDiagnostics, safeAttachCameraPreview, describePreviewFailure, onEnableDevices, restartPreviewStream, renderPreviewGrid, stopPreviewCameras, openAllCameras, populateDeviceLists, fillSelect, stopLevelMeterTest, startLevelMeterTest };
}
