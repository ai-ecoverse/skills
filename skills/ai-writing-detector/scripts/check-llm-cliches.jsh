// check-llm-cliches.jsh — LLM cliché detector (CLI)
//
// Derived from Simon Willison's LLM cliché highlighter
//   https://github.com/simonw/tools/blob/aabd3c5b1258a20ea2d512269ea72a7f083b07a6/llm-cliche-highlighter.html
//   https://tools.simonwillison.net/llm-cliche-highlighter
//   commit aabd3c5b1258a20ea2d512269ea72a7f083b07a6 (2026-08-27)
// Licensed under the Apache License, Version 2.0.
//
// Modifications from upstream:
// - Removed the browser UI, URL loading (Jina Reader), tooltips, and related tests
// - Added a CLI: file in, markdown or JSON out, --test for the upstream self-tests
// - colon-triple is off by default (upstream notes it is noisy in documentation)
//
// Usage:
//   check-llm-cliches <file> [--json] [--all] [--pattern <id>]...
//   check-llm-cliches --test
//   check-llm-cliches --list

// ==== impl start ====
// Each pattern: { id, name, description, find(text) -> [{ start, end, badge?, badgeTitle?, count? }] }
// Add new patterns to this array and they get a checkbox, per-pattern count, and highlighting for free.
// makeChainFinder builds a detector for "HEAD X, HEAD Y, ..." lists and counts the items;
// makeRegexFinder wraps a plain regex (must use the g flag); makeEchoFinder builds a
// detector for runs of consecutive sentences repeating the same multi-word skeleton;
// makeQuestionChainFinder flags runs of consecutive question sentences; and
// makeAnaphoraFinder flags runs of consecutive sentences opening on the same word.

const CHAIN_BODY = String.raw`[^,.;:!?\n\u2013\u2014\u2026]*`;
const CHAIN_SEP = String.raw`(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+|\s*[;&\u2013\u2014]\s*(?:and\s+|or\s+)?|\s+-{1,2}\s+)`;
const CHAIN_SPLIT = new RegExp(CHAIN_SEP, 'i');

function makeChainFinder(head, headTest, itemLabel) {
  const item = head + CHAIN_BODY;
  const chain = new RegExp(String.raw`\b${item}(?:${CHAIN_SEP}${item})+`, 'gi');
  return function (text) {
    const found = [];
    for (const m of text.matchAll(chain)) {
      let end = m.index + m[0].length;
      while (end > m.index && /\s/.test(text[end - 1])) end -= 1;
      const count = m[0].split(CHAIN_SPLIT).filter(p => headTest.test(p.trim())).length;
      found.push({
        start: m.index,
        end,
        count,
        badge: String(count),
        badgeTitle: count + ' ' + itemLabel + (count === 1 ? '' : 's')
      });
    }
    return found;
  };
}

function makeRegexFinder(re) {
  return function (text) {
    const found = [];
    for (const m of text.matchAll(re)) {
      found.push({ start: m.index, end: m.index + m[0].length });
    }
    return found;
  };
}

