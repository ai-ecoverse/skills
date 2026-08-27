// pdf-text.jsh — Extract real text from a PDF with a validated escalation ladder.
//
// Usage: pdf-text <file.pdf> [--layout] [--tier1-only] [--no-ssh] [--json] [--pages N-M]
//
// Why this exists: `pdftk <f> dump_data_utf8` (SLICC's built-in, unpdf-backed
// extractor) silently returns raw glyph indices as if they were characters when a
// PDF uses a subset CID font with no /ToUnicode CMap. It exits 0 with plausible
// looking output, so callers trust it. This tool validates every extraction and
// escalates instead of returning junk.
//
// Tier 1  local extraction (pdftk dump_data_utf8 + independent zlib stream inflation)
// Tier 2  offload to an `ssh` exec follower running poppler `pdftotext -layout`
// Tier 3  rasterise with pdftoppm for visual inspection — explicitly NOT text
//
// The tier that produced the output is always reported.

var fs   = require('fs');
var os   = require('os');
var path = require('path');
var zlib = require('zlib');
var cp   = require('child_process');

// NOTE: SLICC path.resolve() ignores process.cwd() and resolves against "/",
// so relative arguments must be joined to cwd explicitly.
function abs(p) { return path.isAbsolute(p) ? p : path.join(process.cwd(), p); }

// ---------------------------------------------------------------- arg parsing

var argv     = process.argv.slice(2);
var flags    = {};
var operands = [];
for (var ai = 0; ai < argv.length; ai++) {
  var a = argv[ai];
  if (a === '--layout')     { flags.layout = true; }
  else if (a === '--tier1-only') { flags.tier1Only = true; }
  else if (a === '--no-ssh')     { flags.noSsh = true; }
  else if (a === '--json')       { flags.json = true; }
  else if (a === '--pages')      { flags.pages = argv[++ai]; }
  else if (a.indexOf('--pages=') === 0) { flags.pages = a.slice(8); }
  else if (a === '-h' || a === '--help') { flags.help = true; }
  else if (a.indexOf('-') === 0) { flags.unknown = a; }
  else operands.push(a);
}

var USAGE = [
  'usage: pdf-text <file.pdf> [--layout] [--tier1-only] [--no-ssh] [--json] [--pages N-M]',
  '',
  '  --layout      preserve visual column layout (tier 2 only; poppler -layout)',
  '  --tier1-only  never leave this machine; fail loudly if local extraction is junk',
  '  --no-ssh      skip tier 2 (ssh follower offload), allow tier 3 raster',
  '  --json        machine-readable result incl. the tier that produced it',
  '  --pages N-M   restrict to a page range first (1-based, "3-end" allowed)',
  '',
  'Exit codes: 0 text extracted · 3 no tier could produce trustworthy text · 1 usage/IO error'
].join('\n');

if (flags.help || operands.length === 0) { console.log(USAGE); process.exit(flags.help ? 0 : 1); }
if (flags.unknown) { console.error('pdf-text: unknown flag ' + flags.unknown + '\n'); console.error(USAGE); process.exit(1); }

var inputFile = abs(operands[0]);
if (!fs.existsSync(inputFile)) { console.error('pdf-text: no such file: ' + inputFile); process.exit(1); }

var TMPROOT = process.env.PDF_TEXT_TMP || (fs.existsSync('/scoops') ? null : os.tmpdir());
if (!TMPROOT) {
  // Prefer a scoop-writable scratch dir; /tmp may not exist inside a sandbox.
  var guess = inputFile.split('/').slice(0, 3).join('/') + '/tmp';
  TMPROOT = fs.existsSync(guess) ? guess : path.dirname(inputFile);
}
// Scratch files are written flat into TMPROOT with a pid prefix. Creating a
// subdirectory can trip a sandbox write gate, so deliberately never mkdir.
var SCRATCH = [];
function scratch(name) {
  var f = path.join(TMPROOT, 'pdf-text-' + RUNID + '-' + name);
  SCRATCH.push(f);
  return f;
}

