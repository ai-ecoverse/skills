// interview-me / setup-ui.js
//
// The setup screen's Advanced-tab behaviour: knowledge-base mode switching,
// xAI collection listing/creation/test-search, voice-list population, and
// the voice-audition ("Play preview") flow with its per-session TTS cache.
// Extracted verbatim from interview-me.shtml; behaviour unchanged.
//
// `getOrCreateVoicePreviewBytes` is the single shared entry point for the
// audition feature: the "Play preview" button and the self-test both call
// THIS function, so the test exercises the real caching path rather than a
// reimplementation of it. Its cache lives in the host's `state` object, not
// here, so it is shared across a re-render exactly as before.
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).

export function createSetupUi(ctx) {
  const {
    fetchVoices,
    listCollections,
    searchCollection,
    ingestDirectory,
    synthesizeVoicePreview,
    FALLBACK_VOICES,
    DEFAULT_VOICE_PREVIEW_LINE,
    withTimeout,
    el,
    state,
    escapeHtml,
    safeDiag,
  } = ctx;

  function onKbModeChange() {
    const mode = el.kbMode.value;
    el.kbCollectionPanel.classList.toggle("im-hidden", mode !== "collection");
    el.kbCollectionPanel.style.display = mode === "collection" ? "" : "none";
    el.kbLocalPanel.classList.toggle("im-hidden", mode !== "local");
    el.kbLocalPanel.style.display = mode === "local" ? "" : "none";
  }

  async function populateCollections(selectId) {
    el.collectionSelect.innerHTML = "";
    let collections = [];
    try {
      if (typeof slicc.exec === "function") {
        collections = await withTimeout(listCollections((cmd) => slicc.exec(cmd)), 10000, "listCollections");
      }
    } catch (err) {
      collections = [];
      window.__imDiag && window.__imDiag("populate-collections-error", { message: err.message, stack: err.stack });
    }

    // No baked-in default collection ships: a fresh install shows whatever
    // collections the account actually has (empty list if none yet).
    for (const c of collections) {
      const opt = document.createElement("option");
      opt.value = c.collection_id;
      const docCount = typeof c.documents_count === "number" ? ` (${c.documents_count} doc${c.documents_count === 1 ? "" : "s"})` : "";
      opt.textContent = `${c.collection_name || c.collection_id}${docCount}`;
      el.collectionSelect.appendChild(opt);
    }
    if (selectId) el.collectionSelect.value = selectId;
    window.__imDiag && window.__imDiag("populate-collections", { count: collections.length, ids: collections.map((c) => c.collection_id) });
  }

  async function onCreateCollection() {
    const dirPath = el.newCollectionPath.value.trim();
    if (!dirPath) {
      el.createCollectionStatus.textContent = "Enter a folder path first.";
      return;
    }
    const name = el.newCollectionName.value.trim() || undefined;
    el.createCollectionBtn.disabled = true;
    el.createCollectionStatus.textContent = "Creating collection…";
    try {
      const result = await withTimeout(
        ingestDirectory((cmd) => slicc.exec(cmd), dirPath, {
          collectionName: name,
          listDir: (p) => slicc.readDir(p),
          onProgress: (p) => {
            if (p.stage === "created-collection") el.createCollectionStatus.textContent = `Created ${p.collectionId}, uploading files…`;
            else if (p.stage === "uploading") el.createCollectionStatus.textContent = `Uploading ${p.filename}…`;
            else if (p.stage === "attaching") el.createCollectionStatus.textContent = `Indexing ${p.filename}…`;
          },
        }),
        90000,
        "ingestDirectory"
      );
      el.createCollectionStatus.textContent = `Ingested ${result.files.length} file(s) into ${result.collectionId}.`;
      await populateCollections(result.collectionId);
    } catch (err) {
      el.createCollectionStatus.textContent = `Failed: ${err.message}`;
    } finally {
      el.createCollectionBtn.disabled = false;
    }
  }

  async function onTestSearch() {
    const query = el.testQuery.value.trim();
    const collectionId = el.collectionSelect.value;
    // Reported symptom: "test search does nothing". MEASURED: this guard was a
    // bare `return` reached with an EMPTY query box (testQueryValue: "",
    // guardWouldReturnEarly: true) -- and because the "Searching…" placeholder
    // is only written AFTER it, the click left the DOM completely untouched
    // and logged nothing, so the button was indistinguishable from a dead one.
    // The search itself was never broken (a real searchCollection call
    // returned 3 matches in 485ms). So: say why nothing happened, and log it.
    if (!query || !collectionId) {
      const why = !query ? "Enter a query to test the collection." : "Select a collection first.";
      el.testResults.innerHTML = `<span class="im-note">${escapeHtml(why)}</span>`;
      safeDiag("test-search-skipped", { reason: !query ? "empty-query" : "no-collection", collectionId: collectionId || null });
      return;
    }
    el.testSearchBtn.disabled = true;
    el.testResults.innerHTML = `<span class="im-note">Searching…</span>`;
    try {
      const t0 = performance.now();
      const matches = await withTimeout(searchCollection((cmd) => slicc.exec(cmd), collectionId, query, 5), 10000, "searchCollection");
      safeDiag("test-search-ok", { ms: Math.round(performance.now() - t0), matches: matches.length, collectionId });
      el.testResults.innerHTML = "";
      if (!matches.length) {
        el.testResults.innerHTML = `<span class="im-note">No matches.</span>`;
      }
      for (const m of matches) {
        const row = document.createElement("div");
        row.className = "im-card";
        row.style.padding = "var(--s2-spacing-100)";
        const title = (m.fields && (m.fields.title || m.fields["chroma:uri"])) || m.file_id;
        const score = typeof m.score === "number" ? m.score.toFixed(2) : "?";
        row.innerHTML = `<div class="im-note" style="font-weight:600">${escapeHtml(title)} — score ${score}</div><div class="im-note">${escapeHtml((m.chunk_content || "").slice(0, 220))}${(m.chunk_content || "").length > 220 ? "…" : ""}</div>`;
        el.testResults.appendChild(row);
      }
    } catch (err) {
      safeDiag("test-search-failed", { message: err.message, collectionId });
      el.testResults.innerHTML = `<span class="im-note">Search failed: ${escapeHtml(err.message)}</span>`;
    } finally {
      el.testSearchBtn.disabled = false;
    }
  }

  async function populateVoices() {
    el.voice.innerHTML = "";
    let voices = null;
    try {
      if (typeof slicc.exec === "function") {
        voices = await withTimeout(fetchVoices((cmd) => slicc.exec(cmd)), 10000, "fetchVoices");
      }
    } catch (err) {
      voices = null;
      window.__imDiag && window.__imDiag("populate-voices-error", { message: err.message, stack: err.stack });
    }

    if (voices && voices.length) {
      // The API gives no tone/style description for any voice -- just
      // voice_id/name/gender -- so grouping by gender is the only structure
      // available to make 28 undifferentiated names more scannable. The real
      // way to tell them apart is the preview feature right below this
      // dropdown, not the label here.
      const groups = new Map(); // gender -> voice[]
      for (const v of voices) {
        const gender = v.gender || "other";
        if (!groups.has(gender)) groups.set(gender, []);
        groups.get(gender).push(v);
      }
      const preferredOrder = ["female", "male"];
      const genders = [...preferredOrder.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !preferredOrder.includes(g))];
      for (const gender of genders) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = gender.charAt(0).toUpperCase() + gender.slice(1);
        for (const v of groups.get(gender)) {
          const opt = document.createElement("option");
          opt.value = v.voice_id;
          opt.textContent = v.name || v.voice_id;
          if (v.voice_id === "eve") opt.selected = true;
          optgroup.appendChild(opt);
        }
        el.voice.appendChild(optgroup);
      }
    } else {
      // Degraded fallback (API list unavailable) -- no gender data to group
      // by, so a flat list same as before.
      for (const id of FALLBACK_VOICES) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = id.charAt(0).toUpperCase() + id.slice(1);
        if (id === "eve") opt.selected = true;
        el.voice.appendChild(opt);
      }
    }

    const count = voices && voices.length ? voices.length : FALLBACK_VOICES.length;
    window.__imDiag && window.__imDiag("populate-voices", { fromApi: !!(voices && voices.length), count, grouped: !!(voices && voices.length) });
  }

  function voicePreviewCacheKey(voiceId, text) {
    return `${voiceId}::${text}`;
  }

  /**
   * Shared by the real button handler AND the self-test -- the ONE place
   * that decides "cache hit or real network call" for a voice preview.
   * Returns `{ bytes, fromCache }`; never touches the DOM/Blob URLs (that's
   * onPlayVoicePreview()'s job) so this stays trivially testable with a
   * throwaway cache Map and a counting execFn.
   */
  async function getOrCreateVoicePreviewBytes(execFn, cache, voiceId, text) {
    const key = voicePreviewCacheKey(voiceId, text);
    const cached = cache.get(key);
    if (cached) return { bytes: cached, fromCache: true };
    const bytes = await withTimeout(synthesizeVoicePreview(execFn, { text, voiceId }), 20000, "synthesizeVoicePreview");
    cache.set(key, bytes);
    return { bytes, fromCache: false };
  }

  async function onPlayVoicePreview() {
    const voiceId = el.voice.value;
    const text = el.voicePreviewText.value.trim() || DEFAULT_VOICE_PREVIEW_LINE;
    if (!voiceId) {
      el.voicePreviewStatus.textContent = "Pick a voice first.";
      return;
    }
    el.voicePreviewBtn.disabled = true;
    const alreadyCached = state.voicePreviewCache.has(voicePreviewCacheKey(voiceId, text));
    el.voicePreviewStatus.textContent = alreadyCached ? "Playing cached preview…" : "Generating preview…";
    try {
      const { bytes, fromCache } = await getOrCreateVoicePreviewBytes((cmd) => slicc.exec(cmd), state.voicePreviewCache, voiceId, text);
      // One owner of blob: URLs for this feature -- revoke the previous one
      // before creating the next, whether this play was a cache hit or not,
      // so repeated plays never leak object URLs across a long session.
      if (state.voicePreviewCurrentUrl) URL.revokeObjectURL(state.voicePreviewCurrentUrl);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      state.voicePreviewCurrentUrl = URL.createObjectURL(blob);
      el.voicePreviewAudio.src = state.voicePreviewCurrentUrl;
      await el.voicePreviewAudio.play();
      el.voicePreviewStatus.textContent = fromCache ? "Playing (cached — no new request)." : "Playing.";
    } catch (err) {
      el.voicePreviewStatus.textContent = `Preview failed: ${err.message}`;
      window.__imDiag && window.__imDiag("voice-preview-error", { message: err.message, voiceId });
    } finally {
      el.voicePreviewBtn.disabled = false;
    }
  }

  return { onKbModeChange, populateCollections, onCreateCollection, onTestSearch, populateVoices, getOrCreateVoicePreviewBytes, onPlayVoicePreview };
}
