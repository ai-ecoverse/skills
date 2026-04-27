// create-pdf.jsh — Create a PDF from scratch using pdf-lib
// Triggered by: "create a pdf", "make a pdf", "generate a pdf"
// Usage: create-pdf [title] [--output=/shared/out.pdf]
// If called with no arguments, creates a sample document.

var args    = (process && process.argv) ? process.argv.slice(2) : [];
var title   = args.filter(function(a) { return !a.startsWith('--'); }).join(' ') || 'My Document';
var outArg  = args.find(function(a) { return a.startsWith('--output='); });
var output  = outArg ? outArg.replace('--output=', '') : '/shared/' + title.toLowerCase().replace(/\s+/g, '-') + '.pdf';

var lib      = await import('https://esm.sh/pdf-lib');
var pdfDoc   = await lib.PDFDocument.create();
var margin   = 72;
var bodySize = 13;
var titSize  = 24;
var lineGap  = 6;
var W        = 612;
var H        = 792;
var maxW     = W - margin * 2;
var metaSize = 10;
var totalPages = 2;

var stdFonts = lib.StandardFonts;
var bodyFont  = await pdfDoc.embedFont(stdFonts.Helvetica);
var titleFont = await pdfDoc.embedFont(stdFonts.HelveticaBold);
var metaFont  = await pdfDoc.embedFont(stdFonts.Helvetica);

var wrapLines = function(text, font, size) {
  var lines = [];
  var paragraphs = text.split('\n');
  for (var pi = 0; pi < paragraphs.length; pi++) {
    var para = paragraphs[pi];
    if (!para.trim()) { lines.push(''); continue; }
    var words = para.split(' ');
    var line  = '';
    for (var wi = 0; wi < words.length; wi++) {
      var word      = words[wi];
      var candidate = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxW) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
};

var drawPage = function(pageIndex, pgTitle, pgBody) {
  var page = pdfDoc.addPage([W, H]);
  var curY = H - margin;
  var grey = { type: 'RGB', red: 0.5, green: 0.5, blue: 0.5 };
  var rule = { type: 'RGB', red: 0.8, green: 0.8, blue: 0.8 };

  // Header
  var hW = metaFont.widthOfTextAtSize(title, metaSize);
  page.drawText(title, { x: (W - hW) / 2, y: H - margin + metaSize + 4, size: metaSize, font: metaFont, color: grey });
  page.drawLine({ start: { x: margin, y: H - margin + 2 }, end: { x: W - margin, y: H - margin + 2 }, thickness: 0.5, color: rule });

  // Footer
  var footerStr = 'Page ' + (pageIndex + 1) + ' of ' + totalPages;
  var fW = metaFont.widthOfTextAtSize(footerStr, metaSize);
  page.drawLine({ start: { x: margin, y: margin - 4 }, end: { x: W - margin, y: margin - 4 }, thickness: 0.5, color: rule });
  page.drawText(footerStr, { x: (W - fW) / 2, y: margin - metaSize - 6, size: metaSize, font: metaFont, color: grey });

  // Title
  var titleLines = wrapLines(pgTitle, titleFont, titSize);
  for (var tl = 0; tl < titleLines.length; tl++) {
    curY -= titSize;
    if (curY < margin) break;
    page.drawText(titleLines[tl], { x: margin, y: curY, size: titSize, font: titleFont });
    curY -= lineGap;
  }
  curY -= titSize * 0.8;

  // Body
  var bodyLines = wrapLines(pgBody, bodyFont, bodySize);
  for (var bl = 0; bl < bodyLines.length; bl++) {
    if (!bodyLines[bl]) { curY -= bodySize; continue; }
    curY -= bodySize;
    if (curY < margin) break;
    page.drawText(bodyLines[bl], { x: margin, y: curY, size: bodySize, font: bodyFont });
    curY -= lineGap;
  }
};

drawPage(0, title,
  'This document was created with the SLICC pdf skill.\n\nEdit this script or call createPdf() directly to generate documents with your own content, headers, footers, and multi-page layouts.'
);

drawPage(1, 'Getting Started',
  'Use the pdf skill to:\n\n- Create PDFs from scratch with custom text and layout\n- Extract text: pdftk /mnt/file.pdf dump_data_utf8\n- Merge files: pdftk A=a.pdf B=b.pdf cat A B output merged.pdf\n- Split pages: pdftk /mnt/file.pdf cat 2-5 output pages.pdf\n- Rotate pages: pdftk /mnt/file.pdf rotate 1-end right output rotated.pdf'
);

var pdfBytes = await pdfDoc.save();
await fs.writeFileBinary(output, pdfBytes);
open(output, '--download');
console.log('Created: ' + output);
