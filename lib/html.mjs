// Renders dist/index.html
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// width of "exclusive handmade crochet by" in Lato (regular + light italic "by"), in em
const TAGLINE_EM = 13.51;

// the theme as css variables, shared by the page and the legal pages
function cssVars(cfg, logo) {
  const L = cfg.layout, T = cfg.theme, A = cfg.animation, G = cfg.logo;
  const lw16 = G.landscapeWidthAt16x9 * 100, pw9 = G.portraitWidthAt9x16 * 100;
  return `
  --bg:${T.bg};--surface:${T.surface};--line:${T.line};--text:${T.text};--muted:${T.muted};
  --accent:${T.accent};--accent-text:${T.accentText};--emboss-light:${T.embossLight};--emboss-dark:${T.embossDark};--img-shadow:${T.imageShadow || 'none'};--thumb-border:${T.thumbBorder || 'transparent'};
  --page-max:${L.contentWidth}px;--margin:${L.sideMargin}px;--margin-phone:${L.sideMarginPhone}px;
  --gap:${L.gap}px;--border:${L.border}px;
  --pane-dur:${A.paneSeconds}s;--menu-dur:${A.menuSeconds}s;--ease:${A.ease};
  --logo-aspect:${logo ? logo.aspect.toFixed(4) : 3};
  --logo-w-land:min(${lw16}vw, ${(lw16 * 16 / 9).toFixed(3)}vh);
  --logo-w-port:min(${pw9}vw, ${(pw9 * 9 / 16).toFixed(3)}vh);
  --tagline-k:${(G.taglineWidthOfLogo / TAGLINE_EM).toFixed(5)};
  --tagline-top:${G.taglineTop * 100}%;`;
}

// prefix: the way back to the root from the page ('' for index.html, '../' for terms/index.html)
const fontFaces = (fonts, prefix = '') => [
  ['lato-300', 300, 'normal'], ['lato-300i', 300, 'italic'], ['lato-400', 400, 'normal'],
].filter(([k]) => fonts[k]).map(([k, w, st]) =>
  `@font-face{font-family:"Lato";src:url("${prefix}${fonts[k]}") format("${fonts[k].endsWith('woff2') ? 'woff2' : 'woff'}");font-weight:${w};font-style:${st};font-display:swap}`).join('\n');

// the footer of every page: the legal pages, and who sells (required for a webshop in the Netherlands)
function footer(cfg, legal, prefix = '') {
  const b = cfg.site.business || {};
  const links = legal.map((p) => `<a href="${prefix}${p.key}/">${esc(p.key)}</a>`).join('');
  const who = [b.name || cfg.site.contact.name, b.kvk && `KvK ${b.kvk}`, ...(b.address || []).slice(0, 2)].filter(Boolean).map(esc).join(' · ');
  return `<footer class="footer">
    ${links ? `<nav class="legal-links">${links}</nav>` : ''}
    <p>© ${new Date().getFullYear()} ${who}</p>
  </footer>`;
}

/** a page of its own (shipping, returns, terms, privacy) at <key>/index.html, in the look of the site */
export function renderPage({ cfg, css, fonts, title, body, legal }) {
  const s = cfg.site, T = cfg.theme;
  return `<!doctype html>
<html lang="${esc(s.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} — ${esc(s.contact.name)}</title>
<meta name="theme-color" content="${T.bg}">
<style>
:root{${cssVars(cfg, null)}}
${fontFaces(fonts, '../')}
</style>
<link rel="stylesheet" href="../${css}">
</head>
<body class="page-legal">
<main>
  <a class="back-home" href="../">‹ ${esc(s.contact.name)}</a>
  <div class="prose">${body}</div>
</main>
${footer(cfg, legal, '../')}
</body>
</html>
`;
}

