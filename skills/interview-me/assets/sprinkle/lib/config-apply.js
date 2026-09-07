// interview-me / config-apply.js
//
// Reading /shared/sprinkles/interview-me/config.json, applying a config object to the
// setup UI, the CLI live-push entry point, and the setup screen's two tabs.
// Extracted verbatim from interview-me.shtml; behaviour unchanged.
//
// `applyConfig()` is deliberately the ONE place a config object is applied to
// the UI: init() and the CLI push (`applyConfigPush`) both route through it,
// so a field added to one path can never silently miss the other.
//
// `loadConfig()` and `readConfigFile()` are NOT interchangeable: readConfigFile
// throws on failure (what a CLI push needs -- it must report a real error),
// while loadConfig still degrades to `{}` (what init() needs -- "no config
// yet" is normal on a first run, and must not stop startup).
//
// The live-push mechanism has no button, no staleness indicator and no
// polling, by explicit decision; `sprinkle send interview-me
// '{"type":"reloadconfig"}'` from the CLI is the only trigger. That was asked
// for, rejected, and removed once already -- do not re-add one here.
//
// `sessionLengthMs` is a host-scope `let` this module both reads and WRITES
// (a config's `sessionMinutes` changes it), so it crosses as a getter/setter
// pair -- a destructured copy would update nothing the host could see.
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).

