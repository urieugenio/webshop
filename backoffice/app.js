/* Collection backoffice — grid of the collection photos, drag to reorder, click to edit. Every change is saved
   to sources/collection.json right away (closing the detail view saves, so does dropping a dragged piece). */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const grid = $('.grid');
  const dlg = $('.detail');
  const statusEl = $('.status');
  let S = { attrs: [], items: [], cities: [], taken: [] };
  let money = (n) => String(n);
  let current = -1;       // index of the piece in the detail view
  let dragging = false;

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
    $('.name', el).textContent = it.name;
    $('.attrs', el).textContent = caption(it);
    el.title = `${it.name} — ${it.file}`;
  }

  function renderGrid() {
    grid.replaceChildren(...S.items.map(tile));
    $('.count').textContent = `· ${S.items.length} pieces`;
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
    $('.prev', dlg).disabled = i === 0;
    $('.next', dlg).disabled = i === S.items.length - 1;
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
    if (changed) { fillTile(tileOf(it), it); save(); }
    return changed;
  }

  function step(d) {
    commit();
    open(current + d);
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

  // ------------------------------------------------------------ start
  api('GET', '/api/state').then((data) => {
    S = data;
    const nf = new Intl.NumberFormat(data.locale, { style: 'currency', currency: data.currency, maximumFractionDigits: 2, minimumFractionDigits: 0 });
    money = (n) => nf.format(n);
    if (!S.attrs.length) status('attributes.txt not found or empty: only names can be edited', true);
    buildFields();
    renderGrid();
  }).catch((e) => status('could not load: ' + e.message, true));
})();
