// pptx-lib.jsh — PPTX builder library for SLICC
// Pure XML + ZIP generation, no external dependencies

// ============================================================
// ZIP BUILDER (STORE method, binary-safe)
// ============================================================

// Pre-computed CRC32 lookup table
var CRC_TABLE = new Uint32Array(256);
for (var i = 0; i < 256; i++) {
  var c = i;
  for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}

var crc32 = function(buf) {
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
};

var toBytes = function(str) { return new TextEncoder().encode(str); };
var u16 = function(v) { return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]); };
var u32 = function(v) { return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]); };

var cat = function(arrays) {
  var total = 0;
  for (var i = 0; i < arrays.length; i++) total += arrays[i].length;
  var result = new Uint8Array(total);
  var pos = 0;
  for (var i = 0; i < arrays.length; i++) { result.set(arrays[i], pos); pos += arrays[i].length; }
  return result;
};

var buildZip = function(entries) {
  var parts = [], cds = [], off = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var n = toBytes(e.path), d = e.data, c = crc32(d);
    var lh = cat([new Uint8Array([0x50,0x4B,0x03,0x04,0x14,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]), u32(c), u32(d.length), u32(d.length), u16(n.length), u16(0), n, d]);
    var cd = cat([new Uint8Array([0x50,0x4B,0x01,0x02,0x14,0x00,0x14,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]), u32(c), u32(d.length), u32(d.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), n]);
    parts.push(lh); cds.push(cd); off += lh.length;
  }
  var cdsz = 0;
  for (var i = 0; i < cds.length; i++) cdsz += cds[i].length;
  var eocd = cat([new Uint8Array([0x50,0x4B,0x05,0x06,0x00,0x00,0x00,0x00]), u16(entries.length), u16(entries.length), u32(cdsz), u32(off), u16(0)]);
  return cat([...parts, ...cds, eocd]);
};

