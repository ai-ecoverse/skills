import test, { fail, is, ok } from 'tst';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as _prWatchFilterMod from '../scripts/pr-watch-filter.js';
import * as _assignFieldMod from '../scripts/assign-field.js';
import * as _prEditMod from '../scripts/pr-edit.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const target = path.resolve(__dirname, '../scripts/gh.jsh');
const source = fs.readFileSync(target, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = exitCode;
  }
}

// Minimal MCP server stub: collects fetch calls and returns canned responses.
function mcpFetchStub(scenario = {}) {
  const calls = [];
  return {
    calls,
    fn: async (url, opts) => {
      const call = { url: String(url), opts };
      calls.push(call);

      // Server card endpoint (no auth required)
      if (String(url).includes('server-card')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Map([['content-type', 'application/json']]),
          json: async () => scenario.card || {
            name: 'test-server',
            title: 'Test MCP Server',
            description: 'A test server',
            version: '1.0.0',
            remotes: [{ type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' }],
          },
          text: async () => JSON.stringify(scenario.card || { name: 'test-server' }),
        };
      }

      // Domain guard simulation
      if (scenario.domainGuard) {
        throw new Error('Secret oauth.github.token is not allowed for domain api.githubcopilot.com');
      }

      // Auth failure simulation
      if (scenario.authFail) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          headers: new Map([['content-type', 'text/plain']]),
          text: async () => 'bad request: missing required Authorization header',
          json: async () => ({ error: 'unauthorized' }),
        };
      }

      // Parse the request body to determine which JSON-RPC method was called
      let body = {};
      if (opts?.body) {
        try { body = JSON.parse(opts.body); } catch { /* ignore */ }
      }

      const responseHeaders = new Map([
        ['content-type', 'application/json'],
        ['mcp-session-id', 'test-session-123'],
      ]);

      // initialize response
      if (body.method === 'initialize') {
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: responseHeaders,
          json: async () => ({
            jsonrpc: '2.0', id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'github-mcp-server', version: '1.0.0' },
              capabilities: { tools: {} },
            },
          }),
          text: async () => '',
        };
      }

      // notifications/initialized (no response body expected)
      if (body.method === 'notifications/initialized') {
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: responseHeaders,
          json: async () => ({}),
          text: async () => '',
        };
      }

      // tools/list response
      if (body.method === 'tools/list') {
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: responseHeaders,
          json: async () => ({
            jsonrpc: '2.0', id: body.id,
            result: {
              tools: scenario.tools || [
                { name: 'get_me', description: 'Get the authenticated user', inputSchema: { type: 'object', properties: {} } },
                { name: 'get_file_contents', description: 'Get file contents from a repo', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' } } } },
              ],
            },
          }),
          text: async () => '',
        };
      }

      // tools/call response
      if (body.method === 'tools/call') {
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: responseHeaders,
          json: async () => ({
            jsonrpc: '2.0', id: body.id,
            result: {
              content: scenario.callResult || [{ type: 'text', text: '{"login":"testuser","id":12345}' }],
            },
          }),
          text: async () => '',
        };
      }

      // Default response
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: responseHeaders,
        json: async () => ({ jsonrpc: '2.0', id: body.id, result: {} }),
        text: async () => '',
      };
    },
  };
}

