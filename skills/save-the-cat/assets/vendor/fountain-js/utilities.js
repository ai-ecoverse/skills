"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unEscapeHTML = exports.escapeHTML = void 0;
function escapeHTML(line) {
    return line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
exports.escapeHTML = escapeHTML;
function unEscapeHTML(line) {
    return line
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
}
exports.unEscapeHTML = unEscapeHTML;
//# sourceMappingURL=utilities.js.map