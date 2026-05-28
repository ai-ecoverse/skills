Advanced Integration
3 quick links
Register an Integration

Register the Okta client and ownership details FluffyJaws needs for production service access.

API Guide
MCP Guide
Open Integrations

Use this when your service needs long-lived production access with a registered service identity.

Recommended setup order
Create or choose the Okta app that will request service tokens.
Sign in to FluffyJaws and open the registration workspace.
Register the client ID, owners, and usage details.
Request a service token and call the API.
Who should use this

Register your integration if:

your service will call FluffyJaws in production
you need app-owned service-token access
your team needs ownership, governance, and usage visibility for that integration
Create or reuse the Okta app

If you already have an Okta app that can request client_credentials tokens and the fluffyjaws scope, you can reuse it. You do not need to create a special FluffyJaws-only app if your existing client is already appropriate for the integration.

If you are creating a new app, the simplest path is:

Open https://oss.corp.adobe.com/okta/.
Register a new application.
Choose OpenID Connect.
Choose Service as the application type.
Save the client ID and client secret.
Confirm the app can request the fluffyjaws scope.

This is the recommended default because it gives you a clean service identity for automation.

What you need to register
application name
external application ID
Okta client ID used for the service token
one primary owner and any additional owners
required business-case and impact description
optional CORS origins for browser-hosted public API callers
Example registration

Use the fields below as a model for what a complete registration looks like:

application name: Release Notes Assistant
external application ID: release-notes-assistant-prod
Okta client ID: 0oa123example456XYZ7
primary owner: <owner@adobe.com>
business impact description: Summarizes release notes and deployment updates for support handoffs.
CORS origins: https://release-notes.example.com, https://*.entapp.adproto.com
Browser CORS origins

Use CORS origins only when a browser-hosted app calls public /api/v1/* routes directly.

exact origin: https://app.example.com
wildcard subdomain origin: https://*.entapp.adproto.com
bare wildcard input such as *.entapp.adproto.com is normalized to HTTPS
HTTPS is required
paths, query strings, fragments, credentials, and non-leftmost wildcards are rejected
wildcard origins match subdomains only, not the apex domain
each app can store up to 20 origins
What registration unlocks
service client allowlisting
owner mapping for production support and governance
usage analytics by app, owner, and integration path
owner-managed CORS access for public API browser clients
generated snippets that match your registered client
Managing many integrations

The integrations workspace is paginated so teams can manage large app inventories without loading every registration at once. Owned apps and admin search results show the first page ordered by most recent usage, then by app update and creation time. Use Load more when you need older or inactive registrations.

Usage inspection focuses on aggregates first:

endpoint totals with request and error counts
MCP tool totals
error status totals
bounded recent activity

Recent activity defaults to recent errors so high-volume apps do not flood the page. Switch to all activity when you need a small mixed sample of successful and failed calls.

Owners and admins can suspend, reactivate, or delete registrations. Delete asks for confirmation, removes the registration, owners, and CORS origins, and keeps existing telemetry without the deleted app assignment.

Important notes
use the versioned public /api/v1/* routes for integrations
valid registrations are auto-approved
the allowlist is stored in FluffyJaws data, not only in environment variables
suspended app registrations keep stored CORS origins, but those origins are not active
owner mappings are resolved from FluffyJaws users, so owners should have signed in once first
app registration and ownership management are human workflows; they require a direct browser or bearer-user session, not service credentials

Open the registration workspace in FluffyJaws to create and review your owned app records.
