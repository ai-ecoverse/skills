function unique(values = []) {
  return [...new Set(values)];
}

function updatedValues(current, added, removed) {
  const removedValues = new Set(unique(removed));
  return unique([...current, ...added]).filter((value) => !removedValues.has(value));
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reviewerPayload(values) {
  const reviewers = [];
  const teamReviewers = [];
  for (const value of unique(values)) {
    if (value.includes('/')) {
      const slug = value.split('/').pop();
      if (!teamReviewers.includes(slug)) teamReviewers.push(slug);
    } else if (!reviewers.includes(value)) {
      reviewers.push(value);
    }
  }
  return {
    ...(reviewers.length ? { reviewers } : {}),
    ...(teamReviewers.length ? { team_reviewers: teamReviewers } : {}),
  };
}

function buildPrEditPlan(options) {
  const pull = {};
  if (options.title !== undefined && options.title !== options.currentTitle)
    pull.title = options.title;
  if (options.body !== undefined && options.body !== options.currentBody) pull.body = options.body;
  if (options.base !== undefined && options.base !== options.currentBase) pull.base = options.base;

  const issue = {};
  if (options.milestone !== undefined && options.milestone !== options.currentMilestone) {
    issue.milestone = options.milestone;
  }
  if (options.addLabels.length || options.removeLabels.length) {
    const labels = updatedValues(options.currentLabels, options.addLabels, options.removeLabels);
    if (!sameValues(labels, options.currentLabels)) issue.labels = labels;
  }
  if (options.addAssignees.length || options.removeAssignees.length) {
    const assignees = updatedValues(
      options.currentAssignees,
      options.addAssignees,
      options.removeAssignees
    );
    if (!sameValues(assignees, options.currentAssignees)) issue.assignees = assignees;
  }

  const removedReviewers = unique(options.removeReviewers);
  const removedSet = new Set(removedReviewers);
  const addedReviewers = unique(options.addReviewers).filter((value) => !removedSet.has(value));
  return {
    pull,
    issue,
    addReviewers: reviewerPayload(addedReviewers),
    removeReviewers: reviewerPayload(removedReviewers),
  };
}

async function applyPrEdit(api, repo, number, plan) {
  const basePath = `/repos/${repo}`;
  const result = {};
  if (Object.keys(plan.pull).length) {
    result.pull = await api.patch(`${basePath}/pulls/${number}`, { body: plan.pull });
  }
  if (Object.keys(plan.issue).length) {
    result.issue = await api.patch(`${basePath}/issues/${number}`, { body: plan.issue });
  }
  if (Object.keys(plan.addReviewers).length) {
    result.addReviewers = await api.post(`${basePath}/pulls/${number}/requested_reviewers`, {
      body: plan.addReviewers,
    });
  }
  if (Object.keys(plan.removeReviewers).length) {
    result.removeReviewers = await api.delete(`${basePath}/pulls/${number}/requested_reviewers`, {
      body: plan.removeReviewers,
    });
  }
  return result;
}

module.exports = { applyPrEdit, buildPrEditPlan };
