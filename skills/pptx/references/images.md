# Adding images to slides

Two approaches: **full-bleed background** or **positioned image**.

**Rule of thumb**: use `imageSlideXml()` for dramatic full-slide visuals; use `picShape()` for
everything else.

## Fetching images from URLs

Use `fetchImageB64()` to download images (avoids VFS binary corruption):

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)
await fetchImageB64('https://example.com/photo.jpg', '/tmp/img1.b64');
console.log('done');
"
```

Load and decode the b64 file (use this pattern whenever reading a saved b64 file):

```javascript
var b64 = await fs.readFile('/tmp/img1.b64');
var imgBytes = Uint8Array.from(atob(b64.trim()), function(c){ return c.charCodeAt(0); });
```

**Error handling**: `fetchImageB64` validates the HTTP response (uses `curl --fail`) and checks the
file's magic bytes for PNG (`89 50 4E 47`) or JPEG (`FF D8 FF`). On any failure — network error,
non-2xx status, HTML error page, or unsupported format like SVG/WebP/GIF — it deletes the output
file and returns `null`. Check the return value (and that the file exists) before reading it, and
fall back to a placeholder `rectShape` if the image cannot be loaded:

```javascript
var ok = await fetchImageB64('https://example.com/photo.jpg', '/tmp/img1.b64');
if (!ok) {
  // fall back to a placeholder shape instead of embedding a broken image
}
```

**Image formats**: only PNG (`ext: 'png'`) and JPEG (`ext: 'jpeg'`) are supported. SVG, WebP, GIF,
and other formats are rejected by `fetchImageB64` and must be converted upstream.

## Positioned images (recommended)

Use `picShape(x, y, w, h, rId)` to place images at specific positions without stretching. Use
`slideWithImagesXml` for any slide containing `picShape` elements:

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)

// Load image using the b64 decode pattern above
var b64str = await fs.readFile('/tmp/photo.b64');
var imgBytes = Uint8Array.from(atob(b64str.trim()), function(c){ return c.charCodeAt(0); });

var slides = [];

// Title slide
slides.push(slideXml(T.dark, [
  textBox(1, 2, 11, 1, para(textRun('My Deck', {size:4000, color:'FFFFFF', bold:true}), {align:'center'})),
].join('')));

// Slide with positioned image
slides.push(slideWithImagesXml(T.light.bg, [
  textBox(0.6, 0.5, 12, 0.6, para(textRun('Photo Gallery', {size:2400, color:T.light.text, bold:true}))),
  picShape(4, 1.5, 5, 4, 'rId2'),  // centered 5x4 inch image
  textBox(0.6, 6, 12, 0.5, para(textRun('Caption text', {size:1200, color:T.light.textMuted}), {align:'center'})),
].join('')));

// Image metadata: slideIndex (1-based), mediaIndex, bytes, ext
var images = [
  { slideIndex: 2, mediaIndex: 1, bytes: imgBytes, ext: 'jpeg' }
];

var zipData = assemblePptxWithImages(slides, images, {title: 'Photo Deck'});
await writePptx(zipData, '/mnt/photo-deck.pptx');
await exec('open --download /mnt/photo-deck.pptx');
"
```

## Full-bleed background images

Use `imageSlideXml(caption)` for images that fill the entire slide (may stretch):

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)

// Load image using the b64 decode pattern above
var b64str = await fs.readFile('/tmp/photo.b64');
var imgBytes = Uint8Array.from(atob(b64str.trim()), function(c){ return c.charCodeAt(0); });

var slides = [];
slides.push(slideXml(T.dark, [
  textBox(1, 3, 11, 1, para(textRun('Title', {size:4000, color:'FFFFFF', bold:true}), {align:'center'})),
].join('')));

// Full-bleed image slide (stretches to fill)
slides.push(imageSlideXml('Optional caption overlay'));

var images = [
  { slideIndex: 2, mediaIndex: 1, bytes: imgBytes, ext: 'jpeg' }
];

var zipData = assemblePptxWithImages(slides, images, {title: 'Deck'});
await writePptx(zipData, '/mnt/deck.pptx');
await exec('open --download /mnt/deck.pptx');
"
```

## Verify the output

Image assembly embeds binary media into the ZIP. After writing, confirm the file is a valid PPTX
by reading it back with the read script (see [`reading-pptx.md`](reading-pptx.md)) and checking the
slide count matches what you generated.
