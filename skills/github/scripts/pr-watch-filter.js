function buildPrWatchFilter(number, headRef, headRepoId, headSha) {
  const prNumber = Number(number);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new TypeError('PR number must be a positive integer');
  }

  const ref = typeof headRef === 'string' && headRef ? JSON.stringify(headRef) : 'null';
  const numericRepoId = Number(headRepoId);
  const repoId = Number.isSafeInteger(numericRepoId) && numericRepoId > 0 ? numericRepoId : 'null';
  const sha = typeof headSha === 'string' && headSha ? JSON.stringify(headSha) : 'null';
  return `(e) => {
  const N = ${prNumber};
  const R = ${ref};
  const I = ${repoId};
  const S = ${sha};
  const b = (e && e.body) || {};
  const hasNum = (arr) => Array.isArray(arr) && arr.some((p) => p && p.number === N);
  const sameRepo = (repo) => I && repo && repo.id === I;
  if (b.pull_request && b.pull_request.number === N) return true;
  if (b.number === N) return true;
  if (b.issue && b.issue.number === N) return true;
  if (b.check_run) {
    const suite = b.check_run.check_suite || {};
    if (hasNum(b.check_run.pull_requests) || hasNum(suite.pull_requests)) return true;
    if (S && (b.check_run.head_sha === S || suite.head_sha === S)) return true;
    if (R && sameRepo(suite.head_repository) && suite.head_branch === R) return true;
  }
  if (b.check_suite) {
    if (hasNum(b.check_suite.pull_requests) || (S && b.check_suite.head_sha === S)) return true;
    if (R && sameRepo(b.check_suite.head_repository) && b.check_suite.head_branch === R) return true;
  }
  if (S && b.sha === S) return true;
  if (R && sameRepo(b.repository) && Array.isArray(b.branches) &&
      b.branches.some((branch) => branch && branch.name === R)) return true;
  return false;
}`;
}

function composePrWatchFilter(defaultFilter, userFilter) {
  if (!userFilter) return defaultFilter;
  return `(e) => (${defaultFilter})(e) && (${userFilter})(e)`;
}

function findWatchWebhook(stdout, name) {
  const line = String(stdout)
    .split('\n')
    .find((candidate) => {
      const fields = candidate.trim().split(/\s+/);
      return fields.length > 1 && fields[1] === name;
    });
  if (!line) return null;
  return { id: line.trim().split(/\s+/)[0], filtered: line.includes('[filtered]') };
}

module.exports = { buildPrWatchFilter, composePrWatchFilter, findWatchWebhook };
