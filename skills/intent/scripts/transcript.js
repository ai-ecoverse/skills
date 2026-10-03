// Reading an `agent` scoop's transcript (/tmp/agent-<name>-<ts>.md): one
// "### tool: bash" block per call, its Input as JSON and its Result in a
// fence. intent-arm counts the calls and what each put into the context.

/** The scoop's tool calls from its transcript: [{ command, chars }]. */
function toolCalls(transcript) {
  const calls = [];
  const blocks = String(transcript).split(/\n### tool: /).slice(1);
  for (const block of blocks) {
    const input = /Input:\s*```json\n([\s\S]*?)\n```/.exec(block);
    const result = /Result:\s*```[a-z]*\n([\s\S]*?)\n```/.exec(block);
    let command = '';
    try {
      command = JSON.parse(input ? input[1] : '{}').command || '';
    } catch {
      command = '';
    }
    calls.push({ command, chars: result ? result[1].length : 0, result: result ? result[1] : '' });
  }
  return calls;
}

/** n, mean, median, max and total of a list of numbers; null when empty. */
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, mean: Math.round(sum / s.length), p50: s[s.length >> 1], max: s[s.length - 1], total: sum };
};

module.exports = { toolCalls, stats };
