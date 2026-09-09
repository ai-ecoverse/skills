"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InlineLexer = exports.Lexer = void 0;
const rules_1 = require("./rules");
const utilities_1 = require("./utilities");
const token_1 = require("./token");
class Lexer {
    /**
     * Replaces boneyard with an empty string. If a boneyard token exists
     * at the start of a line, it preserves token continuity by adding blank lines
     * for the lexer to parse.
     * @param match
     * @returns {string} empty string or blank lines
     */
    static boneyardStripper(match) {
        const endAtStrStart = /^[^\S\n]*\*\//m;
        let boneyardEnd = '';
        if (endAtStrStart.test(match)) {
            boneyardEnd = '\n\n';
        }
        return boneyardEnd;
    }
    /**
     * Tokenizes the script.
     * @param {string} script
     * @returns {[Token<Array>, Token<Array>]} tuple of title page and script token arrays
     */
    static tokenize(script) {
        let source = script
            .replace(rules_1.rules.boneyard, this.boneyardStripper)
            .replace(/\r\n|\r/g, '\n'); // convert carriage return / returns to newline
        this.scanIndex = 0;
        const titlePageTokens = this.tokenizeTitlePage(source);
        source = source.substring(this.scanIndex);
        const scriptTokens = Lexer.tokenizeScript(source);
        return [titlePageTokens, scriptTokens];
    }
    /**
     * Tokenizes the title page. Tests for title page keywords then lexes going forward.
     * If no keywords are found and empty array is returned.
     * @param {string} source
     * @returns {Token<Array>}
     */
    static tokenizeTitlePage(source) {
        let titlePageTokens = [];
        if (token_1.TitlePageBlock.matchedBy(source)) {
            const titlePageBlock = new token_1.TitlePageBlock(source);
            this.scanIndex = titlePageBlock.scanIndex;
            titlePageTokens = titlePageBlock.addTo(titlePageTokens);
        }
        return titlePageTokens;
    }
    /**
     * Tokenizes all Fountain tokens except Title Page. Splits the script based on
     * blank lines then lexes in reverse to account for dual dialogue tokens.
     * @param {string} source
     * @returns {Token<Array>}
     */
    static tokenizeScript(source) {
        const lines = source
            .split(rules_1.rules.blank_lines)
            .reverse();
        const scriptTokens = lines.reduce((previous, line) => {
            if (!line) {
                return previous;
            }
            /** spaces */
            if (token_1.SpacesToken.matchedBy(line)) {
                return new token_1.SpacesToken().addTo(previous);
            }
            /** scene headings */
            if (token_1.SceneHeadingToken.matchedBy(line)) {
                return new token_1.SceneHeadingToken(line).addTo(previous);
            }
            /** centered */
            if (token_1.CenteredToken.matchedBy(line)) {
                return new token_1.CenteredToken(line).addTo(previous);
            }
            /** transitions */
            if (token_1.TransitionToken.matchedBy(line)) {
                return new token_1.TransitionToken(line).addTo(previous);
            }
            /** dialogue blocks - characters, parentheticals and dialogue */
            if (token_1.DialogueBlock.matchedBy(line)) {
                const dialogueBlock = new token_1.DialogueBlock(line, this.lastLineWasDualDialogue);
                this.lastLineWasDualDialogue = dialogueBlock.dual;
                return dialogueBlock.addTo(previous);
            }
            /** section */
            if (token_1.SectionToken.matchedBy(line)) {
                return new token_1.SectionToken(line).addTo(previous);
            }
            /** synopsis */
            if (token_1.SynopsisToken.matchedBy(line)) {
                return new token_1.SynopsisToken(line).addTo(previous);
            }
            /** notes */
            if (token_1.NoteToken.matchedBy(line)) {
                return new token_1.NoteToken(line).addTo(previous);
            }
            /** lyrics */
            if (token_1.LyricsToken.matchedBy(line)) {
                return new token_1.LyricsToken(line).addTo(previous);
            }
            /** page breaks */
            if (token_1.PageBreakToken.matchedBy(line)) {
                return new token_1.PageBreakToken().addTo(previous);
            }
            /** action */
            return new token_1.ActionToken(line).addTo(previous);
        }, []);
        return scriptTokens.reverse();
    }
}
exports.Lexer = Lexer;
class InlineLexer {
    static reconstruct(line, escapeSpaces = false) {
        const styles = [
            'bold_italic_underline',
            'bold_underline',
            'italic_underline',
            'bold_italic',
            'bold',
            'italic',
            'underline'
        ];
        line = (0, utilities_1.escapeHTML)(line.replace(rules_1.rules.escape, '[{{{$&}}}]') // perserve escaped characters
        );
        if (escapeSpaces) {
            line = line.replace(/^( +)/gm, (_, spaces) => {
                return '&nbsp;'.repeat(spaces.length);
            });
        }
        for (let style of styles) {
            const rule = rules_1.rules[style];
            if (rule.test(line)) {
                line = line.replace(rule, this.inline[style]);
            }
        }
        return line
            .replace(rules_1.rules.note_inline, this.inline.note)
            .replace(/\n/g, this.inline.line_break)
            .replace(/\[{{{\\(&.+?;|.)}}}]/g, this.inline.escape) // restore escaped chars to intended sequence
            .trimEnd();
    }
}
exports.InlineLexer = InlineLexer;
InlineLexer.inline = {
    note: '<!-- $1 -->',
    line_break: '<br />',
    bold_italic_underline: '<span class="bold italic underline">$1</span>',
    bold_underline: '<span class="bold underline">$1</span>',
    italic_underline: '<span class="italic underline">$1</span>',
    bold_italic: '<span class="bold italic">$1</span>',
    bold: '<span class="bold">$1</span>',
    italic: '<span class="italic">$1</span>',
    underline: '<span class="underline">$1</span>',
    escape: '$1'
};
//# sourceMappingURL=lexer.js.map