export function createConfigApply(ctx) {
  const {
    DEFAULT_VOICE_PREVIEW_LINE,
    firstSentenceOf,
    clampSessionMinutes,
    CONFIG_PATH,
    withTimeout,
    el,
    uiState,
    onKbModeChange,
    safeDiag,
    getSessionLengthMs,
    setSessionLengthMs,
  } = ctx;

  // There is no config PERSISTENCE at all besides this: reads
  // /shared/sprinkles/interview-me/config.json (written by lib/interview-me.jsh) and
  // prefills the UI from it, falling back to built-in defaults when the file
  // is absent or a field is missing. The sprinkle does NOT write this file
  // back on its own -- use the CLI to persist settings (see README.md).
  //
  // LIVE UPDATE FROM THE CLI: config.json used to be read exactly once, at
  // init(). A real bug report: the sprinkle can sit open for hours while
  // `interview-me.jsh` edits config.json from a shell, and nothing ever
  // re-read it -- not a parse bug, a missing "notice a push" concept
  // entirely. There is deliberately NO reload button and NO
  // staleness-polling in this sprinkle -- the user explicitly does not want
  // either. The only fix is: the CLI pushes
  // `sprinkle send interview-me '{"type":"reloadconfig"}'` after every
  // write, and the handler below re-reads and re-applies. Two pieces:
  //   - readConfigFile(): throws on failure (missing file OR malformed
  //     JSON) -- used by the push handler, which must surface a real error
  //     rather than fail silently, per the bug report.
  //   - loadConfig(): wraps readConfigFile() with the original silent
  //     fallback-to-{} behavior, kept for init() specifically -- "no
  //     config.json yet" is the normal first-run state, not worth alarming
  //     anyone about.
  //   - applyConfig(): the ONE place that applies a config object to the
  //     UI, used by BOTH init()'s first pass and the push handler, so the
  //     two paths cannot drift apart from each other.
  async function readConfigFile() {
    const text = await withTimeout(slicc.readFile(CONFIG_PATH), 5000, "readConfig");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("config.json did not contain a JSON object");
    return parsed;
  }

  async function loadConfig() {
    try {
      const parsed = await readConfigFile();
      safeDiag("config-loaded", { keys: Object.keys(parsed) });
      return parsed;
    } catch (err) {
      safeDiag("config-load-fallback", { message: err.message });
      return {};
    }
  }

  // Fields that don't depend on dynamically-populated <option> lists --
  // applied immediately so config prefill doesn't wait on network calls.
  // Fills the voice-preview line from the briefing's own opening -- but only
  // while the field is still empty, exactly like the kbPath/newCollectionPath
  // "fill in a default only if the user hasn't already put something there"
  // convention elsewhere in this file. Called from applyStaticConfigFields()
  // so both init() and a CLI-pushed config update keep this in sync with
  // whatever the CURRENT briefing is, without ever clobbering a preview line
  // someone is actively rehearsing.
  function updateVoicePreviewDefault(brief) {
    if (el.voicePreviewText.value.trim()) return;
    el.voicePreviewText.value = firstSentenceOf(brief) || DEFAULT_VOICE_PREVIEW_LINE;
  }

  function applyStaticConfigFields(config) {
    if (typeof config.brief === "string") el.brief.value = config.brief;
    updateVoicePreviewDefault(config.brief);
    el.webSearch.checked = config.webSearch === undefined ? true : !!config.webSearch;
    el.xSearch.checked = config.xSearch === undefined ? true : !!config.xSearch;
    if (Array.isArray(config.webAllowedDomains)) el.webDomains.value = config.webAllowedDomains.join(", ");
    if (Array.isArray(config.xAllowedHandles)) el.xHandles.value = config.xAllowedHandles.join(", ");
    el.kbMode.value = config.kbMode === "local" ? "local" : "collection";
    if (typeof config.kbPath === "string" && config.kbPath) el.kbPath.value = config.kbPath;

    if (config.sessionMinutes !== undefined) {
      const clamped = clampSessionMinutes(config.sessionMinutes);
      if (clamped === null) {
        safeDiag("session-minutes-invalid", { value: config.sessionMinutes });
      } else {
        setSessionLengthMs(clamped * 60 * 1000);
        safeDiag("session-minutes-applied", { minutes: clamped });
      }
    }
    updateSetupIntro();
  }

  // Keeps the Setup screen's own copy ("Up to N minutes...") honest against
  // whatever sessionLengthMs currently is, instead of the old hardcoded
  // "five minutes" text that would have silently gone stale the moment this
  // became configurable.
  // One short line, per the UI spec: the mechanics this used to narrate
  // (recorded, transcribed, session length) are not decisions the user makes
  // on this screen. Kept as a function rather than inlined in the HTML so the
  // intro still has exactly ONE source of truth and every existing call site
  // (applyStaticConfigFields -> a CLI config push) stays valid.
  function updateSetupIntro() {
    el.setupIntro.textContent = "A spoken interview with Grok, grounded in your documents and live search.";
  }

  // Voice/collection selection can only be applied once their <option>
  // lists exist; falls back to whatever default got selected (documented
  // behavior, not a bug) if the configured value isn't in the list yet.
  function applyVoiceSelection(config) {
    if (config.voice && Array.from(el.voice.options).some((o) => o.value === config.voice)) {
      el.voice.value = config.voice;
    }
  }
  function applyCollectionSelection(config) {
    if (config.kbMode !== "local" && config.collectionId && Array.from(el.collectionSelect.options).some((o) => o.value === config.collectionId)) {
      el.collectionSelect.value = config.collectionId;
    }
  }

  // The ONE place that applies a config object to the UI -- init()'s first
  // pass and the CLI push handler both go through this, so they cannot
  // drift. Voice/collection are safe to call unconditionally here even
  // before their <option> lists are populated (a no-op in that case, per
  // applyVoiceSelection/applyCollectionSelection's own fallback) -- init()
  // calls this once early AND again after population resolves (see below);
  // by the time a CLI push can arrive, population has long since finished,
  // so applyConfig alone is always sufficient there.
  function applyConfig(config) {
    applyStaticConfigFields(config);
    onKbModeChange();
    applyVoiceSelection(config);
    applyCollectionSelection(config);
  }

  // The CLI's `{"type":"reloadconfig"}` push handler -- the entire feature.
  // No button, no polling: this is the only way config.json changes ever
  // reach an already-open sprinkle, by design.
  async function applyConfigPush() {
    try {
      const config = await readConfigFile();
      applyConfig(config);
      const chars = typeof config.brief === "string" ? config.brief.length : 0;
      const minutes = getSessionLengthMs() / 60000;
      el.setupStatus.textContent = `Config updated from CLI — briefing ${chars} chars, session ${minutes} min.`;
      safeDiag("config-push-applied", { briefChars: chars, sessionMinutes: minutes });
    } catch (err) {
      el.setupStatus.textContent = `Config update from CLI failed: ${err.message}`;
      safeDiag("config-push-failed", { message: err.message });
    }
  }

  // Hoisted to module scope (was a closure inside wireTabs()) so init() can
  // also call it directly, to apply a restored tab from ui-state.js BEFORE
  // the user has clicked anything -- see the restore() call in init().
  // Externally-observed behavior (aria-selected/tabIndex/panel display) is
  // unchanged; the only addition is persisting the choice via uiState.
  const TAB_LIST = [el.tabInterview, el.tabAdvanced];
  const TAB_PANEL_FOR = { [el.tabInterview.id]: el.panelInterview, [el.tabAdvanced.id]: el.panelAdvanced };

  function selectTab(tab) {
    for (const t of TAB_LIST) {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      // Inline style.display, not a class -- slicc.screenshot() does not
      // reliably honor class-based display:none from a <style> block.
      TAB_PANEL_FOR[t.id].style.display = selected ? "" : "none";
    }
    uiState.update({ tab: tab === el.tabAdvanced ? "advanced" : "interview" });
  }

  function wireTabs() {
    for (const tab of TAB_LIST) {
      tab.addEventListener("click", () => selectTab(tab));
      tab.addEventListener("keydown", (e) => {
        const idx = TAB_LIST.indexOf(tab);
        let nextIdx = null;
        if (e.key === "ArrowRight") nextIdx = (idx + 1) % TAB_LIST.length;
        else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + TAB_LIST.length) % TAB_LIST.length;
        else if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = TAB_LIST.length - 1;
        if (nextIdx !== null) {
          e.preventDefault();
          TAB_LIST[nextIdx].focus();
          selectTab(TAB_LIST[nextIdx]);
        }
      });
    }
  }

  return { readConfigFile, loadConfig, applyStaticConfigFields, updateSetupIntro, applyVoiceSelection, applyCollectionSelection, applyConfig, applyConfigPush, selectTab, wireTabs };
}
