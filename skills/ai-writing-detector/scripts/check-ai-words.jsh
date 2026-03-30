// check-ai-words.jsh — AI Word Rate Checker
// Detects overused AI vocabulary by comparing actual rates to corpus base rates
// Usage: check-ai-words <file> [multiplier]
// Default multiplier: 3 (flag words appearing 3x more than expected)

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
  process.stderr.write('Usage: check-ai-words <file> [multiplier]\n');
  process.exit(1);
}

const content = await fs.readFile(filePath, 'utf8');
const lowercase = content.toLowerCase();
const totalWords = content.split(/\s+/).filter(w => w.length > 0).length;

if (totalWords === 0) {
  process.stdout.write('Input file is empty or contains only whitespace; no analysis to perform.\n');
  process.exit(0);
}

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

