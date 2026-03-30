# Suno UI Automation Reference

Automate song submission to Suno's Create page using `playwright-cli` commands. Requires a browser with an active Suno session.

## Prerequisites

A persistent browser session with Suno auth cookies is required. **Always try to reuse an existing session before starting a new one** — see Session Management below.

## Session Management

Playwright-cli daemon sessions persist across agent invocations. Reuse them to avoid repeated login.

### Check for existing sessions

Daemon sessions live at `~/Library/Caches/ms-playwright/daemon/`. Each daemon directory contains `<name>.session` files and `<name>.sock` sockets.

```bash
# Check if a "suno" session already exists
ls ~/Library/Caches/ms-playwright/daemon/*/suno.session 2>/dev/null
```

### Connect to an existing session

If a `suno.session` file exists, connect to it directly — it likely has Suno auth cookies:

```bash
playwright-cli --session=suno snapshot
```

This connects to the running daemon and takes a snapshot. If it works, you're ready — skip to the login check below.

### Start a new session

If no existing session is found, start a fresh one:

```bash
playwright-cli open --headed --persistent --session=suno https://suno.com/create
```

The `--session=suno` flag names the session so future agents can reconnect to it.

### Verify login state

After connecting (whether to an existing or new session), check that the user is logged in:

```bash
playwright-cli --session=suno snapshot
```

Look for the Create form elements (the "Custom" button, lyrics textbox, styles textbox). If you see a login/signup button instead, the session is unauthenticated.

**If not logged in**, inform the user and poll until they complete manual login:

```bash
# Tell the user: "Please log in to Suno in the browser window."
# Then poll every 5-10 seconds:
playwright-cli --session=suno snapshot
# Check for Create form elements in the snapshot output.
# Repeat until the Create form appears (the "Custom" button is visible).
```

Don't fail on auth — the browser window is visible (`--headed`), so the user can log in manually. Keep polling with snapshots until the Create form appears, then proceed with the automation flow.

## Step-by-Step Flow

### 1. Navigate to Create Page

```bash
playwright-cli goto https://suno.com/create
```

### 2. Select Custom Mode

Take a snapshot to get current element refs, then click the Custom button:

```bash
playwright-cli snapshot
playwright-cli click <ref-for-Custom-button>
```

The Custom button has aria label "Custom".

### 3. Select Persona (if song has a persona)

If the user has Suno Persona Voices configured and the song specifies one, select it:

```bash
# Click Add Persona button
playwright-cli click <ref-for-Add-Persona>

# Wait for dialog, then snapshot to find the search box
playwright-cli snapshot

# Search for the persona by name
playwright-cli fill <ref-for-search-textbox> "Persona Name"

# Wait for results to filter (~500ms), then snapshot
sleep 1
playwright-cli snapshot

# Click the matching persona row
playwright-cli click <ref-for-persona-row>
```

The Persona dialog contains:
- Title: "Personas"
- Tabs: "My Personas" / "Favorites"
- Search textbox with placeholder "Search"
- Persona rows with `[cursor=pointer]` containing the persona name

The dialog closes automatically after selection and the persona appears on the Create form.

### 4. Enter Lyrics

For multiline lyrics, use `run-code` with template literals:

```bash
playwright-cli run-code "async page => {
  const lyrics = \`[Verse 1]
Line one of the verse
Line two of the verse

[Chorus]
The hook goes here\`;
  await page.getByPlaceholder('Write some lyrics').fill(lyrics);
}"
```

The lyrics textbox has placeholder: "Write some lyrics or a prompt — or leave blank for instrumental"

### 5. Enter Styles

The styles textbox has a dynamic placeholder showing random style suggestions (e.g., "arpeggiator, emotional beats, hypnotizing, positive soul, islamic"). If a persona was selected, it will be pre-filled with the persona's default styles.

The most reliable approach is snapshot + ref:

```bash
# Snapshot to find the styles textbox ref
playwright-cli snapshot
# The styles textbox appears below Lyrics, above Advanced Options
# Its accessible name includes the random placeholder text
playwright-cli fill <ref-for-styles-textbox> "indie folk, fingerpicked acoustic, warm vocals, 100 BPM"
```

Alternative using `run-code` — match by the random placeholder text visible in the snapshot:

```bash
playwright-cli run-code "async page => {
  // The accessible name includes the placeholder text, which changes randomly
  // Use a regex matching one of the style suggestions visible in the snapshot
  const styleBox = page.getByRole('textbox', { name: /arpeggiator|emotional beats/ });
  await styleBox.fill('indie folk, fingerpicked acoustic, warm vocals, 100 BPM');
}"
```

**Note**: When a persona is selected, the styles textbox gets pre-filled with the persona's default styles. `fill()` replaces the content entirely — no need to clear first.

### 6. Set Song Title (optional)

**Important**: `getByPlaceholder('Song Title')` resolves to 2 elements (a hidden one and the visible one), causing a strict mode violation. Use snapshot + ref or the full placeholder text:

