// Behaviour tests for scripts/eslint.jsh, run against the .jsh runtime stub in
// jsh-runtime.js:
//
//   node --test skills/eslint/tests/eslint.test.js
//
// The linting itself belongs to real ESLint and is not faked here: the helper is
// stubbed, so what these tests prove is everything the wrapper owns — argument
// handling, config discovery, target expansion, ignore semantics, reporting,
// fix write-back, exit codes, and the shape of the helper request.
//
// Two groups go further and execute the GENERATED helper against a stub Linter
// and the real minimatch, because its ignore-ordering and wrapper-filtering
// logic is where the subtle bugs were.

const { test } = require('node:test');
const assert = require('node:assert');
const { runEslint, compileHelper, runGeneratedHelper } = require('./jsh-runtime.js');

const FLAT_CONFIG = 'export default [{ files: ["**/*.js"], rules: { semi: "error" } }];\n';
const BASE_FILES = {
  '/workspace/proj/eslint.config.js': FLAT_CONFIG,
  '/workspace/proj/a.js': 'var a = 1\n',
};

/** A helper reply carrying the given messages for the first requested file. */
function withMessages(messages, output = null) {
  return (request) => ({
    stdout: JSON.stringify(
      request.files.map((f, i) => ({
        path: f.path,
        messages: i === 0 ? messages : [],
        output: i === 0 ? output : null,
        wrapUnfixable: false,
      }))
    ),
  });
}

/* -------------------------------- usage ---------------------------------- */

test('--help prints usage and the install line, and exits 0', async () => {
  const r = await runEslint({ argv: ['--help'] });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /ipk add -g eslint @eslint\/js esbuild-wasm/);
  assert.deepEqual(r.argvCalls, [], 'help must not invoke the helper');
});

test('an unknown option exits 2 and names it', async () => {
  const r = await runEslint({ argv: ['--nope', 'a.js'], files: BASE_FILES });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /unknown option: --nope/);
});

test('--version answers before target or config resolution', async () => {
  // It must work in a tree with no config and no targets, which is why the
  // version branch sits ahead of both.
  const r = await runEslint({
    argv: ['--version'],
    files: {},
    helper: () => ({ stdout: JSON.stringify({ version: '10.10.0' }) }),
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), '10.10.0');
  assert.equal(r.lastRequest().op, 'version');
});

test('--fix and --fix-dry-run are mutually exclusive', async () => {
  const r = await runEslint({ argv: ['--fix', '--fix-dry-run', 'a.js'], files: BASE_FILES });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /cannot be used together/);
});

/* ---------------------------- config discovery ---------------------------- */

test('discovery walks toward / and embeds the config as a require literal', async () => {
  const r = await runEslint({
    argv: ['src/deep/x.js'],
    files: {
      '/workspace/proj/eslint.config.js': FLAT_CONFIG,
      '/workspace/proj/src/deep/x.js': 'var x = 1\n',
    },
  });
  assert.equal(r.exitCode, 0);
  assert.match(r.helperSources[0], /require\("\/workspace\/proj\/eslint\.config\.js"\)/);
});

test('a directory target starts discovery AT the directory', async () => {
  // `eslint .` must find the project's own config, not walk past it.
  const r = await runEslint({
    argv: ['.'],
    files: {
      '/workspace/proj/eslint.config.js': FLAT_CONFIG,
      '/workspace/proj/a.js': 'var a = 1\n',
    },
  });
  assert.equal(r.exitCode, 0);
  assert.match(r.helperSources[0], /require\("\/workspace\/proj\/eslint\.config\.js"\)/);
});

test('a TypeScript config is rejected with a precise message', async () => {
  const r = await runEslint({
    argv: ['a.js'],
    files: {
      '/workspace/proj/eslint.config.ts': 'export default [];\n',
      '/workspace/proj/a.js': 'var a = 1\n',
    },
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /TypeScript/);
});

test('no config and no --rule exits 2 naming the search start', async () => {
  const r = await runEslint({ argv: ['a.js'], files: { '/workspace/proj/a.js': 'var a = 1\n' } });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /no flat config found from \/workspace\/proj/);
});

