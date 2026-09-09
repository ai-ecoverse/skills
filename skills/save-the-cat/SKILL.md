---
name: save-the-cat
description: Screenwriting assistant using Blake Snyder's Save the Cat! methodology. Helps with high-concept ideas, loglines, hero design, the 15-beat Beat Sheet (BS2), the Board, story genres, and diagnostics. Use when writing screenplays, developing movie structure, creating beat sheets, crafting loglines, building a board, or analyzing script structure, previewing .fountain files, or leaving scene and dialogue feedback on a screenplay.
allowed-tools: bash
command: fountain
script: scripts/fountain.jsh
---

> **Attribution**: This skill provides original reference guides inspired by Blake Snyder's *Save the Cat!* methodology. It is not affiliated with or endorsed by Blake Snyder Enterprises. For the complete methodology, please refer to the original *Save the Cat!* books. All content in these files is an independent summary intended for educational use.

# Save the Cat! Screenwriting Assistant

Develop and diagnose screenplays using Blake Snyder's Save the Cat! framework.
Use the reference guides for story decisions and the Fountain preview for
feedback on the actual script.

## Preview and review a Fountain screenplay

Keep the screenplay in a `.fountain` source file. The bundled `fountain` command
renders title pages, scene headings, action, dialogue, parentheticals, dual
dialogue, transitions, emphasis, and page breaks. It includes the MIT-licensed
[fountain-js 1.2.4 parser](assets/vendor/fountain-js/README.md); no network or
package installation is needed at runtime.

```sh
fountain render /shared/draft.fountain --out /shared/draft.html
fountain review /shared/draft.fountain
```

For a concrete first input, save this as `/shared/draft.fountain`:

```fountain
Title: Night Shift
Author: Example Writer

INT. OBSERVATORY - NIGHT

A green light blinks in the empty room.

MARA
(quietly)
Somebody is still out there.
```

Before `fountain review`, install the `review` skill, follow its Quick-Start
Workflow to assign the owning scoop, and run `sprinkle open review`. If the
panel template is not installed yet, copy it first:

```sh
mkdir -p /shared/sprinkles/review
cp /workspace/skills/review/templates/review.shtml /shared/sprinkles/review/review.shtml
sprinkle refresh
sprinkle open review
```

`fountain review` adds the source to the queue and opens its rendered screenplay
in Review's iframe. If Review is closed, it reports a
delivery error; open the panel and retry.

In the preview, click a scene, action paragraph, or dialogue block, or select a
passage. Type a comment and choose **Save comment**. Comments remain drafts when
the user switches assets or reloads. **Send to agent** explicitly dispatches the
collected feedback with the source path, quote, scene, and token anchor.

When handling a `submit-revisions` event, edit the `.fountain` source, matching
the quoted text and scene against the current file before changing it. Treat
token indexes as hints: inserting an earlier scene shifts them. Do not edit the
generated HTML. Follow Review's batch acknowledgement protocol after applying
or failing a batch, then reload the preview to verify the source renders.
Saving a comment alone does not authorize an edit.

For renderer options, limitations, and the JSON contract consumed by Review,
read [references/fountain.md](references/fountain.md).

## Quick Reference

### Structure and genre

Use the 15-beat Beat Sheet to map the hero's change across setup, disruption,
choice, rising stakes, loss, and resolution. Read
[references/beat-sheet.md](references/beat-sheet.md) for every beat, its page
target, and examples; verify the opposing Opening/Final Images and
Midpoint/All Is Lost before building scenes.

Choose the story's structural genre before developing the Board. Read
[references/genres.md](references/genres.md) for the ten Snyder genres and their
required ingredients, then justify the choice against the actual premise.

### Logline Formula

A winning logline has four elements:
1. **Irony** - emotionally intriguing hook
2. **Compelling mental picture** - whole movie blooms in mind
3. **Audience and cost** - clear tone and scope
4. **Killer title** - says what it is cleverly

**For complete logline framework**: See [references/logline.md](references/logline.md)

### High-Concept "What Is It?"

