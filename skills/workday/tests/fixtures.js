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
