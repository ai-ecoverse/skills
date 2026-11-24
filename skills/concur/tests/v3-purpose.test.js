import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { readScript } from './script.js';

const SOURCE = readScript(path.join(process.cwd(), 'scripts/concur.jsh'));

const ITEMS = [
  { id: '3B05751A3D586D4695FA35595257337C', code: '7', value: 'Adobe MAX (incl MAX roadshows)' },
  {
    id: '3981FF8FF4CEEC4A9960A22023335A9F',
    code: '3',
    value: 'Internal Stakeholder Meetings / Review',
  },
  { id: '92B2BBED77B40F4985450DB22C87F980', code: '10', value: 'Site Council' },
];

const V3_ID = 'gWp03o$py5c3J3KG3i2yelsjiNe$puOTPXWgQ';
const V3_PURPOSE = {
  ListItemID: V3_ID,
  Value: 'Internal Stakeholder Meetings / Review',
  Code: '3',
};
const OTHER_PURPOSE = {
  ListItemID: 'zzOther$listItemIdThatIsLongEnough0',
  Value: 'Site Council',
  Code: '10',
};
const FIRST = 'https://api/api/v3.0/expense/reports?limit=100';
const PAGE2 = 'https://api/api/v3.0/expense/reports?limit=100&offset=100';

function harness(pages) {
  const urls = [];
  const scope = {
    HOST_API: 'https://api',
    getUserId: async () => 'U1',
    callOp: async (name) =>
      name === 'GetNewReportFormFields'
        ? { newReportForm: { fields: [{ id: 'custom14', options: ITEMS }] } }
        : null,
    pageFetch: async (url, options) => {
      urls.push({ url, soft: options?.soft === true });
      return pages(url, urls.length);
    },
  };
  const api = load(
    SOURCE,
    [
      'buildQS',
      'normalizeListId',
      'pickListItem',
      'describeListItems',
      'listItemsForField',
      'purposeItems',
      'purposeFromV3Id',
      'v3PurposeNote',
      'resolveBusinessPurpose',
    ],
    scope
  );
  return {
    api,
    urls: () => urls.map((u) => u.url),
    allSoft: () => urls.every((u) => u.soft),
  };
}

async function rejection(api, input) {
  try {
    await api.resolveBusinessPurpose(input, { policyId: 'POL' });
  } catch (e) {
    return e.message;
  }
  return null;
}

test('a v3 ListItemID found only on the second page resolves', async () => {
  const h = harness((url) =>
    url === PAGE2
      ? { Items: [{ ID: 'R2', Custom14: V3_PURPOSE }], NextPage: null }
      : { Items: [{ ID: 'R1', Custom14: OTHER_PURPOSE }], NextPage: PAGE2 }
  );
  const p = await h.api.resolveBusinessPurpose(V3_ID, { policyId: 'POL' });
  is(p, {
    id: '3981FF8FF4CEEC4A9960A22023335A9F',
    code: '3',
    value: 'Internal Stakeholder Meetings / Review',
  });
  is(h.urls(), [FIRST, PAGE2]);
  ok(h.allSoft());
});

test('a v3 ListItemID found only on a report older than 400 days resolves', async () => {
  const reports = [
    { ID: 'NEW', CreateDate: new Date().toISOString(), Custom14: OTHER_PURPOSE },
    { ID: 'OLD', CreateDate: '2019-03-01T00:00:00', Custom14: V3_PURPOSE },
  ];
  const h = harness((url) => {
    const after = /createDateAfter=([^&]+)/.exec(url);
    const cutoff = after ? decodeURIComponent(after[1]) : '';
    return { Items: reports.filter((r) => r.CreateDate.slice(0, 10) >= cutoff), NextPage: null };
  });
  const p = await h.api.resolveBusinessPurpose(V3_ID, { policyId: 'POL' });
  is(p.code, '3');
  is(h.urls(), [FIRST]);
});

test('a NextPage chain that never ends stops at the page cap', async () => {
  const h = harness((_url, n) => ({
    Items: [{ ID: `R${n}`, Custom14: OTHER_PURPOSE }],
    NextPage: `https://api/api/v3.0/expense/reports?limit=100&offset=${n * 100}`,
  }));
  const message = await rejection(h.api, V3_ID);
  is(h.urls().length, 50);
  is(new Set(h.urls()).size, 50);
  ok(message?.startsWith(`No Business Purpose matches "${V3_ID}".`));
  ok(
    message.includes(
      `"${V3_ID}" was not found in the first 50 pages of your v3 reports (100 per page); the lookup stops there.`
    )
  );
  ok(
    message.includes(
      'Pass the purpose label, code or GraphQL list-item id from `concur purposes` instead.'
    )
  );
});

test('a NextPage link that repeats stops the v3 lookup', async () => {
  const h = harness(() => ({ Items: [{ ID: 'R1', Custom14: OTHER_PURPOSE }], NextPage: PAGE2 }));
  const message = await rejection(h.api, V3_ID);
  is(h.urls(), [FIRST, PAGE2]);
  ok(message?.includes('Concur repeated a v3 NextPage link after 2 pages, so the lookup stopped.'));
});

test('a v3 ListItemID on no report is still rejected with the options and the alternatives', async () => {
  const h = harness((url) =>
    url === PAGE2
      ? { Items: [], NextPage: null }
      : { Items: [{ ID: 'R1', Custom14: OTHER_PURPOSE }], NextPage: PAGE2 }
  );
  const message = await rejection(h.api, V3_ID);
  is(h.urls(), [FIRST, PAGE2]);
  is(
    message,
    `No Business Purpose matches "${V3_ID}". Pass a list-item id, an exact label, a unique label prefix or a code. ` +
      `"${V3_ID}" was not found as a Custom14.ListItemID on any of your v3 reports (2 pages searched). ` +
      'Pass the purpose label, code or GraphQL list-item id from `concur purposes` instead. Options:\n' +
      '  7    Adobe MAX (incl MAX roadshows)  (3B05751A3D586D4695FA35595257337C)\n' +
      '  3    Internal Stakeholder Meetings / Review  (3981FF8FF4CEEC4A9960A22023335A9F)\n' +
      '  10   Site Council  (92B2BBED77B40F4985450DB22C87F980)'
  );
});

test('an unreadable v3 report list says the id could not be checked', async () => {
  const h = harness(() => null);
  const message = await rejection(h.api, V3_ID);
  is(h.urls(), [FIRST]);
  ok(
    message?.includes(
      `The v3 report list could not be read (page 1), so "${V3_ID}" could not be looked up.`
    )
  );
});

test('a v3 purpose the form does not offer names the purpose it found', async () => {
  const h = harness(() => ({
    Items: [{ ID: 'R1', Custom14: { ListItemID: V3_ID, Value: 'Retired Purpose', Code: '99' } }],
    NextPage: null,
  }));
  const message = await rejection(h.api, V3_ID);
  ok(
    message?.includes(
      `The v3 id "${V3_ID}" belongs to "Retired Purpose" (code 99), which this form does not offer.`
    )
  );
});

test('a label that matches nothing does not query the v3 report list', async () => {
  const h = harness(() => ({ Items: [], NextPage: null }));
  const message = await rejection(h.api, 'bogus');
  is(h.urls(), []);
  is(
    message.split(' Options:')[0],
    'No Business Purpose matches "bogus". Pass a list-item id, an exact label, a unique label prefix or a code.'
  );
});
