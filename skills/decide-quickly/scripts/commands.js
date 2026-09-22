// Turn a cua-s1 plan into playwright-cli lines. Nothing here touches a tab.

function shQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value)) return value === '' ? "''" : value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fillValue(plan, decision) {
  if (decision.entityIndex === null) throw new Error(`fill ${decision.token} has no entity`);
  const entity = plan.entities[decision.entityIndex];
  if (!entity) throw new Error(`fill ${decision.token} points past the entity list`);
  return entity.value;
}

function planToPlaywrightLines(plan, tab) {
  const lines = [];
  for (const action of plan.actions) {
    const tabFlag = `--tab=${shQuote(tab)}`;
    const ref = shQuote(action.token);
    if (action.action === 'fill') {
      lines.push(`playwright-cli fill ${tabFlag} ${ref} ${shQuote(fillValue(plan, action))}`);
    } else if (action.action === 'check') {
      lines.push(`playwright-cli check ${tabFlag} ${ref}`);
    } else if (action.action === 'click') {
      lines.push(`playwright-cli click ${tabFlag} ${ref}`);
    }
  }
  return lines;
}

function formatPlan(plan) {
  const lines = [
    `title: ${plan.title || '(none)'}`,
    `min-confidence: ${plan.minConfidence}`,
    `allow-submit: ${plan.allowSubmit ? 'yes' : 'no'}`,
  ];
  for (const decision of plan.decisions) {
    const where = `${decision.token} ${decision.role} ${JSON.stringify(decision.label)}`;
    if (decision.action === 'fill') {
      const entity = plan.entities[decision.entityIndex ?? -1];
      const shown = entity ? `${entity.label}: ${entity.value}` : 'missing entity';
      lines.push(`fill ${where} <- ${shown}  p=${decision.probability.toFixed(2)}`);
    } else {
      lines.push(`${decision.action} ${where}  p=${decision.probability.toFixed(2)}`);
    }
  }
  if (plan.actions.length === 0) lines.push('(no action above the confidence bar)');
  return `${lines.join('\n')}\n`;
}

function parsePrintedPlan(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`plan is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('plan JSON must be an object');
  if (!Array.isArray(parsed.actions) || !Array.isArray(parsed.entities)) {
    throw new Error('plan JSON needs actions and entities arrays');
  }
  return parsed;
}

function flattenDecision(raw) {
  const element = raw.element || {};
  return {
    token: raw.token || element.token || '',
    role: raw.role || element.role || '',
    label: raw.label || element.label || '',
    action: raw.action,
    probability: raw.probability,
    entityIndex: raw.entityIndex ?? null,
  };
}

module.exports = {
  planToPlaywrightLines,
  formatPlan,
  parsePrintedPlan,
  flattenDecision,
};