export function renderIndex({ cfg, logo, css, js, dataName, fonts, sections, splash, legal = [] }) {
  const s = cfg.site, L = cfg.layout, T = cfg.theme;
  const c = s.contact;
  const vars = cssVars(cfg, logo);
  const fontFace = fontFaces(fonts);

  const first = splash[0];
  // placeholder before any script runs: same choice as app.js — the narrowest aspect that is
  // at least as wide as the window (so the image always fills the height)
  const phCss = first ? first.V.map((v, i) => {
    const rule = `.splash-ph{background-image:url('${v.ph}')}`;
    if (i === 0) return rule;
    const prev = first.V[i - 1].a * 1.005;
    return `@media (min-aspect-ratio:${Math.round(prev * 10000)}/10000){${rule}}`;
  }).join('\n') : '';
  const menu = sections.filter((x) => x.title)
    .map((x) => `<li><a href="#${esc(x.id)}">${esc(x.title)}</a></li>`).join('');

  // a picture from site.md: full column width, at the place of its ![description](file) line
  const picture = (im) => {
    const top = im.d[im.d.length - 1];
    const set = im.d.map((v) => `${v.src} ${v.w}w`).join(', ');
    return `<img class="section-img" src="${top.src}" srcset="${set}" sizes="min(100vw, ${L.contentWidth}px)" ` +
      `width="${top.w}" height="${top.h}" alt="${esc(im.alt || '')}" loading="lazy" decoding="async" style="background:${im.color}">`;
  };
  // the grids of site.md's {{beanies}}, {{scarves}} and {{gallery}}; data-section is the key of the items in the
  // site data. Every collection comes with its filter bar. The empty-note shows while a grid has no items.
  const GRID = {
    gallery: `<div class="grid grid-justified" data-section="gallery"></div>
      <p class="empty-note" data-for="gallery" hidden>new pictures coming soon</p>`,
  };
  for (const k of Object.keys(cfg.collections || {})) {
    GRID[k] = `<div class="filters" data-section="${k}" hidden></div>
      <div class="grid grid-square grid-shop" data-section="${k}"></div>
      <p class="empty-note" data-for="${k}" hidden>coming soon</p>
      <p class="filter-empty" data-for="${k}" hidden>nothing matches these filters</p>`;
  }
  // a grid is full width, so the text around it is split in a .prose before and after it
  const body = (x) => `<div class="prose">${x.html}</div>`
    .replace(/<!--image:(\d+)-->/g, (_, i) => picture(x.images[i]))
    .replace(/<!--grid:(\w+)-->\n?/g, (_, g) => `</div>\n      ${GRID[g]}\n      <div class="prose">`)
    .replace(/<div class="prose">\s*<\/div>/g, '');
  const main = sections.map((x) => `
    <section id="${esc(x.id)}" class="section section-${esc(x.id)}${x.title ? '' : ' no-title'}">
      ${x.title ? `<h1>${esc(x.title)}</h1>` : ''}
      ${body(x)}
    </section>`).join('\n');
  const firstId = sections.length ? sections[0].id : 'home';

  return `<!doctype html>
<html lang="${esc(s.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(s.title)}</title>
<meta name="description" content="${esc(s.description)}">
<meta name="theme-color" content="${T.bg}">
<style>
:root{${vars}}
${fontFace}
${phCss}
</style>
<link rel="stylesheet" href="${css}">
</head>
<body>
<button class="menu-btn" type="button" aria-label="open menu" aria-controls="menu" aria-expanded="false"><span></span><span></span><span></span></button>
<button class="cart-btn" type="button" aria-label="shopping cart" hidden>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg><span class="cart-count">0</span>
</button>
<nav id="menu" class="menu" aria-hidden="true">
  <ul>${menu}</ul>
</nav>
<div class="menu-scrim"></div>

<div id="page">
  <header id="home" class="splash" style="background-color:${first ? first.color : T.bg}">
    <div class="splash-ph"></div>
    <div class="slides"></div>
    <p class="tagline">${esc(s.tagline)} <em>${esc(s.taglineBy)}</em></p>
    ${logo ? `<h1 class="logo"><img src="${logo.src}" alt="${esc(c.name)}"></h1>` : `<h1 class="logo">${esc(c.name)}</h1>`}
    <a class="scroll-cue" href="#${esc(firstId)}" aria-label="scroll down"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></a>
  </header>

  <main>${main}
  </main>
  ${footer(cfg, legal)}
</div>
<div class="page-dim"></div>

<div class="pane detail" role="dialog" aria-modal="true" aria-hidden="true" aria-label="item detail">
  <button class="pane-close" type="button" aria-label="close"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
  <button class="nav-prev" type="button" aria-label="previous"><svg viewBox="0 0 24 24"><path d="M15 4l-8 8 8 8"/></svg></button>
  <button class="nav-next" type="button" aria-label="next"><svg viewBox="0 0 24 24"><path d="M9 4l8 8-8 8"/></svg></button>
  <div class="pane-scroll">
    <div class="detail-wrap">
      <div class="detail-media"><div class="detail-ph"></div><img class="detail-img" alt=""></div>
      <div class="detail-info"></div>
    </div>
  </div>
</div>

<div class="cart-scrim"></div>
<div class="pane cart" role="dialog" aria-modal="true" aria-hidden="true" aria-label="shopping cart">
  <button class="pane-close" type="button" aria-label="close"><svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
  <div class="pane-scroll"><div class="cart-wrap"><h1>cart</h1><div class="cart-list"></div></div></div>
</div>

<script src="${dataName}"></script>
<script src="${js}"></script>
</body>
</html>
`;
}
