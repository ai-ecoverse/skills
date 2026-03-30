# AI Writing Patterns Reference

Comprehensive catalog of AI-generated writing patterns. Sources: Wikipedia's "Signs of AI writing" article and ScriptRAG AI Content Indicators Database.

## Table of Contents
- [Vocabulary Markers](#vocabulary-markers)
- [Phrase Patterns](#phrase-patterns)
- [Content Patterns](#content-patterns)
- [Structural Patterns](#structural-patterns)
- [Style Patterns](#style-patterns)
- [The Hydrogen Jukebox Pattern](#the-hydrogen-jukebox-pattern)
- [Domain-Specific Indicators](#domain-specific-indicators)
- [Ineffective Indicators](#ineffective-indicators)
- [Detection Heuristics](#detection-heuristics)

---

## Vocabulary Markers

### Top 10 Red Flag Words

| Word | Usage Increase | Example |
|------|----------------|---------|
| delve | 25x | "delve into the intricacies" |
| showcasing | 9x | "showcasing the diversity" |
| underscore | 9x | "underscores its importance" |
| tapestry | high | "rich tapestry of culture" |
| landscape | high | "navigating the landscape" |
| realm | high | "in the realm of" |
| multifaceted | high | "multifaceted approach" |
| pivotal | high | "pivotal moment" |
| meticulous | high | "meticulous attention" |
| comprehensive | high | "comprehensive guide" |

### Complete Overused Words List (124+)

**A-C:**
Align, Allegedly, Arguably, Augment, Beacon, Bespoke, Bolster, Bustling, Captivate, Catalyst, Celestial, Commendable, Comprehensive, Consequently, Cornerstone, Craft, Crucial, Cultivate

**D-F:**
Daunting, Delve, Demystify, Delicacy, Discover, Diverse, Dynamic, Eerie, Elevate, Elucidate, Embark, Embrace, Empower, Enhance, Enigma, Ensure, Equip, Ethereal, Evocative, Evolving, Excellence, Exemplary, Explore, Exquisite, Facilitate, Facet, Fascinating, Foster, Foundational, Fulcrum

**G-L:**
Grapple, Groundbreaking, Harness, Holistic, Hurdles, Illuminate, Immerse, Imperative, Implement, Indelible, Indispensable, Ineffable, Inevitably, Innovative, Insightful, Integral, Intricate, Intrinsic, Journey, Kaleidoscope, Landscape, Leverage, Lucid, Luminous

**M-P:**
Meticulous, Mitigate, Multifaceted, Myriad, Navigate, Nexus, Nuanced, Optimize, Orchestrate, Paradigm, Paramount, Permeate, Pinnacle, Pioneering, Pivotal, Plethora, Poignant, Potent, Profound, Prowess

**Q-T:**
Realm, Redefine, Reimagine, Renowned, Repertoire, Resilience, Resonate, Revolutionary, Robust, Savvy, Seamless, Sentinel, Showcase, Spearhead, Spectrum, Streamline, Stunning, Substantial, Subtle, Symbiosis, Symphony, Synergy, Tailored, Tapestry, Testament, Thriving, Treasure trove, Transformative

**U-Z:**
Uncharted, Underscore, Undoubtedly, Unique, Unleash, Unlock, Unparalleled, Unveil, Utilize, Vanish, Vanguard, Vast, Venture, Vibrant, Vigilant, Vital, Vivid, Weaving, Whimsical, Yearning, Zenith

---

## Phrase Patterns

### Top Red Flag Phrases

1. **"Delve into"** / **"Let's delve"** - The most notorious AI indicator
2. **"It's important to note that"** / **"It is worth noting"**
3. **"In today's world"** / **"In the world of"**
4. **"Let's dive in"** / **"Dive into"**
5. **"It's not just X, it's Y"** / **"It's not X; it's Y"**
6. **"Moreover"** / **"Furthermore"** / **"Additionally"**
7. **"In conclusion"** / **"To sum up"**
8. **"Certainly, [here are/here is/here's]..."**
9. **"One might argue that..."**

### Opening Phrases
- "In this article, we'll explore…"
- "In this comprehensive guide…"
- "Welcome to our comprehensive guide on..."
- "Are you looking for..."
- "Look no further than..."
- "In an era where..."
- "As we navigate..."
- "In the ever-evolving world of..."

### Transitional Phrases
- "On the other hand..."
- "That being said..."
- "With that in mind..."
- "At the end of the day..."
- "When it comes to..."

### Hedging/Qualifying Language
- "Some experts suggest..."
- "Many experts agree that..."
- "It could be argued that..."
- "Generally speaking..."
- "In many cases..."
- "It's important/critical/crucial to note/remember/consider"

### Legacy/Importance Phrases
- "stands/serves as"
- "is a testament/reminder"
- "plays a vital/significant/crucial/pivotal role"
- "underscores/highlights its importance/significance"
- "symbolizing its ongoing/enduring/lasting impact"
- "key turning point"
- "indelible mark"
- "deeply rooted"
- "profound heritage"

---

## Content Patterns

### Superficial "-ing" Analyses
Sentences ending with present participle phrases that add hollow analysis:

**Pattern:** [Fact], ["-ing" phrase about significance]

**Examples:**
> "This etymology highlights the enduring legacy of the community's resistance and the transformative power of unity in shaping its identity."

> "These colors and patterns evoke enduring faith and resilience, qualities that resonate deeply within this close-knit community."

### Challenges and Future Prospects
Formulaic structure appearing at article ends:

**Pattern:** "Despite its [positive attributes], [subject] faces challenges..."

**Examples:**
> "Despite its industrial and residential prosperity, Korattur faces challenges typical of urban areas..."

> "Despite their promising applications, pyroelectric materials face several challenges that must be addressed for broader adoption."

### The Conclusion Obsession
AI models exhibit a compulsive need to conclude:

1. **Multiple Conclusion Attempts** - Several different ways to wrap up
2. **Redundant summarizing statements**
3. **"Preachy" endings with advice**

**Common patterns:**
- "In conclusion..." / "To sum up..." / "In summary..."
- "Remember, when doing X it's always important to consider Y"
- "Have fun and good luck!"
- "As we move forward..."
- "The journey continues..."
- "At the end of the day..."
- "Moving forward..."
- "The bottom line is..."

### Promotional Language
Advertisement-like puffery:

- "continues to captivate"
- "groundbreaking" (figurative)
- "stunning natural beauty"
- "nestled in the heart of"
- "boasts a..."
- "gateway to"
- "seamlessly connecting"
- "state-of-the-art"
- "cutting-edge"
- "best-in-class"
- "game-changing"
- "paradigm shift"
- "revolutionary approach"

### Vague Attribution
Attributing claims to unnamed authorities:

- "Industry reports suggest"
- "Observers have cited"
- "Experts argue"
- "Some critics argue"
- "Several publications have noted"

---

## Structural Patterns

### Em-Dash Overuse
Known as the "ChatGPT hyphen" - excessive use is a strong AI indicator.

**Threshold:** More than 1 em-dash per 200 words is suspicious.

**AI uses em dashes for:**
- Quick thought connections
- Creating conversational tone
- Avoiding strict grammar rules

### Rule of Three (Tricolon)
Overuse of three-item lists for false comprehensiveness:

**Pattern:** "adjective, adjective, adjective" or "phrase, phrase, and phrase"

**Examples:**
> "The event features keynote sessions, panel discussions, and networking opportunities."

> "Research, collaboration, and problem-solving"

### Forced Juxtapositions (Negative Parallelisms)

AI overuses rhetorical contrasts. These patterns are powerful but lose impact when overused.

**Core AI Patterns (strict limits):**

| Pattern | Regex | Example |
|---------|-------|---------|
| Not just X, but Y | `[Nn]ot (just\|simply\|merely) [^.!?]{1,40}, but` | "not just efficient, but revolutionary" |
| It's not about X, it's about Y | `not about [^.!?]{1,30}it.s about` | "not about the destination, it's about the journey" |
| It's not X, it's Y | `[Ii]t.s not [^.!?]{1,30}it.s` | "It's not a bug, it's a feature" |
| Not only...but also | `[Nn]ot only [^.!?]{1,60}but also` | "not only increases speed but also reduces cost" |
| More than just X | `more than (just\|simply\|merely )` | "more than just a tool" |
| Goes beyond X to Y | `go(es)? beyond [^.!?]{5,30}to` | "goes beyond reporting to action" |

**Sentence-Start Contrasts (moderate limits):**
- "While X, Y..." - at sentence start with comma structure
- "Although X, Y..." - at sentence start
- "Despite its [positive], it [challenges]..." - formulaic challenges pattern

**Examples:**
> "Self-Portrait by Yayoi Kusama constitutes not only a work of self-representation, but a visual document of her obsessions..."

> "It's not just about the beat riding under the vocals; it's part of the aggression and atmosphere."

**Recommended limits per chapter/section:**
- Core patterns: max 1 each
- Sentence-start contrasts: max 2 each

### Inline-Header Lists
Vertical lists with bolded inline headers:

**Pattern:**
```
- **Header:** Description text
- **Header:** Description text
```

### Question-Answer Format
- Rhetorical questions followed by answers
- "What does this mean? It means..."
- "The result?" / "The outcome?" / "The solution?"

### Introduction-Bullets-Conclusion Formula
AI follows a predictable three-part structure:

1. **Introduction Phase** - Generic opening, "In this article, we'll explore..."
2. **Body with Excessive Lists** - Heavy reliance on bullet points, over-segmentation
3. **Persistent Desire to Conclude** - Multiple concluding statements

### Formatting Red Flags
- **Bold Keywords:** Excessive bolding of key terms
- **Numbered Lists:** Over-reliance on numbered sections
- **Conclusion Sections:** Explicit "Conclusion:" headers
- **Title Case in Headings:** Capitalizing all main words
- **Colons in Headers:** "Topic: Subtopic" format

### Emoji Patterns in Headlines
- **Beginning-Title-End Format**: 🚀 Your Guide to Success 🎯
- **Excessive enthusiasm**: 🔥💡✅🚀🎉
- Professional content with childish emojis
- Random placement without contextual relevance

---

## Style Patterns

### Elegant Variation
Unnaturally cycling through synonyms to avoid repetition:

**Example (cycling terms for "non-conformist artists"):**
> "Soviet artistic constraints" → "non-conformist artists" → "their creativity" → "like-minded artists" → "state-imposed artistic norms"

### False Ranges
Meaningless "from X to Y" constructions where no scale exists:

**Example:**
> "from the singularity of the Big Bang to the grand cosmic web, from the birth and death of stars..."

### Overused Metaphors

1. **"Tapestry" Metaphors** - "Rich tapestry of...", "Weaving a tapestry..."
2. **"Symphony" Metaphors** - "Symphony of colors", "Orchestrating a symphony of data"
3. **"Landscape" Metaphors** - "Navigating the landscape of...", "Digital landscape"
4. **"Journey" Metaphors** - "Journey through...", "Embark on a journey..."
5. **"Beacon" Metaphors** - "Beacon of hope", "Shining beacon"

**Other overused metaphors:**
- "Testament to..."
- "Cornerstone of..."
- "Treasure trove of..."
- "Kaleidoscope of..."
- "Nexus of..."
- "Vanguard of..."
- "Catalyst for change"
- "Bridge between..."

---

## The Hydrogen Jukebox Pattern

### Abstract/Concrete Eyeball Kicks (nostalgebraist, 2024)

From nostalgebraist's analysis "hydrogen jukeboxes: on the crammed poetics of 'creative writing' LLMs" - modern creative AI models exhibit a distinctive pattern of what Allen Ginsberg called "eyeball kicks" (visually striking, unexpected image combinations).

The term "hydrogen jukebox" comes from Ginsberg's "Howl" (1955): "...listening to the crack of doom on the hydrogen jukebox..."

### Key Characteristics

1. **Abstract/Concrete Conjunctions**
   - "constraints humming" (described as "like a server farm at midnight")
   - "her grief for her dead husband seeped into its training data like ink"
   - "It writes the exact moment its language model aligned with her laughter"

2. **Crammed Poetics**
   - Every phrase contorted into another contrived "wow" moment
   - Claustrophobic prose that bends over backwards for effect
   - Eyeball kicks appearing "literally everywhere, over and over and over again"

3. **Pattern Persistence**
   - Appears regardless of user prompts or stylistic directions
   - Shows up even when mimicking famous literary authors
   - Not how humans naturally write - placement is excessive and unnatural

### Why This Matters

As nostalgebraist emphasizes: **"this is not just 'what good writing sounds like'! Humans do not write like this."**

While human writers do employ these stylistic tropes, "their place is not 'literally everywhere, over and over and over again, in crammed claustrophobic prose that bends over backwards to contort every single phrase into the shape of another contrived 'wow' moment.'"

---

## Domain-Specific Indicators

### Academic Writing
- Excessive use of "delve" (7.9 per 1000 papers in 2024)
- "A comprehensive grasp of the intricate interplay between..."
- "This study underscores..."
- "Our findings illuminate..."
- Heavy reliance on passive voice

### Business/Marketing Content
- "Leverage synergies"
- "Drive innovation"
- "Unlock potential"
- "Streamline processes"
- "Optimize performance"
- "Facilitate growth"

### Technical Writing
- Over-explanation of simple concepts
- Excessive use of "robust" and "scalable"
- "Cutting-edge technology"
- "Seamless integration"
- "End-to-end solution"

---

## Ineffective Indicators

These are **NOT** reliable signs of AI writing:

| Indicator | Why Unreliable |
|-----------|----------------|
| Perfect grammar | Many humans write well |
| Formal register | Code-switching is normal |
| "Fancy" words | LLMs avoid rare words |
| Conjunctions starting sentences | Stylistically acceptable |
| Bizarre wikitext | Usually browser bugs |

**Key insight:** Low-frequency and unusual words are *less* likely in AI writing because they're statistically uncommon.

---

## Detection Heuristics

### Confidence Calibration

| Pattern Density | Confidence | Notes |
|-----------------|------------|-------|
| 0-2 patterns | Low | Could be coincidence |
| 3-5 patterns | Medium | Warrants scrutiny |
| 6+ patterns | High | Strong AI indicators |
| Multiple categories | Higher | Cross-category patterns more telling |

### Detection Principles

1. **Cluster detection**: Single patterns are weak; multiple patterns across categories are strong
2. **Density matters**: Calculate patterns per 1000 words
3. **Context awareness**: Technical writing legitimately uses some "AI words"
4. **Temporal check**: Pre-November 2022 text cannot be ChatGPT-generated
5. **Explain test**: Can the author explain their word choices?
6. **Hydrogen jukebox check**: Is every phrase contorted into an "eyeball kick"?

### Detection Statistics (2024-2025)

- **"Delve"**: 25x increase in academic papers
- **"Showcasing"**: 9x increase
- **"Underscores"**: 9x increase
- At least 10% of 2024 academic abstracts showed LLM processing
- ~20% of bug report submissions in 2025 were AI-generated

### Important Caveats

- These patterns are not definitive proof of AI authorship
- Human writers may naturally use these phrases
- Detection methods are imperfect and evolving
- Cultural and linguistic backgrounds affect writing patterns
- Professional writers legitimately use many of these elements

---

*Sources: Wikipedia "Signs of AI writing", ScriptRAG AI Content Indicators Database, nostalgebraist (2024)*
