import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok, throws } from 'tst';
import { load } from './extract.js';

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/concur.jsh'), 'utf8');

const ITEMS = [
  { id: '3B05751A3D586D4695FA35595257337C', code: '7', value: 'Adobe MAX (incl MAX roadshows)' },
  { id: '3981FF8FF4CEEC4A9960A22023335A9F', code: '3', value: 'Internal Stakeholder Meetings / Review' },
  { id: '92B2BBED77B40F4985450DB22C87F980', code: '10', value: 'Site Council' },
  { id: 'D1277F309D310340986233C771CA290D', code: '11', value: 'Others-Please specify' },
];

function harness({ responses = {}, v3 = null } = {}) {
  const calls = [];
  const scope = {
    ADOBE_INTL_POLICY: { policyId: 'POL' },
    HOST_API: 'https://api',
    buildQS: (o) => '?' + Object.keys(o).map((k) => `${k}=${o[k]}`).join('&'),
    getUserId: async () => 'U1',
    pageFetch: async () => v3,
    getReportPolicyId: async () => 'POL',
    softFailure: () => null,
    console: { error: () => {}, log: () => {} },
    callOp: async (name, vars) => {
      calls.push({ name, vars });
      const r = responses[name];
      return typeof r === 'function' ? r(vars) : r;
    },
  };
  const api = load(
    SOURCE,
    [
      'normalizeListId', 'pickListItem', 'describeListItems', 'listItemsForField', 'defaultPolicyId',
      'purposeItems', 'purposeFromV3Id', 'resolveBusinessPurpose', 'createReport', 'isEmptyFieldValue',
      'missingRequiredFields', 'missingFieldHint', 'entryForm', 'resolveEntryListItem', 'updateEntryFields',
      'entryExceptionCodes', 'summarizeEntryUpdate', 'summarizeAttach', 'availableRow', 'filterAvailable',
      'fetchAvailable', 'allTypesFilter', 'validateAvailableSince', 'moveAvailable', 'listExpenseTypes',
    ],
    scope
  );
  return { api, calls };
}

const newForm = { newReportForm: { fields: [{ id: 'custom14', options: ITEMS }] } };

test('pickListItem accepts id, label, code and a unique label prefix', () => {
  const { api } = harness();
  is(api.pickListItem(ITEMS, '3981ff8ff4ceec4a9960a22023335a9f').code, '3');
  is(api.pickListItem(ITEMS, 'internal stakeholder meetings / review').code, '3');
  is(api.pickListItem(ITEMS, '10').value, 'Site Council');
  is(api.pickListItem(ITEMS, 'Site').code, '10');
  is(api.pickListItem(ITEMS, 'nope'), null);
});

test('an ambiguous prefix does not match', () => {
  const { api } = harness();
  is(api.pickListItem([{ id: 'a', code: '1', value: 'Alpha' }, { id: 'b', code: '2', value: 'Alpine' }], 'Al'), null);
});

test('business purpose resolves from the new report form options', async () => {
  const { api, calls } = harness({ responses: { GetNewReportFormFields: newForm } });
  const p = await api.resolveBusinessPurpose('Internal Stakeholder Meetings / Review', { policyId: 'POL' });
  is(p.id, '3981FF8FF4CEEC4A9960A22023335A9F');
  is(calls[0].name, 'GetNewReportFormFields');
});

test('business purpose resolves from an existing report via the list id', async () => {
  const { api, calls } = harness({
    responses: {
      GetReportFormFields: { existingReportForm: { fields: [{ id: 'custom14', options: null, list: { id: 'L1' } }] } },
      GetFormListItems: { CDS_spend: { list: { items: ITEMS.map((i) => ({ ...i, id: i.id.toLowerCase() })) } } },
    },
  });
  const p = await api.resolveBusinessPurpose('3', { reportId: 'R1' });
  is(p.id, '3981FF8FF4CEEC4A9960A22023335A9F');
  is(calls.map((c) => c.name).join(), 'GetReportFormFields,GetFormListItems');
  is(calls[1].vars.listInformation.id, 'L1');
});

test('a v3 ListItemID maps through the v3 report list', async () => {
  const v3 = { Items: [{ Custom14: { ListItemID: 'gWp03o$py5c3J3KG3i2yelsjiNe$puOTPXWgQ', Value: 'Internal Stakeholder Meetings / Review', Code: '3' } }] };
  const { api } = harness({ responses: { GetNewReportFormFields: newForm }, v3 });
  const p = await api.resolveBusinessPurpose('gWp03o$py5c3J3KG3i2yelsjiNe$puOTPXWgQ', { policyId: 'POL' });
  is(p.code, '3');
});

