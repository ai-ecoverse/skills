// intent's harness-evals adapter, as tools/harness-evals imports it.
// The logic is in adapter.js (CommonJS, so the in-SLICC tests can load it).
import adapter from './adapter.js';

export const goals = './goals.json';
export const {
  arms,
  timeLimit,
  diagnostics,
  command,
  result,
  containsValue,
  judge,
  hnTopFromHtml,
  placeholder,
  gamePoints,
  judgeTrace,
  metrics,
} = adapter;
