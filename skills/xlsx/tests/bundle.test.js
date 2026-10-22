import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

const read = (f) => fs.readFileSync(path.join(process.cwd(), 'scripts', f), 'utf8');
const pinned = JSON.parse(read('package.json')).dependencies['@e965/xlsx'];

test('package.json pins @e965/xlsx at 0.20.2 or later', () => {
  ok(/^\d+\.\d+\.\d+$/.test(pinned ?? ''), `pinned ${pinned}`);
  const [major, minor, patch] = pinned.split('.').map(Number);
  ok(major > 0 || minor > 20 || (minor === 20 && patch >= 2), `pinned ${pinned}`);
});

test('xlsx.src.js requires @e965/xlsx', () => {
  const src = read('xlsx.src.js');
  ok(src.includes("require('@e965/xlsx')"));
  is(src.includes("require('xlsx')"), false);
});

test('xlsx.jsh bundles the pinned SheetJS version', () => {
  ok(read('xlsx.jsh').includes(`.version="${pinned}"`), `bundle lacks SheetJS ${pinned}`);
});