test('an unknown purpose lists the options', async () => {
  const { api } = harness({ responses: { GetNewReportFormFields: newForm } });
  let err = null;
  try {
    await api.resolveBusinessPurpose('bogus', { policyId: 'POL' });
  } catch (e) {
    err = e;
  }
  ok(err && err.message.includes('No Business Purpose matches "bogus"'));
  ok(err.message.includes('Site Council'));
});

test('new-report with a bad purpose fails before creating the report', async () => {
  const { api, calls } = harness({ responses: { GetNewReportFormFields: newForm, CreateReportHeader: { createReport: { reportId: 'R9' } } } });
  let failed = false;
  try {
    await api.createReport({ name: 'x', policy: 'POL', purpose: 'bogus' });
  } catch {
    failed = true;
  }
  ok(failed);
  ok(!calls.some((c) => c.name === 'CreateReportHeader'));
});

test('new-report sends the resolved list-item id for a label', async () => {
  const { api, calls } = harness({
    responses: {
      GetNewReportFormFields: newForm,
      CreateReportHeader: { createReport: { reportId: 'R9' } },
      UpdateReportHeader: { ok: true },
    },
  });
  const out = await api.createReport({ name: 'x', policy: 'POL', purpose: 'site council' });
  is(out.reportId, 'R9');
  is(calls.find((c) => c.name === 'UpdateReportHeader').vars.fields.custom14.value, '92B2BBED77B40F4985450DB22C87F980');
});

test('move sends ids and reportId without params', async () => {
  const { api, calls } = harness({ responses: { MoveAvailableExpensesToReport: { employee: { moveAvailableExpensesToReport: { status: { success: true }, errors: [] } } } } });
  const r = await api.moveAvailable('R1', ['A', 'B']);
  ok(r.ok);
  is(r.moved, 2);
  const v = calls[0].vars;
  is(JSON.stringify(Object.keys(v).sort()), JSON.stringify(['contextRole', 'ids', 'reportId', 'userId']));
  is(v.ids.join(), 'A,B');
});

test('move reports server errors', async () => {
  const { api } = harness({ responses: { MoveAvailableExpensesToReport: { employee: { moveAvailableExpensesToReport: { status: { success: false }, errors: ['nope'] } } } } });
  const r = await api.moveAvailable('R1', ['A']);
  ok(!r.ok);
  is(r.errors[0], 'nope');
});

test('available pages through results with page and size, never params', async () => {
  const pages = [
    { employee: { availableExpensesWithPagination: { availableExpenses: [{ id: 'a' }], pagination: { totalPages: 2 } } } },
    { employee: { availableExpensesWithPagination: { availableExpenses: [{ id: 'b' }], pagination: { totalPages: 2 } } } },
  ];
  let n = 0;
  const { api, calls } = harness({ responses: { GetAvailableExpenses: () => pages[n++] } });
  const all = await api.fetchAvailable();
  is(all.map((e) => e.id).join(), 'a,b');
  ok(calls.every((c) => !('params' in c.vars)));
  is(calls[1].vars.page, 2);
});

test('available rows are flattened and filtered by --since', () => {
  const { api } = harness();
  const row = api.availableRow({ id: 'x', transactionDate: '2026-10-29', vendor: 'NVN-AL-1', transactionAmount: { value: 468.1, currencyCode: 'EUR' }, expenseType: { code: '01145' }, receiptImageId: 'img' });
  is(row.amount, 468.1);
  is(row.currency, 'EUR');
  is(row.type, '01145');
  ok(row.hasReceipt);
  const rows = [{ date: '2026-01-01' }, { date: '2026-10-01' }, { date: null }];
  is(api.filterAvailable(rows, '2026-06-01').length, 2);
  is(api.filterAvailable(rows, '').length, 3);
  throws(() => api.validateAvailableSince('06/01'));
});

test('set-fields sends the same UpdateExistingExpenseEntry variables as set-payment', async () => {
  const { api, calls } = harness({ responses: { UpdateExistingExpenseEntry: { updateExpense: { id: 'E1', entryExceptions: [] } } } });
  const res = await api.updateEntryFields('R1', 'E1', { ticketNumber: 'KDMDXPL' });
  const v = calls[0].vars;
  is(v.fields.ticketNumber, 'KDMDXPL');
  is(v.expenseTypeId, '');
  is(v.policyId, 'POL');
  is(v.updateRecentExpenseType, false);
  is(v.shouldCopyDownFields, false);
  ok(api.summarizeEntryUpdate(res, 'E1').ok);
});

