import test, { fail, is } from 'tst';
import * as _mod_0 from '../scripts/pr-edit.js';

const { applyPrEdit, buildPrEditPlan } = _mod_0.default || _mod_0;
function plan(overrides = {}) {
  return buildPrEditPlan({
    currentLabels: [],
    currentAssignees: [],
    addLabels: [],
    removeLabels: [],
    addAssignees: [],
    removeAssignees: [],
    addReviewers: [],
    removeReviewers: [],
    ...overrides,
  });
}

test('plans only explicitly requested pull fields', () => {
  is(plan({ title: 'New title', body: 'New body', base: 'stable' }), {
    pull: { title: 'New title', body: 'New body', base: 'stable' },
    issue: {},
    addReviewers: {},
    removeReviewers: {},
  });
});

test('preserves unrelated labels and assignees while de-duplicating edits', () => {
  const result = plan({
    currentLabels: ['keep', 'remove'],
    currentAssignees: ['alice', 'bob'],
    addLabels: ['new', 'new', 'remove'],
    removeLabels: ['remove', 'remove'],
    addAssignees: ['carol', 'carol', 'bob'],
    removeAssignees: ['bob'],
  });

  is(result.issue, {
    labels: ['keep', 'new'],
    assignees: ['alice', 'carol'],
  });
});

test('builds de-duplicated user and team reviewer payloads with removals winning', () => {
  const result = plan({
    addReviewers: ['alice', 'alice', 'acme/platform', 'acme/platform', 'remove-me'],
    removeReviewers: ['remove-me', 'remove-me', 'acme/legacy'],
  });

  is(result.addReviewers, {
    reviewers: ['alice'],
    team_reviewers: ['platform'],
  });
  is(result.removeReviewers, {
    reviewers: ['remove-me'],
    team_reviewers: ['legacy'],
  });
});

test('uses pull, issue, and requested-reviewer endpoints for each payload type', async () => {
  const calls = [];
  const api = {};
  for (const method of ['patch', 'post', 'delete']) {
    api[method] = async (path, options) => {
      calls.push({ method, path, options });
      return { ok: true };
    };
  }
  const editPlan = plan({
    title: 'New title',
    milestone: null,
    currentLabels: ['keep'],
    addLabels: ['new'],
    addReviewers: ['alice'],
    removeReviewers: ['acme/legacy'],
  });

  await applyPrEdit(api, 'octo/repo', 42, editPlan);

  is(calls, [
    {
      method: 'patch',
      path: '/repos/octo/repo/pulls/42',
      options: { body: { title: 'New title' } },
    },
    {
      method: 'patch',
      path: '/repos/octo/repo/issues/42',
      options: { body: { milestone: null, labels: ['keep', 'new'] } },
    },
    {
      method: 'post',
      path: '/repos/octo/repo/pulls/42/requested_reviewers',
      options: { body: { reviewers: ['alice'] } },
    },
    {
      method: 'delete',
      path: '/repos/octo/repo/pulls/42/requested_reviewers',
      options: { body: { team_reviewers: ['legacy'] } },
    },
  ]);
});

test('skips endpoints whose payloads are empty', async () => {
  const api = {
    patch: async () => fail('patch should not be called'),
    post: async () => fail('post should not be called'),
    delete: async () => fail('delete should not be called'),
  };

  is(await applyPrEdit(api, 'octo/repo', 42, plan()), {});
});

test('omits semantic no-ops from pull and issue payloads', () => {
  is(
    plan({
      currentTitle: 'Same',
      currentBody: 'Body\n',
      currentBase: 'main',
      currentMilestone: 7,
      currentLabels: ['ready'],
      currentAssignees: ['octocat'],
      title: 'Same',
      body: 'Body\n',
      base: 'main',
      milestone: 7,
      addLabels: ['ready'],
      removeLabels: ['missing'],
      addAssignees: ['octocat'],
      removeAssignees: ['missing'],
    }),
    { pull: {}, issue: {}, addReviewers: {}, removeReviewers: {} }
  );
});
