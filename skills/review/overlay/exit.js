// Exit ADD mode (Pin Review off). Keeps the marker DISPLAY layer + markers visible.
(function () {
  window.__sliccAddMode = false;
  document.body.classList.remove('__slicc-rv-crosshair');
  document.querySelectorAll('.__slicc-rv-pop').forEach(function (el) { el.remove(); });
  // Markers and tooltips (incl. Fix-with-Speck) stay on the page.
  return { status: 'add-mode-off', markers: (window.__sliccReviewAll || []).filter(function (c) { return !c.done; }).length };
})();
