/**
 * report-overlay-shared.cjs: what an agent's report (data/reports.json, written
 * only by the github skill's `gh dashboard update|clear`) does to a card, as ONE
 * text used by two programs:
 *   - the panel (github-dashboard.shtml) embeds the fenced block below
 *     VERBATIM, indented six spaces, inside its GHD-CLASSIFY region, right after
 *     the THREAD-STAGE block (scripts/embed-report-overlay.js re-embeds it);
 *   - the fetcher can require() it (CommonJS, like thread-stage-shared.cjs)
 *     once it reads reports.json too (not yet).
 * tests/report-overlay.test.js fails on any byte of difference between this
 * block and the panel's copy.
 *
 * Dependency-free on purpose: no require(), no clock, no I/O. `now` comes from
 * the caller, like every function in GHD-CLASSIFY.
 */
/* ---- 8< REPORT-OVERLAY ----------------------------------------------------
   reportOverlay(record, report, now, opts) -> what the report does to the card.

   PRECEDENCE, highest first. The panel's categorize() consults this right
   after the operator's own done mark, so the mark still outranks everything.
     1. GITHUB WINS. A closed or merged item (stage 9/10/11, a mergedAt, or a
        stateReason other than open/reopened) ignores its report: the normal
        closed/merged stage applies.                        effect 'github'
     2. A done or needs-attention report is SUPERSEDED by GitHub activity
        newer than the report (record.lastActivityAt > report.at; the fetcher
        already strips the mirror's own comments from lastActivityAt).
                                                            effect 'superseded'
     3. A working report goes STALE after the panel's stall limit for the
        stage an agent owns (opts.staleAfterHours: the panel passes
        stallLimitFor(REPORT_WORKING_STAGE), i.e. STALL_AFTER_HOURS = 6 h),
        measured from report.at, the same `idle >= limit` test categorize()
        applies to an Active card. Also stale when threads.json says the
        reporting bb thread is archived or gone.            effect 'stale'
     4. An ACTIVE SNOOZE (opts.snoozed) keeps its place: it holds working and
        done reports back, exactly as it holds back the GitHub signals it
        already outranks. needs-attention breaks through, like the other
        "a human is blocked" signals do.                    effect 'snoozed'
     5. Otherwise the report decides the column: working -> active,
        needs-attention -> needs-attention (the note is the reason),
        done -> done.                                       effect 'applied'
   A report with no status, or no valid `at`, decides nothing ('none',
   'invalid'). Whatever the effect, the reporter and the reported PR are still
   returned as links: the card shows who reported, even when GitHub won.

   `stage` is the stage the card's glyph should show: an open issue (stage 1-4,
   before GitHub has a PR to speak for it) reads 4 "agent working" on an applied
   working report and 3 "needs guidance" on needs-attention. Never a PR: its own
   GitHub state is the better signal, the same rule stageFromThread keeps. */

const REPORT_STATUSES = ['working', 'needs-attention', 'done'];
/** The stage whose stall limit a working report inherits: 4, "agent working". */
const REPORT_WORKING_STAGE = 4;
/** Fallback for opts.staleAfterHours: the panel's STALL_AFTER_HOURS. */
const REPORT_STALE_AFTER_HOURS = 6;
const REPORT_CATEGORY = { working: 'active', 'needs-attention': 'needs-attention', done: 'done' };
/** The writer's own rules (gh dashboard): owner/repo#N, thr_ ids, scoop names. */
const REPORT_KEY_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)#([1-9][0-9]*)$/;
const REPORT_THREAD_ID_RE = /^thr_[a-z0-9]+$/;
const REPORT_SCOOP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Closed or merged on GitHub: the item is over, whatever an agent said. */
function reportGithubFinished(rec) {
  if (!rec) return false;
  if ([9, 10, 11].includes(rec.stage)) return true;
  if (rec.mergedAt) return true;
  const sr = rec.stateReason;
  return typeof sr === 'string' && sr !== '' && sr !== 'open' && sr !== 'reopened';
}

/** Who reported. bb: { kind, id, url, label, threadState } where threadState is
    the thread's data/threads.json entry when the file has it (null otherwise).
    scoop: { kind, name, url: null, label }; a scoop has no URL to open. */
function reportReporter(report, threadEntry) {
  const t = report && report.thread;
  if (!t || typeof t !== 'object') return null;
  if (t.kind === 'bb' && typeof t.id === 'string' && REPORT_THREAD_ID_RE.test(t.id)) {
    const url = typeof t.url === 'string' && /^https?:\/\//i.test(t.url) ? t.url : null;
    const threadState = threadEntry && typeof threadEntry === 'object' ? threadEntry : null;
    return { kind: 'bb', id: t.id, url, label: t.id, threadState };
  }
  if (t.kind === 'scoop' && typeof t.name === 'string' && REPORT_SCOOP_RE.test(t.name)) {
    return { kind: 'scoop', name: t.name, url: null, label: t.name, threadState: null };
  }
  return null;
}

/** The reported PR as a GitHub link, straight from its owner/repo#N: it links
    at once, before any fetcher run knows the PR exists. null when the value is
    not a PR key, or names the card's own item. */
function reportPrLink(pr, rec) {
  if (typeof pr !== 'string') return null;
  const m = pr.match(REPORT_KEY_RE);
  if (!m) return null;
  if (rec && `${rec.repo}#${rec.id}` === pr) return null;
  return {
    key: pr,
    url: `https://github.com/${m[1]}/pull/${m[2]}`,
    label: `${m[1].split('/')[1]}#${m[2]}`,
  };
}

/** The effect of one report on one record at `now` (ms or Date).
    opts: { thread: threads.json entry for a bb reporter, staleAfterHours,
    snoozed: the record's snooze is active }. */
