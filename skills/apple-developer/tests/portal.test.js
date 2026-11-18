import { createRequire } from 'node:module';
import test, { is, ok } from 'tst';

const require = createRequire(import.meta.url);
const portal = require('../scripts/lib/portal.js');

function stubFetch(answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers.shift() || { status: 500, text: '' };
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      url: a.url || `https://developer.apple.com${url}`,
      headers: { get: (k) => (a.headers || {})[k.toLowerCase()] ?? null },
      text: async () => a.text || '',
    };
  };
  return calls;
}

test('reads are POSTs with the GET override and the team in the body', async () => {
  const calls = stubFetch([{ status: 200, text: '{"data":[]}' }]);
  const res = await portal.pageRequest(
    portal.readRequest('S8LB56P782', 'bundleIds', {
      'filter[identifier]': 'ai.example.mac',
      limit: 5,
    })
  );
  is(res.status, 200);
  is(calls.length, 1);
  is(calls[0].url, '/services-account/v1/bundleIds');
  is(calls[0].init.method, 'POST');
  is(calls[0].init.headers['x-http-method-override'], 'GET');
  is(JSON.parse(calls[0].init.body), {
    urlEncodedQueryParams: 'filter[identifier]=ai.example.mac&limit=5',
    teamId: 'S8LB56P782',
  });
  is(calls[0].init.headers.csrf, undefined);
});

test('writes prime the CSRF pair from a read and send it, without the override', async () => {
  const calls = stubFetch([
    { status: 200, text: '{}', headers: { csrf: 'tok', csrf_ts: '123' } },
    { status: 201, text: '{"data":{"id":"X"}}' },
  ]);
  const body = { data: { type: 'profiles' } };
  const res = await portal.pageRequest(portal.writeRequest('S8LB56P782', 'POST', 'profiles', body));
  is(res.status, 201);
  is(calls[1].url, '/services-account/v1/profiles');
  is(calls[1].init.method, 'POST');
  is(calls[1].init.headers.csrf, 'tok');
  is(calls[1].init.headers.csrf_ts, '123');
  is(calls[1].init.headers['x-http-method-override'], undefined);
  is(JSON.parse(calls[1].init.body), body);
});

test('a write without a CSRF pair is never sent', async () => {
  const calls = stubFetch([{ status: 200, text: '{}' }]);
  const res = await portal.pageRequest(portal.writeRequest('S8LB56P782', 'POST', 'bundleIds', {}));
  is(res.error, 'csrf');
  is(calls.length, 1);
  ok(/CSRF/.test(portal.parseResponse(res).error));
});

