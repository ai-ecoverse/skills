// Render source, not a generated HTML file, as the durable review target.
const { Fountain } = require('./vendor/fountain-js');
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
function renderFountain(source, path = '') {
  const parser = new Fountain();
  let tokenIndex = 0;
  let scene = '';
  const original = parser.to_html.bind(parser);
  parser.to_html = (token) => {
    const index = tokenIndex++;
    if (token.type === 'scene_heading') scene = token.text;
    // Scene numbers are data, never HTML attributes supplied by the author.
    const html = original({ ...token, scene_number: undefined });
    if (!html || !/^<(h[1-4]|p|hr)(\s|>)/.test(html)) return html;
    return html.replace(
      /^<([a-z0-9]+)/,
      '<$1 id="fountain-' +
        index +
        '" data-fountain-token="' +
        index +
        '" data-fountain-type="' +
        escapeHtml(token.type) +
        '" data-scene="' +
        escapeHtml(scene) +
        '"'
    );
  };
  const result = parser.parse(String(source), true);
  const title = result.title || path.split('/').pop() || 'Screenplay';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--review-bg,#f3f1ec);color:var(--review-fg,#242424);font:15px/1.5 ui-monospace,"Courier New",monospace}
.screenplay{max-width:760px;margin:auto;padding:40px clamp(20px,7vw,72px) 72px;background:var(--review-paper,#fff);min-height:100vh}
.title-page{text-align:center;padding:50px 0 70px;border-bottom:1px solid var(--review-line,#ddd);margin-bottom:40px}.title-page h1{font-size:24px;margin:0 0 24px}.title-page p{margin:8px 0}.title-page .contact{text-align:left;margin-top:32px}
h3{font-size:1em;margin:28px 0 18px;text-transform:uppercase}h2{font-size:1em;text-align:right;margin:24px 0;font-weight:normal}h4{font-size:1em;margin:0 0 0 24%;font-weight:normal}p{margin:0 0 18px;white-space:normal;overflow-wrap:anywhere}
.dialogue{margin:0 12% 18px 20%}.dialogue p{margin:0}.parenthetical{margin-left:12%!important}.centered{text-align:center}.lyrics{font-style:italic}.bold{font-weight:bold}.italic{font-style:italic}.underline{text-decoration:underline}.dual-dialogue{display:flex;gap:24px}.dual-dialogue>.dialogue{flex:1;min-width:0;margin:0 0 18px}.dual-dialogue h4{margin-left:12%}hr{border:0;border-top:1px dashed var(--review-line,#ccc);margin:32px 0;break-after:page}
@media(max-width:420px){body{font-size:13px}.screenplay{padding:24px 20px 48px}.title-page{padding:28px 0 40px}.dialogue{margin-left:12%;margin-right:4%}.dual-dialogue{display:block}.dual-dialogue>.dialogue{margin-left:12%;margin-bottom:18px}}
@media print{body{background:white;color:black}.screenplay{max-width:none;padding:0;background:white}.title-page{break-after:page;border:0}}
</style></head><body><main class="screenplay">${result.html.title_page ? '<header class="title-page">' + result.html.title_page + '</header>' : ''}<article>${result.html.script}</article></main></body></html>`;
  return { format: 'fountain', renderer: 'fountain-js@1.2.4', title, path, html };
}
module.exports = { renderFountain };
