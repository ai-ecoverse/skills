# Portal walkthrough (recorded)

Recorded with `playwright-cli recording-start` on 2026-11-18 while registering
`ai.sliccy.mac` with iCloud and creating its Developer ID profile. The comments are the
`--intent` of each step. Use it for portal flows the CLI doesn't cover yet. Locators
such as `#react-select-2-option-3` depend on the list's order on that day.

```js
// open Identifiers list
await page.goto('https://developer.apple.com/account/resources/identifiers/list');
// Add new identifier
await page.getByRole('link', { name: 'Add new identifier' }).click();
// Continue with App IDs
await page.getByRole('button', { name: 'Continue' }).click();
// type App
await page.getByRole('heading', { name: 'App', exact: true }).click();
await page.locator('#bundle').check();
// Continue
await page.getByRole('button', { name: 'Continue' }).click();
// App ID description
await page.getByRole('textbox', { name: 'Description' }).click();
await page.getByRole('textbox', { name: 'Description' }).fill('Sliccy');
// Bundle ID
await page.getByRole('textbox', { name: 'Bundle ID' }).click();
await page.getByRole('textbox', { name: 'Bundle ID' }).fill('ai.sliccy.mac');
// enable iCloud capability
await page.getByRole('checkbox', { name: 'iCloud', exact: true }).check();
// Continue to review App ID
await page.getByRole('button', { name: 'Continue' }).click();
// Register App ID ai.sliccy.mac
await page.getByRole('button', { name: 'Register' }).click();
// Register a new provisioning profile
await page.goto('https://developer.apple.com/account/resources/profiles/add');
// type Developer ID
await page.getByLabel('Developer IDCreate a Developer ID provisioning profile to use Apple services with your Developer ID signed applications.').check();
// Continue
await page.getByRole('button', { name: 'Continue' }).click();
// open App ID picker
await page.getByText('Select...').click();
// select App ID ai.sliccy.mac
await page.locator('#react-select-2-option-3').click();
// Continue to certificates
await page.getByRole('button', { name: 'Continue' }).click();
// select Developer ID Application cert (serial 714FB0EAF0BEA248)
await page.getByRole('radio', { name: 'Lars Trieloff (Developer ID Application)Feb 01, 2027' }).check();
// Continue to review
await page.getByRole('button', { name: 'Continue' }).click();
// profile name
await page.getByRole('textbox', { name: 'Provisioning Profile Name' }).click();
await page.getByRole('textbox', { name: 'Provisioning Profile Name' }).fill('Sliccy Developer ID iCloud');
// Generate profile
await page.getByRole('button', { name: 'Generate' }).click();
```
