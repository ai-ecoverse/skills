// Question shorthand and answer formatting for `kev ask`.
// The JSON file is the full System One question map. A positional is one
// argv token: name:noul:instruction or name:choice|score:instruction::a|b|c.

const NAME_RE = /^[A-Za-z_][\w-]*$/;

function parseCriteria(kind, raw) {
  const parts = raw
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) {
    throw new Error(`${kind} needs at least two options after ::, separated by |`);
  }
  if (kind === 'score') return parts;
  const criteria = {};
  for (const part of parts) criteria[part] = null;
  return criteria;
}

function parseQuestionShorthand(token) {
  const first = token.indexOf(':');
  const second = first === -1 ? -1 : token.indexOf(':', first + 1);
  if (first <= 0 || second === -1) {
    throw new Error(
      `bad question ${JSON.stringify(token)} (want name:noul:instruction or name:choice:instruction::a|b)`
    );
  }
  const name = token.slice(0, first);
  const kind = token.slice(first + 1, second);
  const rest = token.slice(second + 1);
  if (!NAME_RE.test(name)) throw new Error(`bad question name ${JSON.stringify(name)}`);
  if (kind !== 'noul' && kind !== 'choice' && kind !== 'score') {
    throw new Error(`unknown question type ${JSON.stringify(kind)} (noul, choice, score)`);
  }
  if (kind === 'noul') {
    if (!rest.trim()) throw new Error(`noul question ${name} needs an instruction`);
    return [name, { type: 'noul', instructions: rest }];
  }
  const splitAt = rest.indexOf('::');
  if (splitAt === -1) throw new Error(`${kind} question ${name} needs instruction::opt1|opt2`);
  const instructions = rest.slice(0, splitAt);
  if (!instructions.trim()) throw new Error(`${kind} question ${name} needs an instruction`);
  const criteria = parseCriteria(kind, rest.slice(splitAt + 2));
  if (kind === 'choice') return [name, { type: 'choice', instructions, criteria }];
  return [name, { type: 'score', instructions, criteria }];
}

function parseQuestionPositionals(tokens) {
  const questions = {};
  for (const token of tokens) {
    const [name, question] = parseQuestionShorthand(token);
    if (questions[name]) throw new Error(`duplicate question ${name}`);
    questions[name] = question;
  }
  return questions;
}

function instructionsOf(name, record) {
  if (typeof record.instructions !== 'string' || !record.instructions.trim()) {
    throw new Error(`question ${name} needs a string instructions field`);
  }
  return record.instructions;
}

function questionFromJson(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`question ${name} must be an object`);
  }
  const instructions = instructionsOf(name, value);
  if (value.type === 'noul') return { type: 'noul', instructions };
  if (value.type === 'choice') {
    const criteria = value.criteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new Error(`choice question ${name} needs a criteria object`);
    }
    return { type: 'choice', instructions, criteria };
  }
  if (value.type === 'score') {
    if (!Array.isArray(value.criteria) || value.criteria.some((item) => typeof item !== 'string')) {
      throw new Error(`score question ${name} needs a criteria array of strings`);
    }
    return { type: 'score', instructions, criteria: value.criteria };
  }
  throw new Error(`question ${name} has unknown type ${JSON.stringify(value.type)}`);
}

function parseQuestionsJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`questions are not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('questions JSON must be an object of name → question');
  }
  const questions = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!NAME_RE.test(name)) throw new Error(`bad question name ${JSON.stringify(name)}`);
    questions[name] = questionFromJson(name, value);
  }
  if (Object.keys(questions).length === 0) throw new Error('questions JSON is empty');
  return questions;
}

function parseStateText(text) {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // A document that merely starts with a brace is still prose.
    }
  }
  return text.replace(/\s+$/, '');
}

function formatProbability(value) {
  return value.toFixed(2);
}

function formatAnswers(answers) {
  const lines = [];
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type === 'noul') {
      const yes = answer.noul >= 0.5;
      lines.push(`${name}\t${yes ? 'yes' : 'no'}\t${formatProbability(answer.noul)}`);
      continue;
    }
    if (answer.type === 'choice') {
      lines.push(`${name}\t${answer.choice}\t${formatProbability(answer.confidence)}`);
      continue;
    }
    const level = answer.legend[String(answer.score)] ?? String(answer.score);
    lines.push(`${name}\t${level}\t${formatProbability(answer.confidence)}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

module.exports = {
  parseQuestionShorthand,
  parseQuestionPositionals,
  parseQuestionsJson,
  parseStateText,
  formatAnswers,
};
