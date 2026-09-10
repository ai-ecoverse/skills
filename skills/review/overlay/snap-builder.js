(async () => {
  // Wait for readiness. EDS pages ship body{display:none} until scripts add body.appear and
  // decorate main .section[data-section-status="loaded"] — wait for that. A non-EDS page has no
  // "main .section", so it is ready once readyState is complete (avoids an EDS-only 20s stall).
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (document.readyState === 'complete') {
      const secs = document.querySelectorAll('main .section');
      if (secs.length === 0) break; // not an EDS page — nothing more to wait for
      const appear = document.body.classList.contains('appear');
      const loaded = [...secs].filter(s => s.dataset.sectionStatus === 'loaded').length;
      if (appear && loaded === secs.length) break;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  // Scroll to trigger lazy-loaded sections/images
  const h = document.body.scrollHeight;
  for (let y = 0; y <= h; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 200)); }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 800));
  // Inline all CSS (same-origin sheets are readable in a real tab). Resolve each sheet's relative
  // url(...) refs against THAT sheet's own href — not the document root — so e.g. url('./x.woff2')
  // in /styles/theme.css becomes /styles/x.woff2, not /x.woff2 (fonts/backgrounds would 404).
  const styleBlocks = [];
  for (const sheet of document.styleSheets) {
    let cssText;
    try { cssText = [...sheet.cssRules].map(r => r.cssText).join('\n'); } catch (_) { continue; }
    const sheetBase = sheet.href || location.href;
    cssText = cssText.replace(
      /url\(['"]?(?!data:|https?:|\/\/)([^'")]+)['"]?\)/g,
      (m, p) => { try { return 'url("' + new URL(p, sheetBase).href + '")'; } catch { return m; } }
    );
    styleBlocks.push(cssText);
  }
  // Clone and sanitise
  const dc = document.documentElement.cloneNode(true);
  dc.querySelectorAll('script').forEach(s => s.remove());
  dc.querySelectorAll('link[rel="stylesheet"],link[as="style"]').forEach(l => l.remove());
  dc.querySelectorAll('noscript,link[rel="preload"],link[rel="preconnect"]').forEach(n => n.remove());
  // Absolutize img src from live elements (currentSrc includes responsive choice)
  const liveImgs = [...document.querySelectorAll('img')];
  [...dc.querySelectorAll('img')].forEach((img, i) => {
    const live = liveImgs[i];
    if (!live) return;
    img.src = live.currentSrc || live.src || '';
    img.removeAttribute('srcset'); img.removeAttribute('loading');
  });
  // Absolutize picture source srcset
  const liveSrc = [...document.querySelectorAll('source')];
  [...dc.querySelectorAll('source')].forEach((s, i) => {
    const live = liveSrc[i];
    if (live && live.srcset) s.srcset = live.srcset.split(',').map(p => {
      const [u, w] = p.trim().split(/\s+/);
      try { return new URL(u, location.href).href + (w ? ' ' + w : ''); } catch { return p; }
    }).join(', ');
  });
  // CSS url() refs were already absolutized per-sheet above.
  const absCSS = styleBlocks.join('\n');
  // Inject into head
  const head = dc.querySelector('head');
  const base = document.createElement('base'); base.href = location.origin + '/';
  head.insertBefore(base, head.firstChild);
  const st = document.createElement('style'); st.textContent = absCSS;
  head.appendChild(st);
  dc.querySelector('body').classList.add('appear');
  const html = '<!DOCTYPE html>\n' + dc.outerHTML;
  return JSON.stringify({ html, bytes: html.length, sections: dc.querySelectorAll('main .section').length });
})()
