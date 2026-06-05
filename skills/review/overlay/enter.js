// Review-mode overlay injected into the live page.
// Enables click-to-comment: click anywhere -> prompt -> place a numbered marker.
// Each placed comment is stashed on window.__sliccReview so the cone can poll it.
(function () {
  // Two concerns:
  //  - DISPLAY layer (markers + tooltips + Fix-with-Speck): always present once injected.
  //  - ADD mode (window.__sliccAddMode): crosshair + click-to-comment to place NEW pins.
  // Re-running this script when the display layer already exists just (re)applies add mode
  // and re-renders markers — it does NOT duplicate listeners.
  var OVERLAY_VERSION = 4;  // bump when render/reposition logic changes
  // Honor add-mode request passed in just before eval (window.__sliccWantAdd), default false.
  var wantAdd = !!window.__sliccWantAdd;
  window.__sliccAddMode = wantAdd;
  // Fast path: same version already wired → just refresh markers + cursor and exit.
  if (window.__sliccReviewDisplay && window.__sliccOverlayVersion === OVERLAY_VERSION) {
    if (typeof window.__sliccRenderMarkers === 'function') window.__sliccRenderMarkers();
    document.body.classList.toggle('__slicc-rv-crosshair', wantAdd);
    return { status: 'reinjected', addMode: wantAdd, markers: (window.__sliccReviewAll || []).filter(function(c){return !c.done;}).length };
  }
  // Otherwise (first inject OR upgraded version): run full setup. Remove any old
  // markers/tips so the new render path owns the DOM cleanly.
  document.querySelectorAll('.__slicc-rv-marker, .__slicc-rv-tip, .__slicc-rv-pop').forEach(function (el) { el.remove(); });
  window.__sliccReviewDisplay = true;
  window.__sliccReviewActive = true;
  window.__sliccOverlayVersion = OVERLAY_VERSION;
  var SS_KEY = '__sliccReviewMarkers';
  // Restore markers persisted across reloads (sessionStorage), merge with in-memory.
  function loadPersisted() {
    try { return JSON.parse(sessionStorage.getItem(SS_KEY) || '[]'); } catch (_) { return []; }
  }
  function persist() {
    try { sessionStorage.setItem(SS_KEY, JSON.stringify(window.__sliccReviewAll || [])); } catch (_) {}
  }
  window.__sliccReview = window.__sliccReview || [];   // committed comments (drained by cone)
  window.__sliccReviewAll = window.__sliccReviewAll && window.__sliccReviewAll.length
    ? window.__sliccReviewAll
    : loadPersisted();                                  // full history (for re-render)
  // keep the numbering sequence ahead of restored markers
  (window.__sliccReviewAll || []).forEach(function (c) {
    if (c.num > (window.__slicc_rv_seq || 0)) window.__slicc_rv_seq = c.num;
  });
  var WEBHOOK_URL = '__WEBHOOK_URL__';   // POST target for each placed comment
  var SPECK_WEBHOOK_URL = '__SPECK_WEBHOOK_URL__'; // POST target for "Fix with Speck"

  // ---- styles ----
  var style = document.createElement('style');
  style.id = '__slicc-review-style';
  style.textContent = [
    '.__slicc-rv-marker{position:absolute;z-index:2147483645;width:24px;height:24px;margin:-12px 0 0 -12px;',
    'border-radius:50% 50% 50% 2px;background:#1c64f2;color:#fff;display:flex;align-items:center;justify-content:center;',
    'font:700 12px system-ui;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer;border:2px solid #fff;}',
    '.__slicc-rv-marker:hover{transform:scale(1.15);}',
    '.__slicc-rv-tip{position:absolute;z-index:2147483647;max-width:260px;background:#111;color:#fff;',
    'font:500 12px system-ui;padding:8px 10px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.45);',
    'transform:translate(-50%,calc(-100% - 14px));white-space:normal;display:flex;flex-direction:column;gap:7px;}',
    '.__slicc-rv-tip-text{line-height:1.4;}',
    '.__slicc-rv-fix-btn{background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:6px 10px;',
    'font:600 12px system-ui;cursor:pointer;align-self:flex-start;}',
    '.__slicc-rv-fix-btn:hover{background:#6d28d9;}',
    '.__slicc-rv-fix-btn:disabled{opacity:.7;cursor:default;}',
    '.__slicc-rv-pop{position:fixed;z-index:2147483647;width:260px;background:#fff;color:#111;',
    'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.3);padding:12px;font:13px system-ui;}',
    '.__slicc-rv-pop textarea{width:100%;box-sizing:border-box;height:64px;resize:none;border:1px solid #ccc;',
    'border-radius:6px;padding:7px;font:13px system-ui;outline:none;}',
    '.__slicc-rv-pop textarea:focus{border-color:#1c64f2;}',
    '.__slicc-rv-pop .row{display:flex;gap:8px;margin-top:8px;}',
    '.__slicc-rv-pop button{flex:1;border:none;border-radius:6px;padding:7px;font:600 12px system-ui;cursor:pointer;}',
    '.__slicc-rv-pop .save{background:#1c64f2;color:#fff;}',
    '.__slicc-rv-pop .cancel{background:#eee;color:#333;}',
    'body.__slicc-rv-crosshair, body.__slicc-rv-crosshair *{cursor:crosshair !important;}'
  ].join('');
  document.head.appendChild(style);

  // No in-page banner — Pin Review is controlled solely from the sprinkle button.
  // Crosshair only appears while ADD mode is on (placing new pins).
  document.body.classList.toggle('__slicc-rv-crosshair', !!window.__sliccAddMode);

  // ---- helpers ----
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      var sel = el.nodeName.toLowerCase();
      if (el.id) { sel += '#' + el.id; parts.unshift(sel); break; }
      var sib = el, nth = 1;
      while ((sib = sib.previousElementSibling)) { if (sib.nodeName === el.nodeName) nth++; }
      sel += ':nth-of-type(' + nth + ')';
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function nextNum() { return window.__slicc_rv_seq = (window.__slicc_rv_seq || 0) + 1; }

  // Speck can only inject into locally-served / preview pages (remote pages block it via CSP).
  // Detect: served pages run under the extension preview origin.
  function isLocallyServed() {
    try {
      return location.protocol === 'chrome-extension:' && location.pathname.indexOf('/preview/') !== -1;
    } catch (_) { return false; }
  }

  // Resolve a pin's page-coordinate position, anchored to its target element when possible.
  // Falls back to stored absolute pageX/pageY if the element can't be found.
  function resolvePos(c) {
    if (c.selector) {
      var el = null;
      try { el = document.querySelector(c.selector); } catch (_) { el = null; }
      if (el) {
        var r = el.getBoundingClientRect();
        if (r.width || r.height) {
          var rx = (typeof c.relX === 'number') ? c.relX : 0.5;
          var ry = (typeof c.relY === 'number') ? c.relY : 0.5;
          return {
            x: r.left + window.scrollX + rx * r.width,
            y: r.top + window.scrollY + ry * r.height
          };
        }
      }
    }
    return { x: c.pageX, y: c.pageY };  // fallback
  }

  // Track live markers so we can reposition on resize/scroll.
  var liveMarkers = [];  // { c, m, getTip }

  function renderMarker(c) {
    if (c.done) return;   // completed pins are not drawn on the page
    var m = document.createElement('div');
    m.className = '__slicc-rv-marker';
    m.textContent = c.num;
    var p0 = resolvePos(c);
    m.style.left = p0.x + 'px';
    m.style.top = p0.y + 'px';
    m.title = c.comment;
    var tip = null;
    var hideTimer = null;

    function buildTip() {
      var t = document.createElement('div');
      t.className = '__slicc-rv-tip';
      var p = resolvePos(c);
      t.style.left = p.x + 'px';
      t.style.top = p.y + 'px';
      var label = document.createElement('div');
      label.className = '__slicc-rv-tip-text';
      label.textContent = '#' + c.num + ': ' + c.comment;
      t.appendChild(label);

      // "Fix with Speck" is only available on locally-served pages Speck can inject into.
      if (isLocallyServed()) {
        var btn = document.createElement('button');
        btn.className = '__slicc-rv-fix-btn';
        btn.textContent = '\u2728 Fix with Speck';
        btn.addEventListener('click', function (ev) {
          ev.stopImmediatePropagation();
          ev.stopPropagation();
          ev.preventDefault();
          btn.textContent = '\u23F3 Loading Speck\u2026';
          btn.disabled = true;
          try {
            fetch(SPECK_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'inject-speck',
                url: location.href
              }),
              keepalive: true
            }).then(function () {
              btn.textContent = '\u2728 Speck active';
            }).catch(function () {
              btn.textContent = '\u26A0 Failed \u2014 retry';
              btn.disabled = false;
            });
          } catch (_) {
            btn.textContent = '\u26A0 Failed \u2014 retry';
            btn.disabled = false;
          }
        }, true);
        t.appendChild(btn);
      }
      // keep open while hovering the tooltip
      t.addEventListener('mouseenter', function () { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
      t.addEventListener('mouseleave', scheduleHide);
      return t;
    }

    function scheduleHide() {
      hideTimer = setTimeout(function () { if (tip) { tip.remove(); tip = null; } }, 200);
    }

    m.addEventListener('mouseenter', function () {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (tip) return;
      tip = buildTip();
      document.documentElement.appendChild(tip);
    });
    m.addEventListener('mouseleave', scheduleHide);
    document.documentElement.appendChild(m);

    liveMarkers.push({ c: c, m: m, getTip: function () { return tip; } });
  }

  // Reposition all live markers (anchored to their elements). Called on resize/scroll.
  function repositionMarkers() {
    liveMarkers.forEach(function (lm) {
      var p = resolvePos(lm.c);
      lm.m.style.left = p.x + 'px';
      lm.m.style.top = p.y + 'px';
      var tip = lm.getTip && lm.getTip();
      if (tip) { tip.style.left = p.x + 'px'; tip.style.top = p.y + 'px'; }
    });
  }
  if (!window.__sliccRepositionBound) {
    window.__sliccRepositionBound = true;
    var rafPending = false;
    function schedule() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () { rafPending = false; if (window.__sliccDoReposition) window.__sliccDoReposition(); });
    }
    window.addEventListener('resize', schedule, true);
    window.addEventListener('scroll', schedule, true);
  }
  window.__sliccDoReposition = repositionMarkers;

  // Render all (non-done) markers, clearing any previously drawn ones first (idempotent).
  function renderAllMarkers() {
    document.querySelectorAll('.__slicc-rv-marker, .__slicc-rv-tip').forEach(function (el) { el.remove(); });
    liveMarkers = [];
    (window.__sliccReviewAll || []).forEach(renderMarker);
  }
  // Expose for re-injection refresh.
  window.__sliccRenderMarkers = renderAllMarkers;

  renderAllMarkers();
  persist();   // ensure current markers are stored immediately (survives Speck page reloads)

  // ---- click to comment ----
  var pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }

  // Generation token: only the newest injection's click listener is active.
  // Older listeners (from a prior overlay version) see a mismatched gen and bail,
  // so upgrades never run stale click logic or double-handle clicks.
  var MY_GEN = (window.__sliccClickGen = (window.__sliccClickGen || 0) + 1);

  document.addEventListener('click', function (e) {
    if (MY_GEN !== window.__sliccClickGen) return;   // superseded by a newer injection
    // Only place NEW comments while ADD mode (Pin Review) is on.
    if (!window.__sliccAddMode) return;
    if (e.target.closest('.__slicc-rv-pop')) return;
    if (e.target.closest('.__slicc-rv-marker')) return;
    if (e.target.closest('.__slicc-rv-tip')) return;   // tooltip + Fix-with-Speck button
    e.preventDefault();
    e.stopPropagation();
    closePop();

    var pageX = e.pageX, pageY = e.pageY;
    var selector = cssPath(e.target);
    // Compute the click's fractional offset within the target element so the
    // pin stays anchored to the element on resize/reflow.
    var relX = 0.5, relY = 0.5;
    try {
      var tr = e.target.getBoundingClientRect();
      if (tr.width)  relX = Math.min(1, Math.max(0, (e.clientX - tr.left) / tr.width));
      if (tr.height) relY = Math.min(1, Math.max(0, (e.clientY - tr.top) / tr.height));
    } catch (_) {}

    pop = document.createElement('div');
    pop.className = '__slicc-rv-pop';
    pop.innerHTML = '<textarea placeholder="Comment about this spot\u2026"></textarea>' +
      '<div class="row"><button class="save">Add</button><button class="cancel">Cancel</button></div>';
    var px = Math.min(e.clientX, window.innerWidth - 272);
    var py = Math.min(e.clientY, window.innerHeight - 130);
    pop.style.left = Math.max(8, px) + 'px';
    pop.style.top = Math.max(8, py) + 'px';
    document.documentElement.appendChild(pop);
    var ta = pop.querySelector('textarea');
    ta.focus();

    pop.querySelector('.cancel').addEventListener('click', closePop);
    pop.querySelector('.save').addEventListener('click', function () {
      var txt = ta.value.trim();
      if (!txt) { closePop(); return; }
      var c = {
        num: nextNum(),
        comment: txt,
        pageX: pageX, pageY: pageY,
        selector: selector,
        relX: relX, relY: relY,
        url: location.href,
        ts: Date.now()
      };
      renderMarker(c);
      window.__sliccReview.push(c);
      window.__sliccReviewAll.push(c);
      persist();
      closePop();
      // Real-time delivery to the review log via webhook
      try {
        fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(c),
          keepalive: true
        }).catch(function () {});
      } catch (_) {}
    }, true);
  }, true);

  return { status: 'active', existing: (window.__sliccReviewAll || []).length };
})();