test('teams come from the form-encoded listTeams action', async () => {
  const calls = stubFetch([
    {
      status: 200,
      text: '{"teams":[{"teamId":"S8LB56P782","name":"Lars","type":"Individual","status":"active","extra":1}]}',
    },
  ]);
  const out = portal.parseResponse(await portal.pageRequest({ kind: 'teams' }));
  is(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  is(portal.teamsFrom(out.json), [
    { teamId: 'S8LB56P782', name: 'Lars', type: 'Individual', status: 'active' },
  ]);
});

test('query keeps Apple filter brackets and commas and drops empty values', () => {
  is(
    portal.query({
      'filter[capabilityType]': 'capability,service',
      'filter[name]': 'A & B',
      empty: undefined,
      blank: '',
    }),
    'filter[capabilityType]=capability,service&filter[name]=A%20%26%20B'
  );
});

test('responses: sign-in walls, team, CSRF and API errors read as guidance', () => {
  ok(/log in/.test(portal.parseResponse({ status: 200, text: '<!DOCTYPE html><html>' }).error));
  ok(
    /log in/.test(
      portal.parseResponse({ status: 200, text: '{}', url: 'https://idmsa.apple.com/signin' }).error
    )
  );
  ok(/log in/.test(portal.parseResponse({ status: 401, text: '' }).error));
  ok(
    /--team/.test(
      portal.parseResponse({ status: 403, text: '{"errors":[{"detail":"Please select a team."}]}' })
        .error
    )
  );
  ok(/CSRF/.test(portal.parseResponse({ status: 421, text: 'Bad Request' }).error));
  is(
    portal.parseResponse({
      status: 409,
      text: '{"errors":[{"code":"ENTITY_ERROR","detail":"There is no App ID"}]}',
    }).error,
    'HTTP 409: ENTITY_ERROR: There is no App ID'
  );
  is(portal.parseResponse({ status: 200, text: '{"data":[]}' }).ok, true);
});

test('team: --team, then APPLE_TEAM_ID, then the only active team, never a default', () => {
  const teams = [
    { teamId: 'S8LB56P782', status: 'active' },
    { teamId: 'ZZZZZZZZZZ', status: 'expired' },
  ];
  is(portal.chooseTeam('S8LB56P782', 'ZZZZZZZZZZ', teams), { teamId: 'S8LB56P782' });
  is(portal.chooseTeam(undefined, undefined, teams), { teamId: 'S8LB56P782' });
  ok(/not a member/.test(portal.chooseTeam('AAAAAAAAAA', undefined, teams).error));
  ok(/not a team ID/.test(portal.chooseTeam('nope', undefined, teams).error));
  ok(
    /2 teams/.test(
      portal.chooseTeam(undefined, undefined, [{ teamId: 'AAAAAAAAAA' }, { teamId: 'BBBBBBBBBB' }])
        .error
    )
  );
  ok(/no active/.test(portal.chooseTeam(undefined, undefined, []).error));
});

test('profiles are picked by ID, UUID or a unique name', () => {
  const p = (id, name, uuid) => ({ id, attributes: { name, uuid } });
  const all = [
    p('K2Q8T6ZQTP', 'Sliccy', 'u-1'),
    p('A8F6P4PJTK', 'Twin', 'u-2'),
    p('B8F6P4PJTK', 'Twin', 'u-3'),
  ];
  is(portal.pickProfile(all, 'K2Q8T6ZQTP').profile.id, 'K2Q8T6ZQTP');
  is(portal.pickProfile(all, 'u-2').profile.id, 'A8F6P4PJTK');
  is(portal.pickProfile(all, 'Sliccy').profile.id, 'K2Q8T6ZQTP');
  ok(/2 profiles/.test(portal.pickProfile(all, 'Twin').error));
  ok(/no profile/.test(portal.pickProfile(all, 'Other').error));
});

test('profile content must be a CMS blob, not whatever the field holds', () => {
  const cms = Buffer.concat([Buffer.from([0x30, 0x82, 0x32, 0x00]), Buffer.alloc(80, 1)]);
  is(
    portal.profileBytes({ attributes: { profileContent: cms.toString('base64') } }).length,
    cms.length
  );
  is(
    portal.profileBytes({
      attributes: { profileContent: Buffer.from('<plist>' + 'x'.repeat(80)).toString('base64') },
    }),
    null
  );
  is(portal.profileBytes({ attributes: { profileContent: 'not base64!' } }), null);
  is(portal.profileBytes({ attributes: {} }), null);
});

test('App ID create body matches the portal form, capabilities validated', () => {
  is(
    portal.bundleIdCreateBody({
      teamId: 'S8LB56P782',
      identifier: 'ai.example.mac',
      name: 'Example',
      capabilities: ['ICLOUD'],
    }),
    {
      data: {
        type: 'bundleIds',
        attributes: {
          identifier: 'ai.example.mac',
          seedId: 'S8LB56P782',
          teamId: 'S8LB56P782',
          name: 'Example',
        },
        relationships: {
          bundleIdCapabilities: {
            data: [
              {
                type: 'bundleIdCapabilities',
                attributes: { enabled: true, settings: [] },
                relationships: { capability: { data: { type: 'capabilities', id: 'ICLOUD' } } },
              },
            ],
          },
        },
      },
    }
  );
  for (const bad of [
    { identifier: 'ai example', name: 'x' },
    { identifier: 'ai.example', name: 'a@b' },
    { identifier: 'ai.example', name: 'x', capabilities: ['icloud; rm'] },
  ]) {
    let threw = false;
    try {
      portal.bundleIdCreateBody({ teamId: 'S8LB56P782', ...bad });
    } catch {
      threw = true;
    }
    ok(threw, JSON.stringify(bad));
  }
});

test('profile create body matches the portal form; certificates by ID or serial', () => {
  const certs = [
    { id: 'FAYZ34Y65G', attributes: { serialNumber: '714FB0EAF0BEA248' } },
    { id: '95L57VRC9D', attributes: { serialNumber: '2539EB4EC3DAE1E4' } },
  ];
  const picked = portal.pickCertificates(certs, ['714fb0eaf0bea248']);
  is(
    picked.certificates.map((c) => c.id),
    ['FAYZ34Y65G']
  );
  ok(/no single certificate/.test(portal.pickCertificates(certs, ['nope']).error));
  is(
    portal.profileCreateBody({
      teamId: 'S8LB56P782',
      name: 'Example',
      profileType: 'MAC_APP_DIRECT',
      bundleIdId: '98864CBM97',
      certificateIds: ['FAYZ34Y65G'],
    }),
    {
      data: {
        type: 'profiles',
        attributes: { name: 'Example', profileType: 'MAC_APP_DIRECT', teamId: 'S8LB56P782' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: '98864CBM97' } },
          certificates: { data: [{ type: 'certificates', id: 'FAYZ34Y65G' }] },
        },
      },
    }
  );
  let threw = false;
  try {
    portal.profileCreateBody({
      teamId: 'S8LB56P782',
      name: 'x',
      profileType: 'DEVELOPER_ID',
      bundleIdId: 'A',
      certificateIds: ['B'],
    });
  } catch {
    threw = true;
  }
  ok(threw);
});

test('capabilities of an App ID come from its included bundleIdCapabilities', () => {
  const json = {
    included: [
      {
        type: 'bundleIdCapabilities',
        id: '98864CBM97_ICLOUD',
        attributes: {
          enabled: true,
          settings: [{ key: 'ICLOUD_VERSION', options: [{ key: 'XCODE_6' }] }],
        },
      },
      { type: 'bundleIdCapabilities', id: 'OTHER_PUSH', attributes: { enabled: true } },
      { type: 'certificates', id: 'C' },
    ],
  };
  is(portal.capabilityRows(json, '98864CBM97'), [
    { capability: 'ICLOUD', enabled: true, settings: ['ICLOUD_VERSION=XCODE_6'] },
  ]);
});
