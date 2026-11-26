// fixtures.js — Workday UI responses, shaped like the ones captured live on
// 2026-11-25 (see references/endpoints.md), with invented people and IDs.

const moniker = (instanceId, text, extra = {}) => ({ widget: 'moniker', instanceId, text, ...extra });
const list = (propertyName, instances, extra = {}) => ({ widget: 'monikerList', instances, propertyName, ...extra });

// A navigatorDetail: an org (owner + title) or a person (leaf).
export function detail(id, name, { owner, title = '', location = '', size = 0, leaf = false } = {}) {
  const who = owner || [id, name];
  return {
    widget: 'navigatorDetail',
    badgeNumber: size,
    childrenAndPeersCount: size,
    hasChildren: size > 0,
    ...(leaf ? { leaf: true } : {}),
    navigatorInstance: { widget: 'navigatorList', instances: [{ widget: 'navigator', instanceId: id, text: name }] },
    navigatorItems: [
      {
        widget: 'navigatorItem',
        detailOne: title,
        detailTwo: location,
        owner: list('wd:Navigable_Owner--IS', [moniker(who[0], who[1], { action: 'person' })]),
      },
    ],
  };
}

export const ORG_TOP = detail('2500$3000', 'Engineering  (Grace Hopper)', {
  owner: ['247$9', 'Grace Hopper'],
  title: 'SVP, Engineering',
  size: 2,
});
export const ORG_TEAM = detail('2500$2001', 'Analytical Engines  (Charles Babbage)', {
  owner: ['247$7', 'Charles Babbage'],
  title: 'VP, Engines',
  location: 'London',
  size: 3,
});
export const ADA = detail('247$1001', 'Ada Lovelace', { title: 'Principal', location: 'London', leaf: true });
export const ALAN = detail('247$1002', 'Alan Turing', { title: 'Scientist', location: 'Bletchley', leaf: true });
export const SUB = detail('2500$2002', 'Compilers  (Kathleen Booth)', {
  owner: ['247$1003', 'Kathleen Booth'],
  title: 'Director, Compilers',
  size: 4,
});

export const HOME = {
  widget: 'root',
  currentUser: {
    widget: 'currentUser',
    iid: '247$1001',
    label: 'Ada Lovelace',
    selfLink: { widget: 'link', rel: 'self', uri: '/acme/inst/1$37/247$1001' },
  },
};

export const SEARCH = {
  widget: 'autoCompleteSearchList',
  listItems: [
    {
      widget: 'searchResultEntry',
      instanceId: '247$1001',
      label: 'Ada Lovelace',
      classLabel: 'Employee',
      iconId: 'wd-icon-user',
      subtitle1: 'Principal',
      subtitle2: 'Analytical Engines',
      subtitle3: 'London',
      uri: '/acme/inst/autocompletesearch/247$1001',
    },
    {
      widget: 'searchResultEntry',
      instanceId: '2506$77',
      label: 'LOVELACE_123 LOVELACE',
      classLabel: 'Custom Organization',
      iconId: 'wd-icon-view-team',
      uri: '/acme/inst/autocompletesearch/2506$77',
    },
    {
      widget: 'searchResultEntry',
      instanceId: '247$1004',
      label: 'Ada Byron',
      classLabel: 'Employee',
      iconId: 'wd-icon-user',
      subtitle1: 'Engineer',
      subtitle2: 'Compilers',
      subtitle3: 'Remote',
      uri: '/acme/inst/autocompletesearch/247$1004',
    },
    {
      widget: 'searchResultEntry',
      instanceId: '2997$5',
      label: 'Request Absence',
      classLabel: 'Sequence Task',
      iconId: 'wd-icon-clipboard-card',
      uri: '/acme/task/2997$5',
    },
  ],
};

