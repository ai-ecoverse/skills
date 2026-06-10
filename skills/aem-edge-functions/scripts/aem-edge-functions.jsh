// aem-edge-functions - list / inspect / purge AEM Edge Functions on the Managed CDN.
//
// Replicates @adobe/aio-cli-plugin-aem-edge-functions without the CLI: mints an
// IMS token from an ADC OAuth Server-to-Server credential and calls the
// experimental CDN compute API served directly off the site domain.
//
// Usage:
//   aem-edge-functions list   --site <domain> [creds...]
//   aem-edge-functions purge  --site <domain> --service <name> [creds...]
//   aem-edge-functions token  [creds...]
//
// Target (one required):
//   --site <domain>            Edge Delivery site
//   --program <id> --env <id>  Classic AEMaaCS environment
//
// Credentials (first match wins):
//   --token <jwt>              use this access token verbatim
//   env AEM_EDGE_FUNCTIONS_TOKEN
//   --client-id/--client-secret/--scopes (or AEM_EDGE_FUNCTIONS_ADC_CLIENT_ID/_SECRET/_SCOPES)
//   --adc-config <file.json>   ADC project or credentials JSON on disk
//   --tab                      read the OAuth S2S credential from an open ADC console tab
//
// Options: --stage (cloudmanager stage domain), --json (raw JSON output)

const { positional, flags } = process.argv.parseFlags();
const cmd = positional[0];

const DEFAULT_SCOPES = 'openid,AdobeID,aem.cdn,additional_info.projectedProductContext';
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const CDN_PATH = '/adobe/experimental/compute-expires-20251231/cdn';

const HELP = [
  'aem-edge-functions - manage AEM Edge Functions on the Adobe Managed CDN',
  '',
  'Commands:',
  '  list    List edge functions deployed for a site/environment',
  '  purge   Purge cache for one function (--all OR --surrogate-key <k>; --soft optional)',
  '  token   Mint and print a scoped CDN access token',
  '',
  'Target (one of):',
  '  --site <domain>              Edge Delivery site, e.g. phornig-wknd.testaemcloud.com',
  '  --program <id> --env <id>    Classic AEMaaCS environment',
  '',
  'Credentials (first match wins):',
  '  --token <jwt>                existing access token',
  '  --client-id / --client-secret / --scopes <csv>   ADC OAuth S2S credential',
  '  --adc-config <file.json>     ADC project/credentials JSON',
  '  --tab                        read S2S credential from an open developer.adobe.com tab',
  '',
  'Options:',
  '  --stage   target the Cloud Manager stage domain (-cmstg)',
  '  --json    emit raw JSON instead of a table',
  '',
  'Examples:',
  '  aem-edge-functions list --site phornig-wknd.testaemcloud.com --tab',
  '  aem-edge-functions list --site my.site.com --client-id ID --client-secret SECRET',
  '  aem-edge-functions purge --site my.site.com --service personalization --all --tab',
  '  aem-edge-functions purge --site my.site.com --service wknd-compute --surrogate-key key1 --soft --tab',
].join('\n');

if (!cmd || flags.help || flags.h) {
  cli.help(HELP);
}

function resolveBaseUrl() {
  const stageSuffix = flags.stage ? '-cmstg' : '';
  if (flags.site) {
    return 'https://' + flags.site + CDN_PATH;
  }
  const program = flags.program || process.env.AEM_EDGE_FUNCTIONS_PROGRAM_ID;
  const env = flags.env || flags.environment || process.env.AEM_EDGE_FUNCTIONS_ENVIRONMENT_ID;
  if (program && env) {
    return 'https://author-p' + program + '-e' + env + stageSuffix + '.adobeaemcloud.com' + CDN_PATH;
  }
  cli.die('specify a target: --site <domain>  OR  --program <id> --env <id>', { prefix: 'aem-ef' });
}