test('the class label resolves to the custom15 list-item id', async () => {
  const { api } = harness({
    responses: {
      GetExistingExpenseForm: { existingExpenseForm: { mainForm: { fields: [{ id: 'custom15', label: 'Class of Service', list: { id: 'L15' } }] } } },
      GetFormListItems: { CDS_spend: { list: { items: [{ id: '5e0ac8b576c2d643adf191f71e320549', code: 'Economy', value: 'Economy' }, { id: 'c58a308fa09e7b42a108e82329d159fb', code: 'First', value: 'First' }] } } },
    },
  });
  is(await api.resolveEntryListItem('R1', 'E1', 'custom15', 'economy'), '5E0AC8B576C2D643ADF191F71E320549');
  let msg = '';
  try {
    await api.resolveEntryListItem('R1', 'E1', 'custom15', 'zzz');
  } catch (e) {
    msg = e.message;
  }
  ok(msg.includes('Class of Service') && msg.includes('First'));
});

test('change-type output is concise', () => {
  const { api } = harness();
  const res = { updateExpense: { id: 'E1', entry: { expenseType: { id: 'TOLLS', name: 'Airfare' } }, reportDetails: { huge: 'x'.repeat(1000) } } };
  const out = api.summarizeEntryUpdate(res, 'E1', { expenseTypeId: 'TOLLS' });
  is(JSON.stringify(out), JSON.stringify({ ok: true, expenseId: 'E1', expenseTypeId: 'TOLLS', expenseType: 'Airfare', exceptions: [] }));
});

test('entry update surfaces remaining exception codes', () => {
  const { api } = harness();
  const out = api.summarizeEntryUpdate({ updateExpense: { id: 'E1', entryExceptions: { exceptions: [{ exceptionCode: 'MISSREQFLD' }] } } }, 'E1');
  is(out.exceptions.join(), 'MISSREQFLD');
});

test('attach-receipt output names the expense and image', () => {
  const { api } = harness();
  const out = api.summarizeAttach({ id: 'E1', receiptImageId: 'IMG' }, 'E1', 'UP');
  is(JSON.stringify(out), JSON.stringify({ ok: true, expenseId: 'E1', imageId: 'IMG' }));
  ok(!api.summarizeAttach(null, 'E1', 'UP').ok);
});

const form = {
  existingExpenseForm: {
    mainForm: {
      fields: [
        { id: 'ticketNumber', label: 'Ticket Number', isRequired: true, accessMode: 'EDITABLE', value: { stringValue: '' } },
        { id: 'custom15', label: 'Class of Service', isRequired: true, accessMode: 'EDITABLE', value: { isValid: null, listValue: null } },
        { id: 'comment', label: 'Comment', isRequired: false, accessMode: 'EDITABLE', value: null },
        { id: 'vendor', label: 'Vendor', isRequired: true, accessMode: 'READ_ONLY', value: null },
        { id: 'hasVat', label: 'Has VAT', isRequired: true, accessMode: 'HIDDEN', value: null },
        { id: 'transactionDate', label: 'Date', isRequired: true, accessMode: 'EDITABLE', value: { dateValue: '2026-10-29' } },
        { id: 'isPartOfTravelAllowance', label: 'TA', isRequired: true, accessMode: 'EDITABLE', value: { booleanValue: false } },
      ],
    },
  },
};

test('missing required fields are the empty, editable, required ones', () => {
  const { api } = harness();
  is(api.missingRequiredFields(form).map((f) => f.id).join(), 'ticketNumber,custom15');
});

test('the hint points at the airfare shortcuts', () => {
  const { api } = harness();
  const hint = api.missingFieldHint('R1', 'E1', api.missingRequiredFields(form));
  is(hint, 'concur set-fields R1 E1 --ticket=<ticketNumber> --class=Economy');
});

test('types lists every expense type with the required variables', async () => {
  const { api, calls } = harness({
    responses: {
      GetPolicies: { employee: { expensePolicies: { policies: [{ id: 'P1', isDefault: true }] } } },
      GetExpenseFormExpenseTypes: { employee: { expenseTypes: [{ id: 'TOLLS', name: 'Airfare, Paid by Corporate Card or You', parentName: 'Transportation' }, { id: '01145', name: 'Travel Booking Fees', parentName: 'Transportation' }, { id: 'LODGE', name: 'Lodging', parentName: null }] } },
    },
  });
  const all = await api.listExpenseTypes({});
  is(all.length, 3);
  ok(all[2].isGroupHeader);
  const v = calls.find((c) => c.name === 'GetExpenseFormExpenseTypes').vars;
  is(v.policyId, 'P1');
  is(v.reportOwnerUserId, 'U1');
  is(v.filterBy.isItemization, false);
  const hits = await api.listExpenseTypes({ policyId: 'P1', search: 'airfare' });
  is(hits.map((t) => t.id).join(), 'TOLLS');
});
