// composition.mjs -- the Remotion composition for `remotion render`, built at
// runtime from an EDL (see references/edl-schema.md).
//
// This file is COPIED VERBATIM into the staging dir by `remotion render` and
// loaded by the generated index.html through the esm.sh import map, so every
// bare specifier below resolves to exactly ONE URL (a second React copy breaks
// Remotion's context -- see references/render-target.md).
//
// Lineage: extracted from the harness that
// actually produced interview-cut-v4/v5.mp4. Hardcoded asset sizes, crop focal
// points and caption paths are now driven by cfg.json.

import React from 'react';
import { Sequence, AbsoluteFill, useCurrentFrame } from 'remotion';
import { Video } from '@remotion/media';

const h = React.createElement;

// Cumulative rounding, NOT per-segment rounding: segment boundaries must never
// drift off the caption timeline over a long cut.
export function planSegments(cfg) {
  const out = [];
  let cumSec = 0;
  let prevFrame = 0;
  for (const s of cfg.segments) {
    cumSec += s.durationSec;
    const endFrame = Math.round(cumSec * cfg.fps);
    out.push({ ...s, startFrame: prevFrame, durationInFrames: endFrame - prevFrame });
    prevFrame = endFrame;
  }
  return out;
}

export function totalFrames(segments) {
  if (!segments.length) return 0;
  const last = segments[segments.length - 1];
  return last.startFrame + last.durationInFrames;
}

// Group word-level timings into short karaoke cues.
export function buildCues(captions, offsetSec = 0) {
  const words = (captions?.words || [])
    .map((w) => ({ ...w, t: w.t - offsetSec, end: w.end - offsetSec }))
    .filter((w) => w.end > -0.5);
  const out = [];
  let cur = null;
  const MAX_WORDS = 4;
  const MAX_SPAN = 2.4;
  const MAX_GAP = 0.7;
  for (const w of words) {
    const breakNow =
      !cur ||
      cur.speaker !== w.speaker ||
      cur.words.length >= MAX_WORDS ||
      w.t - cur.words[cur.words.length - 1].end > MAX_GAP ||
      w.end - cur.start > MAX_SPAN;
    if (breakNow) {
      cur = { speaker: w.speaker, start: w.t, end: w.end, words: [w] };
      out.push(cur);
    } else {
      cur.words.push(w);
      cur.end = w.end;
    }
  }
  return out;
}

const PALETTE = [
  { accent: '#ffd23f', scrim: 'rgba(6,8,14,0.80)', text: '#ffffff', italic: false },
  { accent: '#6ff2c8', scrim: 'rgba(4,26,26,0.84)', text: '#eafff8', italic: true },
  { accent: '#8ab4ff', scrim: 'rgba(6,10,26,0.84)', text: '#eef4ff', italic: false },
];

function speakerStyle(speaker, index) {
  const p = PALETTE[index % PALETTE.length];
  return { ...p, label: String(speaker || 'SPEAKER').toUpperCase() };
}

