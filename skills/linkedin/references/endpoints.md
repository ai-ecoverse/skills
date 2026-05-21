# LinkedIn Voyager API Endpoints

Base URL: `https://www.linkedin.com/voyager/api`
Auth: Cookie-based (li_at session cookie) + CSRF token from JSESSIONID cookie
Origin: Must be linkedin.com (page-context fetch required)

## Company Info

- Company URN: `urn:li:fsd_company:122314561`
- Company ID: `122314561`
- Page Name: AI Ecoverse

## Create Post (GraphQL Mutation)

### POST /graphql?action=execute&queryId=voyagerContentcreationDashShares.279996efa5064c01775d5aff003d9377

Creates a new post on the company page.

**Required Headers:**
```
content-type: application/json; charset=UTF-8
csrf-token: <JSESSIONID cookie value>
x-restli-protocol-version: 2.0.0
accept: application/vnd.linkedin.normalized+json+2.1
x-li-lang: en_US
x-li-pem-metadata: Voyager - Sharing - CreateShare=sharing-create-content,Voyager - Organization - Admin=organization-create-post-as-page
```

**Request Body:**
```json
{
  "variables": {
    "post": {
      "allowedCommentersScope": "ALL",
      "intendedShareLifeCycleState": "PUBLISHED",
      "origin": "ORGANIZATION",
      "visibilityDataUnion": { "visibilityType": "ANYONE" },
      "commentary": { "text": "Your post text here.", "attributesV2": [] },
      "nonMemberActorUrn": "urn:li:fsd_company:122314561"
    }
  },
  "queryId": "voyagerContentcreationDashShares.279996efa5064c01775d5aff003d9377",
  "includeWebMetadata": true
}
```

**Success Response (200):**
```json
{
  "data": {
    "data": {
      "createContentcreationDashShares": {
        "resourceKey": "urn:li:fsd_share:urn:li:share:7463310235823370240",
        "*entity": "urn:li:fsd_share:urn:li:share:7463310235823370240"
      }
    }
  }
}
```

## List Posts (GraphQL Query)

### GET /graphql?includeWebMetadata=true&variables=(...)&queryId=voyagerFeedDashOrganizationalPageAdminUpdates.96fdd4f5900fb8a434c2a3286b1952c2

Lists posts from the company page admin view with engagement counts in `included`.

**Variables (RESTLI format):**
```
(organizationalPageFeedUseCase:ADMIN_ORGANIZATIONAL_PAGE_POSTS,organizationalPageIdOrUniversalName:(organizationalPageUUId:122314561),start:0,count:10)
```

**Response includes:**
- `included[].commentary.text` — post text
- `included[].entityUrn` with `fsd_socialActivityCounts` — per-post engagement:
  - `numComments`, `numShares`, `numLikes`, `reactionTypeCounts[]`

## Get Comments

### GET /graphql?includeWebMetadata=true&variables=(...)&queryId=voyagerSocialDashComments.afec6d88d7810d45548797a8dac4fb87

Fetches comments on a specific post.

**Variables (RESTLI format):**
```
(count:20,numReplies:3,nonMemberActorUrn:urn%3Ali%3Afsd_company%3A122314561,socialDetailUrn:urn%3Ali%3Afsd_socialDetail%3A%28urn%3Ali%3Aactivity%3AXXXX%2Curn%3Ali%3Aactivity%3AXXXX%2Curn%3Ali%3AhighlightedReply%3A-%29,sortOrder:RELEVANCE,start:0)
```

**socialDetailUrn format:**
```
urn:li:fsd_socialDetail:(urn:li:activity:XXXX,urn:li:activity:XXXX,urn:li:highlightedReply:-)
```

**Response `included` contains:**
- Comment objects with `commentary.text`, `commenter`, `createdTime`
- Commenter profile mini-objects

## Create Comment

### POST /voyagerSocialDashNormComments?decorationId=com.linkedin.voyager.dash.deco.social.NormComment-43

Creates a comment on a post as the company page.

**Request Body:**
```json
{
  "commentary": {
    "text": "Comment text here",
    "attributesV2": [],
    "$type": "com.linkedin.voyager.dash.common.text.TextViewModel"
  },
  "threadUrn": "urn:li:activity:7463311119181312000",
  "nonMemberActorUrn": "urn:li:fsd_company:122314561"
}
```

**Response (201):**
```json
{
  "data": {
    "entityUrn": "urn:li:fsd_normComment:urn:li:fsd_comment:(COMMENT_ID,urn:li:activity:ACTIVITY_ID)"
  }
}
```

## Get Reactions

### GET /graphql?includeWebMetadata=true&variables=(...)&queryId=voyagerSocialDashReactors.78aa0bb67da9cc9ca4d58fd093d72e6b

Fetches individual reactors on a post.

**Variables:**
```
(count:20,socialDetailUrn:urn%3Ali%3Afsd_socialDetail%3A(...),start:0)
```

## Profile Lookup

### GET /identity/dash/profiles?q=memberIdentity&memberIdentity=MEMBER_URN&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-118

Fetches full profile data by member URN (e.g., `ACoAAAAyzagBI3CieVJqv511Ft1kEK2TRvcjuHM`).

**Response `included` contains:**
- Profile objects: `firstName`, `lastName`, `headline`, `publicIdentifier`, `industryName`, `geoLocationName`, `summary`
- Position objects: `title`, `companyName`, `timePeriod`
- Education, skills, etc.

**Vanity name resolution:** Navigate to `/in/<vanityName>/` and extract the member URN from page HTML (pattern: `ACoA[A-Za-z0-9_-]{30,50}`).

## Notes

- QueryId values are version-pinned. If they stop working (404/500), re-capture from the LinkedIn UI.
- Current client version: `1.13.44276` (as of 2026-05-21)
- All requests must include CSRF token from JSESSIONID cookie
- The `nonMemberActorUrn` field tells LinkedIn to act as the company page, not the personal profile
