/* Runner for the markdown XSS acceptance gate. Authored as its own file ON
   PURPOSE: when this lived inside build.sh as a nested JS string, one level of
   escaping collapsed and `\u0000` was written into the generated page as a RAW
   control byte, which made the regex `[\u0000-\u0020]` an invalid character
   class ("Range out of order"). The whole runner then threw on its first
   statement and the page sat at "running…" while looking structurally perfect.
   Nothing here is escaped by a generator now; build.sh inlines this verbatim.

   Deliberately escape-free where it matters: control characters are stripped by
   char code, not by a regex literal. */
(function () {
  function stripCtrl(s) {
    let out = '';
    for (const ch of String(s)) if (ch.charCodeAt(0) > 32) out += ch;
    return out;
  }

  const spec = JSON.parse(document.getElementById('fixtures').textContent);
  const R = window.GHMarkdown;
  const out = document.getElementById('out');
  const verdict = document.getElementById('verdict');
  let pass = 0;
  let fail = 0;
  delete window.__xssFired;

  if (!R || typeof R.into !== 'function') {
    verdict.className = 'bad';
    verdict.textContent = 'GATE CANNOT RUN — window.GHMarkdown is missing. Rebuild with ./build.sh';
    return;
  }

  for (const f of spec.fixtures) {
    const cell = document.createElement('div');
    cell.style.display = 'none';
    document.body.appendChild(cell);

    let threw = null;
    try {
      R.into(cell, 'gate:' + f.id, f.md);
    } catch (e) {
      threw = String(e);
    }

    const all = [...cell.querySelectorAll('*')];
    const tags = all.map((n) => n.tagName.toLowerCase());
    const attrNames = [];
    const attrValues = [];
    for (const n of all) {
      for (const a of n.attributes) {
        attrNames.push(a.name.toLowerCase());
        attrValues.push(a.value);
      }
    }
    const hrefs = [...cell.querySelectorAll('[href]')].map((n) => n.getAttribute('href') || '');
    const anchors = [...cell.querySelectorAll('a')];
    const e = f.expect || {};
    const fails = [];

    for (const t of e.noTags || []) if (tags.includes(t)) fails.push('tag present: ' + t);
    for (const a of e.noAttrs || []) if (attrNames.includes(a)) fails.push('attr present: ' + a);
    for (const t of e.hasTags || []) if (!tags.includes(t)) fails.push('tag missing: ' + t);
    for (const sch of e.noHrefScheme || []) {
      if (hrefs.some((h) => stripCtrl(h).toLowerCase().startsWith(sch.toLowerCase()))) {
        fails.push('scheme survived: ' + sch);
      }
    }
    if (e.anchorsAllBlank) {
      const bad = anchors.filter((a) => a.getAttribute('target') !== '_blank' || a.getAttribute('rel') !== 'noopener noreferrer');
      if (bad.length) fails.push('anchor without target=_blank/rel=noopener noreferrer');
    }
    if (e.textContains && !cell.textContent.includes(e.textContains)) fails.push('text missing: ' + e.textContains);

    // Attribute-level, never on serialised HTML: escaped text inside <code> is
    // supposed to contain strings like onerror=, and a serialisation check would
    // flag that correct behaviour as a failure.
    const handlers = attrNames.filter((a) => a.indexOf('on') === 0);
    if (handlers.length) fails.push('event-handler attribute: ' + handlers.join(','));
    const dangerous = attrValues.filter((v) => {
      const c = stripCtrl(v).toLowerCase();
      return c.startsWith('javascript:') || c.startsWith('vbscript:') || c.startsWith('data:');
    });
    if (dangerous.length) fails.push('dangerous scheme in an attribute value');
    if (threw) fails.push('renderer threw: ' + threw);

    // Phase 7m: assertions about the <img> elements the renderer BUILT.
    const imgs = [...cell.querySelectorAll("img")];
    for (const needle of e.imgSrcAllOf || []) {
      if (!imgs.length) fails.push("no img built");
      else if (!imgs.every((im) => (im.getAttribute("src") || "").includes(needle))) fails.push("img src lacks " + needle);
    }
    if (e.imgAttrs) {
      if (!imgs.length) fails.push("no img built");
      for (const [k, v] of Object.entries(e.imgAttrs)) {
        const got = imgs.length ? imgs[0].getAttribute(k) : null;
        if (got !== v) fails.push("img " + k + "=" + JSON.stringify(got) + " expected " + JSON.stringify(v));
      }
    }
    // An img may only ever point at a trusted host, whatever the fixture says.
    for (const im of imgs) {
      let host = null;
      try { host = new URL(im.getAttribute("src") || "", "https://invalid.invalid/").hostname.toLowerCase(); } catch (err) { host = "(unparseable)"; }
      // No trailing-dot tolerance on purpose: the renderer canonicalises it away,
      // so a src reaching here with one would mean that normalisation regressed.
      const trusted = host === "github.com" || host === "githubusercontent.com" || host.endsWith(".githubusercontent.com");
      if (!trusted) fails.push("img loaded from UNTRUSTED host: " + host);
    }

    const row = document.createElement('div');
    row.className = 'row ' + (fails.length ? 'bad' : 'good');
    row.textContent = (fails.length ? 'FAIL  ' : 'PASS  ') + f.id + (fails.length ? '   ' + fails.join('; ') : '');
    out.appendChild(row);
    if (fails.length) fail++;
    else pass++;
    cell.remove();
  }

  // Give any injected handler a chance to fire before declaring victory.
  setTimeout(function () {
    const fired = window.__xssFired;
    const ok = fail === 0 && fired === undefined;
    verdict.className = ok ? 'good' : 'bad';
    verdict.textContent =
      (ok ? 'GATE GREEN' : 'GATE RED') +
      ' — ' + pass + ' passed, ' + fail + ' failed, window.__xssFired = ' +
      (fired === undefined ? 'never set' : String(fired));
    document.title = (ok ? 'GATE GREEN ' : 'GATE RED ') + pass + '/' + (pass + fail);
  }, 600);
})();
