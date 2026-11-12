// What gcloud-ext reads from the real gcloud CLI. `spawn` is sliccy:exec's
// exec.spawn, passed in because sliccy:* modules resolve only in the .jsh.

async function defaultProject(spawn) {
  const { stdout, exitCode } = await spawn(['gcloud', 'config', 'get-value', 'project']);
  const p = exitCode === 0 ? String(stdout || '').trim() : '';
  return p && p !== '(unset)' ? p : undefined;
}

async function resolveProject(flagProject, spawn) {
  return typeof flagProject === 'string' && flagProject ? flagProject : defaultProject(spawn);
}

async function resolveBillingAccount(project, spawn) {
  const { stdout, exitCode } = await spawn(['gcloud', 'billing', 'projects', 'describe', project, '--format=json']);
  if (exitCode !== 0) return undefined;
  try {
    return JSON.parse(stdout).billingAccountName || undefined;
  } catch {
    return undefined;
  }
}

module.exports = { defaultProject, resolveProject, resolveBillingAccount };
