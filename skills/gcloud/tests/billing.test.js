import { createRequire } from 'node:module';
import test, { is } from 'tst';

const require = createRequire(import.meta.url);
const gc = require('../scripts/lib/gcloud-config.js');

function stub(answers) {
  const calls = [];
  const spawn = async (argv) => {
    calls.push(argv);
    return answers[argv.slice(1, 3).join(' ')] || { stdout: '', exitCode: 1 };
  };
  return { spawn, calls };
}

test('project: an explicit --project wins and gcloud is not asked', async () => {
  const s = stub({ 'config get-value': { stdout: 'other\n', exitCode: 0 } });
  is(await gc.resolveProject('mine', s.spawn), 'mine');
  is(s.calls, []);
});

test('project: defaults to gcloud config get-value project', async () => {
  const s = stub({ 'config get-value': { stdout: 'helix-225321\n', exitCode: 0 } });
  is(await gc.resolveProject(undefined, s.spawn), 'helix-225321');
  is(s.calls, [['gcloud', 'config', 'get-value', 'project']]);
});

test('project: unset or a failed lookup gives no project', async () => {
  is(await gc.resolveProject(undefined, stub({ 'config get-value': { stdout: '(unset)\n', exitCode: 0 } }).spawn), undefined);
  is(await gc.resolveProject(undefined, stub({ 'config get-value': { stdout: '', exitCode: 0 } }).spawn), undefined);
  is(await gc.resolveProject(undefined, stub({}).spawn), undefined);
});

test('billing account: read from gcloud billing projects describe --format=json', async () => {
  const s = stub({ 'billing projects': { stdout: '{"billingAccountName":"billingAccounts/00-AA"}', exitCode: 0 } });
  is(await gc.resolveBillingAccount('p1', s.spawn), 'billingAccounts/00-AA');
  is(s.calls, [['gcloud', 'billing', 'projects', 'describe', 'p1', '--format=json']]);
});

test('billing account: a failed call, bad JSON or no billing link gives none', async () => {
  is(await gc.resolveBillingAccount('p', stub({}).spawn), undefined);
  is(await gc.resolveBillingAccount('p', stub({ 'billing projects': { stdout: 'nope', exitCode: 0 } }).spawn), undefined);
  is(await gc.resolveBillingAccount('p', stub({ 'billing projects': { stdout: '{}', exitCode: 0 } }).spawn), undefined);
});
