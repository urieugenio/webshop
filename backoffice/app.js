/* Collection backoffice — grid of the collection photos, drag to reorder, click to edit. Every change is saved
   to sources/collection.json right away (closing the detail view saves, so does dropping a dragged piece). */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const grid = $('.grid');
  const dlg = $('.detail');
  const statusEl = $('.status');
  let S = { attrs: [], items: [], cities: [], taken: [], palette: [] };
  let money = (n) => String(n);
  let current = -1;       // index of the piece in the detail view
  let dragging = false;
  let measured = null;    // a new measurement of the piece in the detail view, applied when it closes
  const MULTI = '*multi';
  let filterColor = null; // palette name, MULTI or null (all)
  const picks = {};       // attribute key -> chosen value

  const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const fmt = (a, v) => (v == null || v === '' ? '' : a.key === 'price' ? money(v) : String(v));
  const thumbUrl = (it, w) => `/thumb/${encodeURIComponent(it.file)}?w=${w}`;

  function status(text, err) {
    statusEl.textContent = text;
    statusEl.classList.toggle('err', !!err);
  }

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    return data;
  }

  // ------------------------------------------------------------ saving (one request at a time, always the latest list)
  let saving = Promise.resolve();
  function save() {
    status('saving…');
    const items = S.items.map((e) => ({ ...e }));
    saving = saving.then(() => api('PUT', '/api/collection', { items }))
      .then(() => status('saved ✓'))
      .catch((e) => status('not saved: ' + e.message, true));
    return saving;
  }

  // ------------------------------------------------------------ grid
  function caption(it) {
    return S.attrs.map((a) => fmt(a, it[a.key])).filter(Boolean).join(' · ');
  }

  const swatch = (name) => (S.palette.find((p) => p.name === name) || {}).hex;

  /** a colour dot: the palette colour, with a rainbow half for multicoloured pieces */
  function dot(color, multi) {
    const d = document.createElement('span');
    d.className = 'dot' + (multi ? ' multi' : '') + (color || multi ? '' : ' none');
    if (color) d.style.setProperty('--sw', swatch(color));
    return d;
  }

  function tile(it) {
    const el = document.createElement('figure');
    el.className = 'tile';
    el.dataset.file = it.file;
    el.tabIndex = 0;
    el.innerHTML = '<img loading="lazy" alt=""><figcaption><span class="name"></span><span class="attrs"></span></figcaption>';
    $('img', el).src = thumbUrl(it, 320);
    fillTile(el, it);
    return el;
  }

  function fillTile(el, it) {
    $('.name', el).replaceChildren(dot(it.color, it.multi), it.name);
    $('.attrs', el).textContent = caption(it);
    el.title = `${it.name} — ${it.file} — ${it.color || 'no colour'}${it.multi ? ', ' + S.multiLabel : ''}${it.colorByHand ? ' (set by hand)' : ''}`;
    el.hidden = !matches(it);
  }

  function renderGrid() {
    grid.replaceChildren(...S.items.map(tile));
    $('.count').textContent = `· ${S.items.length} pieces`;
    renderFilters();
  }

  // ------------------------------------------------------------ filter
  // one colour at a time, like radio buttons ("multicolour" shows the multicoloured pieces), and a pulldown for
  // every attribute; a piece is shown when it matches all of them
  const matches = (it) => (filterColor === MULTI ? !!it.multi : !filterColor || it.color === filterColor)
    && Object.entries(picks).every(([k, v]) => it[k] === v);
  const filtering = () => !!filterColor || Object.keys(picks).length > 0;

  function renderFilters() {
    const count = (fn) => S.items.filter(fn).length;
    const btn = (content, pressed, n, onClick, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', pressed);
      b.title = title;
      b.append(...content);
      if (n !== null) { const s = document.createElement('span'); s.className = 'n'; s.textContent = n; b.append(s); }
      if (n === 0) b.classList.add('zero');
      b.addEventListener('click', () => { onClick(); applyFilter(); });
      return b;
    };
    const choose = (v) => () => { filterColor = filterColor === v ? null : v; };
    const parts = S.palette.map((p) => btn(
      [dot(p.name, false), p.name], filterColor === p.name, count((it) => it.color === p.name), choose(p.name), `show only ${p.name}`));
    parts.push(btn([dot(null, true), S.multiLabel], filterColor === MULTI, count((it) => it.multi), choose(MULTI), `show only ${S.multiLabel} pieces`));
    for (const a of S.attrs) {
      // every value of attributes.txt, plus values pieces still have that are no longer listed there
      const values = a.values.concat([...new Set(S.items.map((it) => it[a.key]))].filter((v) => v != null && v !== '' && !a.values.includes(v)));
      const sel = document.createElement('select');
      sel.className = 'fsel' + (a.key in picks ? ' on' : '');
      sel.title = `filter on ${a.label}`;
      sel.append(new Option(`all ${a.label}`, ''), ...values.map((v, i) => {
        const o = new Option(`${fmt(a, v)} (${count((it) => it[a.key] === v)})`, String(i));
        o.selected = a.key in picks && picks[a.key] === v;
        return o;
      }));
      sel.addEventListener('change', () => {
        if (sel.value === '') delete picks[a.key]; else picks[a.key] = values[sel.value];
        applyFilter();
      });
      parts.push(sel);
    }
    if (filtering()) {
      parts.push(btn(['show all'], false, null, () => { filterColor = null; for (const k in picks) delete picks[k]; }, 'clear the filter'));
      const shown = document.createElement('span');
      shown.className = 'filter-count';
      shown.textContent = `${count(matches)} shown`;
      parts.push(shown);
    }
    $('.filters').replaceChildren(...parts);
  }

  function applyFilter() {
    for (const el of grid.children) el.hidden = !matches(S.items[indexOfTile(el)]);
    renderFilters();
  }

  const tileOf = (it) => grid.querySelector(`[data-file="${CSS.escape(it.file)}"]`);
  const indexOfTile = (el) => S.items.findIndex((it) => it.file === el.dataset.file);

  grid.addEventListener('click', (e) => {
    const el = e.target.closest('.tile');
    if (el && !dragging) open(indexOfTile(el));
  });
  grid.addEventListener('keydown', (e) => {
    const el = e.target.closest('.tile');
    if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(indexOfTile(el)); }
  });

  Sortable.create(grid, {
    animation: 150,
    ghostClass: 'ghost',
    dragClass: 'drag',
    onStart() { dragging = true; },
    onEnd(e) {
      setTimeout(() => { dragging = false; }, 0);
      if (e.oldIndex === e.newIndex) return;
      const [moved] = S.items.splice(e.oldIndex, 1);
      S.items.splice(e.newIndex, 0, moved);
      save();
    },
  });

  // ------------------------------------------------------------ detail
  const nameInput = $('[name=name]', dlg);
  const nameMsg = $('.name-msg', dlg);

  function nameProblem(name, it) {
    const slug = slugify(name);
    if (!slug) return 'a name is needed';
    if (S.taken.includes(slug)) return 'this is the name of a section of the site';
    const other = S.items.find((x) => x !== it && slugify(x.name) === slug);
    return other ? `already used by ${other.file}` : '';
  }

  function buildFields() {
    const box = $('.attrs', dlg);
    box.replaceChildren(...S.attrs.map((a) => {
      const l = document.createElement('label');
      l.className = 'field';
      l.innerHTML = '<span></span><select></select>';
      $('span', l).textContent = a.label;
      $('select', l).name = 'attr:' + a.key;
      return l;
    }));
  }

  function open(i) {
    if (i < 0 || i >= S.items.length) return;
    current = i;
    const it = S.items[i];
    const img = $('.photo', dlg);
    img.src = thumbUrl(it, 320);           // already loaded by the grid: instant
    const big = new Image();
    big.onload = () => { if (S.items[current] === it) img.src = big.src; };
    big.src = thumbUrl(it, 960);
    $('.file', dlg).textContent = it.file;
    nameInput.value = it.name;
    nameMsg.textContent = '';
    for (const a of S.attrs) {
      const sel = $(`[name="attr:${a.key}"]`, dlg);
      const values = [...a.values];
      const v = it[a.key];
      const missing = v != null && v !== '' && !values.includes(v);
      sel.replaceChildren(
        ...(v == null || v === '' ? [new Option('—', '')] : []),
        ...(missing ? [new Option(`${fmt(a, v)} (not in attributes.txt)`, String(v))] : []),
        ...values.map((x) => new Option(fmt(a, x), String(x))));
      sel.value = v == null ? '' : String(v);
    }
    measured = null;
    const colorSel = $('[name=color]', dlg);
    colorSel.replaceChildren(new Option('—', ''), ...S.palette.map((p) => new Option(p.name, p.name)));
    colorSel.value = it.color || '';
    $('[name=multi]', dlg).checked = !!it.multi;
    colorNote(it);
    $('.prev', dlg).disabled = neighbour(-1) < 0;
    $('.next', dlg).disabled = neighbour(1) >= S.items.length;
    if (!dlg.open) dlg.showModal();
  }

  /** take the values from the form; returns true when something changed */
  function commit() {
    const it = S.items[current];
    if (!it) return false;
    let changed = false;
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    const problem = nameProblem(name, it);
    if (problem) status(`name not changed (${problem})`, true);
    else if (name !== it.name) { it.name = name; changed = true; }
    for (const a of S.attrs) {
      const raw = $(`[name="attr:${a.key}"]`, dlg).value;
      const v = raw === '' ? null : a.values.find((x) => String(x) === raw) ?? (String(it[a.key]) === raw ? it[a.key] : raw);
      if (v !== it[a.key]) { it[a.key] = v; changed = true; }
    }
    const color = $('[name=color]', dlg).value || null, multi = $('[name=multi]', dlg).checked;
    if (measured) {
      // measured again: automatic again, unless the result was overruled before closing
      Object.assign(it, { color, multi, hex: measured.hex });
      if (color === measured.color && multi === measured.multi) delete it.colorByHand; else it.colorByHand = true;
      measured = null;
      changed = true;
    } else if (color !== (it.color || null) || multi !== !!it.multi) {
      Object.assign(it, { color, multi, colorByHand: true });
      changed = true;
    }
    if (changed) { fillTile(tileOf(it), it); renderFilters(); save(); }
    return changed;
  }

  function colorNote(it, m) {
    const hex = m ? m.hex : it.hex;
    const parts = [];
    if (hex) { const sw = document.createElement('span'); sw.className = 'dot'; sw.style.setProperty('--sw', hex); parts.push(sw, `measured ${hex}`); }
    parts.push(m ? ' — new measurement' : it.colorByHand ? ' — set by hand' : hex ? ' — automatic' : 'not measured yet');
    $('.color-note', dlg).replaceChildren(...parts);
  }

  /** the next piece in direction d that the colour filter shows (-1 or items.length when there is none) */
  function neighbour(d) {
    let j = current + d;
    while (j >= 0 && j < S.items.length && !matches(S.items[j])) j += d;
    return j;
  }

  function step(d) {
    commit();
    open(neighbour(d));
  }

  nameInput.addEventListener('input', () => { nameMsg.textContent = nameProblem(nameInput.value, S.items[current]); });
  $('.dice', dlg).addEventListener('click', () => {
    const used = new Set([...S.taken, ...S.items.map((x) => slugify(x.name))]);
    const free = S.cities.filter((c) => !used.has(slugify(c)));
    if (!free.length) return;
    nameInput.value = free[Math.floor(Math.random() * free.length)];
    nameMsg.textContent = '';
    nameInput.focus();
  });
  $('.measure', dlg).addEventListener('click', async (e) => {
    const it = S.items[current];
    e.currentTarget.disabled = true;
    try {
      measured = await api('POST', '/api/detect', { file: it.file });
      $('[name=color]', dlg).value = measured.color || '';
      $('[name=multi]', dlg).checked = measured.multi;
      colorNote(it, measured);
    } catch (err) { status('could not measure: ' + err.message, true); }
    $('.measure', dlg).disabled = false;
  });
  $('.prev', dlg).addEventListener('click', () => step(-1));
  $('.next', dlg).addEventListener('click', () => step(1));
  dlg.addEventListener('close', () => {
    commit();
    const it = S.items[current];
    current = -1;
    if (it) tileOf(it)?.focus({ preventScroll: true });
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });  // click on the backdrop
  dlg.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select')) { if (e.key === 'Enter') { e.preventDefault(); dlg.close(); } return; }
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  // ------------------------------------------------------------ build
  const buildBtn = $('.build');
  const log = $('.log');
  buildBtn.addEventListener('click', async () => {
    buildBtn.disabled = true;
    log.hidden = false;
    const pre = $('pre', log);
    pre.textContent = '';
    $('.log-title', log).textContent = 'Building…';
    try {
      await saving;
      const r = await fetch('/api/build', { method: 'POST' });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pre.textContent += dec.decode(value, { stream: true });
        pre.scrollTop = pre.scrollHeight;
      }
      $('.log-title', log).textContent = /\[ok\]\s*$/.test(pre.textContent) ? 'Build finished' : 'Build failed';
    } catch (e) {
      pre.textContent += '\n' + e.message;
      $('.log-title', log).textContent = 'Build failed';
    }
    buildBtn.disabled = false;
  });
  $('.log-close').addEventListener('click', () => { log.hidden = true; });

  const measureAll = $('.measure-all');
  measureAll.addEventListener('click', async () => {
    if (!confirm('Measure the colour of every photo again?\nColours you set by hand are kept.')) return;
    measureAll.disabled = true;
    status('measuring colours…');
    try {
      await saving;
      await api('POST', '/api/detect-all');
      await start();
      status('colours measured ✓');
    } catch (e) { status('could not measure: ' + e.message, true); }
    measureAll.disabled = false;
  });

  // ------------------------------------------------------------ start
  const start = () => api('GET', '/api/state').then((data) => {
    S = data;
    $('.multi-label', dlg).textContent = S.multiLabel;
    const nf = new Intl.NumberFormat(data.locale, { style: 'currency', currency: data.currency, maximumFractionDigits: 2, minimumFractionDigits: 0 });
    money = (n) => nf.format(n);
    if (!S.attrs.length) status('attributes.txt not found or empty: only names can be edited', true);
    buildFields();
    renderGrid();
  });
  status('loading… (new photos are measured first)');
  start().then(() => status('')).catch((e) => status('could not load: ' + e.message, true));
})();