```bash
# Option A: snapshot + ref (most reliable)
playwright-cli snapshot
playwright-cli fill <ref-for-Song-Title-textbox> "My Song Title"

# Option B: use the exact role and full name
playwright-cli run-code "async page => {
  await page.getByRole('textbox', { name: 'Song Title (Optional)' }).fill('My Song Title');
}"
```

### 7. Configure Advanced Options

```bash
playwright-cli run-code "async page => {
  // Expand advanced options if collapsed
  const advBtn = page.getByRole('button', { name: 'Advanced Options' });
  const slidersVisible = await page.getByRole('slider').first().isVisible().catch(() => false);
  if (!slidersVisible) {
    await advBtn.click();
  }

  // Set exclude styles (optional)
  await page.getByPlaceholder('Exclude styles').fill('no trap, no pop');

  // Select vocal gender — see 'Female/Manual Button' section below
  // Select lyrics mode — see 'Female/Manual Button' section below
}"
```

#### Slider Interaction

The Weirdness, Style Influence, and Audio Influence sliders are **custom React `<div role="slider">` elements**, NOT native `<input type="range">`. Standard `.fill()` does NOT work.

**Working approach — keyboard arrows** (step=1 per keypress):

```js
async function setSlider(page, label, targetValue) {
  const slider = page.getByLabel(label);
  await slider.focus();
  await page.waitForTimeout(100);
  const current = parseInt(await slider.evaluate(
    el => el.getAttribute("aria-valuenow")
  ));
  const delta = targetValue - current;
  const key = delta > 0 ? "ArrowRight" : "ArrowLeft";
  for (let i = 0; i < Math.abs(delta); i++) {
    await page.keyboard.press(key);
  }
}
```

```bash
playwright-cli run-code "async page => {
  async function setSlider(page, label, targetValue) {
    const slider = page.getByLabel(label);
    await slider.focus();
    await page.waitForTimeout(100);
    const current = parseInt(await slider.evaluate(
      el => el.getAttribute('aria-valuenow')
    ));
    const delta = targetValue - current;
    const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
    for (let i = 0; i < Math.abs(delta); i++) {
      await page.keyboard.press(key);
    }
  }

  await setSlider(page, 'Weirdness', 40);
  await setSlider(page, 'Style Influence', 70);
}"
```

**Warnings:**
- `getByRole('slider').nth(0)` finds the disabled playback progress `<input type="range">` — use `getByLabel()` instead
- DOM attribute manipulation (`setAttribute("aria-valuenow")`) does NOT update React state
- If Advanced Options is collapsed when you manipulate sliders, values reset on re-expand

#### Female/Manual Button

`page.getByRole('button', { name: 'Female' })` fails with strict mode when lyrics contain the word "Female". Same for "Manual", "Male", etc. — Playwright matches role buttons by text content, and lyric text creates duplicate matches.

**Working approach — iterate `div[role=button]` elements with exact text match:**

```js
const buttons = await page.$$("div[role=button]");
for (const btn of buttons) {
  const text = await btn.textContent();
  if (text && text.trim() === "Female") { await btn.click(); break; }
}
```

```bash
playwright-cli run-code "async page => {
  // Select vocal gender: 'Female'
  const genderButtons = await page.$$('div[role=button]');
  for (const btn of genderButtons) {
    const text = await btn.textContent();
    if (text && text.trim() === 'Female') { await btn.click(); break; }
  }

  // Select lyrics mode: 'Manual'
  const modeButtons = await page.$$('div[role=button]');
  for (const btn of modeButtons) {
    const text = await btn.textContent();
    if (text && text.trim() === 'Manual') { await btn.click(); break; }
  }
}"
```

Alternatively, use snapshot + ref when available — the ref-based approach avoids the text-matching ambiguity entirely.

### 8. Create the Song

```bash
playwright-cli run-code "async page => {
  await page.getByRole('button', { name: 'Create song' }).click();
}"
```

The Create button is orange and at the bottom-right of the form panel.

## Complete Example: Submitting a Song

This example submits a folk rock song with lyrics, styles, and title. Each step requires a fresh snapshot because refs change. Assumes a "suno" session is already connected (see Session Management above).

```bash
# 1. Navigate to Create page
playwright-cli --session=suno goto https://suno.com/create

# 2. Snapshot and select Custom mode
playwright-cli snapshot
# Find button "Custom" in the snapshot — click its ref
playwright-cli click <ref-for-Custom-button>

# 3. Enter lyrics (multiline — must use run-code)
playwright-cli run-code "async page => {
  const lyrics = \`[Verse 1]
Morning light through dusty glass
Coffee rings on yesterday's news
The garden gate still won't quite latch
But I've stopped minding

[Chorus]
Let the whole thing rust
Let the whole thing rust
Some things hold better
When you loosen up\`;
  await page.getByPlaceholder('Write some lyrics').fill(lyrics);
}"

# 4. Enter styles (snapshot first to find the textbox ref)
playwright-cli snapshot
# Find the styles textbox ref (its accessible name includes random placeholder text)
playwright-cli fill <ref-for-styles-textbox> "indie folk rock, fingerpicked acoustic guitar, warm male vocal, gentle harmonica, lo-fi warmth, 98 BPM"

# 5. Set title (snapshot first to get the visible textbox ref)
playwright-cli snapshot
# Find textbox "Song Title (Optional)" — fill its ref
playwright-cli fill <ref-for-Song-Title-textbox> "Let It Rust"

# 6. Create the song
playwright-cli snapshot
# Find button "Create song" — should now be enabled (has [cursor=pointer])
playwright-cli click <ref-for-Create-song-button>
```

