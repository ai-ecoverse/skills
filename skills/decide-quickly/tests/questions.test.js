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
