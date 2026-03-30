// check-ai-patterns.jsh — AI Pattern Checker (Comprehensive Analysis)
// Checks vocabulary rates, em-dash usage, and structural patterns
// Usage: check-ai-patterns <file> [multiplier]

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
  process.stderr.write('Usage: check-ai-patterns <file> [multiplier]\n');
  process.exit(1);
}

const content = await fs.readFile(filePath, 'utf8');
const lowercase = content.toLowerCase();
const totalWords = content.split(/\s+/).filter(w => w.length > 0).length;
const today = new Date().toISOString().slice(0, 10);

process.stdout.write('# AI Pattern Analysis Report\n\n');
process.stdout.write(`**File:** \`${filePath}\`\n`);
process.stdout.write(`**Total words:** ${totalWords}\n`);
process.stdout.write(`**Analysis date:** ${today}\n\n`);

// ── Section 1: Em-Dash Analysis ──────────────────────────────

process.stdout.write('## 1. Em-Dash Analysis\n\n');

const emDashCount = (content.match(/\u2014/g) || []).length;
const doubleHyphen = (content.match(/ -- /g) || []).length;
const totalDashes = emDashCount + doubleHyphen;
const dashRate = totalWords > 0 ? (totalDashes * 1000 / totalWords).toFixed(2) : '0';
const dashThreshold = 5;

process.stdout.write(`- Em-dashes (—): ${emDashCount}\n`);
process.stdout.write(`- Double-hyphens (--): ${doubleHyphen}\n`);
process.stdout.write(`- **Total:** ${totalDashes}\n`);
process.stdout.write(`- **Rate:** ${dashRate} per 1000 words\n`);
process.stdout.write(`- **Threshold:** ${dashThreshold} per 1000 words\n\n`);

const dashFlag = parseFloat(dashRate) > dashThreshold ? 1 : 0;
if (dashFlag) {
  process.stdout.write(`⚠️  **Em-dash overuse detected** (${dashRate} > ${dashThreshold})\n\n`);
} else {
  process.stdout.write('✓ Em-dash rate within normal range\n\n');
}

// ── Section 2: Vocabulary Analysis ───────────────────────────

process.stdout.write('## 2. Vocabulary Analysis\n\n');
process.stdout.write(`Checking ${multiplier}x threshold against corpus base rates...\n\n`);

let vocabViolations = 0;
let vocabTotal = 0;
const violationWords = [];

process.stdout.write('| Word | Count | Expected | Rate/M | Base/M | Ratio |\n');
process.stdout.write('|------|-------|----------|--------|--------|-------|\n');

for (const [word, baseRate] of Object.entries(WORD_RATES)) {
  const regex = new RegExp(`\\b${word}\\b`, 'gi');
  const matches = lowercase.match(regex);
  const count = matches ? matches.length : 0;

  if (count > 0) {
    vocabTotal += count;
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
      vocabViolations++;
      violationWords.push(`${word}(${count})`);
      process.stdout.write(`| **${word}** | ${count} | ${expected} | ${actualRate} | ${baseRate} | **${ratio}x** |\n`);
    } else {
      process.stdout.write(`| ${word} | ${count} | ${expected} | ${actualRate} | ${baseRate} | ${ratio}x |\n`);
    }
  }
}

process.stdout.write(`\n**AI vocabulary instances:** ${vocabTotal}\n`);
if (vocabViolations > 0) {
  process.stdout.write(`**Violations:** ${vocabViolations} words exceed ${multiplier}x threshold\n`);
  process.stdout.write(`**Flagged:** ${violationWords.join(' ')}\n`);
}
process.stdout.write('\n');

// ── Section 3: Phrase Patterns ───────────────────────────────

process.stdout.write('## 3. Phrase Patterns\n\n');

let phraseCount = 0;
const phraseList = [];

function checkPhrase(pattern, label) {
  const regex = new RegExp(pattern, 'gi');
  const matches = lowercase.match(regex);
  const count = matches ? matches.length : 0;
  if (count > 0) {
    phraseCount += count;
    phraseList.push(`- **${label}**: ${count}`);
  }
}