async function runGh(args, scenario = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const fetchStub = mcpFetchStub(scenario);

  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      if (requestPath === '/user') return { login: 'viewer' };
      return {};
    },
    patch: async () => fail('unexpected PATCH'),
    post: async () => fail('unexpected POST'),
    delete: async () => fail('unexpected DELETE'),
    put: async () => fail('unexpected PUT'),
  };

  const cli = {
    die: (message, options) => {
      throw new NodeExitError(String(message), options?.exitCode ?? 1);
    },
    help: (message) => {
      stdout.push(String(message));
      throw new NodeExitError('help', 0);
    },
    out: (value) => stdout.push(typeof value === 'string' ? value : JSON.stringify(value)),
    warn: (message) => stderr.push(String(message)),
  };

  const color = new Proxy({}, { get: () => (value) => String(value) });
  const fmt = new Proxy(
    { date: (value) => String(value), col: (s, w) => String(s).padEnd(w) },
    { get: (object, key) => object[key] || ((value) => String(value)) }
  );
  const exec = async (cmd) => {
    // Simulate git config gh-mcp-token lookup
    if (typeof cmd === 'string' && cmd.includes('gh-mcp-token')) {
      return { stdout: scenario.gitMcpToken || '', stderr: '', exitCode: scenario.gitMcpToken ? 0 : 1 };
    }
    return { stdout: '', stderr: '', exitCode: 1 };
  };
  exec.spawn = exec;
  exec.start = exec;

  const mockFs = {
    readFile: async () => '',
    writeFile: async () => {},
    readFileBinary: async (filePath) => {
      if (scenario.inputFileContent) return new TextEncoder().encode(scenario.inputFileContent);
      throw new Error('file not found: ' + filePath);
    },
  };

  const mocks = {
    'sliccy:skill': {
      token: async (provider) => {
        if (scenario.tokenError) throw scenario.tokenError;
        if (Object.hasOwn(scenario, 'token')) return scenario.token;
        return 'fake-github-token';
      },
      config: async () => null,
    },
    'sliccy:cli': cli,
    'sliccy:fmt': fmt,
    'sliccy:color': color,
    'sliccy:http': { client: () => api },
    'sliccy:exec': exec,
    'sliccy:time': {},
    fs: mockFs,
  };

  // Relative script siblings are pre-loaded via static ESM imports (tst's
  // createRequire shim resolves node: builtins but not relative VFS paths).
  const relativeModules = {
    './pr-watch-filter.js': () => (_prWatchFilterMod.default || _prWatchFilterMod),
    './assign-field.js': () => (_assignFieldMod.default || _assignFieldMod),
    './pr-edit.js': () => (_prEditMod.default || _prEditMod),
  };
  const realRequire = createRequire(target);
  const mockRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (Object.hasOwn(relativeModules, id)) return relativeModules[id]();
    return realRequire(id);
  };
  const mockProcess = {
    argv: ['node', target, ...args],
    env: scenario.env || {},
    stdin: { read: async () => scenario.stdinContent || '' },
    exit: (code) => { throw new NodeExitError('exit', code); },
  };
  const mockConsole = {
    log: (message) => stdout.push(String(message)),
    info: (message) => stdout.push(String(message)),
    warn: (message) => stderr.push(String(message)),
    error: (message) => stderr.push(String(message)),
  };

  try {
    await new AsyncFunction('require', 'process', 'console', 'fetch', source)(
      mockRequire, mockProcess, mockConsole, fetchStub.fn,
    );
    return { calls, stdout, stderr, fetchCalls: fetchStub.calls };
  } catch (error) {
    return { error, calls, stdout, stderr, fetchCalls: fetchStub.calls };
  }
}

// ─── Help tests ────────────────────────────────────────────────────────────

test('gh mcp --help prints usage without a token', async () => {
  const result = await runGh(['mcp', '--help'], { tokenError: new Error('no token') });
  is(result.error?.exitCode, 0);
  const output = result.stdout.join('\n');
  ok((/SUBCOMMANDS/).test(output));
  ok((/tools/).test(output));
  ok((/call/).test(output));
  ok((/server-card/).test(output));
  ok((/raw/).test(output));
});

test('gh mcp tools --help prints tool-specific usage', async () => {
  const result = await runGh(['mcp', 'tools', '--help'], { tokenError: new Error('no token') });
  is(result.error?.exitCode, 0);
  const output = result.stdout.join('\n');
  ok((/--json/).test(output));
  ok((/--jq/).test(output));
});

test('gh mcp call --help prints call-specific usage', async () => {
  const result = await runGh(['mcp', 'call', '--help'], { tokenError: new Error('no token') });
  is(result.error?.exitCode, 0);
  const output = result.stdout.join('\n');
  ok((/-F.*--field/).test(output));
  ok((/-f.*--raw-field/).test(output));
});

test('gh mcp raw --help prints raw-specific usage', async () => {
  const result = await runGh(['mcp', 'raw', '--help'], { tokenError: new Error('no token') });
  is(result.error?.exitCode, 0);
  const output = result.stdout.join('\n');
  ok((/--params/).test(output));
  ok((/--init/).test(output));
});

// ─── Server card tests ────────────────────────────────────────────────────