// ============================================================
// XML HELPERS
// ============================================================
var EMU = 914400;
var emu = function(inches) { return Math.round(inches * EMU); };
var escXml = function(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

var GRP_SP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

// ============================================================
// COLOR THEMES
// ============================================================
// Each theme: dark slide colors (T.xxx) + light slide colors (T.light.xxx)
var COLOR_THEMES = [
  { // Navy + Red
    dark: '0D1B2A', dark2: '1A3A5C', cardDark: '1B2838', cardBorderDark: '2A3A4A',
    accentBar: 'E63946', highlightBar: 'FFD166',
    textLight: 'E2E8F0', textMutedDark: 'A0AEC0', textDimDark: '6E7E8E',
    good: '06D6A0', poor: 'EF476F', warning: 'FFD166', info: '60A5FA', purple: 'A78BFA',
    light: { bg: 'FFFFFF', bg2: 'F7FAFC', card: 'EDF2F7', cardBorder: 'CBD5E0',
             text: '1A202C', textMuted: '4A5568', textDim: '718096' }
  },
  { // Deep Teal + Coral
    dark: '0A2E36', dark2: '134E5E', cardDark: '163B45', cardBorderDark: '1E5060',
    accentBar: 'FF6B6B', highlightBar: 'FEC89A',
    textLight: 'E0F2F1', textMutedDark: '8ECAE6', textDimDark: '6B9DAD',
    good: '52B788', poor: 'FF6B6B', warning: 'FEC89A', info: '48BFE3', purple: 'B185DB',
    light: { bg: 'FFFFFF', bg2: 'F0FDFA', card: 'E6FFFA', cardBorder: 'B2F5EA',
             text: '134E4A', textMuted: '2D6A4F', textDim: '5F9EA0' }
  },
  { // Charcoal + Electric Blue
    dark: '1A1A2E', dark2: '16213E', cardDark: '222240', cardBorderDark: '2A2A50',
    accentBar: '00B4D8', highlightBar: 'CAF0F8',
    textLight: 'E2E8F0', textMutedDark: '90E0EF', textDimDark: '7B8FA1',
    good: '76C893', poor: 'FF5C8A', warning: 'FFB347', info: '48BFE3', purple: '9D8FE0',
    light: { bg: 'FFFFFF', bg2: 'F8FAFC', card: 'F1F5F9', cardBorder: 'CBD5E1',
             text: '1E293B', textMuted: '475569', textDim: '64748B' }
  },
  { // Slate + Emerald
    dark: '1B2A41', dark2: '324A5F', cardDark: '243448', cardBorderDark: '3A5468',
    accentBar: '2EC4B6', highlightBar: 'CBF3F0',
    textLight: 'E2F0EE', textMutedDark: '8ED1C0', textDimDark: '7A9E9F',
    good: '2EC4B6', poor: 'E56B6F', warning: 'FFCB77', info: '6FAEDB', purple: 'B09ADB',
    light: { bg: 'FFFFFF', bg2: 'F0FDF9', card: 'ECFDF5', cardBorder: 'A7F3D0',
             text: '065F46', textMuted: '047857', textDim: '6B7280' }
  },
  { // Obsidian + Amber
    dark: '1C1C1C', dark2: '2D2D2D', cardDark: '2A2A2A', cardBorderDark: '404040',
    accentBar: 'F4A261', highlightBar: 'F4E285',
    textLight: 'E5E5E5', textMutedDark: 'C4B59D', textDimDark: '8A8A8A',
    good: '6BCB77', poor: 'E76F51', warning: 'F4A261', info: '6FAEDB', purple: 'C77DFF',
    light: { bg: 'FFFFFF', bg2: 'FAFAF9', card: 'F5F5F4', cardBorder: 'D6D3D1',
             text: '1C1917', textMuted: '57534E', textDim: '78716C' }
  },
  { // Midnight Purple + Rose (OpTel style)
    dark: '1A0A2E', dark2: '2E1A47', cardDark: '3A1868', cardBorderDark: '4C2885',
    accentBar: 'F72585', highlightBar: 'FFC2D1',
    textLight: 'E9D5FF', textMutedDark: 'C8A8E0', textDimDark: '8866AA',
    good: '2D9D78', poor: 'F72585', warning: 'FFB703', info: '4A90D9', purple: 'B5179E',
    light: { bg: 'FFFFFF', bg2: 'F8F9FA', card: 'FAF5FF', cardBorder: 'D0D7DE',
             text: '1D1D1D', textMuted: '555555', textDim: '6E6E6E' }
  },
  { // Forest + Gold
    dark: '1B2D1B', dark2: '2D4A2D', cardDark: '243824', cardBorderDark: '3A5A3A',
    accentBar: 'DAA520', highlightBar: 'F0E68C',
    textLight: 'E8F5E9', textMutedDark: 'A8C8A8', textDimDark: '7A9A7A',
    good: '66BB6A', poor: 'EF5350', warning: 'DAA520', info: '64B5F6', purple: 'BA68C8',
    light: { bg: 'FFFFFF', bg2: 'F1F8E9', card: 'E8F5E9', cardBorder: 'C8E6C9',
             text: '1B5E20', textMuted: '33691E', textDim: '689F38' }
  },
];

// Theme selection (override with THEME_INDEX before loading)
var _themeIndex = typeof THEME_INDEX !== 'undefined' ? THEME_INDEX : Math.floor(Math.random() * COLOR_THEMES.length);
var T = COLOR_THEMES[_themeIndex % COLOR_THEMES.length];
var L = T.light;

// Shape ID counter
var _shapeId = 100;
var nextId = function() { return _shapeId++; };

// ============================================================
// TEXT & SHAPE FUNCTIONS
// ============================================================

// textRun(text, opts) — styled text segment
var textRun = function(text, opts) {
  opts = opts || {};
  var sz = opts.size || 1400;
  var bA = opts.bold ? ' b="1"' : '';
  var iA = opts.italic ? ' i="1"' : '';
  var color = opts.color || '000000';
  var font = opts.font || 'Source Sans Pro';
  return '<a:r><a:rPr lang="en-US" sz="' + sz + '"' + bA + iA + ' dirty="0"><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:latin typeface="' + font + '"/></a:rPr><a:t>' + escXml(text) + '</a:t></a:r>';
};

// para(runs, opts) — paragraph with alignment/spacing
var para = function(runs, opts) {
  opts = opts || {};
  var al = opts.align === 'center' ? 'ctr' : opts.align === 'right' ? 'r' : 'l';
  var sp = opts.lnSpc ? '<a:lnSpc><a:spcPct val="' + opts.lnSpc + '"/></a:lnSpc>' : '';
  var content = Array.isArray(runs) ? runs.join('') : runs;
  return '<a:p><a:pPr algn="' + al + '">' + sp + '</a:pPr>' + content + '</a:p>';
};

// multiPara(texts, opts) — multiple paragraphs from string array
var multiPara = function(texts, opts) {
  opts = opts || {};
  return texts.map(function(t) {
    return para(textRun(t, opts), { lnSpc: opts.lnSpc, align: opts.align });
  }).join('');
};

// textBox(x, y, w, h, paragraphs, opts) — text container
var textBox = function(x, y, w, h, paragraphs, opts) {
  opts = opts || {};
  var anc = opts.va === 'm' ? 'ctr' : opts.va === 'b' ? 'b' : 't';
  var fill = opts.fill ? '<a:solidFill><a:srgbClr val="' + opts.fill + '"/></a:solidFill>' : '<a:noFill/>';
  var ln = opts.border ? '<a:ln w="12700"><a:solidFill><a:srgbClr val="' + opts.border + '"/></a:solidFill></a:ln>' : '';
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + nextId() + '" name="TB"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + emu(x) + '" y="' + emu(y) + '"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' + fill + ln + '</p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="' + anc + '"/><a:lstStyle/>' + paragraphs + '</p:txBody></p:sp>';
};

// rectShape(x, y, w, h, fill, opts) — rectangle
var rectShape = function(x, y, w, h, fill, opts) {
  opts = opts || {};
  var pr = opts.rr ? 'roundRect' : 'rect';
  var av = opts.rr ? '<a:gd name="adj" fmla="val 5000"/>' : '';
  var ln = opts.border ? '<a:ln w="9525"><a:solidFill><a:srgbClr val="' + opts.border + '"/></a:solidFill></a:ln>' : '<a:ln><a:noFill/></a:ln>';
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + nextId() + '" name="R"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + emu(x) + '" y="' + emu(y) + '"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="' + pr + '"><a:avLst>' + av + '</a:avLst></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="' + fill + '"/></a:solidFill>' + ln + '</p:spPr></p:sp>';
};

// picShape(x, y, w, h, rId) — positioned image (preserves aspect ratio)
var picShape = function(x, y, w, h, rId) {
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + nextId() + '" name="Pic"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + rId + '" cstate="print"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="' + emu(x) + '" y="' + emu(y) + '"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
};

// ============================================================
// SLIDE FUNCTIONS
// ============================================================

// slideXml(bgColor, shapes) — standard slide
var slideXml = function(bgColor, shapes) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n' +
    '  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + bgColor + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\n' +
    '    <p:spTree>' + GRP_SP + shapes + '</p:spTree></p:cSld>\n' +
    '  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n' +
    '</p:sld>';
};