export function profile(id, name, { title, email, managers = [], org, team }) {
  return {
    widget: 'root',
    title: { widget: 'titleMonikerList', instances: [moniker(id, name, { action: 'person' })] },
    body: {
      widget: 'profile',
      compositeViewHeader: {
        widget: 'compositeViewHeader',
        contactInfo: {
          widget: 'contactLayout',
          businessTitle: title,
          organization: org,
          firstName: name.split(' ')[0],
          lastName: name.split(' ').slice(1).join(' '),
          primaryEmail: email,
        },
        headerGroupings: [
          {
            widget: 'headerGrouping',
            headerItems: [
              {
                widget: 'headerCardItem',
                headerCardItem: {
                  widget: 'commandButton',
                  label: 'View Team',
                  uri: team,
                  propertyName: 'wd:View_Team',
                },
              },
            ],
          },
        ],
        headerCards: [
          {
            widget: 'headerCard',
            headerCardItems: [
              {
                widget: 'headerCardItem',
                headerCardItem: {
                  widget: 'compositeList',
                  composites: [{ widget: 'composite', header: list('wd:Manager_For_Position--IS', managers.map(([i, n]) => moniker(i, n))) }],
                },
              },
              {
                widget: 'headerCardItem',
                headerCardItem: list('wd:Location_Not_Secured--IS', [moniker('216$1', 'London')], { label: 'Location' }),
              },
            ],
          },
        ],
      },
    },
  };
}

export const PROFILE_ADA = profile('247$1001', 'Ada Lovelace', {
  title: 'Principal',
  email: 'ada@example.com',
  managers: [['247$7', 'Charles Babbage']],
  org: 'Engineering (Grace Hopper) >> Analytical Engines (Charles Babbage)',
  team: '/acme/inst/4547$1/rel-task/2998$90',
});

export const PROFILE_CHARLES = profile('247$7', 'Charles Babbage', {
  title: 'VP, Engines',
  email: 'charles@example.com',
  managers: [['247$9', 'Grace Hopper']],
  org: 'Engineering (Grace Hopper)',
  team: '/acme/inst/4547$2/rel-task/2998$90',
});

// The View Team page: org is the team the worker is on (or leads).
export function teamPage(orgId, orgName, ancestors) {
  return {
    widget: 'root',
    body: {
      widget: 'hierarchyNavigator',
      navigatorInstance: { widget: 'navigatorList', instances: [{ widget: 'navigator', instanceId: orgId, text: orgName }] },
      navigationUri: '/acme/navigable',
      taskIid: '2998$55',
      workerIid: '247$1001',
      ancestors,
    },
  };
}

export function navigator(parent, self, children, { count, chunk } = {}) {
  return {
    widget: 'root',
    body: {
      widget: 'navigatorResponse',
      navigatorContainers: [
        { widget: 'navigatorContainer', navigatorContainerNodeType: 'PARENT', navigatorDetails: parent ? [parent] : [] },
        { widget: 'navigatorContainer', navigatorContainerNodeType: 'SELF', navigatorDetails: [self] },
        {
          widget: 'navigatorContainer',
          navigatorContainerNodeType: 'CHILD_NODES_AND_LEAVES',
          navigatorDetails: children,
          count: count ?? children.length,
          ...(chunk ? { chunkingUrl: chunk } : {}),
        },
      ],
    },
  };
}

export const MISSING_PARM =
  '<?xml version="1.0" encoding="UTF-8"?><wml:System_Error xmlns:wml="http://www.workday.com/ns/model/1.0" Type="com.workday.ui.appservice.oms.OmsRemoteException"><wml:Message>Missing Required Parm: Navigable_Task--IS (15$35098)</wml:Message></wml:System_Error>';
export const SIGN_IN_PAGE = '\n\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html><body>Sign In</body></html>';

export const TOO_MANY =
  '<?xml version="1.0" encoding="UTF-8"?><wml:Application_Error xmlns:wml="http://www.workday.com/ns/model/1.0" Type="Validation"><wml:Message>Too many repeating requests. Please try again later.</wml:Message></wml:Application_Error>';
export const SERVER_ERROR =
  '<?xml version="1.0" encoding="UTF-8"?><wml:Application_Error xmlns:wml="http://www.workday.com/ns/model/1.0" Type="Server Error"><wml:Message>There was an error processing your request.</wml:Message></wml:Application_Error>';

