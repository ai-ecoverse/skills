// Returns + clears any newly committed comments (rarely needed — comments are
// delivered in real time via the review-marker webhook). Reports current state.
(function () {
  return {
    display: !!window.__sliccReviewDisplay,   // display layer present
    addMode: !!window.__sliccAddMode,         // can place new pins
    markers: (window.__sliccReviewAll || []).filter(function (c) { return !c.done; }).length,
    comments: (window.__sliccReview || []).splice(0)  // drain any pending
  };
})();
