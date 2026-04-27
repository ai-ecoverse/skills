// pptx2pdf-lib.jsh — Convert PPTX to PDF preserving layout, text, colors, images.
// Requires: JSZip (SLICC global), pdf-lib + fontkit (via esm.sh)

var EMU_PER_PT = 12700;
var SLIDE_W_PT = 960;
var SLIDE_H_PT = 540;
var TEXT_PAD   = 5;

var _pdfLib = null;
var loadPdfLib = async function() {
  if (!_pdfLib) _pdfLib = await import('https://esm.sh/pdf-lib');
  return _pdfLib;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

var emuToPt = function(emu) { return emu / EMU_PER_PT; };

var hexToRgb = function(hex, lib) {
  var h = (hex || '000000').replace('#', '').toUpperCase();
  if (h.length !== 6) return lib.rgb(0, 0, 0);
  return lib.rgb(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  );
};

var decodeXmlEntities = function(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g,           function(_, d) { return String.fromCharCode(parseInt(d, 10)); });
};

var attr = function(xml, tag, attribute) {
  var m = xml.match(new RegExp('<' + tag + '[^>]*\\s' + attribute + '="([^"]*)"', 'i'));
  return m ? m[1] : null;
};

var findAll = function(xml, tagName) {
  var re = new RegExp('<' + tagName + '[\\s>][\\s\\S]*?<\\/' + tagName + '>|<' + tagName + '\\s*\\/>', 'g');
  return xml.match(re) || [];
};