After clicking Create, Suno generates two variations. Both appear in the song list with disabled Play buttons while generating.

## Deleting Songs

Move songs to trash via the `...` menu on each song row.

### Step-by-Step Flow

1. **Take a snapshot** to get current element refs for the song list in the right-hand panel:

```bash
playwright-cli snapshot
```

2. **Find the target song row** — each row shows the song title as a link. Locate the row containing the song you want to delete.

3. **Click the `...` (more options) button** — this is an unlabeled `button` at the end of each song row. It contains only an `img` child and has no text label or aria-label. Find it by locating the button element nearest to the target song title in the accessibility tree.

```bash
playwright-cli click <ref-for-more-options-button>
```

4. **A popover menu appears** with `menuitem` elements including "Rename", "Add to Playlist", "Download", "Move to Trash", and others. Snapshot to get refs:

```bash
playwright-cli snapshot
```

5. **Click "Move to Trash"** — a `menuitem` with the text "Move to Trash":

```bash
playwright-cli click <ref-for-Move-to-Trash-menuitem>
```

6. **The song is removed immediately** — no confirmation dialog. A toast alert appears saying "{Song Title} has been moved to trash" with an "Undo" button. The toast disappears after a few seconds.

### Deleting Both Variants

Suno creates **two variants** for each song submission. Both must be trashed separately:

```bash
# 1. Snapshot and find the first variant
playwright-cli snapshot
# Find the ... button for the target song row
playwright-cli click <ref-for-more-options-button>

# 2. Snapshot the popover, click Move to Trash
playwright-cli snapshot
playwright-cli click <ref-for-Move-to-Trash-menuitem>

# 3. Re-snapshot — the second variant is still in the list
#    Refs have changed, so a fresh snapshot is required
playwright-cli snapshot
# Find the ... button for the remaining variant
playwright-cli click <ref-for-more-options-button>

# 4. Snapshot the popover again, click Move to Trash
playwright-cli snapshot
playwright-cli click <ref-for-Move-to-Trash-menuitem>
```

### Important Notes

- **No confirmation dialog** — "Move to Trash" takes effect immediately.
- **Undo is time-limited** — the toast with "Undo" disappears after a few seconds.
- **Two variants per submission** — always check for and trash both.
- **Re-snapshot after each deletion** — element refs change when the list updates.

## Form State Between Submissions

When submitting multiple songs in sequence, the Create form retains some state:

- **Persists**: Persona selection, lyrics, styles text, Female/Manual setting, Advanced Options expansion state
- **Resets**: Title field gets cleared, slider values may reset
- **Implication**: For sequential submissions with the same persona/lyrics, only change title, styles, and slider values — no need to re-select persona or re-enter lyrics

## Debugging Tips

- `console.log()` in `run-code` is unreliable for getting values back to the caller
- Use the **page title hack** to extract data from the browser context:

```js
await page.evaluate((data) => {
  document.title = JSON.stringify(data);
}, result);
```

The title appears in `playwright-cli run-code` output under "Page Title:", making it a reliable channel for returning values from `page.evaluate()`.

## Tips and Gotchas

- **Reuse sessions**: Always check for an existing "suno" session before starting a new browser. Reused sessions retain auth cookies, saving login time.
- **Refs change between snapshots**: Always take a fresh `playwright-cli snapshot` before interacting. Element ref IDs are ephemeral.
- **Styles textbox identification**: The styles textbox has a random placeholder that changes each session. When a persona is selected, it gets pre-filled with the persona's default styles. Use snapshot + ref to target it reliably.
- **Multiline content**: `playwright-cli fill` does not handle newlines well. Use `playwright-cli run-code` with template literals for lyrics.
- **Song Title strict mode**: `getByPlaceholder('Song Title')` resolves to 2 elements (one hidden, one visible). Use snapshot + ref, or `page.getByRole('textbox', { name: 'Song Title (Optional)' })` to avoid strict mode violations.
- **Persona pre-fills styles**: After selecting a persona, the styles textbox is auto-filled with the persona's defaults. `fill()` replaces them entirely.
- **Slider values**: Sliders are custom React `<div role="slider">` elements (0-100). `.fill()` does NOT work — use the `setSlider()` keyboard arrow approach documented in section 7. Use `getByLabel()` not `getByRole('slider')` to avoid matching the playback progress bar.
- **Persona dialog latency**: The persona search takes ~500ms to filter. Add a `sleep 1` or re-snapshot after filling the search box.
- **The Create button**: Orange, bottom-right of the form panel. Aria label "Create song". Disabled until lyrics or styles are provided.
- **Two variations**: Suno generates two song variations per submission. Both appear in the workspace list.
- **Workspace selector**: Songs save to "My Workspace" by default. Click the workspace dropdown to change.
