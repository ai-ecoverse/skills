// pptx-lib.jsh — Reusable PPTX builder library
// Generates valid PowerPoint files from structured slide data
// No dependencies — pure XML + custom ZIP builder
// ZIP format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT

// ============================================================
// ZIP BUILDER (STORE method, binary-safe)
// ============================================================
var crc32 = function(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[i] = c; }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
var toBytes = function(str) { return new TextEncoder().encode(str); }
var u16 = function(v) { return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]); }
var u32 = function(v) { return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]); }
var cat = function(arrays) { let t = 0; for (const a of arrays) t += a.length; const r = new Uint8Array(t); let p = 0; for (const a of arrays) { r.set(a, p); p += a.length; } return r; }

// ZIP entry signature bytes (per PKZIP spec)
var SIG_LOCAL = new Uint8Array([0x50, 0x4B, 0x03, 0x04]); // Local file header
var SIG_CD    = new Uint8Array([0x50, 0x4B, 0x01, 0x02]); // Central directory entry
var SIG_EOCD  = new Uint8Array([0x50, 0x4B, 0x05, 0x06]); // End of central directory

var buildZip = function(entries) {
  const parts = [], cds = []; let off = 0;
  for (const e of entries) {
    const n = toBytes(e.path), d = e.data, c = crc32(d);
    const lh = cat([SIG_LOCAL, u16(20), u16(0), u16(0), u32(0), u32(c), u32(d.length), u32(d.length), u16(n.length), u16(0), n]);
    const cd = cat([SIG_CD, u16(20), u16(20), u16(0), u16(0), u32(0), u32(c), u32(d.length), u32(d.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), n]);
    parts.push(cat([lh, d])); cds.push(cd); off += lh.length + d.length;
  }
  let cdsz = 0; for (const cd of cds) cdsz += cd.length;
  return cat([...parts, ...cds, cat([SIG_EOCD, u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdsz), u32(off), u16(0)])]);
}