test('--no-config-lookup with --rule derives concrete file patterns', async () => {
  // ESLint treats a bare `**/*` as universal and would opt no file in, so the
  // patterns must come from the extension list.
  const r = await runEslint({
    argv: ['--no-config-lookup', '--rule', '{"eqeqeq":"error"}', 'a.js'],
    files: { '/workspace/proj/a.js': 'var a = 1\n' },
  });
  assert.equal(r.exitCode, 0);
  const req = r.lastRequest();
  assert.deepEqual(req.rules, { eqeqeq: 'error' });
  assert.ok(req.filePatterns.includes('**/*.js'), 'expected concrete patterns');
  assert.ok(!req.filePatterns.includes('**/*'), 'a universal pattern opts nothing in');
});

/* ---------------------------- target expansion ---------------------------- */

test('a directory is walked, skipping node_modules and .git', async () => {
  const r = await runEslint({
    argv: ['.'],
    files: {
      '/workspace/proj/eslint.config.js': FLAT_CONFIG,
      '/workspace/proj/a.js': 'var a = 1\n',
      '/workspace/proj/src/b.js': 'var b = 1\n',
      '/workspace/proj/node_modules/dep/index.js': 'var c = 1\n',
      '/workspace/proj/.git/hooks/x.js': 'var d = 1\n',
    },
  });
  const paths = r.lastRequest().files.map((f) => f.path);
  assert.ok(paths.includes('/workspace/proj/a.js'));
  assert.ok(paths.includes('/workspace/proj/src/b.js'));
  assert.ok(!paths.some((p) => p.includes('node_modules')));
  assert.ok(!paths.some((p) => p.includes('/.git/')));
});

test('an unreadable directory fails loudly instead of looking clean', async () => {
  // Swallowing the read error yields "no lintable files" and exit 0, which is
  // indistinguishable from a tree with nothing wrong in it.
  const r = await runEslint({
    argv: ['.'],
    files: BASE_FILES,
    breakReadDir: 'EIO: device is on fire',
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /could not read the target tree/);
  assert.match(r.stderr, /device is on fire/);
  assert.ok(!/no lintable files/.test(r.stderr));
});

test('--ext narrows which extensions are walked', async () => {
  const r = await runEslint({
    argv: ['--ext', '.mjs', '.'],
    files: {
      '/workspace/proj/eslint.config.js': FLAT_CONFIG,
      '/workspace/proj/a.js': 'var a = 1\n',
      '/workspace/proj/b.mjs': 'var b = 1\n',
    },
  });
  const paths = r.lastRequest().files.map((f) => f.path);
  assert.deepEqual(paths, ['/workspace/proj/b.mjs']);
});

test('a missing target is reported and exits 2', async () => {
  const r = await runEslint({ argv: ['nope.js'], files: BASE_FILES });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /nope\.js: no such file or directory/);
});

test('a named file is marked explicit; a walked one is not', async () => {
  const named = await runEslint({ argv: ['a.js'], files: BASE_FILES });
  assert.equal(named.lastRequest().files[0].explicit, true);
  const walked = await runEslint({ argv: ['.'], files: BASE_FILES });
  const entry = walked.lastRequest().files.find((f) => f.path.endsWith('/a.js'));
  assert.equal(entry.explicit, false);
});

/* ------------------------------- reporting -------------------------------- */

const ONE_ERROR = [
  { ruleId: 'semi', severity: 2, message: 'Missing semicolon', line: 1, column: 10 },
];

test('stylish reports the finding and exits 1', async () => {
  const r = await runEslint({ argv: ['a.js'], files: BASE_FILES, helper: withMessages(ONE_ERROR) });
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /\/workspace\/proj\/a\.js/);
  assert.match(r.stdout, /1:10\s+error\s+Missing semicolon\s+semi/);
  assert.match(r.stdout, /1 problem \(1 error, 0 warnings\)/);
});

test('--json writes one document and nothing to stderr', async () => {
  const r = await runEslint({
    argv: ['--json', 'a.js'],
    files: BASE_FILES,
    helper: withMessages(ONE_ERROR),
  });
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.summary, { errors: 1, warnings: 0, filesLinted: 1, fixedFiles: 0 });
  assert.equal(doc.results[0].filePath, '/workspace/proj/a.js');
  assert.equal(doc.results[0].errorCount, 1);
  assert.equal(doc.results[0].messages[0].ruleId, 'semi');
  assert.equal(r.stderr, '');
});

