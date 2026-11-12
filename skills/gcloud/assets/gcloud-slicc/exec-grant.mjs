// Sets KEY in the [exec] table of a secrets-policy.toml to exactly VALUE.
// Usage: node exec-grant.mjs KEY VALUE < policy > new-policy
import fs from 'node:fs';

export function setExecGrant(text, key, value) {
  const lines = text.split('\n');
  const out = [];
  let section = null;
  let placed = false;
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      if (section === 'exec' && !placed) {
        out.push(`${key} = ${value}`);
        placed = true;
      }
      section = header[1].trim();
      out.push(line);
      continue;
    }
    if (section === 'exec' && keyRe.test(line)) {
      const rest = line.replace(keyRe, '').trim();
      const open = (rest.match(/[[{]/g) || []).length;
      const close = (rest.match(/[\]}]/g) || []).length;
      if (open !== close) throw new Error(`${key} in [exec] spans several lines; edit it by hand`);
      if (!placed) out.push(`${key} = ${value}`);
      placed = true;
      continue;
    }
    out.push(line);
  }
  if (!placed) {
    if (section === 'exec') {
      while (out.length && out[out.length - 1] === '') out.pop();
      out.push(`${key} = ${value}`, '');
    } else {
      while (out.length && out[out.length - 1] === '') out.pop();
      if (out.length) out.push('');
      out.push('[exec]', `${key} = ${value}`, '');
    }
  }
  return out.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('exec-grant.mjs')) {
  const [key, value] = process.argv.slice(2);
  process.stdout.write(setExecGrant(fs.readFileSync(0, 'utf8'), key, value));
}