// SLICC .jsh does not populate process.pid, so derive a unique run id ourselves.
var RUNID = String(process.pid || '') || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

function run(bin, args, opts) {
  var o = opts || {};
  var r = cp.spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: o.cwd });
  return {
    status: r.status === null || r.status === undefined ? (r.error ? 127 : 1) : r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || '') + (r.error ? String(r.error.message || r.error) : '')
  };
}

// ------------------------------------------------------- optional page subset

var workFile = inputFile;
var notes    = [];
if (flags.pages) {
  if (!/^[0-9]+(-([0-9]+|end))?$/.test(flags.pages)) {
    console.error('pdf-text: --pages expects N, N-M or N-end (got "' + flags.pages + '")');
    process.exit(1);
  }
  var sub = scratch('pages.pdf');
  var cut = run('pdftk', [inputFile, 'cat', flags.pages, 'output', sub]);
  if (cut.status !== 0 || !fs.existsSync(sub)) {
    console.error('pdf-text: could not extract pages ' + flags.pages + ': ' + (cut.stderr || cut.stdout).trim());
    process.exit(1);
  }
  workFile = sub;
  notes.push('restricted to pages ' + flags.pages);
}

// ============================================================ GARBAGE GUARD
// The single most important part of this tool. A wrong answer that looks like
// data is worse than a clean failure, so extraction output is only returned
// once it survives every check below.
//
// Signals, all observed in real failures:
//   * font-program markers  — inflating the wrong stream yields the embedded
//     font binary: copyright notices, family names, SIL licence text, CMap
//     keywords, TrueType table tags.
//   * control-character density — Identity-H glyph indices are 2-byte big
//     endian, so the high byte lands in the C0 range (\x00-\x08) and shows up
//     interleaved through the output ("$QH\x037H\x03").
//   * no alphabetic words at all.
//   * low ratio of letters-in-real-words to total bytes.
//   * vowel-less "words" — glyph indices decoded as latin1 produce consonant
//     soup; genuine prose has a vowel in nearly every word of 3+ letters.

var FONT_MARKERS = [
  [/Copyright\s+(?:\(c\)\s*)?(?:19|20)\d{2}/i,        'embedded font copyright notice'],
  [/SIL Open Font License|Reserved Font Name/i,        'SIL Open Font License text'],
  [/NotoSans|DejaVu|LiberationSans|FontForge|Fontello/i, 'font family / tool name'],
  [/Adobe[- ]Identity[- ]UCS|Adobe\s+UCS/i,            'CMap resource name'],
  [/begincmap|endbfchar|beginbfrange|begincodespacerange/, 'raw CMap program'],
  [/\bglyf\b|\bhmtx\b|\bmaxp\b|\bcvt\s|\bfpgm\b|\bprep\b/, 'TrueType table tag'],
  [/%!(?:PS-)?(?:AdobeFont|FontType)/i,                'PostScript font program header']
];