async function readCredentialFromFile(path) {
  if (!(await fs.exists(path))) cli.die('adc-config not found: ' + path, { prefix: 'aem-ef' });
  let json;
  try {
    json = JSON.parse(await fs.readFile(path));
  } catch (e) {
    cli.die('adc-config is not valid JSON: ' + e.message, { prefix: 'aem-ef' });
  }
  if (json.project) {
    const ws = json.project.workspace || {};
    const details = ws.details || {};
    const creds = details.credentials || [];
    let oauth = null;
    for (const cr of creds) {
      if (cr.integration_type === 'oauth_server_to_server') oauth = cr.oauth_server_to_server;
    }
    if (!oauth) cli.die('no oauth_server_to_server credential in project JSON', { prefix: 'aem-ef' });
    const secrets = oauth.client_secrets || [];
    return {
      clientId: oauth.client_id,
      clientSecret: secrets[0],
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes.join(',') : DEFAULT_SCOPES,
    };
  }
  if (json.CLIENT_ID) {
    return {
      clientId: json.CLIENT_ID,
      clientSecret: Array.isArray(json.CLIENT_SECRETS) ? json.CLIENT_SECRETS[0] : json.CLIENT_SECRETS,
      scopes: Array.isArray(json.SCOPES) ? json.SCOPES.join(',') : (json.SCOPES || DEFAULT_SCOPES),
    };
  }
  cli.die('unrecognized ADC config format (expected project or CLIENT_ID keys)', { prefix: 'aem-ef' });
}

async function readCredentialFromTab() {
  const tab = await browser.findTab({ domain: 'developer.adobe.com' });
  if (!tab) {
    cli.die('no developer.adobe.com tab open - open your ADC credential page first', { prefix: 'aem-ef' });
  }
  const raw = await browser.evalAsync(tab, async () => {
    const text = document.body.innerText || '';
    const out = {};
    const idMatch = text.match(/\b[0-9a-f]{32}\b/);
    if (idMatch) out.clientId = idMatch[0];
    // Only trust a scopes line that actually contains aem.cdn; otherwise leave
    // it unset so the caller falls back to the known-good default scope set.
    const scMatch = text.match(/Scopes\s+((?=[^\n]*aem\.cdn)[a-zA-Z0-9_.,\s]+?)(?:\n|View scopes|$)/);
    if (scMatch) {
      const list = scMatch[1].split(/[,\s]+/).filter(Boolean);
      if (list.indexOf('aem.cdn') !== -1) out.scopes = list.join(',');
    }
    const els = document.querySelectorAll('input,code,pre,span');
    for (const el of els) {
      const v = (el.value || el.textContent || '').trim();
      if (/^[A-Za-z0-9._-]{20,80}$/.test(v) && v !== out.clientId && /[a-z]/.test(v) && /[0-9]/.test(v)) {
        out.clientSecret = v;
      }
    }
    return JSON.stringify(out);
  });
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed.clientId) {
    cli.die('could not read client ID from the ADC tab - open the OAuth Server-to-Server credential page', { prefix: 'aem-ef' });
  }
  if (!parsed.clientSecret) {
    cli.die('client secret not visible on the ADC tab - click Retrieve client secret first', { prefix: 'aem-ef' });
  }
  parsed.scopes = parsed.scopes || DEFAULT_SCOPES;
  return parsed;
}

async function mintToken(clientId, clientSecret, scopes) {
  const resp = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: scopes || DEFAULT_SCOPES,
    }).toString(),
  });
  let data = {};
  try { data = await resp.json(); } catch (e) { data = {}; }
  if (!resp.ok || !data.access_token) {
    const msg = data.error_description || data.error || 'unknown';
    cli.die('IMS token exchange failed (' + resp.status + '): ' + msg, { prefix: 'aem-ef' });
  }
  return data.access_token;
}

async function resolveToken() {
  const verbatim = flags.token || process.env.AEM_EDGE_FUNCTIONS_TOKEN;
  if (verbatim) return verbatim;

  let clientId = flags['client-id'] || process.env.AEM_EDGE_FUNCTIONS_ADC_CLIENT_ID;
  let clientSecret = flags['client-secret'] || process.env.AEM_EDGE_FUNCTIONS_ADC_CLIENT_SECRET;
  let scopes = flags.scopes || process.env.AEM_EDGE_FUNCTIONS_ADC_SCOPES || DEFAULT_SCOPES;

  if ((!clientId || !clientSecret) && flags['adc-config']) {
    const cr = await readCredentialFromFile(flags['adc-config']);
    clientId = clientId || cr.clientId;
    clientSecret = clientSecret || cr.clientSecret;
    scopes = flags.scopes || cr.scopes || scopes;
  }

  if ((!clientId || !clientSecret) && flags.tab) {
    const cr = await readCredentialFromTab();
    clientId = clientId || cr.clientId;
    clientSecret = clientSecret || cr.clientSecret;
    scopes = flags.scopes || cr.scopes || scopes;
  }

  if (!clientId || !clientSecret) {
    cli.die('no credentials - provide --token, --client-id/--client-secret, --adc-config, or --tab', { prefix: 'aem-ef' });
  }
  return mintToken(clientId, clientSecret, scopes);
}

