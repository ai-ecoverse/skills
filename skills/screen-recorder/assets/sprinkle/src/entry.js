// Bundle entry for the recording-setup sprinkle.
//
// Built with esbuild into an IIFE that is embedded inline in
// recording-setup.shtml. It CANNOT be loaded as an external file: a
// full-document sprinkle renders in an `about:srcdoc` iframe whose base URI
// inherits the PARENT frame's URL, so every relative/absolute import or fetch
// specifier resolves against the SLICC app shell and its client-side router
// answers with index.html at HTTP 200 -- the wrong body, not a detectable 404.
// See /workspace/skills/interview-me/references/sprinkle-module-loading.md.
//
// --format=iife matters twice over: it keeps the module's internals (including
// its own top-level `sleep`) inside a closure so they cannot collide with the
// sprinkle's own top-level names, and it avoids `<script type="module">`, which
// would hit the same base-URI problem for any further resolution.
//
// chunk-flusher.js is imported IN PLACE from the interview-me skill -- never
// copied, never edited. It belongs to that skill; bundling reads it where it
// lives, which keeps provenance honest and picks up any upstream fixes on the
// next build.

import { createChunkFlusher } from '/workspace/skills/interview-me/assets/sprinkle/lib/chunk-flusher.js';
import { withTimeout } from './with-timeout.js';
import {
  DURATION_LADDER,
  INFINITY_INDEX,
  durationForIndex,
  formatDuration,
} from './duration-ladder.js';
import {
  VIDEO_AV_MIMES,
  VIDEO_ONLY_MIMES,
  AUDIO_MIMES,
  mimesForStream,
  pickMime,
} from './mimes.js';
import { createBeeper } from './beeps.js';
import {
  parseTabList,
  foregroundTabCmd,
  confirmForegrounded,
  readViewportCmd,
  parseViewport,
  describeResize,
} from './tabs.js';
import { probeCaptureGeometry, watchCaptureResize } from './capture-geometry.js';
import { trackDurationSpreadMs, shortestTrack, TRACK_SPREAD_NOTE } from './track-spread.js';
import {
  validateUrl,
  shellQuoteUrl,
  popupFeatures,
  windowGeometryCmd,
  parseGeometry,
  describeTargetWindow,
  openTargetWindow,
  openTargetWindowApi,
  findTargetId,
  checkDisplayFit,
  displayFitWarning,
  newTargetId,
  tabIds,
  isNavigated,
  landedElsewhere,
  normalizeUrlInput,
  urlSuggestions,
  presetFitness,
} from './target-window.js';

window.__rec = {
  createChunkFlusher,
  withTimeout,
  DURATION_LADDER,
  INFINITY_INDEX,
  durationForIndex,
  formatDuration,
  VIDEO_AV_MIMES,
  VIDEO_ONLY_MIMES,
  AUDIO_MIMES,
  mimesForStream,
  pickMime,
  createBeeper,
  parseTabList,
  foregroundTabCmd,
  confirmForegrounded,
  readViewportCmd,
  parseViewport,
  describeResize,
  probeCaptureGeometry,
  watchCaptureResize,
  validateUrl,
  shellQuoteUrl,
  popupFeatures,
  windowGeometryCmd,
  parseGeometry,
  describeTargetWindow,
  openTargetWindow,
  openTargetWindowApi,
  findTargetId,
  checkDisplayFit,
  displayFitWarning,
  newTargetId,
  tabIds,
  isNavigated,
  landedElsewhere,
  normalizeUrlInput,
  urlSuggestions,
  presetFitness,
  trackDurationSpreadMs,
  shortestTrack,
  TRACK_SPREAD_NOTE,
};