var inner = function(xml, tagName) {
  var m = xml.match(new RegExp('<' + tagName + '[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'i'));
  return m ? m[1] : null;
};

// Replace chars outside WinAnsi range (only used when falling back to Helvetica standard fonts)
var sanitizeWinAnsi = function(text) {
  if (!text) return text;
  var winAnsiExtra = new Set([
    0x0152,0x0153,0x017D,0x017E,0x0160,0x0161,0x0178,0x0192,
    0x02C6,0x02DC,0x2013,0x2014,0x2018,0x2019,0x201A,0x201C,
    0x201D,0x201E,0x2020,0x2021,0x2026,0x2030,0x2039,0x203A,
    0x20AC,0x2122
  ]);
  return text.split('').map(function(c) {
    var code = c.charCodeAt(0);
    if (code <= 0x00FF || winAnsiExtra.has(code)) return c;
    if (code === 0x25B6) return '>';
    if (code === 0x2022 || code === 0x25CF || code === 0x25A0) return '-';
    if (code === 0x2192) return '->';
    if (code === 0x2190) return '<-';
    if (code === 0x2713 || code === 0x2714) return '+';
    if (code === 0x2715 || code === 0x2716) return 'x';
    if (code === 0x00B7) return '.';
    return '';
  }).join('');
};

// ─── Font loading ─────────────────────────────────────────────────────────────
// Priority: 1) fonts embedded in the PPTX itself  2) Google Fonts (TTF UA)  3) Helvetica fallback

var fetchFontBytes = async function(url) {
  var res   = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + url);
  return new Uint8Array(await res.arrayBuffer());
};

// jsDelivr TTF URLs per family. Each entry: [regular, bold, italic, boldItalic].
// Uses the dedicated npm packages that ship TTF files directly.
var FONT_URLS = {
  'source sans pro': [
    'https://cdn.jsdelivr.net/npm/source-sans-pro@3.6.0/TTF/SourceSansPro-Regular.ttf',
    'https://cdn.jsdelivr.net/npm/source-sans-pro@3.6.0/TTF/SourceSansPro-Bold.ttf',
    'https://cdn.jsdelivr.net/npm/source-sans-pro@3.6.0/TTF/SourceSansPro-It.ttf',
    'https://cdn.jsdelivr.net/npm/source-sans-pro@3.6.0/TTF/SourceSansPro-BoldIt.ttf',
  ],
  'open sans': [
    'https://cdn.jsdelivr.net/npm/open-sans-all@0.1.3/fonts/open-sans-regular.ttf',
    'https://cdn.jsdelivr.net/npm/open-sans-all@0.1.3/fonts/open-sans-700.ttf',
    'https://cdn.jsdelivr.net/npm/open-sans-all@0.1.3/fonts/open-sans-italic.ttf',
    'https://cdn.jsdelivr.net/npm/open-sans-all@0.1.3/fonts/open-sans-700italic.ttf',
  ],
  'roboto': [
    'https://cdn.jsdelivr.net/npm/roboto-font@0.1.0/fonts/Roboto/roboto-regular-webfont.ttf',
    'https://cdn.jsdelivr.net/npm/roboto-font@0.1.0/fonts/Roboto/roboto-bold-webfont.ttf',
    'https://cdn.jsdelivr.net/npm/roboto-font@0.1.0/fonts/Roboto/roboto-italic-webfont.ttf',
    'https://cdn.jsdelivr.net/npm/roboto-font@0.1.0/fonts/Roboto/roboto-bolditalic-webfont.ttf',
  ],
  'lato': [
    'https://cdn.jsdelivr.net/npm/lato-font@3.0.0/fonts/lato-normal/lato-normal.woff',
    'https://cdn.jsdelivr.net/npm/lato-font@3.0.0/fonts/lato-bold/lato-bold.woff',
    'https://cdn.jsdelivr.net/npm/lato-font@3.0.0/fonts/lato-normal-italic/lato-normal-italic.woff',
    'https://cdn.jsdelivr.net/npm/lato-font@3.0.0/fonts/lato-bold-italic/lato-bold-italic.woff',
  ],
  'montserrat': [
    'https://cdn.jsdelivr.net/npm/@typopro/web-montserrat@3.7.5/TypoPRO-Montserrat-Regular.ttf',
    'https://cdn.jsdelivr.net/npm/@typopro/web-montserrat@3.7.5/TypoPRO-Montserrat-Bold.ttf',
    'https://cdn.jsdelivr.net/npm/@typopro/web-montserrat@3.7.5/TypoPRO-Montserrat-Italic.ttf',
    'https://cdn.jsdelivr.net/npm/@typopro/web-montserrat@3.7.5/TypoPRO-Montserrat-BoldItalic.ttf',
  ],
  'poppins': [
    'https://cdn.jsdelivr.net/npm/@typopro/web-poppins@3.7.5/TypoPRO-Poppins-Regular.ttf',
    'https://cdn.jsdelivr.net/npm/@typopro/web-poppins@3.7.5/TypoPRO-Poppins-Bold.ttf',
    'https://cdn.jsdelivr.net/npm/@typopro/web-poppins@3.7.5/TypoPRO-Poppins-Italic.ttf',
    'https://cdn.jsdelivr.net/npm/@typopro/web-poppins@3.7.5/TypoPRO-Poppins-BoldItalic.ttf',
  ],
  'inter': [
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.0/files/inter-latin-400-normal.woff2',
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.0/files/inter-latin-700-normal.woff2',
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.0/files/inter-latin-400-italic.woff2',
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.0/files/inter-latin-700-italic.woff2',
  ],
};

var registerFontkit = async function(pdfDoc) {
  var fk = await import('https://esm.sh/@pdf-lib/fontkit');
  pdfDoc.registerFontkit(fk.default || fk);
};

var loadFonts = async function(pdfDoc, lib, typeface, zip) {
  // 1. Fonts embedded inside the PPTX (ppt/fonts/*.ttf / *.otf / *.fntdata)
  var embeddedFontFiles = Object.keys(zip.files).filter(function(f) {
    return /^ppt\/fonts\/.+\.(ttf|otf|fntdata)$/i.test(f);
  });
  if (embeddedFontFiles.length >= 1) {
    try {
      await registerFontkit(pdfDoc);
      var pick = function(kws) {
        var f = embeddedFontFiles.find(function(n) {
          var lo = n.toLowerCase();
          return kws.every(function(k) { return lo.includes(k); });
        }) || embeddedFontFiles[0];
        return zip.file(f).async('uint8array');
      };
      var variants = await Promise.all([
        pick(['regular']), pick(['bold']), pick(['italic']), pick(['bold', 'italic']),
      ]);
      console.log('Using PPTX-embedded font: ' + typeface);
      return {
        regular:    await pdfDoc.embedFont(variants[0], { subset: true }),
        bold:       await pdfDoc.embedFont(variants[1], { subset: true }),
        italic:     await pdfDoc.embedFont(variants[2], { subset: true }),
        boldItalic: await pdfDoc.embedFont(variants[3], { subset: true }),
      };
    } catch (e) {
      console.log('PPTX-embedded font failed: ' + e.message);
    }
  }

  // 2. jsDelivr TTF CDN lookup
  if (typeface) {
    var urls = FONT_URLS[typeface.toLowerCase()];
    if (urls) {
      try {
        await registerFontkit(pdfDoc);
        var variants = await Promise.all(urls.map(fetchFontBytes));
        console.log('Embedded font: ' + typeface);
        return {
          regular:    await pdfDoc.embedFont(variants[0], { subset: true }),
          bold:       await pdfDoc.embedFont(variants[1], { subset: true }),
          italic:     await pdfDoc.embedFont(variants[2], { subset: true }),
          boldItalic: await pdfDoc.embedFont(variants[3], { subset: true }),
        };
      } catch (e) {
        console.log('Font CDN failed (' + typeface + '): ' + e.message + ' — using Helvetica');
      }
    } else {
      console.log('Font not in table: ' + typeface + ' — using Helvetica');
    }
  }

  // 3. Helvetica fallback
  return {
    regular:    await pdfDoc.embedFont(lib.StandardFonts.Helvetica),
    bold:       await pdfDoc.embedFont(lib.StandardFonts.HelveticaBold),
    italic:     await pdfDoc.embedFont(lib.StandardFonts.HelveticaOblique),
    boldItalic: await pdfDoc.embedFont(lib.StandardFonts.HelveticaBoldOblique),
  };
};

// ─── PPTX Parser ─────────────────────────────────────────────────────────────

var parseSlide = function(slideXml, layoutXml, masterXml, relsXml) {
  var slide = { background: 'FFFFFF', shapes: [], images: {} };

  // Background: check slide → layout → master
  var bgSources = [slideXml, layoutXml, masterXml];
  for (var i = 0; i < bgSources.length; i++) {
    if (!bgSources[i]) continue;
    var bgColor = attr(bgSources[i], 'a:srgbClr', 'val');
    if (bgColor) { slide.background = bgColor; break; }
  }

  // rId → media path from slide rels
  if (relsXml) {
    findAll(relsXml, 'Relationship').forEach(function(rel) {
      var id = attr(rel, 'Relationship', 'Id');
      var target = attr(rel, 'Relationship', 'Target');
      var type   = attr(rel, 'Relationship', 'Type') || '';
      if (id && target && type.includes('image'))
        slide.images[id] = target.replace(/^\.\.\//, 'ppt/');
    });
  }

  var spTree = inner(slideXml, 'p:spTree') || slideXml;

  findAll(spTree, 'p:sp').forEach(function(sp) {
    var xfrm = parseXfrm(sp);
    if (!xfrm) return;
    var spPr = inner(sp, 'p:spPr') || '';
    var hasSolidFill = /<a:solidFill/.test(spPr) && !/<a:noFill/.test(spPr);
    slide.shapes.push({
      type: 'text',
      xfrm: xfrm,
      fill: hasSolidFill ? attr(spPr, 'a:srgbClr', 'val') : null,
      paragraphs: parseParagraphs(sp),
    });
  });

  findAll(spTree, 'p:pic').forEach(function(pic) {
    var xfrm = parseXfrm(pic);
    var rId  = attr(pic, 'a:blip', 'r:embed') || attr(pic, 'a:blip', 'embed');
    if (xfrm && rId) slide.shapes.push({ type: 'image', xfrm: xfrm, rId: rId });
  });

  return slide;
};

var parseXfrm = function(xml) {
  var xfrm = inner(xml, 'a:xfrm') || inner(xml, 'p:xfrm');
  if (!xfrm) return null;
  return {
    x:  parseInt(attr(xfrm, 'a:off', 'x')  || '0'),
    y:  parseInt(attr(xfrm, 'a:off', 'y')  || '0'),
    cx: parseInt(attr(xfrm, 'a:ext', 'cx') || '0'),
    cy: parseInt(attr(xfrm, 'a:ext', 'cy') || '0'),
  };
};

var parseParagraphs = function(xml) {
  return findAll(xml, 'a:p').map(function(para) {
    var align = attr(para, 'a:pPr', 'algn') || 'l';
    var runs = findAll(para, 'a:r').map(function(run) {
      var m    = run.match(/<a:t[^>]*>([^<]*)<\/a:t>/i);
      var text = m ? decodeXmlEntities(m[1]) : '';
      var bold   = /<a:b\s*\/>|<a:b>/.test(run) || attr(run, 'a:rPr', 'b') === '1';
      var italic = attr(run, 'a:rPr', 'i') === '1';
      var sizeHpr = parseInt(attr(run, 'a:rPr', 'sz') || '0');
      return {
        text:   text,
        bold:   bold,
        italic: italic,
        size:   sizeHpr > 0 ? sizeHpr / 100 : 18,
        color:  attr(run, 'a:srgbClr', 'val') || '000000',
      };
    });
    return { align: align, runs: runs };
  });
};

// ─── PDF Renderer ─────────────────────────────────────────────────────────────

var pickFont = function(fonts, run) {
  if (!run) return fonts.regular;
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold)               return fonts.bold;
  if (run.italic)             return fonts.italic;
  return fonts.regular;
};

var wrapText = function(text, font, size, maxW) {
  if (maxW <= 0 || font.widthOfTextAtSize(text, size) <= maxW) return [text];
  var words = text.split(' '), lines = [], line = '';
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    var candidate = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxW) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) > maxW) {
        var chunk = '';
        for (var ci = 0; ci < word.length; ci++) {
          var next = chunk + word[ci];
          if (font.widthOfTextAtSize(next, size) <= maxW) { chunk = next; }
          else { if (chunk) lines.push(chunk); chunk = word[ci]; }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
};

var renderSlide = async function(pdfDoc, slide, fonts, embeddedImages, useEmbedded) {
  var lib  = await loadPdfLib();
  var page = pdfDoc.addPage([SLIDE_W_PT, SLIDE_H_PT]);

  page.drawRectangle({ x: 0, y: 0, width: SLIDE_W_PT, height: SLIDE_H_PT,
    color: hexToRgb(slide.background, lib) });

  // Images before text
  var ordered = slide.shapes.slice().sort(function(a, b) {
    return (a.type === 'image' ? 0 : 1) - (b.type === 'image' ? 0 : 1);
  });

  for (var i = 0; i < ordered.length; i++) {
    var shape = ordered[i];
    var sx = emuToPt(shape.xfrm.x);
    var sw = emuToPt(shape.xfrm.cx);
    var sh = emuToPt(shape.xfrm.cy);
    var sy = SLIDE_H_PT - emuToPt(shape.xfrm.y) - sh;

    if (shape.type === 'image') {
      var img = embeddedImages[shape.rId];
      if (img) page.drawImage(img, { x: sx, y: sy, width: sw, height: sh });

    } else if (shape.type === 'text') {
      if (shape.fill)
        page.drawRectangle({ x: sx, y: sy, width: sw, height: sh, color: hexToRgb(shape.fill, lib) });

      var boxTop = SLIDE_H_PT - emuToPt(shape.xfrm.y);
      var boxBot = boxTop - sh;
      var curY   = boxTop - TEXT_PAD;

      for (var pi = 0; pi < shape.paragraphs.length; pi++) {
        var para     = shape.paragraphs[pi];
        var rawText  = para.runs.map(function(r) { return r.text; }).join('');
        var lineText = useEmbedded ? rawText : sanitizeWinAnsi(rawText);
        if (!lineText.trim()) { curY -= 6; continue; }

        var firstRun = para.runs[0];
        var fontSize = firstRun ? firstRun.size : 18;
        var font     = pickFont(fonts, firstRun);
        var maxLineW = sw - TEXT_PAD * 2;
        var wrapped  = wrapText(lineText, font, fontSize, maxLineW);

        for (var wli = 0; wli < wrapped.length; wli++) {
          var wLine = wrapped[wli];
          curY -= fontSize;
          if (curY < boxBot || curY > SLIDE_H_PT) break;

          var lineW = font.widthOfTextAtSize(wLine, fontSize);
          var lineX = sx + TEXT_PAD;
          if (para.align === 'ctr' || para.align === 'center') lineX = sx + (sw - lineW) / 2;
          else if (para.align === 'r') lineX = sx + sw - lineW - TEXT_PAD;

          if (para.runs.length <= 1 || wli > 0) {
            var rr = para.runs[0] || firstRun;
            page.drawText(wLine, { x: lineX, y: curY, size: fontSize, font: font,
              color: hexToRgb((rr && rr.color) || '000000', lib) });
          } else {
            var runX = lineX;
            for (var ri = 0; ri < para.runs.length; ri++) {
              var run   = para.runs[ri];
              var rText = useEmbedded ? run.text : sanitizeWinAnsi(run.text);
              if (!rText) continue;
              var rFont = pickFont(fonts, run);
              var rSize = run.size || fontSize;
              var rMaxW = sx + sw - runX - TEXT_PAD;
              if (rMaxW <= 0) break;
              if (rFont.widthOfTextAtSize(rText, rSize) > rMaxW)
                rText = wrapText(rText, rFont, rSize, rMaxW)[0];
              if (!rText) continue;
              page.drawText(rText, { x: runX, y: curY, size: rSize, font: rFont,
                color: hexToRgb(run.color || '000000', lib) });
              runX += rFont.widthOfTextAtSize(rText, rSize);
            }
          }
          curY -= 3;
        }
      }
    }
  }
};

// ─── Main ────────────────────────────────────────────────────────────────────

var convertPptxToPdf = async function(inputPath, outputPath) {
  var lib = await loadPdfLib();
  var JSZip = require('jszip');
  var zip   = await JSZip.loadAsync(await fs.readFileBinary(inputPath));

  var slideFiles = Object.keys(zip.files)
    .filter(function(f) { return /^ppt\/slides\/slide\d+\.xml$/.test(f); })
    .sort(function(a, b) { return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]); });

  var layoutXml = null, masterXml = null;
  var lf = Object.keys(zip.files).filter(function(f) { return /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f); });
  var mf = Object.keys(zip.files).filter(function(f) { return /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(f); });
  if (lf.length) layoutXml = await zip.file(lf[0]).async('string');
  if (mf.length) masterXml = await zip.file(mf[0]).async('string');

  // Detect theme font
  var typeface = '';
  var tf = Object.keys(zip.files).filter(function(f) { return f.includes('theme'); });
  if (tf.length) {
    var themeXml = await zip.file(tf[0]).async('string');
    var tm = themeXml.match(/a:majorFont[^>]*>[\s]*<a:latin\s+typeface="([^"]+)"/i);
    if (tm) typeface = tm[1];
  }

  var pdfDoc = await lib.PDFDocument.create();
  var fonts  = await loadFonts(pdfDoc, lib, typeface, zip);
  var useEmbedded = fonts.regular.constructor.name !== 'PDFFont' || !lib.StandardFonts;
  // Simpler check: if fontkit was registered, we have a custom font
  useEmbedded = !!zip.files && typeface && fonts.regular.name !== 'Helvetica';

  for (var s = 0; s < slideFiles.length; s++) {
    var slideNum = slideFiles[s].match(/\d+/)[0];
    var slideXml = await zip.file(slideFiles[s]).async('string');
    var relsPath = 'ppt/slides/_rels/slide' + slideNum + '.xml.rels';
    var relsXml  = zip.file(relsPath) ? await zip.file(relsPath).async('string') : null;
    var slide    = parseSlide(slideXml, layoutXml, masterXml, relsXml);

    var embeddedImages = {};
    for (var rId in slide.images) {
      var imgPath = slide.images[rId];
      if (!zip.file(imgPath)) continue;
      var imgBytes = await zip.file(imgPath).async('uint8array');
      try {
        if      (/\.png$/i.test(imgPath))        embeddedImages[rId] = await pdfDoc.embedPng(imgBytes);
        else if (/\.(jpg|jpeg)$/i.test(imgPath)) embeddedImages[rId] = await pdfDoc.embedJpg(imgBytes);
      } catch (e) { /* skip unembeddable images */ }
    }

    await renderSlide(pdfDoc, slide, fonts, embeddedImages, useEmbedded);
    console.log('Rendered slide ' + (s + 1) + ' of ' + slideFiles.length);
  }

  var pdfBytes = await pdfDoc.save();
  await fs.writeFileBinary(outputPath, pdfBytes);
  var check = await exec('wc -c "' + outputPath + '"');
  console.log('PDF written: ' + (check.stdout || '').trim());
  return outputPath;
};