test('gh mcp server-card fetches and displays the card', async () => {
  const result = await runGh(['mcp', 'server-card'], { tokenError: new Error('no token') });
  is(result.error?.exitCode, 0);
  const output = result.stdout.join('\n');
  ok((/Test MCP Server/).test(output));
  // Should have called the server-card endpoint
  ok(result.fetchCalls.some(c => c.url.includes('server-card')));
});

test('gh mcp server-card --json returns raw JSON', async () => {
  const card = { name: 'test', title: 'Test', version: '1.0.0' };
  const result = await runGh(['mcp', 'server-card', '--json'], { tokenError: new Error('no token'), card });
  is(result.error?.exitCode, 0);
  const output = result.stdout.join('');
  const parsed = JSON.parse(output);
  is(parsed.name, 'test');
});

// ─── Tools list tests ─────────────────────────────────────────────────────

test('gh mcp tools lists available tools', async () => {
  const result = await runGh(['mcp', 'tools'], { env: { GITHUB_MCP_TOKEN: 'test-token' } });
  is(result.error?.exitCode, 0);
  const output = result.stdout.join('\n');
  ok((/get_me/).test(output));
  ok((/get_file_contents/).test(output));
  ok((/2 tools/).test(output));
});

test('gh mcp tools --json returns raw JSON', async () => {
  const result = await runGh(['mcp', 'tools', '--json'], { env: { GITHUB_MCP_TOKEN: 'test-token' } });
  is(result.error?.exitCode, 0);
  const parsed = JSON.parse(result.stdout.join(''));
  ok(Array.isArray(parsed));
  is(parsed.length, 2);
  is(parsed[0].name, 'get_me');
});

// ─── Tool call tests ──────────────────────────────────────────────────────

test('gh mcp call invokes a tool with -F fields', async () => {
  const result = await runGh(
    ['mcp', 'call', 'get_file_contents', '-F', 'owner=octocat', '-F', 'repo=hello', '-F', 'path=README.md'],
    { env: { GITHUB_MCP_TOKEN: 'test-token' } },
  );
  is(result.error?.exitCode, 0);
  // Should have made fetch calls: initialize, initialized notification, tools/call
  const mcpCalls = result.fetchCalls.filter(c => c.url.includes('/mcp/') && !c.url.includes('server-card'));
  ok(mcpCalls.length >= 2, `expected at least 2 MCP calls, got ${mcpCalls.length}`);

  // Verify the tool call had the right arguments
  const toolCallFetch = mcpCalls.find(c => {
    if (!c.opts?.body) return false;
    try {
      const body = JSON.parse(c.opts.body);
      return body.method === 'tools/call';
    } catch { return false; }
  });
  ok(toolCallFetch, 'expected a tools/call fetch');
  const toolBody = JSON.parse(toolCallFetch.opts.body);
  is(toolBody.params.name, 'get_file_contents');
  is(toolBody.params.arguments, { owner: 'octocat', repo: 'hello', path: 'README.md' });
});

test('gh mcp call with -f sends raw string fields', async () => {
  const result = await runGh(
    ['mcp', 'call', 'get_me', '-f', 'detail=true'],
    { env: { GITHUB_MCP_TOKEN: 'test-token' } },
  );
  is(result.error?.exitCode, 0);
  const toolCallFetch = result.fetchCalls.find(c => {
    if (!c.opts?.body) return false;
    try { return JSON.parse(c.opts.body).method === 'tools/call'; } catch { return false; }
  });
  const toolBody = JSON.parse(toolCallFetch.opts.body);
  // -f sends as string, not boolean
  is(toolBody.params.arguments.detail, 'true');
});

test('gh mcp call with -F type-converts values', async () => {
  const result = await runGh(
    ['mcp', 'call', 'test_tool', '-F', 'count=42', '-F', 'active=true', '-F', 'label=hello'],
    { env: { GITHUB_MCP_TOKEN: 'test-token' } },
  );
  is(result.error?.exitCode, 0);
  const toolCallFetch = result.fetchCalls.find(c => {
    if (!c.opts?.body) return false;
    try { return JSON.parse(c.opts.body).method === 'tools/call'; } catch { return false; }
  });
  const toolBody = JSON.parse(toolCallFetch.opts.body);
  is(toolBody.params.arguments.count, 42);
  is(toolBody.params.arguments.active, true);
  is(toolBody.params.arguments.label, 'hello');
});