test('--format json is the same reporter as --json', async () => {
  const a = await runEslint({
    argv: ['--json', 'a.js'],
    files: BASE_FILES,
    helper: withMessages(ONE_ERROR),
  });
  const b = await runEslint({
    argv: ['--format', 'json', 'a.js'],
    files: BASE_FILES,
    helper: withMessages(ONE_ERROR),
  });
  assert.equal(a.stdout, b.stdout);
});

test('compact prints one line per finding', async () => {
  const r = await runEslint({
    argv: ['--format', 'compact', 'a.js'],
    files: BASE_FILES,
    helper: withMessages(ONE_ERROR),
  });
  assert.equal(
    r.stdout.trim(),
    '/workspace/proj/a.js: line 1, col 10, error - Missing semicolon (semi)'
  );
});

test('an unknown formatter exits 2', async () => {
  const r = await runEslint({ argv: ['--format', 'nope', 'a.js'], files: BASE_FILES });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /unknown formatter: nope/);
});

test('a clean run prints nothing and exits 0', async () => {
  const r = await runEslint({ argv: ['a.js'], files: BASE_FILES });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
});

test('--quiet drops warnings but keeps a fatal parse error', async () => {
  const r = await runEslint({
    argv: ['--quiet', 'a.js'],
    files: BASE_FILES,
    helper: withMessages([
      { ruleId: 'no-unused-vars', severity: 1, message: 'unused', line: 1, column: 1 },
      { ruleId: null, severity: 2, message: 'Parsing error: boom', line: 1, column: 1 },
    ]),
  });
  assert.ok(!r.stdout.includes('unused'), 'warning should be dropped');
  assert.match(r.stdout, /Parsing error: boom/);
  assert.equal(r.exitCode, 1);
});

test('--max-warnings turns warnings into a failure', async () => {
  const warning = [{ ruleId: 'x', severity: 1, message: 'w', line: 1, column: 1 }];
  const under = await runEslint({
    argv: ['--max-warnings', '1', 'a.js'],
    files: BASE_FILES,
    helper: withMessages(warning),
  });
  assert.equal(under.exitCode, 0);
  const over = await runEslint({
    argv: ['--max-warnings', '0', 'a.js'],
    files: BASE_FILES,
    helper: withMessages(warning),
  });
  assert.equal(over.exitCode, 1);
  assert.match(over.stderr, /exceeded the --max-warnings limit of 0/);
});

/* --------------------------------- fixes ---------------------------------- */