export function buildComposition({ cfg, urls, captions }) {
  const FPS = cfg.fps;
  const W = cfg.width;
  const H = cfg.height;
  const SEGMENTS = planSegments(cfg);
  const TOTAL_FRAMES = totalFrames(SEGMENTS);

  const srcInfo = (name) => {
    const s = cfg.sources[name];
    if (!s) throw new Error(`no source metadata for "${name}"`);
    return s;
  };
  const focusOf = (source) => {
    const f = source.focus || srcInfo(source.src).focus || {};
    return { x: typeof f.x === 'number' ? f.x : 0.5, y: typeof f.y === 'number' ? f.y : 0.5 };
  };

  // A hard-cropped, focal-point-aware <Video>. The wrapper is the visible box
  // and clips; the video is laid out at full `cover` scale and offset, which
  // gives exact ffmpeg-crop parity (object-position alone cannot express this).
  const CropVideo = ({ src, inSec, boxW, boxH, focus, muted, keyName }) => {
    const s = srcInfo(src);
    const scale = Math.max(boxW / s.width, boxH / s.height);
    const vw = s.width * scale;
    const vh = s.height * scale;
    let left = -(focus.x * vw - boxW / 2);
    let top = -(focus.y * vh - boxH / 2);
    left = Math.min(0, Math.max(boxW - vw, left)); // never reveal empty edges
    top = Math.min(0, Math.max(boxH - vh, top));
    return h(
      'div',
      { style: { position: 'absolute', width: boxW, height: boxH, overflow: 'hidden', background: '#000' } },
      h(Video, {
        key: keyName,
        src: urls[src],
        trimBefore: Math.round(inSec * FPS),
        muted: !!muted,
        objectFit: 'fill',
        style: { position: 'absolute', left, top, width: vw, height: vh },
      }),
    );
  };

  const PortraitShot = ({ seg, i }) =>
    h(
      AbsoluteFill,
      { style: { background: '#000' } },
      h(CropVideo, {
        keyName: `s${i}`,
        src: seg.source.src,
        inSec: seg.source.inSec,
        boxW: W,
        boxH: H,
        focus: focusOf(seg.source),
        muted: false,
      }),
    );

  const SplitShot = ({ seg, i }) =>
    h(
      AbsoluteFill,
      { style: { background: '#000' } },
      h(
        'div',
        { style: { position: 'absolute', top: 0, left: 0, width: W, height: H / 2, overflow: 'hidden' } },
        h(CropVideo, {
          keyName: `s${i}top`,
          src: seg.top.src,
          inSec: seg.top.inSec,
          boxW: W,
          boxH: H / 2,
          focus: focusOf(seg.top),
          // audioFrom decides who is heard. A split shot with both tracks live
          // puts one room's noise under the other's speech.
          muted: !(seg.audioFrom === 'top' || seg.audioFrom === 'both'),
        }),
      ),
      h(
        'div',
        { style: { position: 'absolute', top: H / 2, left: 0, width: W, height: H / 2, overflow: 'hidden' } },
        h(CropVideo, {
          keyName: `s${i}bot`,
          src: seg.bottom.src,
          inSec: seg.bottom.inSec,
          boxW: W,
          boxH: H / 2,
          focus: focusOf(seg.bottom),
          muted: !(seg.audioFrom === 'bottom' || seg.audioFrom === 'both' || seg.audioFrom == null),
        }),
      ),
      // seam
      h('div', {
        style: {
          position: 'absolute',
          top: H / 2 - 3,
          left: 0,
          width: W,
          height: 6,
          background: 'rgba(0,0,0,0.85)',
          boxShadow: '0 0 22px 8px rgba(0,0,0,0.55)',
        },
      }),
    );

  const CUES = captions ? buildCues(captions, cfg.captionOffsetSec || 0) : [];
  const speakers = [...new Set(CUES.map((c) => c.speaker))];

  const Captions = () => {
    const frame = useCurrentFrame();
    const t = frame / FPS;
    // Precedence: a cue whose CORE window contains t beats another cue's
    // pre-roll/hold tail (without this a previous speaker's +0.45s hold
    // swallowed the first words of the next -- the v4 bug).
    const cue =
      CUES.find((c) => t >= c.start && t <= c.end) ||
      CUES.find((c) => t >= c.start - 0.12 && t <= c.end + 0.45);
    if (!cue) return null;
    const sp = speakerStyle(cue.speaker, Math.max(0, speakers.indexOf(cue.speaker)));
    const alt = sp.italic;

    const age = Math.max(0, Math.min(1, (t - (cue.start - 0.12)) / 0.14));
    const ease = 1 - Math.pow(1 - age, 3);
    const scale = H / 1920; // caption metrics were tuned at 1080x1920

    return h(
      'div',
      {
        style: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 268 * scale,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingLeft: 60 * scale,
          paddingRight: 60 * scale,
          opacity: ease,
          transform: `translateY(${(1 - ease) * 26}px)`,
        },
      },
      h(
        'div',
        {
          style: {
            marginBottom: 14 * scale,
            padding: `${9 * scale}px ${22 * scale}px ${8 * scale}px`,
            borderRadius: 999,
            background: alt ? sp.accent : 'rgba(6,8,14,0.86)',
            border: alt ? 'none' : `${3 * scale}px solid ${sp.accent}`,
            color: alt ? '#04231f' : sp.accent,
            fontFamily: 'Helvetica, Arial, sans-serif',
            fontSize: 30 * scale,
            fontWeight: 800,
            letterSpacing: 5 * scale,
          },
        },
        sp.label,
      ),
      h(
        'div',
        {
          style: {
            maxWidth: 920 * scale,
            background: sp.scrim,
            borderRadius: 26 * scale,
            padding: `${24 * scale}px ${(alt ? 34 : 30) * scale}px ${26 * scale}px`,
            borderLeft: alt ? `${10 * scale}px solid ${sp.accent}` : 'none',
            borderBottom: alt ? 'none' : `${8 * scale}px solid ${sp.accent}`,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            columnGap: 16 * scale,
            rowGap: 6 * scale,
            fontFamily: 'Helvetica, Arial, sans-serif',
            fontStyle: alt ? 'italic' : 'normal',
            fontSize: 78 * scale,
            fontWeight: 800,
            lineHeight: 1.12,
            color: sp.text,
            textShadow: '0 4px 18px rgba(0,0,0,0.85)',
          },
        },
        cue.words.map((w, i) => {
          const spoken = t >= w.t;
          const active = t >= w.t && t <= w.end + 0.08;
          return h(
            'span',
            {
              key: i,
              style: {
                color: active ? (alt ? '#ffffff' : sp.accent) : spoken ? sp.text : 'rgba(255,255,255,0.45)',
                WebkitTextStrokeWidth: active ? '2px' : '0px',
                WebkitTextStrokeColor: 'rgba(0,0,0,0.6)',
              },
            },
            w.text,
          );
        }),
      ),
    );
  };

  const Cut = () =>
    h(
      AbsoluteFill,
      { style: { background: '#000' } },
      ...SEGMENTS.map((seg, i) =>
        h(
          Sequence,
          { key: i, from: seg.startFrame, durationInFrames: seg.durationInFrames, layout: 'none' },
          seg.shot === 'split' ? h(SplitShot, { seg, i }) : h(PortraitShot, { seg, i }),
        ),
      ),
      CUES.length ? h(Captions, null) : null,
    );

  return {
    composition: {
      id: cfg.id || 'edl-cut',
      component: Cut,
      width: W,
      height: H,
      fps: FPS,
      durationInFrames: TOTAL_FRAMES,
    },
    segments: SEGMENTS,
    cues: CUES,
    totalFrames: TOTAL_FRAMES,
  };
}
