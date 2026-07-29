// monday-dip — render a `monday` JSON plan as a dip (inline shtml widget).
//
// This is the canonical presentation template for `monday` output. It turns a
// rated/planned JSON array into a "plan of attack" card: a doable TODO slice
// ("now"), a held backlog ("later"), and a separate awareness list ("FYI").
// The cone runs this and emits the resulting shtml block in chat.
//
// Usage:
//   monday gh --rate-importance 9-1 --rate-urgency 8-1 --rate-effort --budget 90m \
//     > /tmp/plan.json 2>/dev/null
//   monday-dip /tmp/plan.json        # prints the shtml to stdout
//
// Design rules (keep them — they are the point):
//   * NO EMOJIS. Icons are Lucide via <i data-lucide="name" class="sprinkle-icon">.
//   * No raw importance×urgency numbers in the UI — they are meaningless to a
//     human. Show a priority word and the effort/time instead.
//   * TODO (actionable) is the plan; FYI (merged PRs, closed issues, build
//     notifications) is awareness only and never competes for attention.
//   * Optimise for bang-for-buck: the "now" list is already ROI-ordered by
//     monday; present it in that order.

const fs = require('fs');

const path = process.argv.find((a, i) => i >= 2 && !a.startsWith('-'));
if (!path) {
  console.error('usage: monday-dip <plan.json>   (a JSON array from `monday`)');
  process.exit(2);
}

