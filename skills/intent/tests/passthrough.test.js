// playwright-cli commands through intent, each with its intent stated (2026-10-04).
import test, { is, ok } from 'tst';
import * as intentMod from '../scripts/intent.js';

const lib = intentMod.default || intentMod;

test('passthrough: a playwright-cli command and its intent, files where the caller is', () => {
  const p = lib.passthrough(
    ['screenshot', '--tab=AB12', '--filename=shot.png', '--intent', 'see the result list'],
    '/tmp/run/scoop'
  );
  is(p, {
    sub: 'screenshot',
    args: ['--tab=AB12', '--filename=/tmp/run/scoop/shot.png'],
    intent: 'see the result list',
  });
  is(
    lib.passthrough(['click', 'e5', '--tab=AB12', '--intent=open the first result'], '/x').intent,
    'open the first result'
  );
  // No intent: the command is still recognised, so the caller can be told what is missing.
  is(lib.passthrough(['click', 'e5'], '/x'), { sub: 'click', args: ['e5'], intent: undefined });
  // intent's own words are no playwright-cli command.
  is(lib.passthrough(['--intent', 'click the Search button'], '/x'), null);
  is(lib.passthrough(['serve'], '/x'), null);
  // upload: a ref first is not a file; the files resolve.
  is(lib.passthrough(['upload', 'e7', 'cv.pdf', '--intent', 'attach the CV'], '/tmp/s').args, [
    'e7',
    '/tmp/s/cv.pdf',
  ]);
});

test('checkArgv: commands by name, files only where a scoop may go', () => {
  is(lib.checkArgv(['click', 'e5', '--tab=AB12']), null);
  is(lib.checkArgv(['screenshot', '--tab=AB', '--filename=/tmp/run/scoop/shot.png']), null);
  ok(
    lib.checkArgv(['screenshot', '--filename=/workspace/skills/x.png']),
    'outside the scoop roots'
  );
  ok(lib.checkArgv(['state-save', '/tmp/../workspace/s.json']), 'no .. out of a root');
  ok(lib.checkArgv(['eval-file', '/etc/passwd']), 'reads too');
  ok(lib.checkArgv(['rm', '-rf', '/']), 'not a playwright-cli command');
  ok(lib.checkArgv([]), 'empty');
  ok(lib.checkArgv(['click', 7]), 'strings only');
  const { req, error } = lib.cleanRequest({
    intent: 'see the list',
    argv: ['snapshot', '--tab=AB12'],
  });
  is(error, undefined);
  is(req.argv, ['snapshot', '--tab=AB12']);
  ok(lib.cleanRequest({ intent: 'x', argv: ['screenshot', '--filename=/workspace/x.png'] }).error);
  ok(lib.cleanRequest({ argv: ['snapshot'] }).error, 'the intent is required');
});

test('rawTab: the tab a command names, or the one open/tab-new reports', () => {
  is(lib.rawTab(['click', 'e5', '--tab=AB12'], ''), 'AB12');
  is(
    lib.rawTab(['open', 'https://example.com'], 'Opened https://example.com [targetId: CD34]'),
    'CD34'
  );
  is(lib.rawTab(['tab-list'], '[AB12] https://x "x"'), null);
});

test('checkArgv: a file flag with its value as the next word is checked too', () => {
  // playwright-cli reads `--filename x` as `--filename=x` (its flag parser
  // takes a value flag's next word), so a path there is a path all the same.
  ok(
    lib.checkArgv(['screenshot', '--tab=AB12', '--filename', '/workspace/skills/x/evil.jsh']),
    'screenshot --filename <path>'
  );
  ok(
    lib.checkArgv([
      'eval',
      'document.title',
      '--tab=AB12',
      '--filename',
      '/workspace/skills/x/y.jsh',
    ]),
    'eval --filename <path>'
  );
  ok(
    lib.checkArgv(['eval-file', '/tmp/a.js', '--tab=AB12', '--output', '/workspace/x.json']),
    'eval-file --output <path>'
  );
  ok(
    lib.checkArgv(['drop', 'e5', '--tab=AB12', '--path', '/etc/passwd']),
    'drop --path <path> reads a file'
  );
  ok(
    lib.checkArgv(['response-body', '3', '--tab=AB12', '--filename', '/workspace/r.bin']),
    'response-body --filename <path>'
  );
  is(lib.checkArgv(['screenshot', '--tab', 'AB12', '--filename', '/tmp/run/shot.png']), null);
  // A tab id after --tab is no file, wherever it stands.
  is(lib.checkArgv(['upload', '--tab', 'AB12', 'e7', '/tmp/s/cv.pdf']), null);
  // A cookie's --path is a URL path, not a file.
  is(lib.checkArgv(['cookie-set', 'sid', '1', '--tab=AB12', '--path=/']), null);
});

test('passthrough: a relative file after a space-separated flag resolves where the caller is', () => {
  is(
    lib.passthrough(
      ['screenshot', '--tab', 'AB12', '--filename', 'shot.png', '--intent', 'see it'],
      '/tmp/s'
    ).args,
    ['--tab', 'AB12', '--filename', '/tmp/s/shot.png']
  );
  is(
    lib.passthrough(
      ['upload', '--tab', 'AB12', 'e7', 'cv.pdf', '--intent', 'attach the CV'],
      '/tmp/s'
    ).args,
    ['--tab', 'AB12', 'e7', '/tmp/s/cv.pdf']
  );
});