function reportOverlay(rec, report, now, opts) {
  const o = opts || {};
  const out = {
    present: false,
    status: null,
    effect: 'none',
    category: null,
    stage: null,
    reason: null,
    at: null,
    note: null,
    reporter: null,
    links: { thread: null, pr: null },
  };
  if (!report || typeof report !== 'object') return out;
  out.present = true;
  const status = REPORT_STATUSES.includes(report.status) ? report.status : null;
  out.status = status;
  out.note = typeof report.note === 'string' && report.note.trim() ? report.note.trim() : null;
  const atMs = typeof report.at === 'string' ? Date.parse(report.at) : NaN;
  out.at = Number.isFinite(atMs) ? new Date(atMs).toISOString() : null;
  out.reporter = reportReporter(report, o.thread);
  if (out.reporter && out.reporter.url) {
    out.links.thread = { url: out.reporter.url, label: out.reporter.label };
  }
  out.links.pr = reportPrLink(report.pr, rec);
  if (!status) return out;
  if (!Number.isFinite(atMs)) {
    out.effect = 'invalid';
    out.reason = `${status} report has no valid time`;
    return out;
  }
  if (reportGithubFinished(rec)) {
    out.effect = 'github';
    out.reason = `${status} report ignored: the item is closed or merged on GitHub`;
    return out;
  }
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  if (status === 'working') {
    const limit = Number.isFinite(o.staleAfterHours) ? o.staleAfterHours : REPORT_STALE_AFTER_HOURS;
    const age = (nowMs - atMs) / 36e5;
    const th = out.reporter && out.reporter.threadState;
    if (th && (th.archived || th.live === false)) {
      out.effect = 'stale';
      out.reason = 'working report from a bb thread that is archived now';
      return out;
    }
    if (age >= limit) {
      out.effect = 'stale';
      out.reason = `working report ${Math.round(age)}h old, limit ${limit}h`;
      return out;
    }
  } else {
    const act = rec && rec.lastActivityAt ? Date.parse(rec.lastActivityAt) : NaN;
    if (Number.isFinite(act) && act > atMs) {
      out.effect = 'superseded';
      out.reason = `${status} report superseded by GitHub activity after it`;
      return out;
    }
  }
  if (o.snoozed && status !== 'needs-attention') {
    out.effect = 'snoozed';
    out.reason = `${status} report held back by the snooze`;
    return out;
  }
  out.effect = 'applied';
  out.category = REPORT_CATEGORY[status];
  if (rec && rec.kind === 'issue' && [1, 2, 3, 4].includes(rec.stage)) {
    if (status === 'working') out.stage = 4;
    else if (status === 'needs-attention') out.stage = 3;
  }
  const ageH = Math.round((nowMs - atMs) / 36e5);
  if (status === 'working') out.reason = `agent reported working ${ageH}h ago`;
  else if (status === 'needs-attention') out.reason = out.note || 'agent reported needs-attention';
  else out.reason = 'agent reported done';
  return out;
}

/** Hang each record's report (and, for a bb reporter, that thread's
    threads.json entry) on the record as __report / __reportThread, so
    categorize(item, now) can stay a function of the item. IDEMPOTENT: every pass
    first removes the previous one. Keys match exactly, then case-insensitively
    (GitHub owner and repo names are). A missing or malformed file = no reports.
    Returns counts, for the debug handle. */
function attachReports(records, file, threadsFile) {
  const stats = { reports: 0, matched: 0, unmatched: [] };
  const map = file && file.reports && typeof file.reports === 'object' ? file.reports : null;
  const threads =
    threadsFile && threadsFile.threads && typeof threadsFile.threads === 'object'
      ? threadsFile.threads
      : null;
  const byKey = new Map();
  const byLower = new Map();
  for (const r of records || []) {
    delete r.__report;
    delete r.__reportThread;
    const k = `${r.repo}#${r.id}`;
    byKey.set(k, r);
    if (!byLower.has(k.toLowerCase())) byLower.set(k.toLowerCase(), r);
  }
  if (!map) return stats;
  for (const [key, rep] of Object.entries(map)) {
    if (!rep || typeof rep !== 'object') continue;
    stats.reports++;
    const r = byKey.get(key) || byLower.get(key.toLowerCase());
    if (!r) {
      stats.unmatched.push(key);
      continue;
    }
    stats.matched++;
    r.__report = rep;
    const t = rep.thread;
    const id = t && t.kind === 'bb' && typeof t.id === 'string' ? t.id : null;
    const entry = id && threads && Object.hasOwn(threads, id) ? threads[id] : null;
    if (entry && typeof entry === 'object') r.__reportThread = entry;
  }
  return stats;
}

/** The `report` field of every request lick the panel sends: the exact
    commands, with this item's key filled in, that tell the recipient how to
    report back. The <...> placeholders are the recipient's to fill. */
function reportInstructions(key) {
  const k = String(key);
  return {
    how: 'Report progress with gh dashboard (see gh dashboard update --help).',
    start: `gh dashboard update ${k} --status working --thread <bb-thread-url|scoop-name>`,
    pr: `gh dashboard update ${k} --pr <number>`,
    blocked: `gh dashboard update ${k} --status needs-attention --note "<why>"`,
    done: `gh dashboard update ${k} --status done`,
    clear: `gh dashboard clear ${k}`,
  };
}
/* ---- >8 end REPORT-OVERLAY ------------------------------------------------ */

module.exports = {
  REPORT_STATUSES,
  REPORT_WORKING_STAGE,
  REPORT_STALE_AFTER_HOURS,
  reportGithubFinished,
  reportReporter,
  reportPrLink,
  reportOverlay,
  attachReports,
  reportInstructions,
};