checkPhrase("it.s important to (note|remember|consider)", "Hedging preamble");
checkPhrase("it.s worth (noting|mentioning)", "Worth noting");
checkPhrase("in today.s world", "In today's world");
checkPhrase("in this (article|guide|post)", "Article opener");
checkPhrase("let.s (dive|delve)", "Let's dive/delve");
checkPhrase("at the end of the day", "At the end of the day");
checkPhrase("in conclusion", "In conclusion");
checkPhrase("to sum up", "To sum up");
checkPhrase("not only .+ but also", "Not only...but also");
checkPhrase("it.s not (just|simply) .+, it.s", "It's not X, it's Y");
checkPhrase("(stands|serves) as a testament", "Testament phrase");
checkPhrase("plays a (vital|crucial|pivotal|significant) role", "Plays X role");
checkPhrase("(rich|complex) tapestry", "Tapestry metaphor");
checkPhrase("navigat(e|ing) the .+ landscape", "Navigate landscape");
checkPhrase("embark on a journey", "Embark journey");
checkPhrase("beacon of", "Beacon of");
checkPhrase("despite .+ challenges", "Despite challenges");

// Forced juxtapositions
let juxtCount = 0;
const juxtList = [];

function checkJuxt(pattern, label) {
  const regex = new RegExp(pattern, 'gi');
  const matches = lowercase.match(regex);
  const count = matches ? matches.length : 0;
  if (count > 0) {
    juxtCount += count;
    juxtList.push(`- **${label}**: ${count}`);
  }
}

checkJuxt("not (just|simply|merely|only) [^.!?]{1,40}, but", "Not just X, but Y");
checkJuxt("not about [^.!?]{1,30}it.s about", "Not about X, it's about Y");
checkJuxt("it.s not [^.!?]{1,30}it.s", "It's not X, it's Y");
checkJuxt("not only [^.!?]{1,60}but also", "Not only...but also");
checkJuxt("more than (just |simply |merely )[a-z]", "More than just X");
checkJuxt("go(es)? beyond [^.!?]{5,30}to", "Goes beyond X to Y");

if (juxtCount > 0) {
  process.stdout.write(`**Forced juxtapositions found:** ${juxtCount}\n`);
  process.stdout.write(juxtList.join('\n') + '\n\n');
  phraseCount += juxtCount;
}

if (phraseCount > 0) {
  process.stdout.write(`**AI phrases found:** ${phraseCount}\n`);
  process.stdout.write(phraseList.join('\n') + '\n');
} else {
  process.stdout.write('No common AI phrases detected.\n');
}
process.stdout.write('\n');

// ── Section 4: Summary ──────────────────────────────────────

process.stdout.write('## 4. Summary\n\n');

let score = 0;
if (dashFlag) score += 2;
if (vocabViolations >= 6) score += 3;
else if (vocabViolations >= 3) score += 2;
else if (vocabViolations >= 1) score += 1;
if (phraseCount >= 3) score += 2;
else if (phraseCount >= 1) score += 1;

process.stdout.write('| Category | Finding |\n');
process.stdout.write('|----------|--------|\n');
process.stdout.write(`| Em-dash rate | ${dashRate} per 1000 words |\n`);
process.stdout.write(`| Vocabulary violations | ${vocabViolations} |\n`);
process.stdout.write(`| AI phrases | ${phraseCount} |\n`);
process.stdout.write(`| **Score** | ${score} / 7 |\n\n`);

if (score >= 5) {
  process.stdout.write('### Confidence: HIGH\n');
  process.stdout.write('Multiple strong indicators of AI-generated content across categories.\n');
} else if (score >= 3) {
  process.stdout.write('### Confidence: MEDIUM\n');
  process.stdout.write('Several indicators present. Content warrants closer review.\n');
} else if (score >= 1) {
  process.stdout.write('### Confidence: LOW\n');
  process.stdout.write('Few indicators detected. Likely human-written or well-edited AI.\n');
} else {
  process.stdout.write('### Result: PASS\n');
  process.stdout.write('No significant AI patterns detected.\n');
}

