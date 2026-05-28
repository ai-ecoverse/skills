Advanced Slack Setup
2 quick links
Slack Channel Setup

Make Slack channels appear in the picker, understand why some saves are rejected, and learn how channel sync works.

Slack Channel Configuration
Build a FluffyPack

Use this guide when a Slack channel is missing from the picker, a save says FluffyJaws cannot access the channel, or you want to understand how the channel list works.

This applies to both:

FluffyJaws routing in Integrations -> Slack
FluffyPack reply channels in the Integrations step of the pack builder
How the channel picker works

The picker does not search Slack directly on every keystroke.

It uses FluffyJaws's synced channel list and only shows channels where FluffyJaws is already a member. In practice that means:

the channel must exist in the synced list
FluffyJaws must already be in the channel
newly invited channels can take a few minutes to appear
Required setup order
Add the FluffyJaws Slack app to the channel.
Wait a few minutes for the channel list to refresh.
Search for the channel in FluffyJaws again.
Save the FluffyJaws or FluffyPack configuration.

If you skip step 1 or step 2, the channel can stay invisible in the picker or the save can fail with an access error.

Why a channel can still be missing

The most common reasons are:

FluffyJaws was not added to the channel yet
the channel list has not refreshed yet
the channel exists in Slack, but FluffyJaws is not recognized as a member yet

If the channel still does not appear after several minutes, try removing and re-adding the FluffyJaws app to the channel.

FluffyJaws vs FluffyPack
Use Integrations -> Slack when the channel should use FluffyJaws directly.
Use a FluffyPack reply channel when the channel should use a specialized assistant.
If both are configured for the same channel, the FluffyPack takes priority.
Slack reply channels decide which assistant responds. Slack data sources decide what it can search.
FluffyPack reply channels currently use Slack bot v1 auto-answer behavior. The pack builder does not expose ping-only mode while Slack bot v2 remains in testing.
