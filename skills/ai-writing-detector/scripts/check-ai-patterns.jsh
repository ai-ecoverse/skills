// check-ai-patterns.jsh — AI Pattern Checker (Comprehensive Analysis)
// Checks vocabulary rates, em-dash usage, and structural patterns
// Usage: check-ai-patterns <file> [multiplier]

const args = process.argv.slice(2);

// Load AI word base rates from reference file (../references/ai_word_rates.txt)
const _scriptDir = process.argv[1].substring(0, process.argv[1].lastIndexOf('/'));
const _ratesText = await fs.readFile(_scriptDir + '/../references/ai_word_rates.txt', 'utf8');
const WORD_RATES = {};
for (const line of _ratesText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const [word, rate] = trimmed.split(':');
  if (word && rate) WORD_RATES[word.trim()] = parseFloat(rate.trim());
}

const filePath = args[0];
const multiplier = parseFloat(args[1]) || 3;

if (!filePath) {
  process.stderr.write('Usage: check-ai-patterns <file> [multiplier]\n');
  process.exit(1);
}

const content = await fs.readFile(filePath, 'utf8');
const lowercase = content.toLowerCase();
const totalWords = content.split(/\s+/).filter(w => w.length > 0).length;

if (totalWords === 0) {
  process.stdout.write('Input file is empty or contains only whitespace; no analysis to perform.\n');
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);

process.stdout.write('# AI Pattern Analysis Report\n\n');
process.stdout.write(`**File:** \`${filePath}\`\n`);
process.stdout.write(`**Total words:** ${totalWords}\n`);
process.stdout.write(`**Analysis date:** ${today}\n\n`);

// ── Section 1: Em-Dash Analysis ──────────────────────────────

process.stdout.write('## 1. Em-Dash Analysis\n\n');

const emDashCount = (content.match(/\u2014/g) || []).length;
const doubleHyphen = (content.match(/--/g) || []).length;
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
checkPhrase("not only .+? but also", "Not only...but also");
checkPhrase("it.s not (just|simply) .+?, it.s", "It's not X, it's Y");
checkPhrase("(stands|serves) as a testament", "Testament phrase");
checkPhrase("plays a (vital|crucial|pivotal|significant) role", "Plays X role");
checkPhrase("(rich|complex) tapestry", "Tapestry metaphor");
checkPhrase("navigat(e|ing) the .+? landscape", "Navigate landscape");
checkPhrase("embark on a journey", "Embark journey");
checkPhrase("beacon of", "Beacon of");
checkPhrase("despite .+? challenges", "Despite challenges");

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