function makeClient(token) {
  const baseUrl = resolveBaseUrl();
  return {
    baseUrl: baseUrl,
    get: async function (path) {
      const r = await fetch(baseUrl + path, {
        headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
      });
      return { status: r.status, ok: r.ok, body: await r.text() };
    },
    post: async function (path, jsonBody) {
      const headers = { Authorization: 'Bearer ' + token, accept: 'application/json' };
      const opts = { method: 'POST', headers: headers };
      if (jsonBody !== undefined) {
        headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(jsonBody);
      }
      const r = await fetch(baseUrl + path, opts);
      return { status: r.status, ok: r.ok, body: await r.text() };
    },
  };
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

async function doList() {
  const token = await resolveToken();
  const client = makeClient(token);
  const res = await client.get('/edgeFunctions');
  if (!res.ok) {
    let detail = res.body;
    try {
      const j = JSON.parse(res.body);
      detail = j.error || j.detail || res.body;
    } catch (e) { detail = res.body; }
    cli.die('list failed (HTTP ' + res.status + '): ' + detail, { prefix: 'aem-ef' });
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    cli.die('non-JSON response from CDN API', { prefix: 'aem-ef' });
  }
  if (flags.json) return cli.out(parsed);

  const items = (parsed.items || []).slice().sort(function (a, b) {
    return (a.edgeFunctionName || '').localeCompare(b.edgeFunctionName || '');
  });
  if (items.length === 0) {
    console.log(c.yellow('No Edge Functions found for this target.'));
    return;
  }
  const rows = [['NAME', 'CREATED', 'UPDATED', 'ACTIVE_PACKAGE']];
  for (const it of items) {
    rows.push([
      it.edgeFunctionName || '-',
      fmtDate(it.createdAt),
      fmtDate(it.updatedAt),
      String(it.activePackageId == null ? '-' : it.activePackageId),
    ]);
  }
  const host = client.baseUrl.replace(CDN_PATH, '');
  console.log('\n' + c.bold('Edge Functions') + ' @ ' + c.cyan(host) + '\n');
  console.log(fmt.table(rows));
  console.log(c.dim('\n' + items.length + ' Edge Function(s) found.'));
}

async function doPurge() {
  const service = flags.service || flags.serviceId || positional[1];
  if (!service) cli.die('--service <name> is required for purge', { prefix: 'aem-ef' });

  // Collect surrogate keys: --surrogate-key may be repeated (array) or single.
  let keys = flags['surrogate-key'] || flags.surrogateKey || flags.key;
  if (keys === undefined) keys = [];
  else if (!Array.isArray(keys)) keys = [keys];
  const all = !!flags.all;

  // Exactly one purge mode is required.
  if (all && keys.length > 0) {
    cli.die('use only one of --all or --surrogate-key', { prefix: 'aem-ef' });
  }
  if (!all && keys.length === 0) {
    cli.die('specify a purge mode: --all  OR  --surrogate-key <key> (repeatable)', { prefix: 'aem-ef' });
  }

  const body = {};
  if (flags.soft) body.soft = true;
  if (all) body.all = true;
  else if (keys.length === 1) body.surrogateKey = keys[0];
  else body.surrogateKeys = keys;

  let description;
  if (all) description = 'all cached content';
  else if (keys.length === 1) description = 'surrogate key ' + keys[0];
  else description = 'surrogate keys ' + keys.join(', ');

  const token = await resolveToken();
  const client = makeClient(token);
  const res = await client.post('/edgeFunctions/' + encodeURIComponent(service) + '/purge', body);
  if (!res.ok) cli.die('purge failed (HTTP ' + res.status + '): ' + res.body, { prefix: 'aem-ef' });
  console.log(c.green('OK'), 'purged ' + description + (flags.soft ? ' (soft)' : '') + ' for ' + c.bold(service));
  if (flags.json && res.body) {
    try { cli.out(JSON.parse(res.body)); } catch (e) { console.log(res.body); }
  }
}

async function doToken() {
  const token = await resolveToken();
  if (flags.json) return cli.out({ access_token: token });
  process.stdout.write(token + '\n');
}

if (cmd === 'list') {
  await doList();
} else if (cmd === 'purge') {
  await doPurge();
} else if (cmd === 'token') {
  await doToken();
} else {
  cli.die('unknown command: ' + cmd + ' (try: list, purge, token)', { prefix: 'aem-ef' });
}
