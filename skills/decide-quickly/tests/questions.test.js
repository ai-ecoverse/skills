import test, { is } from 'tst';
import * as questionsMod from '../scripts/questions.js';

const questions = questionsMod.default || questionsMod;

test('shorthand parses noul, choice, and score', () => {
  const parsed = questions.parseQuestionPositionals([
    'billing:noul:Is this about billing?',
    'tone:choice:What tone?::calm|frustrated|angry',
    'urgency:score:How urgent?::can wait|this week|today',
  ]);
  is(parsed.billing, { type: 'noul', instructions: 'Is this about billing?' });
  is(parsed.tone.criteria.calm, null);
  is(parsed.urgency.criteria, ['can wait', 'this week', 'today']);
});

test('shorthand rejects a bare word and a duplicate name', () => {
  let bare = '';
  try {
    questions.parseQuestionShorthand('billing');
  } catch (err) {
    bare = err.message;
  }
  is(bare.includes('bad question'), true);
  let dup = '';
  try {
    questions.parseQuestionPositionals(['a:noul:one', 'a:noul:two']);
  } catch (err) {
    dup = err.message;
  }
  is(dup, 'duplicate question a');
});

test('JSON questions accept a System One map', () => {
  const parsed = questions.parseQuestionsJson(
    JSON.stringify({
      billing: { type: 'noul', instructions: 'Is this about billing?' },
      tone: { type: 'choice', instructions: 'What tone?', criteria: { calm: null } },
    })
  );
  is(parsed.billing.type, 'noul');
  is(parsed.tone.type, 'choice');
});

test('state keeps JSON objects and leaves prose as text', () => {
  is(questions.parseStateText('{"ticket":1}\n'), { ticket: 1 });
  is(questions.parseStateText('not json {\n'), 'not json {');
});

const URGENCY = { 0: 'can wait', 1: 'this week', 2: 'today' };

function scoreLine(answer) {
  return questions.formatAnswers({ urgency: { type: 'score', confidence: 0.74, ...answer } });
}

test('answers print name, label, and probability', () => {
  const text = questions.formatAnswers({
    billing: { type: 'noul', noul: 0.82 },
    tone: { type: 'choice', choice: 'frustrated', confidence: 0.6 },
    urgency: {
      type: 'score',
      score: 1.8,
      legend: URGENCY,
      probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 },
      confidence: 0.5,
    },
  });
  is(text, 'billing\tyes\t0.82\ntone\tfrustrated\t0.60\nurgency\ttoday\t0.50\n');
});

test('a score prints its most likely option, not the expected level (#426)', () => {
  // kev.js 0.5.0 README: expected level 1.482, "today" has 0.5724.
  const readme = {
    score: 1.482,
    legend: URGENCY,
    probabilities: { 0: 0.0904, 1: 0.3372, 2: 0.5724 },
  };
  is(scoreLine(readme), 'urgency\ttoday\t0.74\n');
});

test('the most likely option wins where rounding the score picks another', () => {
  const legend = { 0: 'none', 1: 'low', 2: 'high', 3: 'urgent' };
  // score 1.49: Math.round and the nearest level both give 1 ("low"); level 0 is most likely.
  const low = { score: 1.49, legend, probabilities: { 0: 0.46, 1: 0.04, 2: 0.05, 3: 0.45 } };
  is(scoreLine(low), 'urgency\tnone\t0.74\n');
  // score 1.6: Math.round and the nearest level both give 2 ("high"); level 3 is most likely.
  const high = { score: 1.6, legend, probabilities: { 0: 0.44, 1: 0.02, 2: 0.04, 3: 0.5 } };
  is(scoreLine(high), 'urgency\turgent\t0.74\n');
});

test('a tie between levels goes to the lowest, like kev.js argmax', () => {
  const ends = { score: 1, legend: URGENCY, probabilities: { 0: 0.4, 1: 0.2, 2: 0.4 } };
  is(scoreLine(ends), 'urgency\tcan wait\t0.74\n');
  const upper = { score: 1.2, legend: URGENCY, probabilities: { 0: 0.2, 1: 0.4, 2: 0.4 } };
  is(scoreLine(upper), 'urgency\tthis week\t0.74\n');
});

test('a score without a usable distribution or legend prints the number', () => {
  is(scoreLine({ score: 1.482, legend: URGENCY }), 'urgency\t1.482\t0.74\n');
  is(scoreLine({ score: 1.482, legend: URGENCY, probabilities: {} }), 'urgency\t1.482\t0.74\n');
  const probabilities = { 0: 0.0904, 1: 0.3372, 2: 0.5724 };
  is(scoreLine({ score: 1.482, probabilities }), 'urgency\t1.482\t0.74\n');
  // The most likely level has no legend entry: print the number, not a neighbour's label.
  const short = { 0: 'can wait', 1: 'this week' };
  is(scoreLine({ score: 1.482, legend: short, probabilities }), 'urgency\t1.482\t0.74\n');
});

test('noul and choice lines are unchanged beside a score', () => {
  const text = questions.formatAnswers({
    billing: { type: 'noul', noul: 0.5 },
    spam: { type: 'noul', noul: 0.49 },
    tone: { type: 'choice', choice: 'calm', confidence: 0.333 },
    urgency: {
      type: 'score',
      score: 1.482,
      legend: URGENCY,
      probabilities: { 0: 0.0904, 1: 0.3372, 2: 0.5724 },
      confidence: 0.74,
    },
  });
  is(text, 'billing\tyes\t0.50\nspam\tno\t0.49\ntone\tcalm\t0.33\nurgency\ttoday\t0.74\n');
});