// slideWithImagesXml(bgColor, shapes) — slide that can contain picShape()
var slideWithImagesXml = function(bgColor, shapes) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n' +
    '  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + bgColor + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\n' +
    '    <p:spTree>' + GRP_SP + shapes + '</p:spTree></p:cSld>\n' +
    '  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n' +
    '</p:sld>';
};

// imageSlideXml(caption) — full-bleed background image slide
var imageSlideXml = function(caption) {
  var cap = caption ? (
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Cap"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="457200" y="5486400"/><a:ext cx="11277600" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="000000"><a:alpha val="60000"/></a:srgbClr></a:solidFill></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="ctr"/><a:lstStyle/>' +
    '<a:p><a:r><a:rPr lang="en-US" sz="1800" b="1" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>' +
    '<a:t>' + escXml(caption) + '</a:t></a:r></a:p></p:txBody></p:sp>'
  ) : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:cSld><p:spTree>' + GRP_SP +
    '<p:pic><p:nvPicPr><p:cNvPr id="2" name="Img"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId2" cstate="print"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '</p:pic>' + cap + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
};

// ============================================================
// THEME XML (Office-compatible)
// ============================================================
var THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Custom">' +
  '<a:themeElements>' +
  '<a:clrScheme name="Custom">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="Custom">' +
  '<a:majorFont><a:latin typeface="Source Sans Pro"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Source Sans Pro"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="Custom">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme>' +
  '</a:themeElements>' +
  '<a:objectDefaults/>' +
  '<a:extraClrSchemeLst/>' +
  '</a:theme>';

// ============================================================
// PPTX ASSEMBLY
// ============================================================

