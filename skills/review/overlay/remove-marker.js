// Remove (or restore) a marker by its number on the page overlay.
// Reads window.__rvRemoveNum / window.__rvRemoveDone set just before eval.
(function () {
  var num = window.__rvRemoveNum;
  var done = window.__rvRemoveDone;
  if (typeof num === 'undefined') return { err: 'no num' };

  // Update the persisted "done" flag in the history + sessionStorage
  window.__sliccReviewAll = window.__sliccReviewAll || [];
  window.__sliccReviewAll.forEach(function (c) { if (c.num === num) c.done = !!done; });
  try { sessionStorage.setItem('__sliccReviewMarkers', JSON.stringify(window.__sliccReviewAll)); } catch (_) {}

  // Preferred path: let the overlay re-render all markers from state (handles
  // both hide-done and restore-undone, even if the marker wasn't drawn yet).
  if (typeof window.__sliccRenderMarkers === 'function') {
    window.__sliccRenderMarkers();
    return { num: num, done: !!done, applied: true, via: 'render' };
  }
  // Fallback: toggle the existing DOM node directly.
  var removed = false;
  document.querySelectorAll('.__slicc-rv-marker').forEach(function (m) {
    if (m.textContent.trim() === String(num)) {
      m.style.display = done ? 'none' : '';
      removed = true;
    }
  });
  document.querySelectorAll('.__slicc-rv-tip').forEach(function (t) { t.remove(); });
  return { num: num, done: !!done, applied: removed, via: 'fallback' };
})();
