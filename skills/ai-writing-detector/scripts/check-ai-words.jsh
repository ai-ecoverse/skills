// check-ai-words.jsh — AI Word Rate Checker
// Detects overused AI vocabulary by comparing actual rates to corpus base rates
// Usage: check-ai-words <file> [multiplier]
// Default multiplier: 3 (flag words appearing 3x more than expected)

// AI word base rates (per million words) — source: ngrams.dev English corpus
const WORD_RATES = {
  delve:0.64, reimagine:0.05, demystify:0.10, orchestrate:0.21, captivate:0.24,
  unveil:0.31, spearhead:0.42, groundbreaking:0.44, uncharted:0.42, unleash:0.43,
  kaleidoscope:0.43, showcase:1.01, underscore:1.00, immerse:0.60, resonate:0.58,
  nuanced:0.70, multifaceted:0.78, evocative:0.75, permeate:0.74, symbiosis:0.70,
  synergy:0.79, savvy:0.77, indelible:0.80, hurdles:0.90, redefine:0.83,
  tapestry:1.72, streamline:1.17, insightful:1.05, plethora:1.03, unlock:1.04,
  grapple:1.10, foundational:1.12, enigma:1.17, ethereal:1.31, poignant:1.31,
  meticulous:1.35, cornerstone:1.53, seamless:1.53, nexus:1.57, prowess:1.65,
  elucidate:1.61, bolster:1.68, vigilant:1.76, vibrant:1.79, empower:1.84,
  illuminate:1.85, lucid:1.90, navigate:1.95, optimize:1.84, stunning:2.05,
  align:2.06, transformative:1.01, pivotal:2.17, holistic:2.22, embark:2.20,
  resilience:2.22, zenith:2.25, thriving:2.25, sentinel:2.14, myriad:2.58,
  pioneering:2.61, repertoire:2.63, elevate:2.03, facet:2.08, mitigate:2.91,
  tailored:3.00, exemplary:3.21, luminous:3.53, leverage:3.61, renowned:3.77,
  beacon:4.26, intricate:4.05, equip:3.99, harness:4.32, evolving:4.34,
  cultivate:4.74, exquisite:5.05, symphony:5.75, paramount:5.94, paradigm:6.28,
  potent:6.19, fascinating:6.53, catalyst:6.79, robust:6.86, vivid:6.90,
  imperative:7.91, innovative:8.30, utilize:8.39, indispensable:8.23, intrinsic:8.57,
  embrace:9.83, subtle:10.24, inevitably:10.93, realm:12.64, enhance:14.06,
  explore:14.19, profound:14.22, craft:14.54, testament:16.62, crucial:16.85,
  facilitate:17.01, implement:17.35, integral:17.54, venture:17.02, landscape:19.88,
  foster:20.05, revolutionary:20.23, undoubtedly:20.44, spectrum:26.05, dynamic:27.27,
  journey:28.17, vital:28.92, comprehensive:34.75, vast:33.84, ensure:41.82,
  substantial:49.66,
};

const filePath = args[0];
const multiplier = parseFloat(args[1]) || 3;

if (!filePath) {
  process.stderr.write('Usage: check-ai-words <file> [multiplier]\n');
  process.exit(1);
}

const content = await fs.readFile(filePath, 'utf8');
const lowercase = content.toLowerCase();
const totalWords = content.split(/\s+/).filter(w => w.length > 0).length;

if (totalWords < 100) {
  process.stderr.write(`Warning: File has only ${totalWords} words. Results may be unreliable.\n`);
}

process.stdout.write('## AI Word Rate Analysis\n\n');
process.stdout.write(`**File:** ${filePath}\n`);
process.stdout.write(`**Total words:** ${totalWords}\n`);
process.stdout.write(`**Threshold:** ${multiplier}x base rate\n\n`);

let violations = 0;
let totalFound = 0;
const violationList = [];

process.stdout.write('| Word | Count | Expected | Actual/M | Base/M | Ratio |\n');
process.stdout.write('|------|-------|----------|----------|--------|-------|\n');

for (const [word, baseRate] of Object.entries(WORD_RATES)) {
  const regex = new RegExp(`\\b${word}\\b`, 'gi');
  const matches = lowercase.match(regex);
  const count = matches ? matches.length : 0;

  if (count > 0) {
    totalFound += count;
    const expected = (totalWords * baseRate / 1000000).toFixed(2);
    const actualRate = (count * 1000000 / totalWords).toFixed(2);
    let ratio;
    if (parseFloat(expected) > 0.01) {
      ratio = (count / parseFloat(expected)).toFixed(1);
    } else {
      ratio = (parseFloat(actualRate) / baseRate).toFixed(1);
    }

    const isViolation = parseFloat(actualRate) > baseRate * multiplier;
    if (isViolation) {
      violations++;
      violationList.push(`${word}(${count})`);
      process.stdout.write(`| **${word}** | ${count} | ${expected} | ${actualRate} | ${baseRate} | **${ratio}x** |\n`);
    } else {
      process.stdout.write(`| ${word} | ${count} | ${expected} | ${actualRate} | ${baseRate} | ${ratio}x |\n`);
    }
  }
}

process.stdout.write('\n---\n\n');
process.stdout.write(`**AI vocabulary found:** ${totalFound} instances\n`);

if (violations > 0) {
  process.stdout.write(`**Violations:** ${violations} words exceed ${multiplier}x threshold\n`);
  process.stdout.write(`**Flagged:** ${violationList.join(' ')}\n`);

  if (violations >= 6) {
    process.stdout.write('\n### Confidence: HIGH\n');
    process.stdout.write('Multiple AI vocabulary indicators significantly exceed base rates.\n');
  } else if (violations >= 3) {
    process.stdout.write('\n### Confidence: MEDIUM\n');
    process.stdout.write('Several AI vocabulary indicators exceed base rates.\n');
  } else {
    process.stdout.write('\n### Confidence: LOW\n');
    process.stdout.write('Few indicators exceed threshold. Could be coincidence.\n');
  }
} else {
  process.stdout.write('\n### Result: PASS\n');
  process.stdout.write('No significant AI vocabulary rate violations detected.\n');
}

