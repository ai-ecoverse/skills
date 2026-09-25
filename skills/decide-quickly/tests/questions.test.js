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

test('answers print name, label, and probability', () => {
  const text = questions.formatAnswers({
    billing: { type: 'noul', noul: 0.82 },
    tone: { type: 'choice', choice: 'frustrated', confidence: 0.6 },
    urgency: { type: 'score', score: 2, legend: { 2: 'today' }, confidence: 0.5 },
  });
  is(text, 'billing\tyes\t0.82\ntone\tfrustrated\t0.60\nurgency\ttoday\t0.50\n');
});

const URGENCY = { 0: 'can wait', 1: 'this week', 2: 'today' };

function scoreLine(score, legend = URGENCY) {
  return questions.formatAnswers({ urgency: { type: 'score', score, legend, confidence: 0.74 } });
}

test('a fractional score prints the nearest option, not the number (#426)', () => {
  // "urgency:score:How urgent?::can wait|this week|today" answered 1.37.
  is(scoreLine(1.37), 'urgency\tthis week\t0.74\n');
  is(scoreLine(0.49), 'urgency\tcan wait\t0.74\n');
  is(scoreLine(0.51), 'urgency\tthis week\t0.74\n');
  is(scoreLine(1.62), 'urgency\ttoday\t0.74\n');
  is(scoreLine(0), 'urgency\tcan wait\t0.74\n');
  is(scoreLine(2), 'urgency\ttoday\t0.74\n');
});

test('a score exactly between two levels takes the higher one', () => {
  is(scoreLine(0.5), 'urgency\tthis week\t0.74\n');
  is(scoreLine(1.5), 'urgency\ttoday\t0.74\n');
});

test('a score outside the legend takes the end label', () => {
  is(scoreLine(-0.3), 'urgency\tcan wait\t0.74\n');
  is(scoreLine(2.8), 'urgency\ttoday\t0.74\n');
  is(scoreLine(7), 'urgency\ttoday\t0.74\n');
  // A legend shorter than the score range clamps to its last level.
  is(scoreLine(1.9, { 0: 'can wait', 1: 'this week' }), 'urgency\tthis week\t0.74\n');
});

test('a score with no usable legend prints the number', () => {
  const noLegend = { type: 'score', score: 1.37, confidence: 0.74 };
  is(questions.formatAnswers({ urgency: noLegend }), 'urgency\t1.37\t0.74\n');
  is(scoreLine(1.37, {}), 'urgency\t1.37\t0.74\n');
  is(scoreLine(1.37, { low: 'can wait' }), 'urgency\t1.37\t0.74\n');
});

test('noul and choice lines are unchanged beside a fractional score', () => {
  const text = questions.formatAnswers({
    billing: { type: 'noul', noul: 0.5 },
    spam: { type: 'noul', noul: 0.49 },
    tone: { type: 'choice', choice: 'calm', confidence: 0.333 },
    urgency: { type: 'score', score: 1.37, legend: URGENCY, confidence: 0.74 },
  });
  is(text, 'billing\tyes\t0.50\nspam\tno\t0.49\ntone\tcalm\t0.33\nurgency\tthis week\t0.74\n');
});
