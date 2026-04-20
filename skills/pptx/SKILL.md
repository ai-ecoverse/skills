---
name: pptx
description: Generate, read, and edit PowerPoint files (.pptx). Fully self-contained — no npm, no pip, no external skills required. Ships pptx-lib.jsh for creating presentations with images, themes, and positioning.
allowed-tools: bash
trigger-phrases:
  - create a pptx
  - generate pptx file
  - make powerpoint file
  - export to pptx
  - read pptx
  - edit pptx
  - extract text from pptx
  - add slide to pptx
  - pptx with images
---

# PPTX Skill

> **Note**: This skill generates `.pptx` files. For content strategy and presentation structure guidance, see the `presentations` skill.

Four operations: **Create**, **Images**, **Read**, **Edit**. No dependencies on other skills.

---

## Create a presentation

Inline `pptx-lib.jsh` via shell expansion. Key functions:
- `slideXml(bgColor, shapes)` — create a slide with background color and shape content
- `textBox(x, y, w, h, paragraphs, opts)` — text box at position (inches)
- `rectShape(x, y, w, h, fill, opts)` — rectangle shape
- `para(runs, opts)` — paragraph with alignment and spacing
- `textRun(text, opts)` — styled text segment
- `multiPara(texts, opts)` — multiple paragraphs from array

### Theme colors

Each presentation gets a random color theme. Access via `T.xxx` for dark slides:
- `T.dark`, `T.dark2` — dark backgrounds
- `T.accentBar`, `T.highlightBar` — accent colors
- `T.textLight`, `T.textMutedDark` — text on dark backgrounds
- `T.cardBg`, `T.cardBorder` — cards on dark backgrounds
- `T.good`, `T.poor`, `T.warning`, `T.neutral`, `T.purple` — semantic colors

For light slides, use `T.light.xxx`:
- `T.light.bg`, `T.light.bg2` — light backgrounds
- `T.light.text`, `T.light.textMuted`, `T.light.textDim` — dark text for light backgrounds
- `T.light.card`, `T.light.cardBorder` — cards on light backgrounds

### Basic example (text only)

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)
var slides = [];

// Dark title slide
slides.push(slideXml(T.dark, [
  rectShape(0, 0, 13.33, 0.06, T.accentBar),
  textBox(1, 2.2, 11, 1.0, para(textRun('My Title', {size:4000, color:'FFFFFF', bold:true}), {align:'center'})),
  textBox(1, 3.5, 11, 0.5, para(textRun('Subtitle', {size:1600, color:T.textMutedDark}), {align:'center'})),
].join('')));

// Light content slide (note: dark text on light background)
slides.push(slideXml(T.light.bg, [
  rectShape(0, 0, 13.33, 0.06, T.accentBar),
  textBox(0.8, 0.7, 11, 0.6, para(textRun('Slide Title', {size:2200, color:T.light.text, bold:true}))),
  textBox(0.8, 1.6, 11, 4.5, multiPara(['Point one', 'Point two'], {size:1200, color:T.light.textMuted, lnSpc:150000})),
].join('')));

var zipData = assemblePptx(slides, {title: 'My Presentation'});
await writePptx(zipData, '/mnt/my-presentation.pptx');
await exec('open --download /mnt/my-presentation.pptx');
"
```

---

## Add images to slides

Two approaches: **full-bleed background** or **positioned image**.

### When to use which

| Use Case | Function | Notes |
|----------|----------|-------|
| Hero/cover image that fills the slide | `imageSlideXml()` | May stretch non-16:9 images |
| Photo gallery or product shots | `picShape()` | Preserves aspect ratio |
| Screenshot with surrounding text | `picShape()` | Position anywhere on slide |
| Cinematic/visual impact slide | `imageSlideXml()` | Best with 16:9 landscape images |
| Logo or icon placement | `picShape()` | Control exact size and position |
| Infographic with annotations | `picShape()` | Combine with textBox, rectShape |

**Rule of thumb**: Use `imageSlideXml()` for dramatic full-slide visuals. Use `picShape()` for everything else.

### Positioned images (recommended)

Use `picShape(x, y, w, h, rId)` to place images at specific positions without stretching:

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)

// Load image (read b64 file saved by fetchImageB64, then decode)
var b64str = await fs.readFile('/tmp/photo.b64');
var imgBytes = Uint8Array.from(atob(b64str.trim()), function(c){ return c.charCodeAt(0); });

var slides = [];

// Title slide
slides.push(slideXml(T.dark, [
  textBox(1, 2, 11, 1, para(textRun('My Deck', {size:4000, color:'FFFFFF', bold:true}), {align:'center'})),
].join('')));

// Slide with positioned image — use slideWithImagesXml for slides containing picShape
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

### Full-bleed background images

Use `imageSlideXml(caption)` for images that fill the entire slide (may stretch):

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)

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

### Fetching images from URLs

Use `fetchImageB64()` to download images (avoids VFS binary corruption):

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)
await fetchImageB64('https://example.com/photo.jpg', '/tmp/img1.b64');
console.log('done');
"
```

Then load the b64 file and decode:
```javascript
var b64 = await fs.readFile('/tmp/img1.b64');
var imgBytes = Uint8Array.from(atob(b64.trim()), function(c){ return c.charCodeAt(0); });
```

### Image formats

Supported: PNG (`ext: 'png'`) and JPEG (`ext: 'jpeg'`). The skill auto-detects and sets Content-Types.

---

## Read an existing .pptx

Extract all slide text:

