import test, { is } from 'tst';
import * as htmlMod from '../scripts/html.js';

const html = htmlMod.default || htmlMod;
const { decodeEntity, stripHtml } = html;

test('non-strings become an empty snippet', () => {
  is(stripHtml(null), '');
  is(stripHtml(undefined), '');
  is(stripHtml(12), '');
});

test('markup does not leave orphaned punctuation in a snippet', () => {
  is(
    stripHtml('Free tier: <strong>1 query/second</strong>, then $5 CPM.'),
    'Free tier: 1 query/second, then $5 CPM.'
  );
});

test('named and numeric entities decode; unknown names stay verbatim', () => {
  is(stripHtml('A &amp; B &#8212; C &#x2026;'), 'A & B — C …');
  is(decodeEntity('amp'), '&');
  is(decodeEntity('#8212'), '—');
  is(decodeEntity('#x2026'), '…');
  is(decodeEntity('not-a-real-entity'), '&not-a-real-entity;');
});