// assemblePptx(slideXmls, meta) — build PPTX without images
var assemblePptx = function(slideXmls, meta) {
  meta = meta || {};
  var title = meta.title || 'Presentation';
  var author = meta.author || 'SLICC';
  var now = new Date().toISOString();
  var files = {};
  var i;

  // [Content_Types].xml
  var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '  <Default Extension="xml" ContentType="application/xml"/>\n' +
    '  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>\n' +
    '  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>\n' +
    '  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>\n' +
    '  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>\n' +
    '  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\n' +
    '  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
  for (i = 0; i < slideXmls.length; i++) {
    ct += '\n  <Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  }
  ct += '\n</Types>';
  files['[Content_Types].xml'] = ct;

  files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';

  files['docProps/core.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + escXml(title) + '</dc:title><dc:creator>' + escXml(author) + '</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>';

  files['docProps/app.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application><Slides>' + slideXmls.length + '</Slides></Properties>';

  var sldIds = '';
  for (i = 0; i < slideXmls.length; i++) sldIds += '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 3) + '"/>';
  files['ppt/presentation.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + sldIds + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="12192000"/></p:presentation>';

  var pr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>';
  for (i = 0; i < slideXmls.length; i++) {
    pr += '<Relationship Id="rId' + (i + 3) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>';
  }
  pr += '</Relationships>';
  files['ppt/_rels/presentation.xml.rels'] = pr;

  files['ppt/theme/theme1.xml'] = THEME_XML;

  files['ppt/slideMasters/slideMaster1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>';

  files['ppt/slideLayouts/slideLayout1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>';

  for (i = 0; i < slideXmls.length; i++) {
    files['ppt/slides/slide' + (i + 1) + '.xml'] = slideXmls[i];
    files['ppt/slides/_rels/slide' + (i + 1) + '.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';
  }

  // Build ZIP
  var zipEntries = [{ path: '[Content_Types].xml', data: toBytes(files['[Content_Types].xml']) }];
  var keys = Object.keys(files).filter(function(p) { return p !== '[Content_Types].xml'; }).sort();
  for (i = 0; i < keys.length; i++) {
    zipEntries.push({ path: keys[i], data: toBytes(files[keys[i]]) });
  }
  return buildZip(zipEntries);
};

// assemblePptxWithImages(slideXmls, images, meta) — build PPTX with embedded images
// images: [{ slideIndex (1-based), mediaIndex, bytes (Uint8Array), ext ('png'|'jpeg') }]
var assemblePptxWithImages = function(slideXmls, images, meta) {
  var baseZip = assemblePptx(slideXmls, meta);
  var entries = [];
  var view = new DataView(baseZip.buffer, baseZip.byteOffset);
  var off = 0;

  // Check which image types we need
  var needsPng = images.some(function(img) { return (img.ext || 'png') === 'png'; });
  var needsJpeg = images.some(function(img) { return img.ext === 'jpeg' || img.ext === 'jpg'; });

  // Parse existing ZIP entries
  while (off < baseZip.length - 4) {
    var sig = view.getUint32(off, true);
    if (sig !== 0x04034b50) break;
    var nameLen = view.getUint16(off + 26, true);
    var extraLen = view.getUint16(off + 28, true);
    var compSize = view.getUint32(off + 18, true);
    var name = new TextDecoder().decode(baseZip.slice(off + 30, off + 30 + nameLen));
    var dataStart = off + 30 + nameLen + extraLen;
    var data = baseZip.slice(dataStart, dataStart + compSize);

    // Patch [Content_Types].xml
    if (name === '[Content_Types].xml') {
      var ctStr = new TextDecoder().decode(data);
      if (needsPng && ctStr.indexOf('image/png') === -1) {
        ctStr = ctStr.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
      }
      if (needsJpeg && ctStr.indexOf('image/jpeg') === -1) {
        ctStr = ctStr.replace('</Types>', '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
      }
      data = toBytes(ctStr);
    }

    // Patch slide rels for image slides
    var relMatch = name.match(/ppt\/slides\/_rels\/slide(\d+)\.xml\.rels/);
    if (relMatch) {
      var sIdx = parseInt(relMatch[1]);
      for (var ii = 0; ii < images.length; ii++) {
        if (images[ii].slideIndex === sIdx) {
          var midx = images[ii].mediaIndex;
          var imgExt = images[ii].ext || 'png';
          data = toBytes(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image' + midx + '.' + imgExt + '"/>' +
            '</Relationships>'
          );
          break;
        }
      }
    }

    entries.push({ path: name, data: data });
    off = dataStart + compSize;
  }

  // Add image files
  for (var j = 0; j < images.length; j++) {
    var ext = images[j].ext || 'png';
    entries.push({ path: 'ppt/media/image' + images[j].mediaIndex + '.' + ext, data: images[j].bytes });
  }

  return buildZip(entries);
};

// ============================================================
// UTILITIES
// ============================================================

// toB64Safe(bytes) — base64 encode large arrays without stack overflow
var toB64Safe = function(bytes) {
  var binary = '';
  var chunk = 8192;
  for (var i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.slice(i, i + chunk));
  }
  return btoa(binary);
};

// fetchImageB64(url, outPath) — download image and save as base64
var fetchImageB64 = async function(url, outB64Path) {
  outB64Path = outB64Path || '/tmp/_pptx_img.b64';
  var response = await fetch(url);
  var buf = await response.arrayBuffer();
  var bytes = new Uint8Array(buf);
  var b64 = toB64Safe(bytes);
  await require('fs').promises.writeFile(outB64Path, b64);
  return outB64Path;
};

// Library loaded marker
var PPTX_LIB_LOADED = true;
