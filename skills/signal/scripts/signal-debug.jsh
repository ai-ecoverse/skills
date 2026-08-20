const { exec } = require('sliccy:exec');
const fs = require('fs');
const cli = require('sliccy:cli');

function escapeShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

(async () => {
  const list = await exec('playwright-cli tab-list');
  console.log('tab-list exit', list.exitCode, 'len', (list.stdout||'').length);
  const line = (list.stdout||'').split('\n').find(l => /Signal\.app|background\.html/i.test(l));
  console.log('line', line);
  const m = line && line.match(/^\[([^\]]+)\]/);
  const tabId = m && m[1];
  console.log('tabId', tabId);

  const tmp = '/shared/.signal_dbg_' + Date.now() + '.js';
  const code = "(() => JSON.stringify({title: document.title, n: document.querySelectorAll('button.module-conversation-list__item--contact-or-conversation').length}))()";
  try {
    await fs.writeFile(tmp, code);
    console.log('wrote', tmp);
    const r = await exec('playwright-cli eval-file ' + escapeShellArg(tmp) + ' --tab=' + escapeShellArg(tabId));
    console.log('eval-file exit', r.exitCode);
    console.log('stdout', r.stdout);
    console.log('stderr', r.stderr);
  } catch (e) {
    console.error('ERR', e && e.message ? e.message : e);
    console.error(e);
  } finally {
    try { await fs.rm(tmp); } catch (e) { console.error('rm err', e.message); }
  }

  // Also try plain eval
  try {
    const r2 = await exec('playwright-cli eval --tab=' + escapeShellArg(tabId) + ' ' + escapeShellArg('document.title'));
    console.log('eval exit', r2.exitCode, 'out', r2.stdout, 'err', r2.stderr);
  } catch (e) {
    console.error('eval ERR', e.message);
  }
})();
