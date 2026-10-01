/**
 * escalations — commands a scoop asked the cone to approve, from `cost --json --all` rows
 * (`escalations: { asked, allowed, denied }`, slicc #3746). A skill arm's agent() scoops must not
 * get commands approved by the cone: an approved command acts outside the skill's own loop (a
 * System 2 scoop once drove the page itself for 100+ steps), so such a run measures something
 * else and is invalid. The bare agent arm is the cone itself; its scoops escalating is ordinary
 * agent behaviour, recorded but not held against it.
 */

const KEYS = ['asked', 'allowed', 'denied'];

/** Summed escalations over every scoop row, or null when the JSON is unreadable or a row has
 * no counter (a leader older than slicc #3746). */
export function escalationTotals(costJson) {
  let data;
  try {
    data = JSON.parse(costJson);
  } catch {
    return null;
  }
  const rows = data?.scoops;
  if (!Array.isArray(rows)) return null;
  const totals = { asked: 0, allowed: 0, denied: 0 };
  for (const row of rows) {
    const e = row?.escalations;
    if (!e || !KEYS.every((k) => Number.isFinite(e[k]))) return null;
    for (const k of KEYS) totals[k] += e[k];
  }
  return totals;
}

/** Escalations during one run, or null when either reading is unknown or a counter went
 * backwards (the leader reset them). */
export function escalationDelta(before, after) {
  if (!before || !after || KEYS.some((k) => after[k] < before[k])) return null;
  return Object.fromEntries(KEYS.map((k) => [k, after[k] - before[k]]));
}

/** Why a run doesn't count, or null when it does. */
export function invalidReason(kind, escalations) {
  if (kind !== 'skill' || !escalations?.allowed) return null;
  return `${escalations.allowed} command(s) escalated to the cone and approved`;
}