test('--fix writes the fixed output back through the shell fs', async () => {
  const r = await runEslint({
    argv: ['--fix', 'a.js'],
    files: BASE_FILES,
    helper: withMessages([], 'var a = 1;\n'),
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.read('/workspace/proj/a.js'), 'var a = 1;\n');
});

test('--fix-dry-run reports the rewrite and writes nothing', async () => {
  const r = await runEslint({
    argv: ['--fix-dry-run', 'a.js'],
    files: BASE_FILES,
    helper: withMessages([], 'var a = 1;\n'),
  });
  assert.equal(r.read('/workspace/proj/a.js'), 'var a = 1\n');
  assert.match(r.stderr, /--fix would rewrite/);
});

test('a fix that rewrote the .jsh wrapper leaves the file alone', async () => {
  const r = await runEslint({
    argv: ['--fix', 's.jsh'],
    files: {
      '/workspace/proj/eslint.config.js': FLAT_CONFIG,
      '/workspace/proj/s.jsh': 'return 1\n',
    },
    helper: (request) => ({
      stdout: JSON.stringify(
        request.files.map((f) => ({
          path: f.path,
          messages: [],
          output: null,
          wrapUnfixable: true,
        }))
      ),
    }),
  });
  assert.match(r.stderr, /rewrote the script wrapper/);
  assert.equal(r.read('/workspace/proj/s.jsh'), 'return 1\n');
});

test('a discarded wrapper fix still reports the real violations', async () => {
  // `verifyAndFix` returns only what is LEFT after fixing. When the fix is
  // thrown away because it rewrote the wrapper, those leftovers describe a file
  // that will never exist — `semi` can fix the body and the generated `})` in
  // one pass and report nothing, so the run would exit 0 over an unfixed file.
  let firstCall = true;
  const helperSrc = (await runEslint({ argv: ['a.js'], files: BASE_FILES })).helperSources[0];
  const results = await runGeneratedHelper(
    helperSrc,
    {
      op: 'lint',
      fix: true,
      basePath: '/workspace/proj',
      files: [{ path: '/workspace/proj/s.jsh', source: 'var a = 1\n', explicit: true }],
    },
    // verifyAndFix's residue is empty; a plain verify still sees the violation.
    () => {
      if (firstCall) {
        firstCall = false;
        return [];
      }
      return [{ ruleId: 'semi', severity: 2, message: 'Missing semicolon', line: 2, endLine: 2 }];
    },
    undefined,
    { fixesWrapper: true }
  );
  assert.equal(results[0].wrapUnfixable, true);
  assert.equal(results[0].output, null, 'the file must be left alone');
  assert.equal(results[0].messages.length, 1, 'the violation must survive the discard');
  assert.equal(results[0].messages[0].ruleId, 'semi');
});

test('a global-ignores block that carries a name is still honored', async () => {
  // ESLint's own globalIgnores(patterns, name) helper returns { name, ignores },
  // and requiring `ignores` to be the only key walks those trees anyway.
  const results = await runGeneratedHelper(
    (await runEslint({ argv: ['a.js'], files: BASE_FILES })).helperSources[0],
    {
      op: 'lint',
      basePath: '/workspace/proj',
      files: [{ path: '/workspace/proj/dist/bundle.js', source: 'var a = 1\n', explicit: false }],
    },
    () => [],
    [
      { name: 'my/global-ignores', ignores: ['dist/**'] },
      { files: ['**/*.js'], rules: {} },
    ]
  );
  assert.deepEqual(results, [], 'a named ignores-only block is a global ignore');
});

/* ---------------------------- helper failures ----------------------------- */

test('a missing module is rewritten into the ipk install line', async () => {
  const r = await runEslint({
    argv: ['a.js'],
    files: BASE_FILES,
    helper: () => ({
      stderr: "Error: Cannot find module 'eslint/universal' (run: ipk install eslint)\n",
      exitCode: 1,
    }),
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /eslint is not installed/);
  assert.match(r.stderr, /ipk add -g eslint @eslint\/js esbuild-wasm/);
});

test('a missing scoped module is named', async () => {
  const r = await runEslint({
    argv: ['a.js'],
    files: BASE_FILES,
    helper: () => ({
      stderr: "Error: Cannot find module '@eslint/js' (run: ipk install @eslint/js)\n",
      exitCode: 1,
    }),
  });
  assert.match(r.stderr, /@eslint\/js is not installed/);
});

test('unparseable helper output surfaces with the helper stderr attached', async () => {
  const r = await runEslint({
    argv: ['a.js'],
    files: BASE_FILES,
    helper: () => ({ stdout: 'not json', stderr: 'something went sideways' }),
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /could not parse helper output/);
  assert.match(r.stderr, /something went sideways/);
});

test('the generated helper is removed from the VFS afterwards', async () => {
  const r = await runEslint({ argv: ['a.js'], files: BASE_FILES });
  const helperPath = r.argvCalls[0][1];
  assert.match(helperPath, /^\/tmp\/\.eslint-helper-/);
  assert.match(r.helperSources[0], /require\('eslint\/universal'\)/);
  assert.equal(r.read(helperPath), undefined, 'helper must not outlive the run');
});

/* ------------------- the request never reaches a shell -------------------- */

test('the helper request is passed as argv, not interpolated into a command', async () => {
  const r = await runEslint({ argv: ['a.js'], files: BASE_FILES });
  assert.equal(r.argvCalls.length, 1);
  assert.deepEqual(r.stringCalls, [], 'no command string may be built');
  const [bin, , payload] = r.argvCalls[0];
  assert.equal(bin, 'node');
  assert.equal(JSON.parse(payload).op, 'lint');
});

test('a command-substitution payload travels through untouched', async () => {
  // Linting a repo the agent did not write means both the file paths and the
  // bytes are attacker-influenced. `$` and backticks survive JSON.stringify and
  // the shell expands them inside double quotes, so argv is the only safe
  // carrier.
  const nasty = 'const x = `$(touch /workspace/pwned)`;\n';
  const r = await runEslint({
    argv: ['--stdin', '--stdin-filename', 'src/$(id).js'],
    files: BASE_FILES,
    stdin: nasty,
  });
  const request = JSON.parse(r.argvCalls[0][2]);
  assert.equal(request.files[0].source, nasty);
  assert.equal(request.files[0].path, '/workspace/proj/src/$(id).js');
  assert.equal(r.read('/workspace/pwned'), undefined);
  assert.deepEqual(r.stringCalls, []);
});

test('the generated helper parses as JavaScript', async () => {
  // It is built from a template literal, so an unescaped backtick or a real
  // newline where `\\n` was meant yields a broken script whose only symptom is
  // an opaque helper failure at runtime.
  const r = await runEslint({ argv: ['a.js'], files: BASE_FILES });
  assert.doesNotThrow(() => compileHelper(r.helperSources[0]));
});

/* ------------------------- stdin is never written ------------------------- */

test('--fix with --stdin is refused rather than writing the virtual filename', async () => {
  // `--stdin-filename` selects a config; it is not a target. Writing to it would
  // replace a real file with the piped buffer.
  const r = await runEslint({
    argv: ['--stdin', '--stdin-filename', 'src/app.js', '--fix'],
    files: { ...BASE_FILES, '/workspace/proj/src/app.js': 'const real = 1;\n' },
    stdin: 'var piped = 1\n',
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /not available for piped-in code/);
  assert.equal(r.read('/workspace/proj/src/app.js'), 'const real = 1;\n');
  assert.deepEqual(r.argvCalls, [], 'it never reached the helper');
});

test('--fix-dry-run with --stdin prints the fixed buffer and writes nothing', async () => {
  const r = await runEslint({
    argv: ['--stdin', '--stdin-filename', 'src/app.js', '--fix-dry-run'],
    files: { ...BASE_FILES, '/workspace/proj/src/app.js': 'const real = 1;\n' },
    stdin: 'var piped = 1\n',
    helper: withMessages([], 'var piped = 1;\n'),
  });
  assert.match(r.stdout, /var piped = 1;/);
  assert.equal(r.read('/workspace/proj/src/app.js'), 'const real = 1;\n');
});

test('--stdin --fix-dry-run --json still emits exactly one JSON document', async () => {
  // Printing the fixed buffer after the document leaves stdout unparseable,
  // which breaks every machine consumer of a documented flag combination.
  const r = await runEslint({
    argv: ['--stdin', '--stdin-filename', 'src/app.js', '--fix-dry-run', '--json'],
    files: BASE_FILES,
    stdin: 'var piped = 1\n',
    helper: withMessages([], 'var piped = 1;\n'),
  });
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.results[0].output, 'var piped = 1;\n', 'the fix belongs in the document');
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'one line, one document');
});

test('a bare --stdin creates no stdin.js placeholder', async () => {
  const r = await runEslint({ argv: ['--stdin'], files: BASE_FILES, stdin: 'var piped = 1\n' });
  assert.equal(r.read('/workspace/proj/stdin.js'), undefined);
});

test('--stdin cannot be combined with file arguments', async () => {
  const r = await runEslint({ argv: ['--stdin', 'a.js'], files: BASE_FILES, stdin: 'x' });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /cannot be combined with file arguments/);
});

/* ------------------ the helper's own global-ignore logic ------------------ */

async function generatedHelper() {
  const r = await runEslint({ argv: ['a.js'], files: BASE_FILES });
  return r.helperSources[0];
}

const noFindings = () => [];

test('a later negated ignore pattern re-includes the path', async () => {
  // ESLint evaluates ignores in order, so `!src/**/*.js` after `**/*.js` means
  // src IS linted. A short-circuiting matcher skipped it — and a skipped file
  // makes lint pass, so the gap is invisible.
  const results = await runGeneratedHelper(
    await generatedHelper(),
    {
      op: 'lint',
      basePath: '/workspace/proj',
      files: [
        { path: '/workspace/proj/src/app.js', source: 'var a = 1\n', explicit: false },
        { path: '/workspace/proj/lib/other.js', source: 'var b = 1\n', explicit: false },
      ],
    },
    noFindings,
    [{ ignores: ['**/*.js', '!src/**/*.js'] }, { files: ['**/*.js'], rules: {} }]
  );
  assert.deepEqual(
    results.map((r) => r.path),
    ['/workspace/proj/src/app.js']
  );
});

test('a pattern after the negation re-ignores the path', async () => {
  const results = await runGeneratedHelper(
    await generatedHelper(),
    {
      op: 'lint',
      basePath: '/workspace/proj',
      files: [{ path: '/workspace/proj/src/app.js', source: 'var a = 1\n', explicit: false }],
    },
    noFindings,
    [{ ignores: ['**/*.js', '!src/**/*.js', 'src/app.js'] }, { files: ['**/*.js'], rules: {} }]
  );
  assert.deepEqual(results, [], 'precedence is order, not "negations win"');
});

test('an explicitly named ignored file is reported, not silently skipped', async () => {
  const results = await runGeneratedHelper(
    await generatedHelper(),
    {
      op: 'lint',
      basePath: '/workspace/proj',
      files: [{ path: '/workspace/proj/skipme.js', source: 'var a = 1\n', explicit: true }],
    },
    noFindings,
    [{ ignores: ['skipme.js'] }, { files: ['**/*.js'], rules: {} }]
  );
  assert.equal(results.length, 1);
  assert.match(results[0].messages[0].message, /ignored because of a matching ignore pattern/);
});

/* ---------------- the helper's own wrapper-message filtering -------------- */

const jshRequest = (source) => ({
  op: 'lint',
  basePath: '/workspace/proj',
  files: [{ path: '/workspace/proj/s.jsh', source, explicit: true }],
});

test('a finding entirely inside the injected prefix is dropped', async () => {
  // This is what `no-unused-vars` did to a NAMED wrapper: a report on line 1 of
  // a file whose line 1 is the user's first real statement.
  const results = await runGeneratedHelper(
    await generatedHelper(),
    jshRequest('const x = 1\n'),
    () => [
      {
        ruleId: 'no-unused-vars',
        severity: 2,
        message: "'__slicc' is defined",
        line: 1,
        endLine: 1,
      },
    ]
  );
  assert.deepEqual(results[0].messages, []);
});

test('a finding that starts in the wrapper but spans the body is kept', async () => {
  const results = await runGeneratedHelper(
    await generatedHelper(),
    jshRequest('const x = 1\nconst y = 2\n'),
    () => [{ ruleId: 'indent', severity: 2, message: 'Expected indentation', line: 1, endLine: 3 }]
  );
  assert.equal(results[0].messages.length, 1);
  assert.equal(results[0].messages[0].ruleId, 'indent');
});

test('a finding on the injected suffix line is dropped', async () => {
  // Wrapped: 1 is the prefix, 2-3 the statements, 4 the empty line left by the
  // trailing newline, 5 the closing `})`.
  const results = await runGeneratedHelper(
    await generatedHelper(),
    jshRequest('const x = 1\nconst y = 2\n'),
    () => [{ ruleId: 'eol-last', severity: 1, message: 'Newline required', line: 5, endLine: 5 }]
  );
  assert.deepEqual(results[0].messages, []);
});

test('a fatal parse error is never dropped, even on a wrapper line', async () => {
  const results = await runGeneratedHelper(
    await generatedHelper(),
    jshRequest('const x = (\n'),
    () => [
      {
        ruleId: null,
        severity: 2,
        message: 'Parsing error: Unexpected token',
        line: 1,
        fatal: true,
      },
    ]
  );
  assert.equal(results[0].messages.length, 1);
  assert.equal(results[0].messages[0].fatal, true);
});

test('an ordinary body finding shifts back by the prefix line, column intact', async () => {
  const results = await runGeneratedHelper(
    await generatedHelper(),
    jshRequest('var a = 1\n'),
    () => [
      {
        ruleId: 'semi',
        severity: 2,
        message: 'Missing semicolon',
        line: 2,
        column: 10,
        endLine: 2,
      },
    ]
  );
  assert.equal(results[0].messages[0].line, 1);
  assert.equal(results[0].messages[0].column, 10);
});
