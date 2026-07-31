function buildPrWatchFilter(number, headRef) {
  const prNumber = Number(number);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new TypeError('PR number must be a positive integer');
  }

  const ref = typeof headRef === 'string' && headRef ? JSON.stringify(headRef) : 'null';
  return `(e) => {
  const N = ${prNumber};
  const R = ${ref};
  const b = (e && e.body) || {};
  const hasNum = (arr) => Array.isArray(arr) && arr.some((p) => p && p.number === N);
  if (b.pull_request && b.pull_request.number === N) return true;
  if (b.number === N) return true;
  if (b.issue && b.issue.number === N) return true;
  if (b.check_run && (hasNum(b.check_run.pull_requests) ||
      (b.check_run.check_suite && (hasNum(b.check_run.check_suite.pull_requests) ||
        (R && b.check_run.check_suite.head_branch === R))))) return true;
  if (b.check_suite && (hasNum(b.check_suite.pull_requests) ||
      (R && b.check_suite.head_branch === R))) return true;
  if (R && Array.isArray(b.branches) && b.branches.some((branch) => branch && branch.name === R)) return true;
  return false;
}`;
}

function composePrWatchFilter(defaultFilter, userFilter) {
  if (!userFilter) return defaultFilter;
  return `(e) => (${defaultFilter})(e) && (${userFilter})(e)`;
}

module.exports = { buildPrWatchFilter, composePrWatchFilter };
