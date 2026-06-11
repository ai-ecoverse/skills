// Clear ALL review markers + state (page + sessionStorage).
(function () {
  window.__sliccReview = [];
  window.__sliccReviewAll = [];
  window.__slicc_rv_seq = 0;
  try { sessionStorage.removeItem('__sliccReviewMarkers'); } catch (_) {}
  document.querySelectorAll('.__slicc-rv-marker, .__slicc-rv-tip, .__slicc-rv-pop').forEach(function (e) { e.remove(); });
  return { reset: true };
})();
