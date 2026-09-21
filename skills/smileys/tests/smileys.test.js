// Static guards for scripts/smileys.jsh.
//
//   node --test skills/smileys/tests/smileys.test.js
//
// The .jsh talks to shop.smileys.de through sliccy:browser, so these tests
// assert source-level contracts (confirm gate, no payment command, no
// hardcoded identity) rather than live HTTP.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'smileys.jsh');
const SKILL_MD = path.join(__dirname, '..', 'SKILL.md');
const ENDPOINTS_MD = path.join(__dirname, '..', 'references', 'endpoints.md');

const source = fs.readFileSync(SCRIPT, 'utf8');
const skill = fs.readFileSync(SKILL_MD, 'utf8');
const endpoints = fs.readFileSync(ENDPOINTS_MD, 'utf8');

test('checkout returns before any write when --confirm is absent', () => {
  const start = source.indexOf('async function cmdCheckout(');
  assert.ok(start > 0, 'cmdCheckout not found');
  const guard = source.indexOf('if (!flags.confirm)', start);
  const write = source.indexOf('apiWrite(', start);
  assert.ok(guard > start, 'no !flags.confirm guard');
  assert.ok(write > guard, 'checkout writes before the --confirm guard');
});

test('checkout requires address flags and never hardcodes a customer', () => {
  const start = source.indexOf('async function cmdCheckout(');
  const body = source.slice(start, source.indexOf('async function main('));
  for (const flag of ['firstname', 'lastname', 'email', 'phone', 'street', 'number', 'zip', 'city']) {
    assert.ok(body.includes(`flags.${flag}`), `missing flags.${flag}`);
  }
  assert.ok(!/lars@trieloff\.net/.test(source), 'script hardcodes an email');
  assert.ok(!/0151/.test(source), 'script hardcodes a phone');
  assert.ok(!/Rudolf-Breitscheid/.test(source), 'script hardcodes a street');
});

test('payment endpoints are documented but not wired as commands', () => {
  const help = source.slice(source.indexOf('const HELP = `'), source.indexOf('`;', source.indexOf('const HELP = `')));
  assert.ok(!/smileys pay/.test(help), 'HELP advertises a pay command');
  assert.ok(!/subcommand === 'pay'/.test(source));
  assert.ok(!/subcommand === 'paypal'/.test(source));
  assert.ok(endpoints.includes('/checkout/payment/paypal'));
  assert.ok(endpoints.includes('/checkout/payment/wallet'));
  assert.ok(/\*\*Charges\.\*\*/.test(endpoints));
});

test('writes go through in-page eval, reads through browser.fetch', () => {
  assert.ok(/async function apiGet\(/.test(source));
  assert.ok(/async function apiWrite\(/.test(source));
  assert.ok(/browser\.fetch\(tab, url/.test(source));
  assert.ok(/browser\.evalAsync/.test(source));
  assert.ok(/credentials: 'include'/.test(source));
  const add = source.slice(source.indexOf('async function cmdAdd('), source.indexOf('async function cmdSuggestions('));
  assert.ok(/method: 'POST'/.test(add));
  assert.ok(/cart\/items/.test(add));
});

test('default store is potsdam and X-Widget-Version is the captured 4.1.0', () => {
  assert.ok(/'potsdam'/.test(source));
  assert.ok(/const WIDGET = '4.1.0'/.test(source));
});

test('SKILL.md frontmatter names the command and the confirm gate', () => {
  assert.ok(/^name: smileys/m.test(skill));
  assert.ok(/^command: smileys/m.test(skill));
  assert.ok(/script: scripts\/smileys.jsh/.test(skill));
  assert.ok(skill.includes('--confirm'));
  assert.ok(/shop\.smileys\.de/.test(skill));
});

test('HELP lists every shipped subcommand', () => {
  const help = source.slice(source.indexOf('const HELP = `'), source.indexOf('`;', source.indexOf('const HELP = `')));
  for (const cmd of ['stores', 'autocomplete', 'groups', 'add', 'suggestions', 'delivery', 'checkout']) {
    assert.ok(help.includes(`smileys ${cmd}`), `HELP missing ${cmd}`);
  }
});