function assess(text) {
  var reasons = [];
  var t = String(text == null ? '' : text);
  var trimmed = t.replace(/\s+/g, ' ').trim();

  if (trimmed.length === 0) return { ok: false, reasons: ['empty output'], stats: { len: 0 } };

  for (var i = 0; i < FONT_MARKERS.length; i++) {
    if (FONT_MARKERS[i][0].test(t)) reasons.push('font-program marker: ' + FONT_MARKERS[i][1]);
  }

  var total = t.length;

  // Counted by code point rather than by regex: a character class containing
  // literal control characters trips Biome noControlCharactersInRegex, and this
  // is both clearer and a single pass.
  var ctrl = 0, printable = 0;
  for (var ci = 0; ci < total; ci++) {
    var cc = t.charCodeAt(ci);
    var isTabNlCr = cc === 9 || cc === 10 || cc === 13;
    if (!isTabNlCr && (cc < 32 || cc === 127)) ctrl++;
    if (isTabNlCr ||
        (cc >= 32 && cc <= 126) ||          // printable ASCII
        (cc >= 0xa0 && cc <= 0x24f) ||      // Latin-1 Supplement .. Latin Extended-B
        (cc >= 0x2010 && cc <= 0x203a) ||   // general punctuation (dashes, quotes)
        cc === 0x20ac) {                    // euro sign
      printable++;
    }
  }

  var ctrlRatio = ctrl / total;
  if (ctrlRatio > 0.02) reasons.push('control-character density ' + (ctrlRatio * 100).toFixed(1) + '% (>2%) — looks like raw glyph indices');

  var printRatio = printable / total;
  if (printRatio < 0.85) reasons.push('only ' + (printRatio * 100).toFixed(1) + '% printable/Latin characters (<85%)');

  var words = t.match(/[A-Za-z\u00c0-\u024f]{2,}/g) || [];
  if (words.length === 0) reasons.push('zero alphabetic words');

  var letters = words.join('').length;
  var density = letters / total;
  if (words.length > 0 && density < 0.35) {
    reasons.push('word density ' + (density * 100).toFixed(1) + '% of bytes are letters-in-words (<35%)');
  }

  var long = words.filter(function (w) { return w.length >= 3; });
  if (long.length >= 6) {
    var voweled = long.filter(function (w) { return /[aeiouyAEIOUY\u00c0-\u024f]/.test(w); }).length;
    var vowelShare = voweled / long.length;
    if (vowelShare < 0.5) {
      reasons.push('only ' + (vowelShare * 100).toFixed(0) + '% of 3+ letter words contain a vowel (<50%) — not natural text');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons: reasons,
    stats: { len: total, words: words.length, density: +density.toFixed(3), ctrlRatio: +ctrlRatio.toFixed(4) }
  };
}

// Exposed for the test harness (see references/text-extraction.md).
if (process.env.PDF_TEXT_SELFTEST) {
  var cases = JSON.parse(fs.readFileSync(process.env.PDF_TEXT_SELFTEST, 'utf8'));
  var out = cases.map(function (c) { var a = assess(c.text); return { name: c.name, expectOk: c.expectOk, ok: a.ok, reasons: a.reasons }; });
  console.log(JSON.stringify(out, null, 2));
  var bad = out.filter(function (r) { return r.ok !== r.expectOk; });
  process.exit(bad.length ? 1 : 0);
}

// ====================================================== TIER 1a — built-in
// pdftk dump_data_utf8 is SLICC's unpdf-backed text extractor. It honours a
// /ToUnicode CMap when the PDF has one, which makes it the best first attempt.

function tier1Builtin(file) {
  var r = run('pdftk', [file, 'dump_data_utf8']);
  if (r.status !== 0) return { text: '', err: (r.stderr || r.stdout).trim() || 'pdftk exited ' + r.status };
  return { text: r.stdout, err: null };
}

// ====================================================== TIER 1b — inflation
// Independent implementation: inflate the page content streams ourselves and
// pull the text-showing operators, decoding through /ToUnicode where present.
// Deliberately only ever looks at streams reachable from a /Page /Contents, so
// it cannot mistake an embedded font program for page text.

function inflate(buf) {
  try { return zlib.inflateSync(buf); } catch {}
  try { return zlib.inflateRawSync(buf); } catch {}
  return null;
}

// Split the file into indirect objects: { num: {dict, stream} }
function parseObjects(buf) {
  var s = buf.toString('latin1');
  var objs = {};
  var re = /(\d+)\s+(\d+)\s+obj\b/g;
  var m = re.exec(s);
  while (m !== null) {
    var num = parseInt(m[1], 10);
    var bodyStart = m.index + m[0].length;
    var endIdx = s.indexOf('endobj', bodyStart);
    if (endIdx < 0) endIdx = s.length;
    var body = s.slice(bodyStart, endIdx);
    var entry = { dict: body, stream: null };
    var sm = /stream\r?\n?/.exec(body);
    if (sm) {
      var dictPart = body.slice(0, sm.index);
      var dataStart = bodyStart + sm.index + sm[0].length;
      var dataEnd = s.indexOf('endstream', dataStart);
      if (dataEnd > dataStart) {
        var raw = buf.slice(dataStart, dataEnd);
        // /Length may lie or be an indirect ref; trailing EOL before endstream is not data.
        while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) raw = raw.slice(0, raw.length - 1);
        entry.dict = dictPart;
        entry.stream = /\/Filter\s*\/FlateDecode|\/Filter\s*\[\s*\/FlateDecode/.test(dictPart) ? inflate(raw) : raw;
      }
    }
    objs[num] = entry;
    m = re.exec(s);
  }
  return objs;
}

function refsIn(str, key) {
  // /Key 12 0 R   or   /Key [12 0 R 13 0 R]
  var out = [];
  var single = new RegExp('\\/' + key + '\\s+(\\d+)\\s+\\d+\\s+R').exec(str);
  if (single) out.push(parseInt(single[1], 10));
  var arr = new RegExp('\\/' + key + '\\s*\\[([^\\]]*)\\]').exec(str);
  if (arr) {
    var rr = /(\d+)\s+\d+\s+R/g;
    var mm = rr.exec(arr[1]);
    while (mm !== null) { out.push(parseInt(mm[1], 10)); mm = rr.exec(arr[1]); }
  }
  return out;
}

// Parse a ToUnicode CMap stream into { glyphCode -> string }
function parseToUnicode(txt) {
  var map = {};
  if (!txt) return map;
  var s = String(txt);
  var hex = function (h) {
    var out = '';
    for (var i = 0; i + 3 < h.length + 1 && i < h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    return out;
  };
  var bfcRe = /beginbfchar([\s\S]*?)endbfchar/g;
  var bc = bfcRe.exec(s);
  while (bc !== null) {
    var pr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    var pm = pr.exec(bc[1]);
    while (pm !== null) { map[parseInt(pm[1], 16)] = hex(pm[2]); pm = pr.exec(bc[1]); }
    bc = bfcRe.exec(s);
  }
  var bfrRe = /beginbfrange([\s\S]*?)endbfrange/g;
  var br = bfrRe.exec(s);
  while (br !== null) {
    var rr2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    var q = rr2.exec(br[1]);
    while (q !== null) {
      var lo = parseInt(q[1], 16), hi = parseInt(q[2], 16), dst = parseInt(q[3], 16);
      // Guard a malformed/hostile range; the advance below must still run.
      if (hi >= lo && hi - lo <= 65535) {
        for (var c = lo; c <= hi; c++) map[c] = String.fromCharCode(dst + (c - lo));
      }
      q = rr2.exec(br[1]);
    }
    br = bfrRe.exec(s);
  }
  return map;
}

// Decode a PDF string literal body (already unescaped) or hex string.
function pdfStringBytes(tok) {
  if (tok.kind === 'hex') {
    var h = tok.value.replace(/[^0-9A-Fa-f]/g, '');
    if (h.length % 2) h += '0';
    var b = [];
    for (var i = 0; i < h.length; i += 2) b.push(parseInt(h.substr(i, 2), 16));
    return b;
  }
  var out = [], s = tok.value;
  for (var j = 0; j < s.length; j++) {
    var ch = s[j];
    if (ch === '\\') {
      var n = s[++j];
      if (n === 'n') out.push(10);
      else if (n === 'r') out.push(13);
      else if (n === 't') out.push(9);
      else if (n === 'b') out.push(8);
      else if (n === 'f') out.push(12);
      else if (n >= '0' && n <= '7') {
        var oct = n;
        while (oct.length < 3 && s[j + 1] >= '0' && s[j + 1] <= '7') oct += s[++j];
        out.push(parseInt(oct, 8) & 0xff);
      } else if (n === '\n') { /* line continuation */ }
      else out.push(n.charCodeAt(0) & 0xff);
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return out;
}

function decodeBytes(bytes, font) {
  var twoByte = font && font.identity;
  var map = (font && font.toUnicode) || null;
  var out = '';
  if (twoByte) {
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      var code = (bytes[i] << 8) | bytes[i + 1];
      if (map && Object.hasOwn(map, code)) out += map[code];
      else { out += String.fromCharCode(code); if (font) font.undecoded = (font.undecoded || 0) + 1; }
    }
  } else {
    for (var k = 0; k < bytes.length; k++) {
      var c = bytes[k];
      if (map && Object.hasOwn(map, c)) out += map[c];
      else out += String.fromCharCode(c);
    }
  }
  return out;
}

function extractFromContent(content, fonts) {
  // Tokenise just enough: strings, arrays, names, numbers and operators.
  var s = content.toString('latin1');
  var out = '';
  var cur = null;
  var i = 0;
  var pending = [];
  var undecodable = 0;

  function readLiteral(start) {
    var depth = 1, j = start, v = '';
    while (j < s.length) {
      var c = s[j];
      if (c === '\\') { v += c + (s[j + 1] || ''); j += 2; continue; }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (!depth) break; }
      v += c; j++;
    }
    return { value: v, next: j + 1, kind: 'lit' };
  }

  while (i < s.length) {
    var ch = s[i];
    if (ch === '(') { var lit = readLiteral(i + 1); pending.push(lit); i = lit.next; continue; }
    if (ch === '<' && s[i + 1] !== '<') {
      var close = s.indexOf('>', i + 1);
      if (close < 0) break;
      pending.push({ value: s.slice(i + 1, close), kind: 'hex' });
      i = close + 1; continue;
    }
    if (ch === '<' && s[i + 1] === '<') { i += 2; continue; }
    if (ch === '>' && s[i + 1] === '>') { i += 2; continue; }
    if (ch === '/') {
      var nm = /^\/([^\s/[\]<>(){}]*)/.exec(s.slice(i));
      pending.push({ kind: 'name', value: nm ? nm[1] : '' });
      i += nm ? nm[0].length : 1; continue;
    }
    if (ch === '[' || ch === ']') { i++; continue; }
    var numm = /^[-+]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (numm) { pending.push({ kind: 'num', value: parseFloat(numm[0]) }); i += numm[0].length; continue; }
    var opm = /^[A-Za-z'"*][A-Za-z0-9'"*]*/.exec(s.slice(i));
    if (opm) {
      var op = opm[0];
      if (op === 'Tf') {
        for (var pi = pending.length - 1; pi >= 0; pi--) {
          if (pending[pi].kind === 'name') { cur = fonts[pending[pi].value] || { identity: false, toUnicode: null }; break; }
        }
      } else if (op === 'Tj' || op === "'" || op === '"') {
        for (var pj = pending.length - 1; pj >= 0; pj--) {
          if (pending[pj].kind === 'lit' || pending[pj].kind === 'hex') {
            var before = cur ? (cur.undecoded || 0) : 0;
            out += decodeBytes(pdfStringBytes(pending[pj]), cur);
            if (cur) undecodable += (cur.undecoded || 0) - before;
            break;
          }
        }
        if (op === "'" || op === '"') out += '\n';
      } else if (op === 'TJ') {
        // Elements alternate strings and kerning numbers (thousandths of an em).
        // A large negative adjustment is how PDF producers render a word space,
        // so translate it back into one instead of running words together.
        for (var pk = 0; pk < pending.length; pk++) {
          var el = pending[pk];
          if (el.kind === 'lit' || el.kind === 'hex') {
            var b2 = cur ? (cur.undecoded || 0) : 0;
            out += decodeBytes(pdfStringBytes(el), cur);
            if (cur) undecodable += (cur.undecoded || 0) - b2;
          } else if (el.kind === 'num' && el.value <= -100 && !/\s$/.test(out)) {
            out += ' ';
          }
        }
      } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET') {
        out += '\n';
      }
      pending = [];
      i += op.length; continue;
    }
    i++;
  }
  return { text: out, undecodable: undecodable };
}

function tier1Inflate(file) {
  var buf = fs.readFileSync(file);
  var objs = parseObjects(buf);
  var pages = [];
  Object.keys(objs).forEach(function (n) {
    if (/\/Type\s*\/Page\b/.test(objs[n].dict)) pages.push(parseInt(n, 10));
  });
  if (pages.length === 0) return { text: '', err: 'no /Page objects found (encrypted, linearised or object-stream PDF?)' };

  var allText = '';
  var undecodable = 0;
  pages.sort(function (a, b) { return a - b; });

  for (var p = 0; p < pages.length; p++) {
    var page = objs[pages[p]];
    // Build the font table for this page from /Resources /Font << /F1 5 0 R >>
    var fonts = {};
    var fdict = /\/Font\s*<<([\s\S]*?)>>/.exec(page.dict);
    if (fdict) {
      var fr = /\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g;
      var fm = fr.exec(fdict[1]);
      while (fm !== null) {
        var fo = objs[parseInt(fm[2], 10)];
        if (fo) {
          var identity = /\/Subtype\s*\/Type0\b/.test(fo.dict) || /\/Encoding\s*\/Identity-[HV]/.test(fo.dict);
          var tuRefs = refsIn(fo.dict, 'ToUnicode');
          var tu = null;
          if (tuRefs.length && objs[tuRefs[0]] && objs[tuRefs[0]].stream) {
            tu = parseToUnicode(objs[tuRefs[0]].stream.toString('latin1'));
            if (!Object.keys(tu).length) tu = null;
          }
          fonts[fm[1]] = { identity: identity, toUnicode: tu, undecoded: 0 };
        }
        fm = fr.exec(fdict[1]);
      }
    }
    var contentRefs = refsIn(page.dict, 'Contents');
    for (var c = 0; c < contentRefs.length; c++) {
      var co = objs[contentRefs[c]];
      if (!co || !co.stream) continue;
      var got = extractFromContent(co.stream, fonts);
      allText += got.text + '\n';
      undecodable += got.undecodable;
    }
  }

  var cleaned = allText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, err: null, undecodable: undecodable };
}

// ========================================================= TIER 2 — ssh/poppler

// PDF_TEXT_SSH_BIN overrides the ssh binary (testing / alternate transports).
var SSH_BIN = process.env.PDF_TEXT_SSH_BIN || 'ssh';

function sshTargets() {
  var r = run(SSH_BIN, ['--list']);
  if (r.status !== 0) return [];
  var ids = r.stdout.match(/follower-[0-9a-f-]{36}/g) || [];
  var seen = {}, out = [];
  ids.forEach(function (i) { if (!seen[i]) { seen[i] = 1; out.push(i); } });
  return out;
}

function tier2(file) {
  var targets = sshTargets();
  if (!targets.length) {
    return { text: '', err: 'no ssh exec follower attached — nothing to offload to. ' +
      'Attach one with `slicc … follow "bash -c"` on a machine that has poppler ' +
      '(`brew install poppler`), then re-run. `host` lists followers tagged [ssh].' };
  }
  var target = targets[0];

  var probe = run(SSH_BIN, ['--timeout', '20', target, 'command -v pdftotext || echo __MISSING__']);
  if (probe.status !== 0) return { text: '', err: 'ssh probe failed on ' + target + ': ' + (probe.stderr || probe.stdout).trim() };
  if (/__MISSING__/.test(probe.stdout) || !/pdftotext/.test(probe.stdout)) {
    return { text: '', err: 'follower ' + target + ' has no pdftotext. One-line fix on that machine: ' +
      '`brew install poppler` (macOS) / `apt-get install -y poppler-utils` (Debian/Ubuntu).' };
  }

  // Transfer: base64 locally, append in ~25 KB chunks. A single ssh call carrying
  // the whole payload as one argument fails on large PDFs, so chunk it. The local
  // `split` command is unreliable here, so slice the string in JS instead.
  var b64 = fs.readFileSync(file).toString('base64');
  var remoteDir = '$HOME/.slicc-pdf-text-' + RUNID;
  var mk = run(SSH_BIN, ['--timeout', '20', target, 'mkdir -p ' + remoteDir + ' && rm -f ' + remoteDir + '/f.b64 ' + remoteDir + '/f.pdf && echo OK']);
  if (mk.status !== 0 || !/OK/.test(mk.stdout)) {
    return { text: '', err: 'could not create remote scratch dir: ' + (mk.stderr || mk.stdout).trim() };
  }

  var CHUNK = 25 * 1024;
  for (var off = 0; off < b64.length; off += CHUNK) {
    var piece = b64.slice(off, off + CHUNK);
    var put = run(SSH_BIN, ['--timeout', '60', target, "printf '%s' '" + piece + "' >> " + remoteDir + '/f.b64']);
    if (put.status !== 0) {
      run(SSH_BIN, ['--timeout', '20', target, 'rm -rf ' + remoteDir]);
      return { text: '', err: 'chunk upload failed at byte ' + off + ': ' + (put.stderr || put.stdout).trim() };
    }
  }

  // macOS base64 wants -i/-o; GNU coreutils wants --decode. Try both.
  var dec = run(SSH_BIN, ['--timeout', '60', target,
    'cd ' + remoteDir + ' && (base64 -d -i f.b64 -o f.pdf 2>/dev/null || base64 --decode f.b64 > f.pdf) && wc -c < f.pdf']);
  var remoteSize = parseInt(String(dec.stdout).trim(), 10);
  var localSize = fs.statSync(file).size;
  if (dec.status !== 0 || !(remoteSize > 0)) {
    run(SSH_BIN, ['--timeout', '20', target, 'rm -rf ' + remoteDir]);
    return { text: '', err: 'remote base64 decode failed: ' + (dec.stderr || dec.stdout).trim() };
  }
  if (remoteSize !== localSize) {
    run(SSH_BIN, ['--timeout', '20', target, 'rm -rf ' + remoteDir]);
    return { text: '', err: 'transfer size mismatch (local ' + localSize + ' vs remote ' + remoteSize + ') — aborted rather than extract from a truncated file.' };
  }

  var layout = flags.layout ? '-layout ' : '';
  var got = run(SSH_BIN, ['--timeout', '120', target, 'cd ' + remoteDir + ' && pdftotext ' + layout + 'f.pdf - ']);
  run(SSH_BIN, ['--timeout', '20', target, 'rm -rf ' + remoteDir]);
  if (got.status !== 0) return { text: '', err: 'remote pdftotext failed: ' + (got.stderr || got.stdout).trim() };
  return { text: got.stdout, err: null, target: target, bytes: localSize };
}

// ============================================================ TIER 3 — raster

function tier3(file) {
  var base = scratch('page');
  var r = run('pdftoppm', ['-r', '150', '-png', file, base]);
  if (r.status !== 0) return { files: [], err: (r.stderr || r.stdout).trim() || 'pdftoppm exited ' + r.status };
  var dir = path.dirname(base);
  var pref = path.basename(base);
  var files = fs.readdirSync(dir).filter(function (f) { return f.indexOf(pref) === 0 && /\.png$/.test(f); })
    .sort().map(function (f) { return path.join(dir, f); });
  return { files: files, err: files.length ? null : 'pdftoppm produced no images' };
}

// ================================================================= pipeline

var attempts = [];
var result = null;

// PDF_TEXT_SKIP is a debugging aid: a comma-separated list of tier ids to skip
// (e.g. PDF_TEXT_SKIP=1a) so a single tier can be exercised in isolation.
var SKIP = String(process.env.PDF_TEXT_SKIP || '').split(',').map(function (x) { return x.trim(); });
function skipped(t) { return SKIP.indexOf(t) >= 0; }

// --- tier 1a
var b = skipped('1a') ? { text: '', err: 'skipped (PDF_TEXT_SKIP)' } : tier1Builtin(workFile);
if (b.err) attempts.push({ tier: '1a', method: 'pdftk dump_data_utf8', ok: false, why: b.err });
else {
  var ab = assess(b.text);
  attempts.push({ tier: '1a', method: 'pdftk dump_data_utf8', ok: ab.ok, why: ab.reasons.join('; ') || null, stats: ab.stats });
  if (ab.ok) result = { tier: '1a', method: 'pdftk dump_data_utf8 (unpdf)', text: b.text };
}

// --- tier 1b
if (!result) {
  var inf;
  if (skipped('1b')) inf = { text: '', err: 'skipped (PDF_TEXT_SKIP)' };
  else try { inf = tier1Inflate(workFile); } catch (e) { inf = { text: '', err: 'inflation threw: ' + e.message }; }
  if (inf.err) attempts.push({ tier: '1b', method: 'zlib stream inflation', ok: false, why: inf.err });
  else {
    var ai2 = assess(inf.text);
    var why = ai2.reasons.slice();
    if (inf.undecodable > 0) why.push(inf.undecodable + ' glyph codes had no /ToUnicode mapping');
    var ok = ai2.ok && inf.undecodable === 0;
    attempts.push({ tier: '1b', method: 'zlib stream inflation + ToUnicode', ok: ok, why: why.join('; ') || null, stats: ai2.stats });
    if (ok) result = { tier: '1b', method: 'zlib stream inflation + ToUnicode CMap', text: inf.text };
  }
}

// --- tier 2
if (!result && !flags.tier1Only && !flags.noSsh) {
  var t2 = tier2(workFile);
  if (t2.err) attempts.push({ tier: '2', method: 'ssh follower + pdftotext', ok: false, why: t2.err });
  else {
    var a2 = assess(t2.text);
    attempts.push({ tier: '2', method: 'ssh follower + pdftotext', ok: a2.ok, why: a2.reasons.join('; ') || null, stats: a2.stats });
    if (a2.ok) result = { tier: '2', method: 'poppler pdftotext' + (flags.layout ? ' -layout' : '') + ' on ' + t2.target, text: t2.text };
  }
} else if (!result && flags.tier1Only) {
  attempts.push({ tier: '2', method: 'ssh follower + pdftotext', ok: false, why: 'skipped (--tier1-only)' });
} else if (!result && flags.noSsh) {
  attempts.push({ tier: '2', method: 'ssh follower + pdftotext', ok: false, why: 'skipped (--no-ssh)' });
}

// --- output
if (result) {
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, tier: result.tier, method: result.method, file: inputFile, notes: notes, attempts: attempts, text: result.text }, null, 2));
  } else {
    console.log(result.text.replace(/\s+$/, ''));
    console.error('\n[pdf-text] tier ' + result.tier + ' — ' + result.method);
    notes.forEach(function (n) { console.error('[pdf-text] ' + n); });
  }
  process.exit(0);
}

