# LLM cliché catalog

Pattern catalog used by `check-llm-cliches`. Derived from Simon Willison's
[LLM cliché highlighter](https://tools.simonwillison.net/llm-cliche-highlighter)
([source](https://github.com/simonw/tools/blob/aabd3c5b1258a20ea2d512269ea72a7f083b07a6/llm-cliche-highlighter.html),
Apache-2.0, commit `aabd3c5`). Wikipedia-group names follow
[Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

`colon-triple` is off by default (`--all` to enable); it is noisy in technical writing.

| id | name | group |
|----|------|-------|
| `no-chain` | “No X, no Y” chains | LLM cliché |
| `whole` | “That’s the whole …” | LLM cliché |
| `did-not-chain` | “Did not X, did not Y” chains | LLM cliché |
| `dont-verb-it` | “Don’t VERB it … VERB it” | LLM cliché |
| `sit-with` | “Sit with that” | LLM cliché |
| `already-know` | “You already know” | LLM cliché |
| `is-the-entire` | “Is the entire …” | LLM cliché |
| `the-entire-is` | “The entire … is” | LLM cliché |
| `is-real` | “Is real … and / not” | LLM cliché |
| `punchline` | “The punchline is” | LLM cliché |
| `worth-naming` | “Worth naming” | LLM cliché |
| `not-nothing` | “That’s not nothing” | LLM cliché |
| `is-the-whole` | “Is the whole …” | LLM cliché |
| `echo-triad` | Echoing sentence runs | LLM cliché |
| `performative-honesty` | Performative honesty | LLM cliché |
| `thats-the-part` | “That’s the part …” | LLM cliché |
| `the-only-i-trust` | “The only X I trust” | LLM cliché |
| `take-my-word` | “Don’t take my word for it” | LLM cliché |
| `turns-out` | “Turns out …” | LLM cliché |
| `fits-in-your-head` | “Fits in your head” | LLM cliché |
| `stacked-questions` | Stacked rhetorical questions | LLM cliché |
| `sentence-anaphora` | Repeated sentence openers | LLM cliché |
| `colon-triple` | Colon into a triple | LLM cliché |
| `heres-the-twist` | “Here’s the twist” | LLM cliché |
| `x-is-dead` | “X is dead” | LLM cliché |
| `thats-why-mattered` | “That’s why X mattered” | LLM cliché |
| `stranded-auxiliary` | Stranded auxiliary contrast | LLM cliché |
| `ai-vocab` | AI vocabulary words | Signs of AI writing (Wikipedia) |
| `not-just` | “Not just X, but Y” | Signs of AI writing (Wikipedia) |
| `note-that` | “It’s important to note” | Signs of AI writing (Wikipedia) |
| `testament` | “Stands as a testament” | Signs of AI writing (Wikipedia) |
| `crucial-role` | “Plays a crucial role” | Signs of AI writing (Wikipedia) |
| `landscape` | “Ever-evolving landscape” | Signs of AI writing (Wikipedia) |
| `vague-experts` | “Experts argue” | Signs of AI writing (Wikipedia) |
| `despite-challenges` | “Despite these challenges” | Signs of AI writing (Wikipedia) |
| `participle-tail` | Participle sentence tails | Signs of AI writing (Wikipedia) |
| `promo` | Promotional boilerplate | Signs of AI writing (Wikipedia) |
| `ai-leftovers` | Chatbot leftovers | Signs of AI writing (Wikipedia) |

## Descriptions

### `no-chain` — “No X, no Y” chains

Two or more “no …” items in a row, e.g. “No fluff, no filler, no jargon.” The badge counts the “no” items.

### `whole` — “That’s the whole …”

“That / this is the whole point, game, thing …”

### `did-not-chain` — “Did not X, did not Y” chains

Two or more “did not …” or “didn’t …” items in a row. The badge counts the items.

### `dont-verb-it` — “Don’t VERB it … VERB it”

“Don’t call it X. Call it Y.” — a negated verb + “it”, then the same verb + “it” again.

### `sit-with` — “Sit with that”

The reflective “sit with that / this / it (for a moment)”, plus “sit with the discomfort” and friends.

### `already-know` — “You already know”

“You already know” — the answer, what to do, or standing alone before a full stop.

### `is-the-entire` — “Is the entire …”

“X is the entire point / game / business model.”

### `the-entire-is` — “The entire … is”

“The entire point / game / business model is …” — the flipped twin of “is the entire”.

### `is-real` — “Is real … and / not”

“The X is real, and / not …”, including “is the real … and it”. Skips “real estate”, “real time”, and similar.

### `punchline` — “The punchline is”

“The punchline is …”, “the punchline:”, or “the punchline?”.

### `worth-naming` — “Worth naming”

The therapist-voiced “that loss is real and it’s worth naming”, “it’s worth naming that …”, or a “Worth naming:” opener. Skips “naming names”.

### `not-nothing` — “That’s not nothing”

“That is not nothing” / “that’s not nothing”, plus the “this / it / which is not nothing” variants.

### `is-the-whole` — “Is the whole …”

Any subject + “is the whole point / trick / pitch / idea”, plus the “here is the whole …” opener. The twin of “is the entire …”, and a generalisation of “That’s the whole …” to subjects other than that/this.

### `echo-triad` — Echoing sentence runs

Consecutive sentences built on the same repeated skeleton — “A shopping cart is an object in the system. A chat room is an object in the system.” The badge counts the echoing sentences.

### `performative-honesty` — Performative honesty

Sincerity announced rather than demonstrated: “I won’t pretend”, “I’ll be honest”, “let’s be honest”, “to be clear”, and sentence-initial “Honestly,” or “Look,”.

### `thats-the-part` — “That’s the part …”

Gesturing at a favoured detail instead of stating it: “that is the part a counter can’t reach”, “the part that makes me trust the rest”, “my favourite part of …”.

### `the-only-i-trust` — “The only X I trust”

The narrowing superlative reveal: “the only marketing I trust”, “the only thing it needs”, “the only X that matters”.

### `take-my-word` — “Don’t take my word for it”

The stock invitation to verify: “you don’t have to take my word for it”, “don’t take my word for any of this”.

### `turns-out` — “Turns out …”

The casual-revelation opener, almost always bolted to a tidy conclusion: “Turns out X”, “it turns out that X”.

### `fits-in-your-head` — “Fits in your head”

Dev-blog boilerplate for simplicity: “small enough to hold in your head”, “batteries included”, “it just works”, “zero config”, “sane defaults”.

### `stacked-questions` — Stacked rhetorical questions

Two or more questions fired in a row, usually fragments after the first: “Do I know how it works? Where it breaks? Which corners it cut?” The badge counts the questions.

### `sentence-anaphora` — Repeated sentence openers

Three or more consecutive sentences starting on the same word — “Maybe nobody needed it. Maybe it introduced … Maybe a small convenience …” Pronouns and articles are ignored. The badge counts the sentences.

### `colon-triple` — Colon into a triple

A colon opening onto three or more comma-separated items: “separate ports, processes, and local state”. The most common shape LLM prose uses to sound concrete. Noisy in technical writing — leave it off by default if your corpus is documentation.

### `heres-the-twist` — “Here’s the twist”

The stage-managed reveal: “here’s the twist”, “here’s the thing”, “here’s the catch / kicker / rub”, “here’s the first example:”.

### `x-is-dead` — “X is dead”

The obituary headline and its sequel: “peer code review is dead”, “botd is dead; long live botd”.

### `thats-why-mattered` — “That’s why X mattered”

Retroactively assigning significance: “that’s why being able to open the environment mattered”, “this is why preserving every conversation mattered”.

### `stranded-auxiliary` — Stranded auxiliary contrast

A clause that lands on a bare auxiliary for the reversal: “The tool died; the data didn’t.”, “Reading mostly passed … Writing didn’t”, “Maybe it wouldn’t have.”

### `ai-vocab` — AI vocabulary words

Words LLMs lean on far more than people do: “delve”, “tapestry”, “meticulous”, “pivotal”, “intricate”, “interplay”, “underscore”, “garner”, “bolster”, “vibrant”, “bustling”, “multifaceted”, “seamless”, “ever-evolving”. One hit can be coincidence \u2014 several is a tell.

### `not-just` — “Not just X, but Y”

Negative parallelisms: “not just X, but (also) Y”, “not only … but …”, and the “it’s not X \u2014 it’s Y” contrast.

### `note-that` — “It’s important to note”

Didactic hedging: “it is important to note that”, “it’s worth noting”, “it should be noted”, plus the “worth pausing / considering / asking” family.

### `testament` — “Stands as a testament”

“Stands / serves as a testament (or reminder)”, “is a testament to” \u2014 inflating significance instead of saying what happened.

### `crucial-role` — “Plays a crucial role”

“Plays a crucial / pivotal / vital / key / significant role in …”.

### `landscape` — “Ever-evolving landscape”

Scene-setting boilerplate: “the ever-evolving / changing / shifting landscape”, “in today’s fast-paced world”.

### `vague-experts` — “Experts argue”

Vague attribution to unnamed authorities: “experts argue”, “some critics have noted”, “observers suggest”, “industry reports indicate”.

### `despite-challenges` — “Despite these challenges”

The boilerplate challenges-and-outlook formula: “despite these challenges”, “faces several challenges”, “challenges remain”, “remains to be seen”, “time will tell”.

### `participle-tail` — Participle sentence tails

Superficial analysis bolted onto a sentence end: “…, highlighting / underscoring / showcasing / reflecting the …”.

### `promo` — Promotional boilerplate

Travel-brochure tone: “nestled in”, “in the heart of”, “rich tapestry / heritage”, “hidden gem”, “boasts a”, “breathtaking”, “stunning views”.

### `ai-leftovers` — Chatbot leftovers

Artifacts pasted straight from a chatbot: “as an AI language model”, “as of my last update”, “knowledge cutoff”, plus markup debris like “oaicite”, “contentReference”, “turn0search” and “utm_source=” tracking parameters.
