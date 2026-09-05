// make-fixtures.jsh — build the deterministic PDF fixtures used by run-tests.sh
//
// Usage: make-fixtures [outdir]     (default: current directory)
//
// Everything is written from raw PDF bytes, so the fixtures need no network, no
// font files and no `convert` (which has no `text:` coder in SLICC). Byte-for-byte
// reproducible apart from big.pdf's random padding, which only affects file size.

var fs     = require('fs');
var path   = require('path');
var zlib   = require('zlib');
var crypto = require('crypto');

var argOut = process.argv.slice(2)[0];
var OUT = argOut ? (path.isAbsolute(argOut) ? argOut : path.join(process.cwd(), argOut)) : process.cwd();

// ---------------------------------------------------------------- PDF assembler

function assemble(objs, order, trailerExtra) {
  var chunks = [], pos = 0, off = {};
  function push(b) {
    var buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    chunks.push(buf); pos += buf.length;
  }
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  for (var i = 0; i < order.length; i++) {
    var n = order[i], o = objs[n];
    off[n] = pos;
    if (o.stream != null) {
      var data = Buffer.isBuffer(o.stream) ? o.stream : Buffer.from(o.stream, 'latin1');
      push(n + ' 0 obj\n<< /Length ' + data.length + (o.extra || '') + ' >>\nstream\n');
      push(data);
      push('\nendstream\nendobj\n');
    } else {
      push(n + ' 0 obj\n' + o.dict + '\nendobj\n');
    }
  }
  var xref = pos;
  var maxNum = Math.max.apply(null, order);
  var x = 'xref\n0 ' + (maxNum + 1) + '\n0000000000 65535 f \n';
  for (var k = 1; k <= maxNum; k++) {
    x += (off[k] === undefined ? '0000000000 65535 f \n'
                              : String(off[k]).padStart(10, '0') + ' 00000 n \n');
  }
  push(x);
  push('trailer\n<< /Size ' + (maxNum + 1) + ' /Root 1 0 R' + (trailerExtra || '') + ' >>\n' +
       'startxref\n' + xref + '\n%%EOF\n');
  return Buffer.concat(chunks);
}

function write(name, buf) {
  var p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  console.log('  ' + name + '  ' + buf.length + ' bytes');
  return p;
}

var SIMPLE_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

// ------------------------------------------- 1 & 2: simple-raw / simple-flate

var simpleContent =
  'BT /F1 18 Tf 72 700 Td (INVOICE ACME CORP) Tj ET\n' +
  'BT /F1 12 Tf 72 670 Td (Total Due 4242 USD) Tj ET\n' +
  'BT /F1 12 Tf 72 650 Td [(Hello) -500 (World) -500 (Fixture)] TJ ET\n' +
  'BT /F1 12 Tf 72 630 Td (Line item: Widget x3 at 14.00) Tj ET\n';