```bash
cat > /tmp/read_pptx.py << 'EOF'
import zipfile, io, re, sys
data = open(sys.argv[1], 'rb').read()
zf = zipfile.ZipFile(io.BytesIO(data))
slides = sorted(
    [n for n in zf.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)],
    key=lambda x: int(re.search(r'\d+', x).group())
)
for i, path in enumerate(slides, 1):
    xml = zf.read(path).decode('utf-8', errors='replace')
    texts = re.findall(r'<a:t[^>]*>([^<]+)</a:t>', xml)
    print(f'Slide {i}: {" | ".join(t.strip() for t in texts if t.strip())}')
print(f'Total: {len(slides)} slides')
EOF
python3 /tmp/read_pptx.py /mnt/file.pptx
```

---

## Edit an existing .pptx

### Replace text

```bash
cat > /tmp/edit_pptx.py << 'EOF'
import zipfile, io, sys
src, dst, find, replace = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
data = open(src, 'rb').read()
src_zip = zipfile.ZipFile(io.BytesIO(data))
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
    for name in src_zip.namelist():
        content = src_zip.read(name)
        if name.startswith('ppt/slides/slide') and name.endswith('.xml'):
            content = content.replace(find.encode(), replace.encode())
        out.writestr(name, content)
open(dst, 'wb').write(buf.getvalue())
print(f'Saved: {dst}')
EOF
python3 /tmp/edit_pptx.py /mnt/input.pptx /mnt/output.pptx "Old Title" "New Title"
open --download /mnt/output.pptx
```

### Add a text slide

```bash
cat > /tmp/add_slide.py << 'EOF'
import zipfile, io, re, sys
src, dst = sys.argv[1], sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else 'New Slide'
body = sys.argv[4] if len(sys.argv) > 4 else ''
data = open(src, 'rb').read()
src_zip = zipfile.ZipFile(io.BytesIO(data))
slides = [n for n in src_zip.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)]
new_num = len(slides) + 1
new_slide_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{body}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClr/></p:clrMapOvr>
</p:sld>'''
new_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
prs_xml = src_zip.read('ppt/presentation.xml').decode('utf-8')
max_id = max((int(x) for x in re.findall(r'id="(\d+)"', prs_xml)), default=256)
prs_xml = prs_xml.replace('</p:sldIdLst>', f'<p:sldId id="{max_id+1}" r:id="rId{new_num+10}"/></p:sldIdLst>')
prs_rels = src_zip.read('ppt/_rels/presentation.xml.rels').decode('utf-8')
prs_rels = prs_rels.replace('</Relationships>', f'<Relationship Id="rId{new_num+10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{new_num}.xml"/></Relationships>')
ct = src_zip.read('[Content_Types].xml').decode('utf-8')
ct = ct.replace('</Types>', f'<Override PartName="/ppt/slides/slide{new_num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>')
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
    for name in src_zip.namelist():
        if name == 'ppt/presentation.xml': out.writestr(name, prs_xml.encode())
        elif name == 'ppt/_rels/presentation.xml.rels': out.writestr(name, prs_rels.encode())
        elif name == '[Content_Types].xml': out.writestr(name, ct.encode())
        else: out.writestr(name, src_zip.read(name))
    out.writestr(f'ppt/slides/slide{new_num}.xml', new_slide_xml.encode())
    out.writestr(f'ppt/slides/_rels/slide{new_num}.xml.rels', new_rels.encode())
open(dst, 'wb').write(buf.getvalue())
print(f'Added slide {new_num}: "{title}" -> {dst}')
EOF
python3 /tmp/add_slide.py /mnt/input.pptx /mnt/output.pptx "Slide Title" "Body text"
open --download /mnt/output.pptx
```

---

## Downloading the result

Use `writePptx()` to write the file, then `open --download` to deliver it. Write to `/mnt/` paths — binary output to `/tmp/` is not reliable.

```javascript
await writePptx(zipData, '/mnt/my-deck.pptx');
await exec('open --download /mnt/my-deck.pptx');
```

`writePptx` handles the base64 encode/decode internally — no manual `toB64Safe` or shell piping needed.

---

## API Reference

### Slide creation
- `slideXml(bgColor, shapes)` — standard slide with solid background
- `slideWithImagesXml(bgColor, shapes)` — slide that can contain `picShape()` elements
- `imageSlideXml(caption)` — full-bleed background image slide

### Shapes
- `textBox(x, y, w, h, paragraphs, opts)` — text container
  - opts: `{fill, border, va}` (va: 't'|'m'|'b' for vertical align)
- `rectShape(x, y, w, h, fill, opts)` — rectangle
  - opts: `{rr, border}` (rr: true for rounded corners)
- `picShape(x, y, w, h, rId)` — positioned image (use with `slideWithImagesXml`)

### Text
- `textRun(text, opts)` — styled text segment
  - opts: `{size, color, bold, italic, font}`
- `para(runs, opts)` — paragraph wrapper
  - opts: `{align, lnSpc}` (align: 'left'|'center'|'right')
- `multiPara(texts, opts)` — multiple paragraphs from string array

### Assembly
- `assemblePptx(slideXmls, meta)` — build PPTX without images
- `assemblePptxWithImages(slideXmls, images, meta)` — build PPTX with embedded images
  - images: `[{slideIndex, mediaIndex, bytes, ext}]`
- `toB64Safe(bytes)` — convert Uint8Array to base64 string

### Utilities
- `fetchImageB64(url, outPath)` — download image and save as base64
- `emu(inches)` — convert inches to EMUs (914400 per inch)
- `escXml(str)` — escape XML special characters