**The question:** Can you pitch the movie in one irresistible sentence that a stranger instantly "gets"?

**For high-concept and test-pitching**: See [references/high-concept.md](references/high-concept.md)  
**For idea-generation games**: See [references/idea-games.md](references/idea-games.md)

### Hero Design ("It's About a Guy Who...")

Design the hero to serve the idea, maximize the journey, and keep casting broad (write for archetype, not a single star).

**For hero design & archetypes**: See [references/hero.md](references/hero.md)

### The Board (40 Card Method)

See the movie before you write it. Use 40 scene cards across 4 rows to troubleshoot structure and weave storylines.

**For Board setup and usage**: See [references/board.md](references/board.md)

## Workflows

### Writing a New Screenplay

Copy this checklist:
- [ ] Nail a high-concept "What is it?" and test-pitch it out loud
- [ ] Develop logline with all four elements (irony, picture, audience, title)
- [ ] Tune the hero to the idea (longest journey, primal goal, archetype fit)
- [ ] Identify which of the 10 genres your story fits
- [ ] Study genre requirements and ensure your concept meets them
- [ ] Create the Beat Sheet - fill in all 15 beats with page targets
- [ ] Identify the "Six Things That Need Fixing" for Set-Up
- [ ] Ensure Opening Image and Final Image are opposites
- [ ] Verify Midpoint and All Is Lost are opposites (up/down)
- [ ] Check that hero CHOOSES Break into Two (not lured or tricked)
- [ ] Confirm "whiff of death" at All Is Lost
- [ ] Build The Board: 40 scene cards with +/- and >< on each
- [ ] Color-code A/B stories to verify weaving and focus
- [ ] Check the Board against the Beat Sheet: every turning point has a scene, a clear cause, and an observable change
- [ ] Write the draft as `.fountain`, run `fountain review <path>`, and verify one scene, dialogue block, and saved comment in the rendered preview

### Diagnosing a Problematic Script

Copy this checklist:
- [ ] Run the Hero Leads Test (active? seeks clues? never asks questions?)
- [ ] Check for Talking the Plot (characters serving writer, not themselves)
- [ ] Test the bad guy (bad enough? matched with hero? has edge?)
- [ ] Verify Turn, Turn, Turn (plot spins and intensifies?)
- [ ] Check Emotional Color Wheel (all emotions represented?)
- [ ] Run "Hi How Are You" dialogue test (unique voices?)
- [ ] Confirm hero's journey starts far back enough
- [ ] Verify all characters have "limp and eyepatch" (memorable traits)
- [ ] Test for primal motivations (survival, sex, protection, fear of death)
- [ ] Check for Too Much Marzipan (overstuffed concept / Black Vet)
- [ ] Rank the findings by story impact, cite the scene or dialogue that supports each, and propose one concrete revision per finding
- [ ] After revisions, re-read the affected beats and verify that the change resolves the cited problem without breaking adjacent scenes

**For detailed diagnostics**: See [references/diagnostics.md](references/diagnostics.md)

## Immutable Laws of Screenplay Physics

- **Save the Cat** - Hero must do something likeable when we meet them
- **The Pope in the Pool** - Bury exposition with visual interest
- **Double Mumbo Jumbo** - Only ONE piece of magic per movie
- **Laying Pipe** - Max 25 pages of setup before the hook
- **Too Much Marzipan / Black Vet** - Don't cram multiple clever hooks into one concept
- **Watch Out for That Glacier!** - Danger must be PRESENT danger
- **The Covenant of the Arc** - Everyone changes except bad guys
- **Keep the Press Out** - Media breaks the intimate reality

## Key Principles

- "Stasis equals death" - Things must change
- "Give me the same thing... only different"
- "Primal, primal, primal!" - Ground everything in survival, sex, protection, fear of death
- The hero cannot be lured or tricked into Act Two - must choose
- It's never as good as it seems at Midpoint, never as bad at All Is Lost
- Simple is better - one concept at a time
- Every scene needs emotional change (+/-) and conflict (><)
