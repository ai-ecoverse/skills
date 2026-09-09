"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionToken = exports.SpacesToken = exports.PageBreakToken = exports.NoteToken = exports.SynopsisToken = exports.SectionToken = exports.LyricsToken = exports.DualDialogueEndToken = exports.DualDialogueBeginToken = exports.ParentheticalToken = exports.DialogueEndToken = exports.DialogueToken = exports.CharacterToken = exports.DialogueBeginToken = exports.DialogueBlock = exports.TransitionToken = exports.CenteredToken = exports.SceneHeadingToken = exports.TitlePageToken = exports.TitlePageBlock = void 0;
const rules_1 = require("./rules");
class TitlePageBlock {
    constructor(source) {
        this.tokens = [];
        const titlePageBlock = /^\s*(?:[\w ]+(?<!\\)\:[^\S\n]*(?:(?:\n(?: {3}|\t))?[^\S\n]*\S.*)+(?:\n|$))+/;
        const keyValuePair = /^\s*[\w ]+(?<!\\)\:[^\S\n]*(?:(?:\n(?![\w ]+\:)(?: {3}|\t))?[^\S\n]*\S.*)+(?:\n|$)/;
        let scanPosition = 0;
        const match = source.match(titlePageBlock);
        if (match) {
            let titlePageData = match[0];
            this.scanIndex = titlePageData.length;
            while (scanPosition < this.scanIndex) {
                const pair = titlePageData.match(keyValuePair);
                if (pair) {
                    this.tokens = new TitlePageToken(pair[0]).addTo(this.tokens);
                    titlePageData = titlePageData.substring(pair[0].length);
                    scanPosition += pair[0].length;
                }
                else {
                    this.scanIndex = scanPosition;
                    break;
                }
            }
        }
    }
    addTo(tokens) {
        return [...tokens, ...this.tokens];
    }
    static matchedBy(source) {
        return rules_1.rules.title_page.test(source);
    }
}
exports.TitlePageBlock = TitlePageBlock;
class TitlePageToken {
    constructor(pair) {
        this.is_title = true;
        const [key, delimeter, value] = pair.split(/(\:[^\S\n]*\n?)([\S\s]*)/, 3);
        this.type = key.trim().toLowerCase().replace(/ /g, '_');
        this.text = value.replace(/^\s*|\s*$/gm, '');
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.TitlePageToken = TitlePageToken;
class SceneHeadingToken {
    constructor(line) {
        this.type = 'scene_heading';
        const match = line.match(rules_1.rules.scene_heading);
        if (match) {
            this.text = (match[1] || match[2]).trim();
        }
        const meta = this.text.match(rules_1.rules.scene_number);
        if (meta) {
            this.scene_number = meta[1];
            this.text = this.text.replace(rules_1.rules.scene_number, '');
        }
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.scene_heading.test(line);
    }
}
exports.SceneHeadingToken = SceneHeadingToken;
class CenteredToken {
    constructor(line) {
        this.type = 'centered';
        const match = line.match(rules_1.rules.centered);
        if (match) {
            this.text = match[0].replace(/[^\S\n]*[><][^\S\n]*/g, '');
        }
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.centered.test(line);
    }
}
exports.CenteredToken = CenteredToken;
class TransitionToken {
    constructor(line) {
        this.type = 'transition';
        const match = line.match(rules_1.rules.transition);
        if (match) {
            this.text = (match[1] || match[2]).trim();
        }
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.transition.test(line);
    }
}
exports.TransitionToken = TransitionToken;
class DialogueBlock {
    constructor(line, dual) {
        this.tokens = [];
        const match = line.match(rules_1.rules.dialogue);
        if (match) {
            this.scanIndex = match.length;
            let name = match[1].trim();
            // iterating from the bottom up, so push dialogue blocks in reverse order
            const isDualDialogue = !!match[2];
            if (isDualDialogue) {
                this.tokens.push(new DualDialogueEndToken());
            }
            this.tokens.push(new DialogueEndToken());
            const parts = match[3].split(/\n/);
            let dialogue = parts.reduce((p, text = '') => {
                const lastIndex = p.length - 1;
                const previousToken = p[lastIndex];
                if (!text.length) {
                    return p;
                }
                if (rules_1.rules.line_break.test(text)) {
                    text = '';
                }
                text = text.trim();
                if (rules_1.rules.parenthetical.test(text)) {
                    return [...p, new ParentheticalToken(text)];
                }
                if (rules_1.rules.lyrics.test(text)) {
                    if (previousToken.type === 'lyrics') {
                        p[lastIndex].text =
                            `${previousToken.text}\n${text.replace(/^~/, '')}`;
                        return p;
                    }
                    else {
                        return [...p, new LyricsToken(text)];
                    }
                }
                if ((previousToken === null || previousToken === void 0 ? void 0 : previousToken.type) === 'dialogue') {
                    p[lastIndex].text = `${previousToken.text}\n${text}`;
                    return p;
                }
                return [...p, new DialogueToken(text)];
            }, []).reverse();
            this.tokens.push(...dialogue);
            this.tokens.push(new CharacterToken(name.startsWith('@')
                ? name.replace(/^@/, '').trim()
                : name.trim()), new DialogueBeginToken(isDualDialogue ? 'right' : dual ? 'left' : undefined));
            if (dual) {
                this.tokens.push(new DualDialogueBeginToken());
            }
            this.dual = isDualDialogue;
        }
    }
    addTo(tokens) {
        return [...tokens, ...this.tokens];
    }
    static matchedBy(line) {
        return rules_1.rules.dialogue.test(line);
    }
}
exports.DialogueBlock = DialogueBlock;
class DialogueBeginToken {
    constructor(dual) {
        this.type = 'dialogue_begin';
        this.dual = dual;
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.DialogueBeginToken = DialogueBeginToken;
class CharacterToken {
    constructor(text) {
        this.type = 'character';
        this.text = text;
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.CharacterToken = CharacterToken;
class DialogueToken {
    constructor(text) {
        this.type = 'dialogue';
        this.text = text;
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.DialogueToken = DialogueToken;
class DialogueEndToken {
    constructor() {
        this.type = 'dialogue_end';
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.DialogueEndToken = DialogueEndToken;
class ParentheticalToken {
    constructor(text) {
        this.type = 'parenthetical';
        this.text = text;
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.ParentheticalToken = ParentheticalToken;
class DualDialogueBeginToken {
    constructor() {
        this.type = 'dual_dialogue_begin';
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.DualDialogueBeginToken = DualDialogueBeginToken;
class DualDialogueEndToken {
    constructor() {
        this.type = 'dual_dialogue_end';
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.DualDialogueEndToken = DualDialogueEndToken;
class LyricsToken {
    constructor(line) {
        this.type = 'lyrics';
        this.text = line.replace(/^\s*~(?! )/gm, '');
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.lyrics.test(line);
    }
}
exports.LyricsToken = LyricsToken;
class SectionToken {
    constructor(line) {
        this.type = 'section';
        const match = line.match(rules_1.rules.section);
        if (match) {
            this.text = match[2];
            this.depth = match[1].length;
        }
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.section.test(line);
    }
}
exports.SectionToken = SectionToken;
class SynopsisToken {
    constructor(line) {
        this.type = 'synopsis';
        const match = line.match(rules_1.rules.synopsis);
        if (match) {
            this.text = match[1];
        }
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.synopsis.test(line);
    }
}
exports.SynopsisToken = SynopsisToken;
class NoteToken {
    constructor(line) {
        this.type = 'note';
        const match = line.match(rules_1.rules.note);
        if (match) {
            this.text = match[1];
        }
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.note.test(line);
    }
}
exports.NoteToken = NoteToken;
class PageBreakToken {
    constructor() {
        this.type = 'page_break';
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.page_break.test(line);
    }
}
exports.PageBreakToken = PageBreakToken;
class SpacesToken {
    constructor() {
        this.type = 'spaces';
    }
    addTo(tokens) {
        return [...tokens, this];
    }
    static matchedBy(line) {
        return rules_1.rules.blank_lines.test(line);
    }
}
exports.SpacesToken = SpacesToken;
class ActionToken {
    constructor(line) {
        this.type = 'action';
        this.text = line
            .replace(/^(\s*)!(?! )/gm, '$1')
            .replace(/^( *)(\t+)/gm, (_, leading, tabs) => {
            return leading + '    '.repeat(tabs.length);
        });
    }
    addTo(tokens) {
        return [...tokens, this];
    }
}
exports.ActionToken = ActionToken;
//# sourceMappingURL=token.js.map