test('gh mcp call without tool name dies with usage', async () => {
  const result = await runGh(['mcp', 'call'], { env: { GITHUB_MCP_TOKEN: 'test-token' } });
  is(result.error?.exitCode, 1);
  ok((/usage.*gh mcp call/i).test(result.error.message));
});

// ─── Auth error tests ─────────────────────────────────────────────────────

test('gh mcp tools dies with domain guard error', async () => {
  const result = await runGh(['mcp', 'tools'], { domainGuard: true });
  is(result.error?.exitCode, 1);
  ok((/domain/i).test(result.error.message));
  ok((/GITHUB_MCP_TOKEN/).test(result.error.message));
});

test('gh mcp tools dies on auth failure from server', async () => {
  const result = await runGh(['mcp', 'tools'], { env: { GITHUB_MCP_TOKEN: 'bad-token' }, authFail: true });
  is(result.error?.exitCode, 1);
  ok((/401/).test(result.error.message));
});

// ─── Raw subcommand tests ─────────────────────────────────────────────────

test('gh mcp raw sends arbitrary method', async () => {
  const result = await runGh(
    ['mcp', 'raw', 'tools/list', '--init'],
    { env: { GITHUB_MCP_TOKEN: 'test-token' } },
  );
  is(result.error?.exitCode, 0);
  // Should have at least 3 calls: initialize, initialized, tools/list
  const mcpCalls = result.fetchCalls.filter(c => c.url.includes('/mcp/') && !c.url.includes('server-card'));
  ok(mcpCalls.length >= 3, `expected >= 3 MCP calls with --init, got ${mcpCalls.length}`);
});

test('gh mcp raw without method dies with usage', async () => {
  const result = await runGh(['mcp', 'raw'], { env: { GITHUB_MCP_TOKEN: 'test-token' } });
  is(result.error?.exitCode, 1);
  ok((/usage.*gh mcp raw/i).test(result.error.message));
});

// ─── Unknown subcommand test ──────────────────────────────────────────────

test('gh mcp unknown-sub dies with error', async () => {
  const result = await runGh(['mcp', 'bogus'], { env: { GITHUB_MCP_TOKEN: 'test-token' } });
  is(result.error?.exitCode, 1);
  ok((/unknown mcp subcommand.*bogus/i).test(result.error.message));
});

// ─── Token resolution tests ──────────────────────────────────────────────

test('gh mcp tools uses GITHUB_MCP_TOKEN from env', async () => {
  const result = await runGh(['mcp', 'tools'], { env: { GITHUB_MCP_TOKEN: 'env-token' } });
  is(result.error?.exitCode, 0);
  // Check that the fetch used the env token
  const authCall = result.fetchCalls.find(c =>
    c.opts?.headers?.Authorization === 'Bearer env-token'
  );
  ok(authCall, 'expected fetch with env token in Authorization header');
});

test('gh mcp tools uses git config token when env not set', async () => {
  const result = await runGh(['mcp', 'tools'], { gitMcpToken: 'git-config-token' });
  is(result.error?.exitCode, 0);
  const authCall = result.fetchCalls.find(c =>
    c.opts?.headers?.Authorization === 'Bearer git-config-token'
  );
  ok(authCall, 'expected fetch with git config token in Authorization header');
});

// ─── Session handling test ────────────────────────────────────────────────

test('gh mcp tools sends Mcp-Session-Id on subsequent calls', async () => {
  const result = await runGh(['mcp', 'tools'], { env: { GITHUB_MCP_TOKEN: 'test-token' } });
  is(result.error?.exitCode, 0);
  // After initialize returns a session id, tools/list should include it
  const mcpCalls = result.fetchCalls.filter(c =>
    c.url.includes('/mcp/') && !c.url.includes('server-card')
  );
  // Find a call after initialize that includes the session header
  const sessionCalls = mcpCalls.filter(c =>
    c.opts?.headers?.['Mcp-Session-Id'] === 'test-session-123'
  );
  ok(sessionCalls.length > 0, 'expected at least one call with Mcp-Session-Id header');
});