// --- tier 3: no trustworthy text anywhere
var raster = null;
if (!flags.tier1Only) {
  var t3 = tier3(workFile);
  if (t3.err) attempts.push({ tier: '3', method: 'pdftoppm raster', ok: false, why: t3.err });
  else { raster = t3.files; attempts.push({ tier: '3', method: 'pdftoppm raster', ok: false, why: 'rendered ' + t3.files.length + ' page image(s) — IMAGES, NOT TEXT' }); }
}

if (flags.json) {
  console.log(JSON.stringify({ ok: false, tier: null, file: inputFile, notes: notes, attempts: attempts, raster: raster || [], text: null }, null, 2));
} else {
  console.error('pdf-text: no tier produced trustworthy text for ' + inputFile);
  console.error('');
  attempts.forEach(function (a) {
    console.error('  tier ' + a.tier + ' (' + a.method + '): ' + (a.ok ? 'ok' : 'REJECTED') + (a.why ? ' — ' + a.why : ''));
  });
  console.error('');
  if (raster && raster.length) {
    console.error('  Rasterised ' + raster.length + ' page(s) for VISUAL inspection — this is NOT extracted text:');
    raster.forEach(function (f) { console.error('    ' + f); });
    console.error('  View with: open --view ' + raster[0] + ' --size high');
    console.error('  If the glyphs render as tofu boxes the embedded subset font is unmappable;');
    console.error('  neither text extraction nor OCR-free reading can recover it here.');
    console.error('');
  }
  console.error('  Most likely cause: subset CID font with no /ToUnicode CMap. The literal');
  console.error('  strings in the content stream are glyph indices, not characters, so nothing');
  console.error('  local can map them back. Fix: run poppler `pdftotext -layout` on a machine');
  console.error('  with the real font stack — attach an ssh follower and re-run without --no-ssh.');
}
process.exit(3);