// ============================================================
// XML / SHAPE HELPERS
// ============================================================
const EMU = 914400;
var emu = function(inches) { return Math.round(inches * EMU); }
var escXml = function(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var trunc = function(s, max) { if (!s || s.length <= max) return s || ''; return s.substring(0, max-3) + '...'; }

const GRP_SP = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

// OOXML namespace constants
const NS_REL  = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_OFF  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_CT   = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_PRES = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A    = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// ============================================================
// COLOR THEMES — randomly selected per presentation
// ============================================================
var COLOR_THEMES = [
  { // Navy + Red
    dark: '0D1B2A', dark2: '1A3A5C', accent: '2D1B69', accentBar: 'E63946',
    highlightBar: 'FFD166', cardBg: '1B2838', cardBorder: '2A3A4A',
    muted: 'A0AEC0', dim: '6E7E8E',
    good: '06D6A0', poor: 'EF476F', warning: 'FFD166', neutral: '60A5FA', purple: 'A78BFA'
  },
  { // Deep Teal + Coral
    dark: '0A2E36', dark2: '134E5E', accent: '1B3A4B', accentBar: 'FF6B6B',
    highlightBar: 'FEC89A', cardBg: '163B45', cardBorder: '1E5060',
    muted: '8ECAE6', dim: '6B9DAD',
    good: '52B788', poor: 'FF6B6B', warning: 'FEC89A', neutral: '48BFE3', purple: 'B185DB'
  },
  { // Charcoal + Electric Blue
    dark: '1A1A2E', dark2: '16213E', accent: '0F3460', accentBar: '00B4D8',
    highlightBar: 'CAF0F8', cardBg: '222240', cardBorder: '2A2A50',
    muted: '90E0EF', dim: '7B8FA1',
    good: '76C893', poor: 'FF5C8A', warning: 'FFB347', neutral: '48BFE3', purple: '9D8FE0'
  },
  { // Slate + Emerald
    dark: '1B2A41', dark2: '324A5F', accent: '0B3D2E', accentBar: '2EC4B6',
    highlightBar: 'CBF3F0', cardBg: '243448', cardBorder: '3A5468',
    muted: '8ED1C0', dim: '7A9E9F',
    good: '2EC4B6', poor: 'E56B6F', warning: 'FFCB77', neutral: '6FAEDB', purple: 'B09ADB'
  },
  { // Obsidian + Amber
    dark: '1C1C1C', dark2: '2D2D2D', accent: '3D2C2E', accentBar: 'F4A261',
    highlightBar: 'F4E285', cardBg: '2A2A2A', cardBorder: '404040',
    muted: 'C4B59D', dim: '8A8A8A',
    good: '6BCB77', poor: 'E76F51', warning: 'F4A261', neutral: '6FAEDB', purple: 'C77DFF'
  },
  { // Midnight Purple + Rose
    dark: '1A0A2E', dark2: '2B1055', accent: '3A1078', accentBar: 'F72585',
    highlightBar: 'FFC2D1', cardBg: '240E3E', cardBorder: '3A1868',
    muted: 'C8A8E0', dim: '8866AA',
    good: '57CC99', poor: 'F72585', warning: 'FFB703', neutral: '7ECBF5', purple: 'B5179E'
  },
  { // Forest + Gold
    dark: '1B2D1B', dark2: '2D4A2D', accent: '1A3C1A', accentBar: 'DAA520',
    highlightBar: 'F0E68C', cardBg: '243824', cardBorder: '3A5A3A',
    muted: 'A8C8A8', dim: '7A9A7A',
    good: '66BB6A', poor: 'EF5350', warning: 'DAA520', neutral: '64B5F6', purple: 'BA68C8'
  },
];

// Pick a random theme (or allow override via THEME_INDEX)
var _themeIndex = typeof THEME_INDEX !== 'undefined' ? THEME_INDEX : Math.floor(Math.random() * COLOR_THEMES.length);
var THEME = COLOR_THEMES[_themeIndex % COLOR_THEMES.length];
var T = THEME;

// Convenience aliases for common text colors on dark backgrounds
T.textLight      = 'FFFFFF';
T.textMutedDark  = T.muted;
T.textDimDark    = T.dim;

// Light slide palette (dark text on light background)
T.light = {
  bg:           'F8F9FA',
  bg2:          'FFFFFF',
  text:         '1A1A1A',
  textMuted:    '555555',
  textDim:      '888888',
  card:         'FFFFFF',
  cardBorder:   'E0E0E0',
};

let _shapeId = 100;
var nextId = function() { return _shapeId++; }

var textRun = function(text, opts = {}) {
  const sz = opts.size || 1400;
  const bA = opts.bold ? ' b="1"' : '';
  const iA = opts.italic ? ' i="1"' : '';
  return `<a:r><a:rPr lang="en-US" sz="${sz}"${bA}${iA} dirty="0"><a:solidFill><a:srgbClr val="${opts.color || '000000'}"/></a:solidFill><a:latin typeface="${opts.font || 'Source Sans Pro'}"/></a:rPr><a:t>${escXml(text)}</a:t></a:r>`;
}
var para = function(runs, opts = {}) {
  const al = opts.align === 'center' ? 'ctr' : opts.align === 'right' ? 'r' : 'l';
  const sp = opts.lnSpc ? `<a:lnSpc><a:spcPct val="${opts.lnSpc}"/></a:lnSpc>` : '';
  return `<a:p><a:pPr algn="${al}">${sp}</a:pPr>${Array.isArray(runs) ? runs.join('') : runs}</a:p>`;
}
var multiPara = function(texts, opts = {}) {
  return texts.map(t => para(textRun(t, opts), { lnSpc: opts.lnSpc, align: opts.align })).join('');
}
var textBox = function(x, y, w, h, paragraphs, opts = {}) {
  const anc = opts.va === 'm' ? 'ctr' : opts.va === 'b' ? 'b' : 't';
  const fill = opts.fill ? `<a:solidFill><a:srgbClr val="${opts.fill}"/></a:solidFill>` : '<a:noFill/>';
  const ln = opts.border ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${opts.border}"/></a:solidFill></a:ln>` : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="TB"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}${ln}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anc}"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}
var rectShape = function(x, y, w, h, fill, opts = {}) {
  const pr = opts.rr ? 'roundRect' : 'rect';
  const av = opts.rr ? '<a:gd name="adj" fmla="val 5000"/>' : '';
  const ln = opts.border ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${opts.border}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="R"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="${pr}"><a:avLst>${av}</a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>${ln}</p:spPr></p:sp>`;
}
var slideXml = function(bgColor, shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgColor}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>${GRP_SP}${shapes}</p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

// ============================================================
// THEME (Office-compatible)
// ============================================================
const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS_A}" name="Custom">
  <a:themeElements>
    <a:clrScheme name="Custom">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Custom">
      <a:majorFont><a:latin typeface="Source Sans Pro"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Source Sans Pro"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Custom">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;

// ============================================================
// PPTX ASSEMBLY — takes slide XML array, returns binary ZIP
// ============================================================
var assemblePptx = function(slideXmls, meta = {}) {
  const title = meta.title || 'Presentation';
  const author = meta.author || 'SLICC';
  const now = new Date().toISOString();
  const files = {};

  let ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS_CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`;
  for (let i = 0; i < slideXmls.length; i++) ct += `\n  <Override PartName="/ppt/slides/slide${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  ct += '\n</Types>';
  files['[Content_Types].xml'] = ct;

  files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="${NS_REL}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${NS_OFF}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  files['docProps/core.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escXml(title)}</dc:title><dc:creator>${escXml(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  files['docProps/app.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application><Slides>${slideXmls.length}</Slides></Properties>`;

  let sldIds = ''; for (let i = 0; i < slideXmls.length; i++) sldIds += `<p:sldId id="${256+i}" r:id="rId${i+3}"/>`;
  files['ppt/presentation.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="12192000"/></p:presentation>`;

  let pr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${NS_OFF}/theme" Target="theme/theme1.xml"/>`;
  for (let i = 0; i < slideXmls.length; i++) pr += `<Relationship Id="rId${i+3}" Type="${NS_OFF}/slide" Target="slides/slide${i+1}.xml"/>`;
  pr += '</Relationships>';
  files['ppt/_rels/presentation.xml.rels'] = pr;

  files['ppt/theme/theme1.xml'] = THEME_XML;
  files['ppt/slideMasters/slideMaster1.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${NS_OFF}/theme" Target="../theme/theme1.xml"/></Relationships>`;
  files['ppt/slideLayouts/slideLayout1.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;

  const slideRel = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  for (let i = 0; i < slideXmls.length; i++) {
    files[`ppt/slides/slide${i+1}.xml`] = slideXmls[i];
    files[`ppt/slides/_rels/slide${i+1}.xml.rels`] = slideRel;
  }

  const zipEntries = [{ path: '[Content_Types].xml', data: toBytes(files['[Content_Types].xml']) }];
  for (const p of Object.keys(files).filter(p => p !== '[Content_Types].xml').sort()) {
    zipEntries.push({ path: p, data: toBytes(files[p]) });
  }
  return buildZip(zipEntries);
}

// Write PPTX binary to file via base64 + shell decode
// ============================================================
// IMAGE SUPPORT
// ============================================================

// Convert Uint8Array to base64 string — O(n) via join (not O(n²) string +=)
var toB64Safe = function(bytes) {
  return btoa(Array.from(bytes, function(b) { return String.fromCharCode(b); }).join(''));
}

// Positioned image shape — use with slideWithImagesXml(), rId must match image relationship
var picShape = function(x, y, w, h, rId) {
  return `<p:pic>` +
    `<p:nvPicPr><p:cNvPr id="${nextId()}" name="img"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  `</p:pic>`;
}

// Slide that contains picShape elements — adds r: namespace and image relationships
var slideWithImagesXml = function(bgColor, shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgColor}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>${GRP_SP}${shapes}</p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

// Full-bleed background image slide — image fills the entire slide
var imageSlideXml = function(caption) {
  const capShape = caption
    ? textBox(0.5, 6.2, 12.33, 0.7, para(textRun(caption, {size:1200, color:'FFFFFF'}), {align:'center'}), {fill:'00000080'})
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}">
  <p:cSld>
    <p:bg><p:bgPr>
      <a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>
      <a:effectLst/>
    </p:bgPr></p:bg>
    <p:spTree>${GRP_SP}${capShape}</p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

// Download an image URL and save as base64 to a file (avoids binary VFS corruption)
var fetchImageB64 = async function(url, outPath) {
  var tmp = outPath + '.raw';
  await exec('curl -sL "' + url + '" -o "' + tmp + '"');
  await exec('base64 "' + tmp + '" > "' + outPath + '"');
  return outPath;
}

// Build PPTX with embedded images
// images: [{ slideIndex (1-based), mediaIndex (1-based), bytes: Uint8Array, ext: 'jpeg'|'png' }]
var assemblePptxWithImages = function(slideXmls, images, meta) {
  meta = meta || {};
  const title  = meta.title  || 'Presentation';
  const author = meta.author || 'SLICC';
  const now    = new Date().toISOString();
  const n      = slideXmls.length;

  // Track which slides have images (slideIndex → [mediaIndex, ...])
  const slideImages = {};
  for (const img of images) {
    if (!slideImages[img.slideIndex]) slideImages[img.slideIndex] = [];
    slideImages[img.slideIndex].push(img);
  }

  // Content-type for each image format
  const imgCT = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png' };

  // Build per-slide entries
  let sldIds = '', presRels = '', ctSlides = '', ctImages = '';
  for (let i = 0; i < n; i++) {
    sldIds   += `<p:sldId id="${256+i}" r:id="rId${i+3}"/>`;
    presRels += `<Relationship Id="rId${i+3}" Type="${NS_OFF}/slide" Target="slides/slide${i+1}.xml"/>`;
    ctSlides += `<Override PartName="/ppt/slides/slide${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  }
  for (const img of images) {
    const ext = img.ext === 'jpg' ? 'jpeg' : (img.ext || 'jpeg');
    ctImages += `<Default Extension="${ext === 'jpeg' ? 'jpg' : ext}" ContentType="${imgCT[ext] || 'image/jpeg'}"/>`;
  }

  const files = {};

  files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS_CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>${ctSlides}
</Types>`;

  files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="${NS_REL}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${NS_OFF}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  files['docProps/core.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escXml(title)}</dc:title><dc:creator>${escXml(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  files['docProps/app.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application><Slides>${n}</Slides></Properties>`;
  files['ppt/presentation.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="12192000"/></p:presentation>`;

  let pr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${NS_OFF}/theme" Target="theme/theme1.xml"/>`;
  for (let i = 0; i < n; i++) pr += `<Relationship Id="rId${i+3}" Type="${NS_OFF}/slide" Target="slides/slide${i+1}.xml"/>`;
  pr += '</Relationships>';
  files['ppt/_rels/presentation.xml.rels'] = pr;

  files['ppt/theme/theme1.xml'] = THEME_XML;
  files['ppt/slideMasters/slideMaster1.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${NS_OFF}/theme" Target="../theme/theme1.xml"/></Relationships>`;
  files['ppt/slideLayouts/slideLayout1.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_OFF}" xmlns:p="${NS_PRES}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;

  // Add slide XML and per-slide relationship files (with image rels where needed)
  for (let i = 0; i < n; i++) {
    const slideNum = i + 1;
    files[`ppt/slides/slide${slideNum}.xml`] = slideXmls[i];
    const imgs = slideImages[slideNum] || [];
    let slideRel = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFF}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
    for (const img of imgs) {
      const ext = img.ext === 'jpg' ? 'jpeg' : (img.ext || 'jpeg');
      const fname = `image${img.mediaIndex}.${ext === 'jpeg' ? 'jpg' : ext}`;
      slideRel += `<Relationship Id="rId${img.mediaIndex + 1}" Type="${NS_OFF}/image" Target="../media/${fname}"/>`;
      // Also add image data as binary entry
      files[`ppt/media/${fname}`] = img.bytes; // will be treated as binary below
    }
    slideRel += '</Relationships>';
    files[`ppt/slides/_rels/slide${slideNum}.xml.rels`] = slideRel;
  }

  // Assemble ZIP — binary entries (Uint8Array) stored as-is, text entries encoded
  const zipEntries = [{ path: '[Content_Types].xml', data: toBytes(files['[Content_Types].xml']) }];
  for (const p of Object.keys(files).filter(p => p !== '[Content_Types].xml').sort()) {
    const val = files[p];
    zipEntries.push({ path: p, data: val instanceof Uint8Array ? val : toBytes(val) });
  }
  return buildZip(zipEntries);
}

// ============================================================
// FILE OUTPUT
// ============================================================

// Write PPTX binary to file via base64 + shell decode
var writePptx = async function(zipData, outputPath) {
  const b64 = toB64Safe(zipData);
  await fs.writeFile('/tmp/_pptx_export.b64', b64);
  await exec(`cat /tmp/_pptx_export.b64 | base64 -d > "${outputPath}"`);
  await exec('rm -f /tmp/_pptx_export.b64');
  const verify = await exec(`wc -c "${outputPath}"`);
  return (verify.stdout || '').trim();
}

var PPTX_LIB_LOADED = true;