function buildSimple(compress) {
  var body = Buffer.from(simpleContent, 'latin1');
  var extra = '';
  if (compress) { body = zlib.deflateSync(body); extra = ' /Filter /FlateDecode'; }
  return assemble({
    1: { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    2: { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    3: { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
               '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
    4: { stream: body, extra: extra },
    5: { dict: SIMPLE_FONT }
  }, [1, 2, 3, 4, 5], ' /Info << /Title (Fixture Doc) /Author (pdf-skill-tests) >>');
}

console.log('writing fixtures to ' + OUT);
write('simple-raw.pdf',   buildSimple(false));
write('simple-flate.pdf', buildSimple(true));

// ------------------------------------ 3 & 4: cid-tounicode / cid-nounicode
// Same Identity-H glyph indices in both. With the /ToUnicode CMap they decode to
// "PAIDYID"; without it they are unrecoverable and must be rejected.

var GLYPHS = [[0x0024, 'P'], [0x0051, 'A'], [0x0048, 'I'], [0x0003, 'D'],
              [0x0037, 'Y'], [0x0048, 'I'], [0x0003, 'D']];
var cidHex = GLYPHS.map(function (g) { return g[0].toString(16).padStart(4, '0'); }).join('');
var cidContent = 'BT /F1 18 Tf 72 700 Td <' + cidHex + '> Tj ET\n';

function buildCid(withToUnicode) {
  var objs = {
    1: { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    2: { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    3: { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
               '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
    4: { stream: cidContent },
    5: { dict: '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+NotoSans-BoldItalic ' +
               '/Encoding /Identity-H /DescendantFonts [6 0 R]' +
               (withToUnicode ? ' /ToUnicode 8 0 R' : '') + ' >>' },
    6: { dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+NotoSans-BoldItalic ' +
               '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
               '/FontDescriptor 7 0 R /DW 600 >>' },
    7: { dict: '<< /Type /FontDescriptor /FontName /AAAAAA+NotoSans-BoldItalic /Flags 4 ' +
               '/ItalicAngle -12 /Ascent 1069 /Descent -293 /CapHeight 714 /StemV 80 ' +
               '/FontBBox [-619 -293 1500 1069] >>' }
  };
  var order = [1, 2, 3, 4, 5, 6, 7];
  if (withToUnicode) {
    var seen = {}, bf = '', count = 0;
    GLYPHS.forEach(function (g) {
      if (seen[g[0]]) return;
      seen[g[0]] = 1; count++;
      bf += '<' + g[0].toString(16).padStart(4, '0') + '> <' +
            g[1].charCodeAt(0).toString(16).padStart(4, '0') + '>\n';
    });
    objs[8] = { stream:
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      count + ' beginbfchar\n' + bf + 'endbfchar\nendcmap\n' +
      'CMapName currentdict /CMap defineresource pop\nend\nend\n' };
    order.push(8);
  }
  return assemble(objs, order);
}

write('cid-tounicode.pdf', buildCid(true));
write('cid-nounicode.pdf', buildCid(false));

// ------------------------------------------------------------ 5: fontnoise.pdf
// Clean page text alongside an embedded font program carrying every garbage
// marker. Proves extraction reads only /Contents, never a /FontFile2.

var fnContent = 'BT /F1 14 Tf 72 700 Td (NET AMOUNT PAYABLE 1234.56 EUR) Tj ET\n';
var fontProgram =
  'Copyright 2012 Google Inc. All Rights Reserved.\u0000NotoSans-BoldItalic\u0000' +
  'This Font Software is licensed under the SIL Open Font License, Version 1.1.\u0000' +
  'glyf hmtx maxp loca head cvt fpgm prep name post\u0000' +
  new Array(201).join('\u0001\u0002\u0000\u0004');

write('fontnoise.pdf', assemble({
  1: { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  2: { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  3: { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
             '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
  4: { stream: zlib.deflateSync(Buffer.from(fnContent, 'latin1')), extra: ' /Filter /FlateDecode' },
  5: { dict: '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+NotoSans ' +
             '/Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>' },
  6: { dict: '<< /Type /FontDescriptor /FontName /AAAAAA+NotoSans /Flags 4 /FontFile2 7 0 R >>' },
  7: { stream: zlib.deflateSync(Buffer.from(fontProgram, 'latin1')),
       extra: ' /Filter /FlateDecode /Length1 4000' }
}, [1, 2, 3, 4, 5, 6, 7]));

// ------------------------------------------------------------------ 6: big.pdf
// 12 pages, padded with an unreferenced random-bytes object to ~98 KB so the
// base64 payload spans 6 chunks of the tier-2 transfer.

var N = 12;
var bigObjs = {
  1: { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  2: { dict: '' } // filled in below
};
var fontNum = 3 + 2 * N;
var kids = [], order = [1, 2];
for (var p = 0; p < N; p++) {
  var pageNum = 3 + p, contNum = 3 + N + p;
  kids.push(pageNum + ' 0 R');
  bigObjs[pageNum] = { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 ' + fontNum + ' 0 R >> >> /Contents ' + contNum + ' 0 R >>' };
  var c = 'BT /F1 14 Tf 60 750 Td (PAGE ' + (p + 1) + ' LEDGER SUMMARY) Tj ET\n';
  for (var l = 0; l < 45; l++) {
    c += 'BT /F1 9 Tf 60 ' + (730 - l * 15) + ' Td (Row ' + (l + 1) + ' of page ' + (p + 1) +
         ': description text padding to grow the file size, amount ' + (l * 7.25).toFixed(2) + ' USD) Tj ET\n';
  }
  bigObjs[contNum] = { stream: zlib.deflateSync(Buffer.from(c, 'latin1')), extra: ' /Filter /FlateDecode' };
  order.push(pageNum, contNum);
}
bigObjs[2].dict = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + N + ' >>';
bigObjs[fontNum] = { dict: SIMPLE_FONT };
order.push(fontNum);
// Unreferenced padding object: grows the file without touching the page tree.
bigObjs[fontNum + 1] = { stream: crypto.randomBytes(70000).toString('base64').slice(0, 88000) };
order.push(fontNum + 1);
order.sort(function (a, b) { return a - b; });
write('big.pdf', assemble(bigObjs, order));

// ------------------------------------------------- 7: scanned-image-only.pdf
// A page whose only content is a raster image, i.e. what a scan looks like: no
// text layer at all. Every text extractor must return EMPTY for this, and
// pdf-text must diagnose 'no text layer' rather than blaming a CID font.
//
// The JPEG is generated here rather than shipped: SLICC's `convert` cannot WRITE
// PDF (it only rasterises PDF input) and has no `text:` coder, so the raster is
// built by annotating a pdftoppm-rendered blank page, then embedded by hand as a
// /DCTDecode image XObject.

var cp = require('child_process');

// spawnSync's `cwd` option is IGNORED by the SLICC runtime, so every path must
// be absolute; `o()` anchors a name into the output directory.
function o(name) { return path.join(OUT, name); }
function sh(bin, args) {
  var r = cp.spawnSync(bin, args, { encoding: 'utf8' });
  return r.status === 0;
}

function jpegSize(jpg) {
  for (var i = 2; i < jpg.length - 9;) {
    if (jpg[i] !== 0xff) { i++; continue; }
    var mk = jpg[i + 1];
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return { h: jpg.readUInt16BE(i + 5), w: jpg.readUInt16BE(i + 7) };
    }
    if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
    i += 2 + jpg.readUInt16BE(i + 2);
  }
  return null;
}

// A blank page, rasterised, gives a white canvas (convert has no -size/xc:).
write('blank.pdf', assemble({
  1: { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  2: { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  3: { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' }
}, [1, 2, 3]));

var okRaster =
  sh('pdftoppm', ['-r', '100', '-png', o('blank.pdf'), o('canvas')]) &&
  sh('convert', [o('canvas-1.png'), '-pointsize', '34', '-fill', 'black',
                '-annotate', '+70+140', 'SCANNED INVOICE TOTAL 777 USD', o('scanned.png')]) &&
  sh('convert', [o('scanned.png'), '-quality', '85', o('scanned.jpg')]);

if (!okRaster) {
  console.log('  scanned-image-only.pdf  SKIPPED (pdftoppm/convert unavailable)');
} else {
  var jpg = fs.readFileSync(o('scanned.jpg'));
  var dim = jpegSize(jpg);
  if (!dim) {
    console.log('  scanned-image-only.pdf  SKIPPED (could not read JPEG dimensions)');
  } else {
    write('scanned-image-only.pdf', assemble({
      1: { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      2: { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      3: { dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
                 '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>' },
      4: { stream: 'q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ\n' },
      5: { stream: jpg,
           extra: ' /Type /XObject /Subtype /Image /Width ' + dim.w + ' /Height ' + dim.h +
                  ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode' }
    }, [1, 2, 3, 4, 5], ' /Info << /Title (Scanned Fixture) >>'));
  }
}

console.log('done');