// A person card with a generated id: person(5) is 247$5005.
export const person = (n, extra = {}) =>
  detail(`247$${5000 + n}`, `Person ${n}`, { title: `Role ${n}`, location: n % 2 ? 'Berlin' : 'Paris', leaf: true, ...extra });

const chunk = (details, totalCount) => ({ widget: 'navigatorDetailsChunk', totalCount, navigatorDetails: details });
const range = (from, to) => Array.from({ length: to - from }, (_, i) => person(from + i));

// Orgs for the tree tests, under the tenant `acme`:
//   2500$4000 Research (Barbara Liskov, 247$20): 120 members, 50 per page.
//     First page: orgs A and B and leaves 1-48. Chunks: leaves 49-98, 99-118.
//   2500$4001 A (Donald Knuth, 247$21): 60 members: leaves 200-258 and X (247$6001).
//     First page 50, chunk of 10.
//   2500$4002 B (Margaret Hamilton, 247$22): X, Y (247$6002) and sub-org C.
//   2500$4003 C (Katherine Johnson, 247$23): leaves 247$6003, 247$6004.
// X is in both A and B. 185 distinct people in all.
export const X = detail('247$6001', 'Xavier Example', { title: 'Engineer', location: 'Oslo', leaf: true });
export const Y = detail('247$6002', 'Yara Example', { title: 'Analyst', location: 'Lima', leaf: true });
const ROOT = detail('2500$4000', 'Research  (Barbara Liskov)', { owner: ['247$20', 'Barbara Liskov'], title: 'Head of Research', location: 'Boston', size: 120 });
const ORG_A = detail('2500$4001', 'A  (Donald Knuth)', { owner: ['247$21', 'Donald Knuth'], title: 'Director A', location: 'Palo Alto', size: 60 });
const ORG_B = detail('2500$4002', 'B  (Margaret Hamilton)', { owner: ['247$22', 'Margaret Hamilton'], title: 'Director B', location: 'Cambridge', size: 3 });
const ORG_C = detail('2500$4003', 'C  (Katherine Johnson)', { owner: ['247$23', 'Katherine Johnson'], title: 'Lead C', location: 'Hampton', size: 2 });
export const TREE_ROUTES = {
  'POST /acme/navigable/2500$4000.htmld': navigator(null, ROOT, [ORG_A, ORG_B, ...range(1, 49)], { count: 120, chunk: '/acme/navigablechunk/r/1' }),
  'GET /acme/navigablechunk/r/1.htmld?startRow=50&maxRows=50': chunk(range(49, 99), 120),
  'GET /acme/navigablechunk/r/1.htmld?startRow=100&maxRows=50': chunk(range(99, 119), 120),
  'POST /acme/navigable/2500$4001.htmld': navigator(ROOT, ORG_A, [...range(200, 249), X], { count: 60, chunk: '/acme/navigablechunk/a/1' }),
  'GET /acme/navigablechunk/a/1.htmld?startRow=50&maxRows=50': chunk(range(249, 259), 60),
  'POST /acme/navigable/2500$4002.htmld': navigator(ROOT, ORG_B, [X, Y, ORG_C]),
  'POST /acme/navigable/2500$4003.htmld': navigator(ORG_B, ORG_C, [detail('247$6003', 'Zed Example', { title: 'Tech', location: 'Rome', leaf: true }), detail('247$6004', 'Zoe Example', { title: 'Tech', location: 'Rome', leaf: true })]),
};

// ── keepalive ─────────────────────────────────────────────────────────
// home.htmld with the session fields the client reads (invented token).
export const homeWith = (minutes, token = 'TEST-SESSION-TOKEN-0000') => ({ ...HOME, sessionSecureToken: token, sessionTimeoutMinutes: minutes });
export const PING_OK = (minutes = 30) =>
  `<?xml version="1.0" encoding="UTF-8"?><nyw:Keepalive_Response xmlns:nyw="urn:com.netyourwork/aod" nyw:Session_Timeout_Minutes="${minutes}"/>`;
