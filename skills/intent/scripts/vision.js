// The screenshot as a kev vision bundle sees it: scaled to kev.js's pixel
// cap when the window is bigger than that, with every shortlisted control
// boxed and labelled with its ref, so an option such as click:e31 points at
// something visible (set-of-marks).
// The canvas work needs a worker's createImageBitmap and OffscreenCanvas;
// the layout is plain arithmetic and is tested on its own.

// kev.js resizes an image to at most 768 x 768 = 589,824 pixels, as Qwen's
// processor does. Drawing the marks at that size keeps them legible after.
const MAX_PIXELS = 589824;
const LABEL_PX = 14;
const COLORS = { mark: '#e11d48', label: '#ffffff' };

/** The size kev will see: the screenshot scaled down to the pixel cap. */
function fitSize(width, height, maxPixels = MAX_PIXELS) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

/**
 * One mark per control on the menu that is at least partly on screen, in
 * image pixels. `toImage` maps CSS pixels (the snapshot's boxes) to the
 * image: image width / viewport width.
 */
function layoutMarks(menu, viewport, size) {
  if (!viewport || !viewport.width) return [];
  const k = size.width / viewport.width;
  const seen = new Set();
  const marks = [];
  for (const action of menu) {
    const element = action.element;
    if (!element || !element.box || seen.has(element.token)) continue;
    const [x, y, w, h] = element.box;
    if (
      w === 0 ||
      h === 0 ||
      y + h <= 0 ||
      y >= viewport.height ||
      x + w <= 0 ||
      x >= viewport.width
    ) {
      continue;
    }
    seen.add(element.token);
    marks.push({
      label: element.token,
      x: Math.round(x * k),
      y: Math.round(y * k),
      w: Math.max(2, Math.round(w * k)),
      h: Math.max(2, Math.round(h * k)),
    });
  }
  return marks;
}

/**
 * Decode a PNG, scale it, draw the marks, and return
 * { image: {width, height, data}, png, marks } where image is what
 * kev.systemOne takes and png the same picture for the debug page.
 */
async function markedImage(bytes, menu, viewport, g = globalThis) {
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') {
    throw new Error(
      'this worker has no createImageBitmap / OffscreenCanvas for the marked screenshot'
    );
  }
  const bitmap = await g.createImageBitmap(new g.Blob([bytes], { type: 'image/png' }));
  const size = fitSize(bitmap.width, bitmap.height);
  const canvas = new g.OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  if (bitmap.close) bitmap.close();
  const marks = layoutMarks(menu, viewport, size);
  ctx.font = `bold ${LABEL_PX}px sans-serif`;
  ctx.textBaseline = 'top';
  for (const m of marks) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.mark;
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    const tw = Math.ceil(ctx.measureText(m.label).width) + 6;
    const ly = m.y >= LABEL_PX + 2 ? m.y - LABEL_PX - 2 : m.y;
    ctx.fillStyle = COLORS.mark;
    ctx.fillRect(m.x, ly, tw, LABEL_PX + 2);
    ctx.fillStyle = COLORS.label;
    ctx.fillText(m.label, m.x + 3, ly + 1);
  }
  const pixels = ctx.getImageData(0, 0, size.width, size.height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const png = new Uint8Array(await blob.arrayBuffer());
  return {
    image: { width: pixels.width, height: pixels.height, data: pixels.data },
    png,
    marks,
    scale: size.scale,
  };
}

/**
 * The same picture as a JPEG, for the training log (a fraction of the PNG's
 * size).
 */
async function toJpeg(pngBytes, quality = 0.7) {
  const g = globalThis;
  const bitmap = await g.createImageBitmap(new g.Blob([pngBytes], { type: 'image/png' }));
  const canvas = new g.OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

module.exports = {
  toJpeg,
  MAX_PIXELS,
  fitSize,
  layoutMarks,
  markedImage,
};