let items;
try {
  items = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`monday-dip: could not read/parse ${path}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(items)) {
  console.error('monday-dip: expected a JSON array from `monday`.');
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const scoreOf = (it) => (it.importance || 0) * (it.urgency || 0);
const priorityWord = (it) => {
  const s = scoreOf(it);
  if (s >= 20) return ['Critical', '--negative'];
  if (s >= 12) return ['High', '--notice'];
  if (s >= 6) return ['Medium', '--informative'];
  return ['Low', '--positive'];
};
// Lucide icon for the source item type.
const typeIcon = (it) => {
  const t = (it.type || '').toLowerCase();
  if (t.includes('pr')) return 'git-pull-request';
  if (t.includes('issue')) return 'circle-dot';
  if (t.includes('mail') || t.includes('email')) return 'mail';
  if (t.includes('msg') || t.includes('chat')) return 'message-square';
  return 'bell';
};
const effortText = (it) =>
  it.effort_minutes != null ? `~${it.effort_minutes} min` : (it.effort_band || '');

const byBucket = (b) => items.filter((it) => it.bucket === b);
// If the plan has no buckets (unplanned run), treat actionable items as "now".
const hasBuckets = items.some((it) => 'bucket' in it);
const now = hasBuckets ? byBucket('now') : items.filter((it) => it.actionable !== false);
const later = hasBuckets ? byBucket('later') : [];
const followup = hasBuckets ? byBucket('followup') : items.filter((it) => it.category === 'waiting');
const fyi = hasBuckets ? byBucket('fyi') : items.filter((it) => it.actionable === false && it.category !== 'waiting');

const nowMinutes = now.reduce((a, it) => a + (it.effort_minutes || 0), 0);
const haveEffort = now.some((it) => it.effort_minutes != null);

// ── row renderers ──────────────────────────────────────────────────────────────
function todoRow(it) {
  const [word, cls] = priorityWord(it);
  const eff = effortText(it);
  // Build the lick payload as a JS object literal: JSON is valid JS, and
  // esc() turns the quotes into &quot; which the browser decodes back inside
  // the attribute — so slicc.lick receives a real object, not a string.
  const doneData = esc(JSON.stringify({ id: it.id, title: it.title }));
  const deferData = esc(JSON.stringify({ id: it.id }));
  return `      <div class="monday-item">
        <div class="monday-item__head">
          <i data-lucide="${typeIcon(it)}" class="sprinkle-icon sprinkle-icon--s"></i>
          <a href="${esc(it.url)}" target="_blank" class="monday-item__title">${esc(it.title)}</a>
        </div>
        <div class="monday-item__meta">
          <span class="sprinkle-badge sprinkle-badge${cls}">${word}</span>
          ${eff ? `<span class="monday-eff"><i data-lucide="clock" class="sprinkle-icon sprinkle-icon--xs"></i> ${esc(eff)}</span>` : ''}
          <span class="monday-src">${esc(it.subtitle || it.source || '')}</span>
        </div>
        ${it.summary ? `<div class="monday-item__why">${esc(it.summary)}</div>` : ''}
        <div class="monday-item__actions">
          <button class="sprinkle-btn sprinkle-btn--primary sprinkle-btn--s" onclick="window.open('${esc(it.url)}','_blank')"><i data-lucide="external-link" class="sprinkle-icon sprinkle-icon--xs"></i> Open</button>
          <button class="sprinkle-btn sprinkle-btn--s" onclick="slicc.lick({action:'done',data:${doneData}})"><i data-lucide="check" class="sprinkle-icon sprinkle-icon--xs"></i> Done</button>
          <button class="sprinkle-btn sprinkle-btn--secondary sprinkle-btn--s" onclick="slicc.lick({action:'defer',data:${deferData}})"><i data-lucide="clock" class="sprinkle-icon sprinkle-icon--xs"></i> Later</button>
        </div>
      </div>`;
}

function listRow(it) {
  const eff = effortText(it);
  return `        <li><i data-lucide="${typeIcon(it)}" class="sprinkle-icon sprinkle-icon--xs"></i> <a href="${esc(it.url)}" target="_blank">${esc(it.title)}</a> <span class="monday-src">${esc(it.subtitle || '')}${eff ? ` · ${esc(eff)}` : ''}</span></li>`;
}

// ── assemble ─────────────────────────────────────────────────────────────────
const nowRows = now.map(todoRow).join('\n');
const laterRows = later.map(listRow).join('\n');
const fyiRows = fyi.map(listRow).join('\n');
// "Waiting on others" rows get a Nudge action — the ball is in someone else's court.
function followupRow(it) {
  const nudge = esc(JSON.stringify({ id: it.id, title: it.title }));
  const eff = effortText(it);
  return `        <li><i data-lucide="hourglass" class="sprinkle-icon sprinkle-icon--xs"></i> <a href="${esc(it.url)}" target="_blank">${esc(it.title)}</a> <span class="monday-src">${esc(it.subtitle || '')}${eff ? ` · ${esc(eff)}` : ''}</span> <button class="sprinkle-btn sprinkle-btn--secondary sprinkle-btn--s" onclick="slicc.lick({action:'nudge',data:${nudge}})"><i data-lucide="send" class="sprinkle-icon sprinkle-icon--xs"></i> Nudge</button></li>`;
}
const followupRows = followup.map(followupRow).join('\n');

const headerCount = `${now.length} to-do${followup.length ? ` · ${followup.length} waiting` : ''}${fyi.length ? ` · ${fyi.length} FYI` : ''}`;
const intro = now.length
  ? `Start here — ${haveEffort ? `about ${nowMinutes} minutes of ` : ''}${now.length} thing${now.length === 1 ? '' : 's'} worth doing now.${later.length ? ` ${later.length} more held for later.` : ''}`
  : 'Nothing needs your action right now.';

const style = `  <style>
    .monday-item { padding: 10px 0; border-top: 1px solid var(--s2-color-border, rgba(128,128,128,.25)); }
    .monday-item__head { display: flex; align-items: center; gap: 6px; }
    .monday-item__title { font-weight: 600; text-decoration: none; }
    .monday-item__meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; font-size: 12px; }
    .monday-eff { display: inline-flex; align-items: center; gap: 3px; opacity: .8; }
    .monday-src { opacity: .6; }
    .monday-item__why { font-size: 13px; margin-bottom: 6px; }
    .monday-item__actions { display: flex; gap: 6px; }
    .monday-list { font-size: 13px; margin: 8px 0 0; padding-left: 4px; list-style: none; }
    .monday-list li { padding: 3px 0; display: flex; align-items: center; gap: 6px; }
    .monday-list a { text-decoration: none; }
    details { margin-top: 12px; }
    summary { cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  </style>`;

const laterBlock = later.length
  ? `      <details>
        <summary><i data-lucide="list" class="sprinkle-icon sprinkle-icon--s"></i> ${later.length} more, ranked for later</summary>
        <ul class="monday-list">
${laterRows}
        </ul>
      </details>`
  : '';

const followupBlock = followup.length
  ? `      <details open>
        <summary><i data-lucide="hourglass" class="sprinkle-icon sprinkle-icon--s"></i> ${followup.length} waiting on others — chase or nudge</summary>
        <ul class="monday-list">
${followupRows}
        </ul>
      </details>`
  : '';

const fyiBlock = fyi.length
  ? `      <details>
        <summary><i data-lucide="info" class="sprinkle-icon sprinkle-icon--s"></i> ${fyi.length} for your information — no action needed</summary>
        <ul class="monday-list">
${fyiRows}
        </ul>
      </details>`
  : '';

const shtml = `<div class="sprinkle-action-card">
${style}
  <div class="sprinkle-action-card__header">
    <i data-lucide="calendar-check" class="sprinkle-icon sprinkle-icon--l"></i> Your plan
    <span class="sprinkle-badge sprinkle-badge--notice">${headerCount}</span>
  </div>
  <div class="sprinkle-action-card__body">
    <div style="font-size:13px;opacity:.85;margin-bottom:2px">${esc(intro)}</div>
${nowRows}
${laterBlock}
${followupBlock}
${fyiBlock}
  </div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:'replan',data:{budget:'120m'}})"><i data-lucide="refresh-cw" class="sprinkle-icon sprinkle-icon--xs"></i> Re-plan for 2h</button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:'start',data:{}})"><i data-lucide="play" class="sprinkle-icon sprinkle-icon--xs"></i> Start now list</button>
  </div>
  <script>if (window.LucideIcons) LucideIcons.render();</script>
</div>`;

process.stdout.write(shtml + '\n');
