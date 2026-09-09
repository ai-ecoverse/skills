// fountain — render a screenplay and open its source in the Review queue.
const fs = require('fs');
const path = require('path');
const cli = require('sliccy:cli');
const exec = require('sliccy:exec');
const { renderFountain } = require('../assets/render-fountain.js');
const { positional, flags } = process.argv.parseFlags();
const command = positional[0];
if (flags.help || flags.h || !command) {
  cli.help('Usage: fountain render <file.fountain> [--json | --out <file.html>]\n       fountain review <file.fountain> [--title <title>]\n\nRender Fountain as a screenplay. Review queues the source for inline comments;\nit requires the review skill and its open sprinkle. Comments are sent only\nwhen the user clicks Send to agent.');
}
try {
  if (!['render', 'review'].includes(command)) cli.die('Use fountain render or fountain review.');
  if (!positional[1]) cli.die('Provide a .fountain source path.');
  const file = path.resolve(process.cwd(), positional[1]);
  const result = renderFountain(await fs.readFile(file, 'utf8'), file);
  if (command === 'render') {
    if (flags.out) {
      const output = path.resolve(process.cwd(), String(flags.out));
      if (output === file) cli.die('Choose a different output path; keep the Fountain source.');
      await fs.writeFile(output, result.html);
      cli.out(flags.json ? { ...result, html: undefined, output } : output);
    } else cli.out(flags.json ? result : result.html);
  } else {
    const id = 'review:' + file;
    for (const msg of [
      { action: 'ensure-item', id, path: file, title: flags.title || result.title },
      { action: 'open-file', id, path: file, title: flags.title || result.title },
    ]) {
      const r = await exec.spawn(['sprinkle', 'send', 'review', JSON.stringify(msg)]);
      if (r.exitCode !== 0) cli.die('Open the Review sprinkle and retry. ' + (r.stderr || r.stdout || 'Delivery failed.'));
    }
    cli.out(flags.json ? { id, path: file, title: result.title } : 'Opened in Review: ' + file);
  }
} catch (error) {
  if (error?.name === 'NodeExitError') throw error;
  cli.die(error.message, { prefix: 'fountain' });
}