// makeEchoFinder builds a detector for runs of consecutive sentences that
// repeat the same multi-word skeleton -- the "X does A. Y does B." triad.
// The badge counts the echoing sentences.
function makeEchoFinder({ minGram = 3, minRun = 2 } = {}) {
  const SENT = /[^.!?\n]+[.!?]?/g;
  const grams = (s, n) => {
    const w = s.toLowerCase().match(/[a-z0-9'’-]+/g) || [];
    const out = new Set();
    for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
    return out;
  };
  return function (text) {
    const sents = [];
    for (const m of text.matchAll(SENT)) {
      if ((m[0].match(/\S+/g) || []).length >= 4) {
        sents.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    }
    const found = [];
    let i = 0;
    while (i < sents.length) {
      let j = i;
      let shared = null;
      while (j + 1 < sents.length) {
        if (sents[j + 1].start - sents[j].end > 3) break; // adjacent prose only
        const a = grams(sents[j].text, minGram);
        const b = grams(sents[j + 1].text, minGram);
        const common = [...a].filter(g => b.has(g));
        if (!common.length) break;
        shared = common.sort((x, y) => y.length - x.length)[0];
        j += 1;
      }
      const run = j - i + 1;
      if (run >= minRun && shared) {
        let end = sents[j].end;
        while (end > sents[i].start && /\s/.test(text[end - 1])) end -= 1;
        found.push({
          start: sents[i].start,
          end,
          count: run,
          badge: String(run),
          badgeTitle: run + ' sentences echoing “' + shared + '”'
        });
        i = j + 1;
      } else {
        i += 1;
      }
    }
    return found;
  };
}

// Flags runs of consecutive question sentences -- the stacked rhetorical
// interrogation. The badge counts the questions.
function makeQuestionChainFinder({ minRun = 2 } = {}) {
  const chain = /[^.!?\n]+\?(?:\s+[^.!?\n]+\?)+/g;
  return function (text) {
    const found = [];
    for (const m of text.matchAll(chain)) {
      const count = (m[0].match(/\?/g) || []).length;
      if (count < minRun) continue;
      let start = m.index;
      while (start < m.index + m[0].length && /\s/.test(text[start])) start += 1;
      found.push({
        start,
        end: m.index + m[0].length,
        count,
        badge: String(count),
        badgeTitle: count + ' questions in a row'
      });
    }
    return found;
  };
}

// Flags runs of consecutive sentences opening on the same word -- "Maybe X.
// Maybe Y. Maybe Z." Pronouns and articles are skipped, since repeating those
// is just ordinary prose. The badge counts the sentences.
const ANAPHORA_SKIP = /^(?:i|it|the|a|an|this|that|we|you|they|he|she|there|but|and|so|in|as|if|my|his|her|their|its|these|those|for|at|on|of|to|is|was)$/i;
function makeAnaphoraFinder({ minRun = 3 } = {}) {
  const SENT = /[^.!?\n]+[.!?]/g;
  return function (text) {
    const sents = [];
    for (const m of text.matchAll(SENT)) {
      const w = m[0].match(/[A-Za-z'’-]+/);
      if (w) {
        sents.push({
          start: m.index + m[0].indexOf(w[0]),
          end: m.index + m[0].length,
          head: w[0].toLowerCase()
        });
      }
    }
    const found = [];
    let i = 0;
    while (i < sents.length) {
      let j = i;
      while (j + 1 < sents.length && sents[j + 1].head === sents[i].head
             && sents[j + 1].start - sents[j].end < 4) j += 1;
      const run = j - i + 1;
      if (run >= minRun && !ANAPHORA_SKIP.test(sents[i].head)) {
        found.push({
          start: sents[i].start,
          end: sents[j].end,
          count: run,
          badge: String(run),
          badgeTitle: run + ' sentences opening “' + sents[i].head + '”'
        });
        i = j + 1;
      } else i += 1;
    }
    return found;
  };
}

// Patterns in this group are adapted from Wikipedia's "Signs of AI writing"
// guide: https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
const WIKI_GROUP = 'Signs of AI writing (Wikipedia)';

const patterns = [
  {
    id: 'no-chain',
    name: '“No X, no Y” chains',
    description: 'Two or more “no …” items in a row, e.g. “No fluff, no filler, no jargon.” The badge counts the “no” items.',
    find: makeChainFinder(String.raw`no[-\s]`, /^no[-\s]/i, '\u201cno\u201d item')
  },
  {
    id: 'whole',
    name: '“That’s the whole …”',
    description: '“That / this is the whole point, game, thing …”',
    find: makeRegexFinder(/\b(?:that|this)(?:['\u2019]s|\s+(?:is|was))\s+the\s+whole\b(?:\s+\w+)?/gi)
  },
  {
    id: 'did-not-chain',
    name: '“Did not X, did not Y” chains',
    description: 'Two or more “did not …” or “didn’t …” items in a row. The badge counts the items.',
    find: makeChainFinder(String.raw`(?:did\s+not|didn['\u2019]t)\s`, /^(?:did\s+not|didn['\u2019]t)\s/i, '\u201cdid not\u201d item')
  },
  {
    id: 'dont-verb-it',
    name: '“Don’t VERB it … VERB it”',
    description: '“Don’t call it X. Call it Y.” — a negated verb + “it”, then the same verb + “it” again.',
    find: makeRegexFinder(/\b(?:do\s+not|don['\u2019]t)\s+(?:just\s+|simply\s+|merely\s+)?(\w+)(?:\s+(?:of|about|at|on|for|with|to))?\s+it\b[^.!?\n]*?[.!?;,:\u2013\u2014]['"\u201d\u2019]*\s*(?:just\s+|simply\s+|merely\s+)?\1(?:\s+(?:of|about|at|on|for|with|to))?\s+it\b/gi)
  },
  {
    id: 'sit-with',
    name: '“Sit with that”',
    description: 'The reflective “sit with that / this / it (for a moment)”, plus “sit with the discomfort” and friends.',
    find: makeRegexFinder(/\bsit(?:s|ting)?\s+with\s+(?:that|this|it|(?:the|your)\s+(?:discomfort|feelings?|tension|weight|uncertainty|ambiguity|grief|silence|unease))\b(?:\s+for\s+a\s+\w+)?/gi)
  },
  {
    id: 'already-know',
    name: '“You already know”',
    description: '“You already know” — the answer, what to do, or standing alone before a full stop.',
    find: makeRegexFinder(/\byou\s+already\s+knows?\s+(?:the\s+answer|what|how|why|this|that|it|who|where)\b|\byou\s+already\s+knows?\b(?![ \t]+\w)/gi)
  },
  {
    id: 'is-the-entire',
    name: '“Is the entire …”',
    description: '“X is the entire point / game / business model.”',
    find: makeRegexFinder(/(?:\b(?:is|was|are|were)|['\u2019]s)\s+the\s+entire\b(?:\s+\w+)?/gi)
  },
  {
    id: 'the-entire-is',
    name: '“The entire … is”',
    description: '“The entire point / game / business model is …” — the flipped twin of “is the entire”.',
    find: makeRegexFinder(/\bthe\s+entire\s+[\w'\u2019-]+(?:\s+[\w'\u2019-]+){0,4}?\s+(?:is|was|are|were)\b/gi)
  },
  {
    id: 'is-real',
    name: '“Is real … and / not”',
    description: '“The X is real, and / not …”, including “is the real … and it”. Skips “real estate”, “real time”, and similar.',
    find: makeRegexFinder(/\bis\s+(?:(?:the|a)\s+real\b(?![\s-]+(?:estate|time|life|world|quick)\b)[^.!?\n]*?\b(?:and|not)\s+it\b|real\b(?![\s-]+(?:estate|time|life|world|quick)\b)[^.!?\n]*?\b(?:and|not)\b)/gi)
  },
  {
    id: 'punchline',
    name: '“The punchline is”',
    description: '“The punchline is …”, “the punchline:”, or “the punchline?”.',
    find: makeRegexFinder(/\bthe\s+punchline(?:\s+(?:is|was|being)\b|\s*[:?])/gi)
  },
  {
    id: 'worth-naming',
    name: '“Worth naming”',
    description: 'The therapist-voiced “that loss is real and it’s worth naming”, “it’s worth naming that …”, or a “Worth naming:” opener. Skips “naming names”.',
    find: makeRegexFinder(/(?:\b(?:is|are|was|were|feels?|felt|seems?|seemed)|['\u2019]s)\s+(?:\w+\s+){0,2}?worth\s+naming\b(?!\s+names\b)|\bworth\s+naming\s*:/gi)
  },
  {
    id: 'not-nothing',
    name: '\u201cThat\u2019s not nothing\u201d',
    description: '\u201cThat is not nothing\u201d / \u201cthat\u2019s not nothing\u201d, plus the \u201cthis / it / which is not nothing\u201d variants.',
    find: makeRegexFinder(/\b(?:that|this|it|which)(?:['\u2019]s|\s+(?:is|was))\s+not\s+nothing\b/gi)
  },
  {
    id: 'is-the-whole',
    name: '“Is the whole …”',
    description: 'Any subject + “is the whole point / trick / pitch / idea”, plus the “here is the whole …” opener. The twin of “is the entire …”, and a generalisation of “That’s the whole …” to subjects other than that/this.',
    find: makeRegexFinder(/(?:\b(?:is|was|are|were)|['’]s)\s+the\s+whole\b(?:\s+\w+)?|\bhere(?:['’]s|\s+is)\s+the\s+whole\b(?:\s+\w+)?/gi)
  },
  {
    id: 'echo-triad',
    name: 'Echoing sentence runs',
    description: 'Consecutive sentences built on the same repeated skeleton — “A shopping cart is an object in the system. A chat room is an object in the system.” The badge counts the echoing sentences.',
    find: makeEchoFinder({ minGram: 4, minRun: 2 })
  },
  {
    id: 'performative-honesty',
    name: 'Performative honesty',
    description: 'Sincerity announced rather than demonstrated: “I won’t pretend”, “I’ll be honest”, “let’s be honest”, “to be clear”, and sentence-initial “Honestly,” or “Look,”.',
    find: makeRegexFinder(/\bI\s+(?:will\s+not|won['’]t)\s+pretend\b|\b(?:I['’]ll|let['’]s|to)\s+be\s+(?:honest|clear|blunt|real)\b|(?:^|[.!?–—]\s+|\n)(?:Honestly|Look|Truthfully|Frankly)\s*,/gi)
  },
  {
    id: 'thats-the-part',
    name: '“That’s the part …”',
    description: 'Gesturing at a favoured detail instead of stating it: “that is the part a counter can’t reach”, “the part that makes me trust the rest”, “my favourite part of …”.',
    find: makeRegexFinder(/\b(?:that|this|it)(?:['’]s|\s+(?:is|was))\s+the\s+part\b|\bthe\s+part\s+that\s+(?:makes|made|gets|got|keeps|kept)\s+(?:me|you|us|it)\b|\bmy\s+favou?rite\s+part\s+of\b/gi)
  },
  {
    id: 'the-only-i-trust',
    name: '“The only X I trust”',
    description: 'The narrowing superlative reveal: “the only marketing I trust”, “the only thing it needs”, “the only X that matters”.',
    find: makeRegexFinder(/\bthe\s+only\s+[\w'’-]+(?:\s+[\w'’-]+){0,2}?\s+(?:I|you|we|it|he|she|they)\s+(?:trust|need|needs|care|want|wants|use|uses|believe)\b|\bthe\s+only\s+[\w'’-]+\s+that\s+(?:matters|counts|works|survives)\b/gi)
  },
  {
    id: 'take-my-word',
    name: '“Don’t take my word for it”',
    description: 'The stock invitation to verify: “you don’t have to take my word for it”, “don’t take my word for any of this”.',
    find: makeRegexFinder(/\b(?:you\s+)?(?:do\s+not|don['’]t)\s+(?:have\s+to\s+)?take\s+my\s+word\s+for\s+(?:it|any\s+of\s+(?:it|this|that))\b/gi)
  },
  {
    id: 'turns-out',
    name: '“Turns out …”',
    description: 'The casual-revelation opener, almost always bolted to a tidy conclusion: “Turns out X”, “it turns out that X”.',
    find: makeRegexFinder(/(?:^|[.!?–—]\s+|\n)Turns\s+out\b|\bit\s+turns\s+out\s+that\b/gi)
  },
  {
    id: 'fits-in-your-head',
    name: '“Fits in your head”',
    description: 'Dev-blog boilerplate for simplicity: “small enough to hold in your head”, “batteries included”, “it just works”, “zero config”, “sane defaults”.',
    find: makeRegexFinder(/\b(?:hold|fit|fits|holds|held)\s+(?:it\s+)?in\s+your\s+head\b|\bbatteries[-\s]included\b|\bit\s+just\s+works\b|\bzero[-\s]config(?:uration)?\b|\bsane\s+defaults\b/gi)
  },
  {
    id: 'stacked-questions',
    name: 'Stacked rhetorical questions',
    description: 'Two or more questions fired in a row, usually fragments after the first: “Do I know how it works? Where it breaks? Which corners it cut?” The badge counts the questions.',
    find: makeQuestionChainFinder({ minRun: 2 })
  },
  {
    id: 'sentence-anaphora',
    name: 'Repeated sentence openers',
    description: 'Three or more consecutive sentences starting on the same word — “Maybe nobody needed it. Maybe it introduced … Maybe a small convenience …” Pronouns and articles are ignored. The badge counts the sentences.',
    find: makeAnaphoraFinder({ minRun: 3 })
  },
  {
    id: 'colon-triple',
    name: 'Colon into a triple',
    description: 'A colon opening onto three or more comma-separated items: “separate ports, processes, and local state”. The most common shape LLM prose uses to sound concrete. Noisy in technical writing — leave it off by default if your corpus is documentation.',
    find: makeRegexFinder(/:\s+[^.!?;:\n]{2,40},\s+[^.!?;:\n]{2,40},\s+(?:and\s+|or\s+)?[^.!?;:\n]{2,40}(?=[.!?\n])/g)
  },
  {
    id: 'heres-the-twist',
    name: '“Here’s the twist”',
    description: 'The stage-managed reveal: “here’s the twist”, “here’s the thing”, “here’s the catch / kicker / rub”, “here’s the first example:”.',
    find: makeRegexFinder(/\bhere(?:['’]s|\s+is)\s+(?:the|a|my|one)\s+(?:twist|thing|catch|kicker|rub|problem|first|second|third|next|recent|real|best|worst|surprising|interesting|key|important)\b[\w\s-]{0,20}[:.]/gi)
  },
  {
    id: 'x-is-dead',
    name: '“X is dead”',
    description: 'The obituary headline and its sequel: “peer code review is dead”, “botd is dead; long live botd”.',
    find: makeRegexFinder(/\b[\w\s]{3,30}\s+(?:is|are)\s+dead\b|\blong\s+live\s+\w+/gi)
  },
  {
    id: 'thats-why-mattered',
    name: '“That’s why X mattered”',
    description: 'Retroactively assigning significance: “that’s why being able to open the environment mattered”, “this is why preserving every conversation mattered”.',
    find: makeRegexFinder(/\b(?:that|this)(?:['’]s|\s+(?:is|was))\s+why\b[^.!?\n]{0,80}?\b(?:matter(?:s|ed)?|count(?:s|ed)?)\b/gi)
  },
  {
    id: 'stranded-auxiliary',
    name: 'Stranded auxiliary contrast',
    description: 'A clause that lands on a bare auxiliary for the reversal: “The tool died; the data didn’t.”, “Reading mostly passed … Writing didn’t”, “Maybe it wouldn’t have.”',
    find: makeRegexFinder(/[;:,]\s+[^.;:!?\n]{2,50}\s(?:did|does|do|was|were|is|are|has|have|had|can|could|would|will)(?:n['’]t)?\s*[.;]|\b(?:Maybe|Perhaps)\s+\w+[^.!?\n]{0,40}\s(?:would|could|might|should|did|had|was|is)(?:n['’]t)?\s+(?:have\s*)?\./g)
  },
  {
    id: 'ai-vocab',
    group: WIKI_GROUP,
    name: 'AI vocabulary words',
    description: 'Words LLMs lean on far more than people do: \u201cdelve\u201d, \u201ctapestry\u201d, \u201cmeticulous\u201d, \u201cpivotal\u201d, \u201cintricate\u201d, \u201cinterplay\u201d, \u201cunderscore\u201d, \u201cgarner\u201d, \u201cbolster\u201d, \u201cvibrant\u201d, \u201cbustling\u201d, \u201cmultifaceted\u201d, \u201cseamless\u201d, \u201cever-evolving\u201d. One hit can be coincidence \u2014 several is a tell.',
    find: makeRegexFinder(/\b(?:delv(?:e|es|ed|ing)|tapestr(?:y|ies)|meticulous(?:ly)?|pivotal|intricate(?:ly)?|intricacies|interplay|underscor(?:e|es|ed|ing)|garner(?:s|ed|ing)?|bolster(?:s|ed|ing)?|vibrant|bustling|multifaceted|seamless(?:ly)?|commendable|ever-evolving)\b/gi)
  },
  {
    id: 'not-just',
    group: WIKI_GROUP,
    name: '\u201cNot just X, but Y\u201d',
    description: 'Negative parallelisms: \u201cnot just X, but (also) Y\u201d, \u201cnot only \u2026 but \u2026\u201d, and the \u201cit\u2019s not X \u2014 it\u2019s Y\u201d contrast.',
    find: makeRegexFinder(/\bnot\s+(?:just|only|merely|simply)\s+[^.!?\n;]*?\bbut(?:\s+also)?\b|\b(?:it|this|that)(?:['\u2019]s|\s+(?:is|was))\s+not\s+[^.!?\n,;\u2014\u2013]{1,60}[,;\u2014\u2013]\s*(?:it|this|that)(?:['\u2019]s|\s+(?:is|was))\b/gi)
  },
  {
    id: 'note-that',
    group: WIKI_GROUP,
    name: '\u201cIt\u2019s important to note\u201d',
    description: 'Didactic hedging: \u201cit is important to note that\u201d, \u201cit\u2019s worth noting\u201d, \u201cit should be noted\u201d, plus the \u201cworth pausing / considering / asking\u201d family.',
    find: makeRegexFinder(/\bit(?:['\u2019]s|\s+(?:is|was))\s+(?:also\s+)?(?:important|worth|crucial|essential|vital)\s+(?:to\s+(?:note|remember|understand|recognize|mention|pause|consider|ask)|noting|mentioning|remembering|pausing|considering|asking)\b(?:\s+that\b)?|\bit\s+should\s+be\s+noted\b/gi)
  },
  {
    id: 'testament',
    group: WIKI_GROUP,
    name: '\u201cStands as a testament\u201d',
    description: '\u201cStands / serves as a testament (or reminder)\u201d, \u201cis a testament to\u201d \u2014 inflating significance instead of saying what happened.',
    find: makeRegexFinder(/\b(?:stand|stands|stood|serve|serves|served|standing|serving)\s+as\s+(?:a|an)\s+(?:\w+\s+)?(?:testament|reminder)\b|\b(?:is|was|are|were|remain|remains)\s+a\s+(?:\w+\s+)?testament\s+to\b/gi)
  },
  {
    id: 'crucial-role',
    group: WIKI_GROUP,
    name: '\u201cPlays a crucial role\u201d',
    description: '\u201cPlays a crucial / pivotal / vital / key / significant role in \u2026\u201d.',
    find: makeRegexFinder(/\bplay(?:s|ed|ing)?\s+(?:a|an)\s+(?:\w+\s+)?(?:crucial|pivotal|vital|key|significant|central|critical|important)\s+role\b/gi)
  },
  {
    id: 'landscape',
    group: WIKI_GROUP,
    name: '\u201cEver-evolving landscape\u201d',
    description: 'Scene-setting boilerplate: \u201cthe ever-evolving / changing / shifting landscape\u201d, \u201cin today\u2019s fast-paced world\u201d.',
    find: makeRegexFinder(/\b(?:ever-)?(?:evolving|changing|shifting)\s+landscape\b|\bin\s+today['\u2019]s\s+(?:fast-paced|ever-changing|ever-evolving|digital|modern|competitive)\s+\w+/gi)
  },
  {
    id: 'vague-experts',
    group: WIKI_GROUP,
    name: '\u201cExperts argue\u201d',
    description: 'Vague attribution to unnamed authorities: \u201cexperts argue\u201d, \u201csome critics have noted\u201d, \u201cobservers suggest\u201d, \u201cindustry reports indicate\u201d.',
    find: makeRegexFinder(/\b(?:many|some|several|most|numerous)?\s*(?:experts|critics|observers|scholars|analysts|commentators)\s+(?:have\s+|often\s+|widely\s+)?(?:argu(?:e|es|ed)|not(?:e|es|ed)|suggest(?:s|ed)?|believ(?:e|es|ed)|agree[ds]?|contend(?:s|ed)?|observ(?:e|es|ed)|caution(?:s|ed)?|claim(?:s|ed)?|cit(?:e|es|ed)|point(?:s|ed)?\s+out)\b|\bindustry\s+reports?\s+(?:suggest|indicate|show)\w*\b/gi)
  },
  {
    id: 'despite-challenges',
    group: WIKI_GROUP,
    name: '\u201cDespite these challenges\u201d',
    description: 'The boilerplate challenges-and-outlook formula: \u201cdespite these challenges\u201d, \u201cfaces several challenges\u201d, \u201cchallenges remain\u201d, \u201cremains to be seen\u201d, \u201ctime will tell\u201d.',
    find: makeRegexFinder(/\bdespite\s+(?:these|those|such|its|their|the|numerous|significant|ongoing)\s+(?:\w+\s+)?challenges\b|\bfac(?:e|es|ed|ing)\s+(?:several|numerous|many|significant|various|a\s+number\s+of)\s+challenges\b|\bchallenges\s+remain\b|\bremains\s+to\s+be\s+seen\b|\b(?:only\s+)?time\s+will\s+tell\b/gi)
  },
  {
    id: 'participle-tail',
    group: WIKI_GROUP,
    name: 'Participle sentence tails',
    description: 'Superficial analysis bolted onto a sentence end: \u201c\u2026, highlighting / underscoring / showcasing / reflecting the \u2026\u201d.',
    find: makeRegexFinder(/,\s+(?:highlighting|underscoring|emphasizing|showcasing|reflecting|demonstrating|illustrating|signaling|solidifying|cementing|reinforcing|underlining)\s+(?:its|his|her|their|our|the|a|an|how|that|what|both)\b[^.!?\n]*/gi)
  },
  {
    id: 'promo',
    group: WIKI_GROUP,
    name: 'Promotional boilerplate',
    description: 'Travel-brochure tone: \u201cnestled in\u201d, \u201cin the heart of\u201d, \u201crich tapestry / heritage\u201d, \u201chidden gem\u201d, \u201cboasts a\u201d, \u201cbreathtaking\u201d, \u201cstunning views\u201d.',
    find: makeRegexFinder(/\bnestled\s+(?:in|on|among|between|along|at)\b|\bin\s+the\s+heart\s+of\b|\brich\s+(?:cultural\s+|historical\s+)?(?:heritage|history|tapestry)\b|\bhidden\s+gem\b|\bmust-(?:visit|see|try)\b|\bbreathtaking\b|\bboasts?\s+(?:a|an|the)\b|\bstunning\s+(?:views?|scenery|architecture|backdrop)\b/gi)
  },
  {
    id: 'ai-leftovers',
    group: WIKI_GROUP,
    name: 'Chatbot leftovers',
    description: 'Artifacts pasted straight from a chatbot: \u201cas an AI language model\u201d, \u201cas of my last update\u201d, \u201cknowledge cutoff\u201d, plus markup debris like \u201coaicite\u201d, \u201ccontentReference\u201d, \u201cturn0search\u201d and \u201cutm_source=\u201d tracking parameters.',
    find: makeRegexFinder(/\bas\s+an\s+ai(?:\s+language)?\s+model\b|\bas\s+of\s+my\s+last\s+(?:update|training)\b|\bknowledge\s+cutoff\b|\bI\s+(?:cannot|can['\u2019]t|do\s+not|don['\u2019]t)\s+(?:browse\s+the\s+internet|access\s+real-?time)\b|contentReference|oaicite|turn0(?:search|news|image)\d*|attributableIndex|utm_source=/gi)
  }
];

const patternsById = Object.fromEntries(patterns.map(p => [p.id, p]));

const CONTEXT_WORDS = 12;

function countWords(s) {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

function expandLeft(text, pos, words) {
  let i = pos;
  let count = 0;
  while (i > 0 && count < words) {
    while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
    if (i === 0) break;
    while (i > 0 && !/\s/.test(text[i - 1])) i -= 1;
    count += 1;
  }
  return i;
}

function expandRight(text, pos, words) {
  let i = pos;
  let count = 0;
  while (i < text.length && count < words) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i === text.length) break;
    while (i < text.length && !/\s/.test(text[i])) i += 1;
    count += 1;
  }
  return i;
}

function buildWindows(text, regions) {
  const windows = [];
  for (const r of regions) {
    const ws = expandLeft(text, r.start, CONTEXT_WORDS);
    const we = expandRight(text, r.end, CONTEXT_WORDS);
    const last = windows[windows.length - 1];
    if (last && (ws <= last.end || countWords(text.slice(last.end, ws)) === 0)) {
      last.end = Math.max(last.end, we);
      last.regions.push(r);
    } else {
      windows.push({ start: ws, end: we, regions: [r] });
    }
  }
  return windows;
}

function collectMatches(text, enabled) {
  const perPattern = {};
  const raw = [];
  for (const p of patterns) {
    perPattern[p.id] = 0;
    if (!enabled.has(p.id)) continue;
    for (const m of p.find(text)) {
      m.patternId = p.id;
      raw.push(m);
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const matches = [];
  for (const m of raw) {
    const last = matches[matches.length - 1];
    if (last && m.start < last.end) continue;
    m.id = matches.length;
    matches.push(m);
    perPattern[m.patternId] += 1;
  }
  return { matches, perPattern };
}

function buildRegions(text, matches) {
  const regions = [];
  for (const m of matches) {
    const [s, e] = sentenceBounds(text, m.start, m.end);
    const last = regions[regions.length - 1];
    if (last && s <= last.end) {
      last.end = Math.max(last.end, e);
      last.matches.push(m);
    } else {
      regions.push({ start: s, end: e, matches: [m] });
    }
  }
  return regions;
}

function sentenceBounds(text, start, end) {
  let s = start;
  while (s > 0) {
    const ch = text[s - 1];
    if (ch === '\n' || ch === '.' || ch === '!' || ch === '?' || ch === '\u2026') break;
    s -= 1;
  }
  while (s < start && /\s/.test(text[s])) s += 1;
  let e = end;
  while (e < text.length) {
    const ch = text[e];
    if (ch === '\n') break;
    e += 1;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\u2026') {
      while (e < text.length && /["'\u201d\u2019)\]]/.test(text[e])) e += 1;
      break;
    }
  }
  return [s, e];
}

const EXAMPLE = `We rebuilt the editor from the ground up. No sign-ups, no downloads, no hassle — just paste your text and start writing. Everything runs locally in your browser.

The reviewer read the draft twice. Did not flinch, did not blink, did not reach for the red pen. That's the whole review, honestly.

Don't call it a rewrite — call it a rescue. The improvement is real, and it's not subtle. That loss is worth naming. Sit with that for a moment. The gains were modest, but that's not nothing.

You already know the answer, of course. Consistency is the entire game, and the punchline is that nobody wants to hear it. The entire pitch is one sentence long.

In this guide we delve into the redesign. It is important to note that the rollout happened in stages. Community feedback plays a pivotal role in every release. Experts argue that the shift was overdue.

The studio is nestled in a converted warehouse. The finished space is not just an office, but a small museum. Visitors keep coming back, reflecting the appeal of the collection. The steady attendance is a testament to the curators.

Despite these challenges, the team kept shipping. They adapted to an ever-evolving landscape. As of my last update, the pricing page still said “coming soon”.

The parser is a tiny state machine. The renderer is a tiny state machine.

I won't pretend the rollout was smooth. It turns out that nobody reads the changelog. Here is the whole secret. The small core still fits in your head. That's the part a schedule can't capture. It's the only estimate I trust. You don't have to take my word for it.

The launch needed three things: a blog post, a demo video, and a pricing page. Here's the catch: the demo was recorded months earlier. Do I regret shipping it? Do I miss the old importer?

The old importer is dead, and nobody mourned. That's why the export button mattered. The tool died; the data didn't.

Maybe nobody needed the importer. Maybe the shortcut confused people. Maybe the redesign was overdue all along.

This closing paragraph is deliberately ordinary, with no list patterns at all, so nothing here should light up.`;

// ==== tests start ====

const selfTests = [];

function test(name, fn) {
  selfTests.push({ name, fn });
}

function expectEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(label + ': expected ' + b + ', got ' + a);
}

function caseName(id, sample) {
  const clean = sample.replace(/\s+/g, ' ').trim();
  const short = clean.length > 44 ? clean.slice(0, 41) + '\u2026' : clean;
  return id + ' \u00b7 \u201c' + short + '\u201d';
}

const patternCases = [
  ['no-chain', 'No sign-ups, no downloads, no hassle — just paste and go.', 1, [3]],
  ['no-chain', 'The plan has no hidden fees and no long-term contracts.', 1, [2]],
  ['no-chain', 'No fluff, no filler, no jargon, no corporate buzzwords.', 1, [4]],
  ['no-chain', 'There is no catch here, honestly.', 0, []],
  ['no-chain', 'It ships with no bells and whistles, no fluff.', 1, [2]],
  ['no-chain', 'No, no, I insist.', 0, []],
  ['no-chain', 'no no no', 0, []],
  ['no-chain', 'with no list patterns at all, so nothing lights up.', 0, []],
  ['no-chain', 'NO FEES, NO CONTRACTS, NO SURPRISES', 1, [3]],
  ['no-chain', 'no fluff; no filler', 1, [2]],
  ['no-chain', 'no time, no money, no way to say no thanks', 1, [3]],
  ['no-chain', 'no-code, no-fuss setup', 1, [2]],
  ['no-chain', 'I know nothing, notice nothing.', 0, []],
  ['no-chain', 'No fluff, no filler.\nNo ads here.', 1, [2]],
  ['whole', "That's the whole point.", 1],
  ['whole', 'This is the whole game, really.', 1],
  ['whole', 'That was the whole pitch.', 1],
  ['whole', 'The whole team showed up.', 0],
  ['did-not-chain', 'Did not flinch, did not blink, did not apologize.', 1, [3]],
  ['did-not-chain', "He didn't call and didn't write.", 1, [2]],
  ['did-not-chain', 'She did not go.', 0, []],
  ['did-not-chain', 'Did not know why, did not care.', 1, [2]],
  ['dont-verb-it', "Don't call it a comeback. Call it a return.", 1],
  ['dont-verb-it', 'Do not think of it as a burden. Think of it as fuel.', 1],
  ['dont-verb-it', "Don't fear it. Name it.", 0],
  ['dont-verb-it', 'Don\u2019t call it "luck." Call it preparation.', 1],
  ['dont-verb-it', "Don't just read it — read it aloud.", 1],
  ['dont-verb-it', "Don't overthink it.", 0],
  ['sit-with', 'Sit with that for a moment.', 1],
  ['sit-with', 'Just sit with it.', 1],
  ['sit-with', 'She was sitting with the discomfort.', 1],
  ['sit-with', 'Come sit with us at lunch.', 0],
  ['already-know', 'You already know the answer.', 1],
  ['already-know', 'Deep down, you already know.', 1],
  ['already-know', 'If you already know Python, skip ahead.', 0],
  ['already-know', 'You already know what to do.', 1],
  ['already-know', 'Part of you already knows it.', 1],
  ['is-the-entire', 'Consistency is the entire game.', 1],
  ['is-the-entire', "That's the entire business model.", 1],
  ['is-the-entire', 'He toured the entire factory.', 0],
  ['the-entire-is', 'The entire point is that nobody reads.', 1],
  ['the-entire-is', 'The entire business model is built on churn.', 1],
  ['the-entire-is', 'The entire point of the exercise is repetition.', 1],
  ['the-entire-is', 'He ate the entire pizza.', 0],
  ['the-entire-is', 'The entire team was exhausted.', 1],
  ['the-entire-is', 'The entire history of the modern industrial world economy is complex.', 0],
  ['is-real', "The improvement is real, and it's not subtle.", 1],
  ['is-real', 'This is the real work, and it never ends.', 1],
  ['is-real', 'The demand is real and growing.', 1],
  ['is-real', 'He is a real estate agent and it shows.', 0],
  ['is-real', 'Is it real? And does it matter?', 0],
  ['is-real', 'The painting is real, but stolen.', 0],
  ['punchline', 'The punchline is that nobody laughed.', 1],
  ['punchline', 'The punchline: nothing changed.', 1],
  ['punchline', 'And the punchline? You knew.', 1],
  ['punchline', 'He forgot the punchline entirely.', 0],
  ['worth-naming', "That loss is real and it's worth naming.", 1],
  ['worth-naming', 'It’s worth naming that this hurts.', 1],
  ['worth-naming', 'The grief here is worth naming.', 1],
  ['worth-naming', 'That anger feels worth naming out loud.', 1],
  ['worth-naming', 'Worth naming: nobody asked for this.', 1],
  ['worth-naming', "It's not worth naming names here.", 0],
  ['worth-naming', 'They spent the meeting naming the new mascot.', 0],
  ['worth-naming', 'The naming convention is worth documenting.', 0],
  ['not-nothing', "That's not nothing.", 1],
  ['not-nothing', 'Ten sign-ups in a week — that is not nothing.', 1],
  ['not-nothing', "It's not nothing, even if it's not everything.", 1],
  ['not-nothing', 'The launch drew a small crowd, which was not nothing.', 1],
  ['not-nothing', 'She insisted that nothing was wrong.', 0],
  ['not-nothing', 'There is nothing left to say.', 0],
  ['is-the-whole', 'Distribution is the whole game.', 1],
  ['is-the-whole', "Here's the whole pitch in one slide.", 1],
  ['is-the-whole', 'That was the whole point of the meeting.', 1],
  ['is-the-whole', 'The whole team showed up.', 0],
  ['echo-triad', 'A shopping cart is an object in the system. A chat room is an object in the system.', 1, [2]],
  ['echo-triad', 'The parser is a state machine. The renderer is a state machine. The scheduler is a state machine.', 1, [3]],
  ['echo-triad', 'The parser is fast today. The renderer is fast today.', 0, []],
  ['echo-triad', 'The parser is fast. The tests are slow.', 0, []],
  ['performative-honesty', "I won't pretend the migration was painless.", 1],
  ['performative-honesty', "Let's be honest: nobody reads the docs.", 1],
  ['performative-honesty', 'To be clear, the API is unchanged.', 1],
  ['performative-honesty', 'Honestly, it was fine.', 1],
  ['performative-honesty', 'She answered honestly.', 0],
  ['performative-honesty', 'Look at the diagram.', 0],
  ['thats-the-part', "That's the part a counter can't reach.", 1],
  ['thats-the-part', 'The part that makes me trust the rest is the errata.', 1],
  ['thats-the-part', 'My favorite part of the demo was the undo.', 1],
  ['thats-the-part', 'He played the part of the villain.', 0],
  ['the-only-i-trust', 'It’s the only marketing I trust.', 1],
  ['the-only-i-trust', 'The only benchmark that matters is retention.', 1],
  ['the-only-i-trust', 'The only thing it needs is a cache.', 1],
  ['the-only-i-trust', 'She was the only engineer on call.', 0],
  ['take-my-word', "You don't have to take my word for it.", 1],
  ['take-my-word', "Don't take my word for any of this.", 1],
  ['take-my-word', 'He kept his word.', 0],
  ['turns-out', 'Turns out the cache was never warm.', 1],
  ['turns-out', 'It turns out that nobody tested it.', 1],
  ['turns-out', 'She turns out solid work every week.', 0],
  ['fits-in-your-head', 'The design is small enough to hold in your head.', 1],
  ['fits-in-your-head', 'It ships with sane defaults and zero config.', 2],
  ['fits-in-your-head', 'Install it and it just works.', 1],
  ['fits-in-your-head', 'We choose boring technology on purpose.', 0],
  ['fits-in-your-head', 'The helmet fits your head.', 0],
  ['stacked-questions', 'Do I know how it works? Where it breaks? Which corners it cut?', 1, [3]],
  ['stacked-questions', 'Was it worth it? Would I do it again?', 1, [2]],
  ['stacked-questions', 'Did it work? Yes, and then some.', 0, []],
  ['stacked-questions', 'What changed?', 0, []],
  ['sentence-anaphora', 'Maybe nobody needed it. Maybe the timing was off. Maybe both.', 1, [3]],
  ['sentence-anaphora', 'Maybe nobody needed it. Maybe the timing was off.', 0, []],
  ['sentence-anaphora', 'The parser is small. The renderer is small. The scheduler is small.', 0, []],
  ['sentence-anaphora', 'Everything changed. Everything slowed down. Everything cost more.', 1, [3]],
  ['colon-triple', 'The fix needs three things: separate ports, separate processes, and separate state.', 1],
  ['colon-triple', 'Each service gets its own everything: ports, processes, local state.', 1],
  ['colon-triple', 'The recipe calls for flour, butter, and sugar.', 0],
  ['colon-triple', 'Note: the flag is off by default.', 0],
  ['heres-the-twist', "Here's the twist: nobody clicked it.", 1],
  ['heres-the-twist', 'Here is the thing. The demo was fake.', 1],
  ['heres-the-twist', "Here's a surprising result: it got faster.", 1],
  ['heres-the-twist', "Here's the door code.", 0],
  ['x-is-dead', 'Peer code review is dead.', 1],
  ['x-is-dead', 'The old importer is dead; long live the importer.', 2],
  ['x-is-dead', 'Long live the king.', 1],
  ['x-is-dead', 'He played dead until the bear left.', 0],
  ['thats-why-mattered', "That's why being able to open the environment mattered.", 1],
  ['thats-why-mattered', 'This is why preserving every conversation mattered.', 1],
  ['thats-why-mattered', "That's why the deadline counts.", 1],
  ['thats-why-mattered', 'That is why we left early.', 0],
  ['stranded-auxiliary', "The tool died; the data didn't.", 1],
  ['stranded-auxiliary', "Reading mostly passed, writing didn't.", 1],
  ['stranded-auxiliary', "Maybe it wouldn't have.", 1],
  ['stranded-auxiliary', 'The test passed and the build was green.', 0],
  ['ai-vocab', 'We delve into the intricacies of the interplay.', 3],
  ['ai-vocab', 'Her vibrant tapestry hung in the bustling hall.', 3],
  ['ai-vocab', 'A meticulously curated, seamless experience.', 2],
  ['ai-vocab', 'The report was thorough and well organized.', 0],
  ['not-just', 'This is not just a tool, but a philosophy.', 1],
  ['not-just', 'Not only fast but also reliable.', 1],
  ['not-just', 'It’s not a bug — it’s a feature.', 1],
  ['not-just', 'He did not buy it.', 0],
  ['not-just', 'She was not sure about the plan.', 0],
  ['note-that', 'It is important to note that timing matters.', 1],
  ['note-that', 'It’s worth noting the fees are separate.', 1],
  ['note-that', 'It should be noted that this changed in 2020.', 1],
  ['note-that', "It's worth pausing on that number.", 1],
  ['note-that', 'It is worth asking who benefits.', 1],
  ['note-that', 'Please note the door code.', 0],
  ['testament', 'The building stands as a testament to postwar optimism.', 1],
  ['testament', 'Her career is a testament to persistence.', 1],
  ['testament', 'It serves as a stark reminder that nothing lasts.', 1],
  ['testament', 'He read from the Old Testament.', 0],
  ['crucial-role', 'Volunteers play a crucial role in the program.', 1],
  ['crucial-role', 'She played a truly pivotal role in the merger.', 1],
  ['crucial-role', 'He plays the role of the villain.', 0],
  ['landscape', 'Adapting to an ever-evolving landscape.', 1],
  ['landscape', 'The rapidly changing landscape of retail.', 1],
  ['landscape', 'In today’s fast-paced world, attention is scarce.', 1],
  ['landscape', 'The landscape outside the window was gray.', 0],
  ['vague-experts', 'Experts argue that the policy failed.', 1],
  ['vague-experts', 'Some critics have noted a decline in quality.', 1],
  ['vague-experts', 'Industry reports suggest strong demand.', 1],
  ['vague-experts', 'Dr. Chen argued the opposite in her paper.', 0],
  ['despite-challenges', 'Despite these challenges, growth continued.', 1],
  ['despite-challenges', 'The sector faces several challenges.', 1],
  ['despite-challenges', 'Whether it works remains to be seen.', 1],
  ['despite-challenges', 'Only time will tell whether it sticks.', 1],
  ['despite-challenges', 'Time will tell.', 1],
  ['despite-challenges', 'He arrived on time and will tell you himself.', 0],
  ['despite-challenges', 'The climb was a challenge.', 0],
  ['participle-tail', 'The bridge reopened in June, highlighting the city’s investment in infrastructure.', 1],
  ['participle-tail', 'Sales doubled, underscoring the strength of the brand.', 1],
  ['participle-tail', 'She kept highlighting passages in yellow.', 0],
  ['participle-tail', 'The team, reflecting on the loss, regrouped.', 0],
  ['promo', 'The inn is nestled in a quiet valley.', 1],
  ['promo', 'The museum boasts a rich tapestry of exhibits.', 2],
  ['promo', 'Located in the heart of downtown.', 1],
  ['promo', 'A hidden gem with breathtaking views.', 2],
  ['promo', 'The soup was rich and hearty.', 0],
  ['ai-leftovers', 'As of my last update, the API was in beta.', 1],
  ['ai-leftovers', 'As an AI language model, I cannot form opinions.', 1],
  ['ai-leftovers', 'See example.com/page?utm_source=chatgpt.com for details.', 1],
  ['ai-leftovers', 'contentReference[oaicite:0]{index=0}', 2],
  ['ai-leftovers', 'The last update shipped on Tuesday.', 0]
];

for (const [id, sample, expectMatches, expectItems] of patternCases) {
  test(caseName(id, sample), () => {
    const found = patternsById[id].find(sample);
    expectEqual(found.length, expectMatches, 'matches');
    if (expectItems) expectEqual(found.map(f => f.count), expectItems, 'item counts');
  });
}

test('sentence bounds isolate the flagged sentence', () => {
  const t = 'First sentence here. No fluff, no filler. Last one.';
  const m = patternsById['no-chain'].find(t)[0];
  const [s, e] = sentenceBounds(t, m.start, m.end);
  expectEqual(t.slice(s, e), 'No fluff, no filler.', 'bounds');
});

test('excerpts: 12 words of context on each side', () => {
  const pre = Array.from({ length: 30 }, (_, i) => 'w' + i).join(' ');
  const post = Array.from({ length: 30 }, (_, i) => 't' + i).join(' ');
  const t = pre + '. No fluff, no filler, just results. ' + post + '.';
  const regions = buildRegions(t, collectMatches(t, new Set(['no-chain'])).matches);
  const wins = buildWindows(t, regions);
  expectEqual(wins.length, 1, 'windows');
  expectEqual(countWords(t.slice(0, wins[0].start)), 18, 'hidden before');
  expectEqual(countWords(t.slice(wins[0].end)), 18, 'hidden after');
});

test('excerpts: nearby matches merge into one window', () => {
  const pre = Array.from({ length: 30 }, (_, i) => 'w' + i).join(' ');
  const post = Array.from({ length: 30 }, (_, i) => 't' + i).join(' ');
  const t = pre + '. No fluff, no filler. Ok. No ads, no fees. ' + post + '.';
  const regions = buildRegions(t, collectMatches(t, new Set(['no-chain'])).matches);
  const wins = buildWindows(t, regions);
  expectEqual(wins.length, 1, 'windows');
  expectEqual(wins[0].regions.length, 2, 'regions in window');
});

test('excerpts: distant matches stay separate with a counted gap', () => {
  const mid = Array.from({ length: 60 }, (_, i) => 'm' + i).join(' ');
  const t = 'No fluff, no filler. ' + mid + '. No ads, no fees.';
  const regions = buildRegions(t, collectMatches(t, new Set(['no-chain'])).matches);
  const wins = buildWindows(t, regions);
  expectEqual(wins.length, 2, 'windows');
  expectEqual(countWords(t.slice(wins[0].end, wins[1].start)), 36, 'gap words');
});

test('example text trips every pattern exactly once', () => {
  const all = new Set(patterns.map(p => p.id));
  const { matches } = collectMatches(EXAMPLE, all);
  expectEqual(matches.length, patterns.length, 'matches');
  expectEqual(new Set(matches.map(m => m.patternId)).size, patterns.length, 'distinct patterns');
  expectEqual(buildRegions(EXAMPLE, matches).length, patterns.length - 1, 'flagged sentences (two cliches share one)');
});
// ==== tests end ====

// ==== CLI (not in upstream) ====

function offsetToLineCol(text, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function parseArgs(argv) {
  const positional = [];
  const flags = { json: false, all: false, test: false, list: false, help: false, pattern: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--test') flags.test = true;
    else if (a === '--list') flags.list = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--pattern' || a === '-p') {
      const v = argv[++i];
      if (!v) throw new Error('--pattern needs an id');
      flags.pattern.push(v);
    } else if (a.startsWith('--pattern=')) {
      flags.pattern.push(a.slice('--pattern='.length));
    } else if (a.startsWith('-')) {
      throw new Error('unknown flag: ' + a);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function enabledSet(flags) {
  if (flags.pattern.length) {
    const unknown = flags.pattern.filter((id) => !patternsById[id]);
    if (unknown.length) throw new Error('unknown pattern id: ' + unknown.join(', '));
    return new Set(flags.pattern);
  }
  const ids = patterns.map((p) => p.id);
  if (!flags.all) return new Set(ids.filter((id) => id !== 'colon-triple'));
  return new Set(ids);
}

function helpText() {
  return [
    'Usage: check-llm-cliches <file> [--json] [--all] [--pattern <id>]...',
    '       check-llm-cliches --test',
    '       check-llm-cliches --list',
    '',
    'Detect LLM writing clichés. Engine derived from Simon Willison\'s',
    'llm-cliche-highlighter (Apache-2.0).',
    '',
    '  --json            machine-readable output',
    '  --all             include colon-triple (off by default; noisy in docs)',
    '  --pattern <id>    only these patterns (repeatable)',
    '  --test            run upstream self-tests',
    '  --list            print the pattern catalog',
  ].join('\n') + '\n';
}

function listPatterns() {
  const lines = ['id\tname\tgroup', '----------------------------------------'];
  for (const p of patterns) {
    lines.push(p.id + '\t' + p.name + '\t' + (p.group || 'LLM cliché'));
  }
  return lines.join('\n') + '\n';
}

function runSelfTests() {
  const results = [];
  for (const t of selfTests) {
    try {
      t.fn();
      results.push({ name: t.name, ok: true });
    } catch (err) {
      results.push({
        name: t.name,
        ok: false,
        message: err && err.message ? err.message : String(err),
      });
    }
  }
  return results;
}

function analyze(text, enabled) {
  const { matches, perPattern } = collectMatches(text, enabled);
  const regions = buildRegions(text, matches);
  const words = countWords(text);
  const hits = matches.map((m) => {
    const { line, col } = offsetToLineCol(text, m.start);
    const [s, e] = sentenceBounds(text, m.start, m.end);
    const p = patternsById[m.patternId];
    return {
      id: m.patternId,
      name: p.name,
      group: p.group || 'LLM cliché',
      line,
      col,
      start: m.start,
      end: m.end,
      match: text.slice(m.start, m.end),
      sentence: text.slice(s, e),
      count: m.count,
      badge: m.badgeTitle || m.badge,
    };
  });
  const byPattern = [];
  for (const p of patterns) {
    if (!enabled.has(p.id)) continue;
    const n = perPattern[p.id] || 0;
    if (n > 0) {
      byPattern.push({
        id: p.id,
        name: p.name,
        group: p.group || 'LLM cliché',
        matches: n,
      });
    }
  }
  return { words, matches: hits, byPattern, regions: regions.length };
}

function formatMarkdown(filePath, report) {
  const lines = [];
  lines.push('# LLM cliché analysis');
  lines.push('');
  lines.push('**File:** `' + filePath + '`');
  lines.push('**Words:** ' + report.words);
  lines.push(
    '**Matches:** ' + report.matches.length + ' across ' + report.byPattern.length + ' patterns'
  );
  lines.push('**Flagged sentences:** ' + report.regions);
  lines.push('');
  if (report.byPattern.length === 0) {
    lines.push('No LLM clichés detected.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('## By pattern');
  lines.push('');
  for (const p of report.byPattern) {
    lines.push('- `' + p.id + '` (' + p.matches + '): ' + p.name);
  }
  lines.push('');
  lines.push('## Matches');
  lines.push('');
  for (const m of report.matches) {
    const extra = m.badge ? ' [' + m.badge + ']' : '';
    const snippet = m.sentence.replace(/\s+/g, ' ').trim();
    lines.push('- L' + m.line + ' `' + m.id + '`' + extra + ': ' + snippet);
  }
  lines.push('');
  return lines.join('\n');
}

const USAGE_ERROR = 2;

try {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(helpText());
    process.exit(0);
  }
  if (flags.list) {
    process.stdout.write(listPatterns());
    process.exit(0);
  }
  if (flags.test) {
    const results = runSelfTests();
    const failed = results.filter((r) => !r.ok);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ passed: results.length - failed.length, failed }, null, 2) + '\n');
    } else {
      process.stdout.write(
        failed.length === 0
          ? 'Self-tests: all ' + results.length + ' passed\n'
          : 'Self-tests: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed\n'
      );
      for (const r of failed) {
        process.stdout.write('FAIL ' + r.name + ': ' + r.message + '\n');
      }
    }
    process.exit(failed.length === 0 ? 0 : 1);
  }
  const asReview = positional[0] === 'review';
  const filePath = asReview ? (flags.path || positional[1]) : positional[0];
  if (!filePath) {
    process.stderr.write(helpText());
    process.exit(USAGE_ERROR);
  }
  const fs = require('fs');
  const text = await fs.readFile(filePath, 'utf8');
  if (!text.trim()) {
    if (asReview) {
      process.stdout.write(JSON.stringify({
        source: 'check-llm-cliches',
        id: flags.id || ('cliches:' + filePath),
        path: filePath,
        title: String(filePath).split('/').pop(),
        summary: 'Empty file',
        severity: 'info',
        findings: [],
      }) + '\n');
      process.exit(0);
    }
    process.stdout.write('Input file is empty or contains only whitespace; no analysis to perform.\n');
    process.exit(0);
  }
  const enabled = enabledSet(flags);
  const report = analyze(text, enabled);
  if (asReview) {
    process.stdout.write(JSON.stringify(reviewContribution(filePath, flags.id, report)) + '\n');
  } else if (flags.json) {
    process.stdout.write(JSON.stringify({ file: filePath, ...report }, null, 2) + '\n');
  } else {
    process.stdout.write(formatMarkdown(filePath, report));
  }
} catch (err) {
  process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
  process.exit(USAGE_ERROR);
}
