Advanced Authoring
3 quick links
Build a FluffyPack

Create a FluffyPack with clear guidance, optional knowledge, and a welcome experience that helps people start well.

Choose the Right FluffyPack
Slack Channel Setup
Register an Integration

Use the builder when you want to create a guided FluffyJaws experience for a team, product, or workflow. A strong pack helps people start quickly, stay on task, and use the right sources without learning the underlying setup.

Good team packs usually combine three decisions: what job the pack should do, what sources it is allowed to use, and who can maintain it. Keep those decisions explicit so other people understand when to use the pack and who owns updates.

Build the pack in this order
Define the job Write a clear name and instructions. Use the optional description to explain the business impact, value brought, and intended audience.
Shape the first screen Design a welcome surface that helps people start with the right prompt.
Add knowledge when needed Add only the sources the pack should rely on. Leave this empty when the pack should work from its custom instructions alone.
Configure integrations Use the available integration cards to bring in only the modules the pack needs. Add Slack reply coverage when the pack should answer in channels, Marketplace only for a carefully selected set of specialists, and standard FluffyJaws tools only as fallback.
Set access and ownership Decide who can use the pack and who can update it.
Review before saving Use the final review step to check the full setup and the exact changes that will be saved, then save once at the end.
What teams can include
Instructions define the pack's role, tone, constraints, and expected output shape.
Welcome experience gives people a useful first screen with quick starts and structured prompts.
Indexed knowledge sources connect the pack to searchable Slack, wiki, docs, Jira, GitHub, SharePoint, Field Readiness, AEM Live, or Skyline Runbook scopes.
Exact SharePoint files let the pack inspect fixed documents, spreadsheets, or reports when exact file content matters.
Native tools add selected FluffyJaws tools only when pack-specific sources are not enough.
Marketplace agents attach selected external specialists to the pack.
Slack reply channels let the pack answer from configured Slack channels.
Access rules and admins separate who can use the pack from who can maintain its setup.
Insights show owners and admins adoption, active users, and recent activity metadata.
Review usage with Insights

After a FluffyPack is saved, config admins can open Insights from the FluffyPack manager or from the setup header. Insights shows adoption and usage analytics for the selected pack:

conversations, people using it, messages, and last-used date
daily activity for the last 7, 30, or 90 days
top people by recent activity
recent activity rows without message text or conversation transcripts

Insights is for FluffyPack owners and configured admins. People who can only use a pack do not see the Insights action. The dashboard is pack-scoped and uses activity metadata only; it is not the global Stats dashboard and does not expose message content.

Design the welcome experience

The builder customizes the welcome surface and pack-specific panels. It does not replace the main chat shell.

Start with the basic controls:

Pick an accent color.
Choose a layout preset.
Add a hero section.
Add a promptGrid or accordion.
Add markdown or cardGrid only when users need more explanation before they begin.

Use advanced controls only when you need compact density, explicit section placement, or exact color values.

Choose knowledge sources carefully

Good packs search the smallest useful set of sources.

Think about knowledge in two buckets:

Indexed knowledge sources for normal retrieval

Runtime files for exact SharePoint documents or spreadsheets the pack should inspect directly

Use the guided picker for Slack channels.

Use indexed search to pick Experience League, HelpX, and Developer docs scopes.

Use repository search for GitHub scopes, then narrow to a folder only when needed.

Use the search-and-pick flow for Field Readiness spots or lists.

Use the wiki space and page fields to validate a space first, then narrow to a page only when needed.

Paste a SharePoint site, Site Pages, folder, or file URL directly and let the builder detect the scope for you.

The add-source button stays disabled until the current source entry is valid.

Runtime file guidance is optional and limited to 500 words per file.

Slack reply channels and Slack search scope solve different problems:

reply channels decide where Slack responses appear
Slack datasource scopes decide what the pack can search
FluffyPack Slack reply channels currently use the production auto-answer behavior. Ping-only mode is not exposed in the pack builder yet.

Advanced integrations stay scoped:

Marketplace agents are selected one by one per pack from the Marketplace integration card
Marketplace API calls use configured FluffyJaws service credentials when available, otherwise the current Okta user session
Marketplace packs still require a normal FluffyJaws user session; pure service-token chats do not get Marketplace tools
only Okta-backed, credential-free default Marketplace agents are currently supported in packs
standard FluffyJaws tools such as full_documentation_search are disabled by default and should be added with caution
pack-specific search should stay the first choice whenever custom_search or other pack tools can answer the request
Use files only when the pack needs exact material

Some workflows need a fixed spreadsheet, report, or reference file. Add exact files only when the pack must work from that specific material rather than general search.

Supported section types
hero: title, body, optional kicker, visual, and a primary prompt action
accordion: collapsible questions, FAQs, or step-by-step guidance
markdown: formatted explanatory copy
cardGrid: expandable cards with optional prompt actions
promptGrid: grouped quick-start prompts
tabGroup: tabbed groupings of child sections
Theme inputs and color formats

The manual accent field accepts:

#rgb
#rrggbb
rgb(...)
rgba(...)

Use the icon picker instead of typing icon names manually. That keeps the saved config aligned with the icons the runtime already supports.

Saved shape

The builder stores the pack experience in uiConfig:

schemaVersion
theme
experience.sections
Example
Copy
{
  "schemaVersion": 1,
  "theme": {
    "accentColor": "#0265dc",
    "layoutPreset": "spotlight",
    "density": "comfortable",
    "heroStyle": "accent"
  },
  "experience": {
    "sections": [
      {
        "id": "hero-1",
        "type": "hero",
        "title": "Welcome to the pack",
        "body": "Start with a case summary, then drill into the details.",
        "primaryAction": {
          "label": "Prepare a case review",
          "prompt": "Prepare a case review using the pack context.",
          "submitMode": "fill"
        }
      },
      {
        "id": "prompt-grid-1",
        "type": "promptGrid",
        "title": "Quick starts",
        "placement": "belowInput",
        "prompts": [
          {
            "title": "Review a case",
            "prompt": "Review the current case and cite the key facts."
          }
        ]
      }
    ]
  }
}

