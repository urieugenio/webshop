/* Uri Eugenio — front-end. Data comes from window.SITE (generated data/site-*.js). No dependencies. */
(() => {
  'use strict';
  const S = window.SITE;
  const C = S.config;
  const L = C.layout;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const html = document.documentElement;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 4);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const money = (n) => (n == null ? '' : new Intl.NumberFormat(C.shop.locale, { style: 'currency', currency: C.shop.currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const label = (it) => it.name || it.id;     // the product name, or the file name for gallery pictures
  const ref = (it) => it.slug || it.id;       // what goes after the # in the url
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ============================================================ splash
  const Splash = {
    slides: [], cur: 0,
    init() {
      const host = $('.splash .slides');
      if (!host || !S.splash.length) return;
      host.style.setProperty('--fade', C.splash.fadeSeconds + 's');
      this.box = $('.splash');
      this.slides = S.splash.map((d) => { const el = document.createElement('div'); el.className = 'slide'; host.appendChild(el); return { d, el, h: 0, n: '' }; });
      this.pick(this.slides[0], true);
      if (this.slides.length > 1) {
        setInterval(() => {
          const next = this.slides[(this.cur + 1) % this.slides.length];
          this.pick(next).then(() => {
            this.slides[this.cur].el.classList.remove('on');
            next.el.classList.add('on');
            this.cur = this.slides.indexOf(next);
          });
        }, C.splash.slideSeconds * 1000);
      }
      addEventListener('resize', debounce(() => this.pick(this.slides[this.cur]), 250));
    },
    variant(d) {
      const r = this.box.getBoundingClientRect();
      const W = r.width || innerWidth, H = r.height || innerHeight;
      // narrowest aspect that is still at least as wide as the window: "cover" then scales it to
      // the window height, so only the left and right are cut off, never the top or bottom
      const asp = d.V.find((v) => v.a >= (W / H) * 0.995) || d.V[d.V.length - 1];
      const need = Math.max(H, W / asp.a) * dpr();
      const size = asp.sizes.find((x) => x.h >= need * 0.92) || asp.sizes[asp.sizes.length - 1];
      return { n: asp.n, v: size };
    },
    pick(s, first) {
      const { n, v } = this.variant(s.d);
      if (s.n === n && s.h >= v.h) return Promise.resolve(); // same aspect: never downgrade
      return new Promise((res) => {
        const img = new Image();
        img.onload = img.onerror = () => {
          s.el.style.backgroundImage = `url("${v.src}")`;
          s.n = n; s.h = v.h;
          if (first) requestAnimationFrame(() => {
            s.el.classList.add('on');
            // remove the full-screen blurred placeholder once the fade-in is done
            setTimeout(() => this.box.classList.add('loaded'), C.splash.fadeSeconds * 1000 + 100);
          });
          res();
        };
        img.decoding = 'async';
        img.src = v.src;
      });
    },
  };

  // ============================================================ thumbnail sheets
  // Each section has sheets per tile size ("tier"). A thumb shows its tile by using the
  // sheet as background and scaling/offsetting it so only its own cell is visible.
  const Sheets = {
    cache: new Map(), // url -> Promise
    load(url) {
      if (!this.cache.has(url)) {
        this.cache.set(url, new Promise((res) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(true); i.onerror = () => res(false); i.src = url; }));
      }
      return this.cache.get(url);
    },
    isLoaded(url) { return this.cache.has(url); },
    tierFor(section, cssPx) {
      const tiers = Object.keys(S.sheets[section].tiers).map(Number).sort((a, b) => a - b);
      const want = cssPx * dpr();
      return tiers.find((t) => t >= want * 0.9) || tiers[tiers.length - 1];
    },
    /** background CSS for showing item `it` in a box of w x h css px */
    css(section, it, tier, w, h) {
      const sh = S.sheets[section];
      const sheet = sh.tiers[tier][it.s];
      if (!sheet) return null;
      const cell = tier + sh.pad * 2;
      const sx = w / tier, sy = h / tier;
      const col = it.p % sh.cols, row = Math.floor(it.p / sh.cols);
      return {
        url: sheet.url,
        backgroundImage: `url("${sheet.url}")`,
        backgroundSize: `${sh.cols * cell * sx}px ${sheet.rows * cell * sy}px`,
        backgroundPosition: `${-(col * cell + sh.pad) * sx}px ${-(row * cell + sh.pad) * sy}px`,
      };
    },
    /** best tier for which the sheet is already in the browser (for instant placeholders) */
    loadedTier(section, it) {
      const tiers = Object.keys(S.sheets[section].tiers).map(Number).sort((a, b) => b - a);
      return tiers.find((t) => { const sh = S.sheets[section].tiers[t][it.s]; return sh && this.isLoaded(sh.url); });
    },
  };

  // ============================================================ grids
  const Grid = {
    sections: {},
    init() {
      for (const el of $$('.grid')) {
        const key = el.dataset.section;
        const items = S[key] || [];
        const sec = { key, el, items, thumbs: [], tier: 0, type: el.classList.contains('grid-square') ? 'square' : 'justified' };
        this.sections[key] = sec;
        if (!items.length) { const n = el.parentElement.querySelector('.empty-note'); if (n) n.hidden = false; continue; }
        const frag = document.createDocumentFragment();
        items.forEach((it, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'thumb';
          b.id = 't-' + it.id;
          b.dataset.i = i;
          b.style.setProperty('--c', it.c);
          b.setAttribute('aria-label', label(it));
          b.innerHTML = '<span class="ti"></span>' + (key === 'collection' ? '<span class="sold-band">sold</span>' : '');
          b.addEventListener('click', () => Detail.open(key, i, true));
          frag.appendChild(b);
          sec.thumbs.push(b);
        });
        el.appendChild(frag);
      }
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.reveal(e.target);
      }, { rootMargin: `${C.thumbs.lazyMargin}px 0px` });
      this.layout();
      addEventListener('resize', debounce(() => this.layout(), 120));
    },
    columns(width) {
      if (width < L.phoneBreakpoint) return L.phoneColumns;
      return Math.max(L.phoneColumns, Math.floor((width + L.gap) / (L.minThumbWidth + L.gap)));
    },
    layout() {
      for (const sec of Object.values(this.sections)) {
        if (!sec.items.length) continue;
        const W = sec.el.clientWidth;
        const cols = this.columns(W);
        const size = (W - (cols - 1) * L.gap) / cols;
        let maxBox = size;
        if (sec.type === 'square') {
          sec.el.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
          sec.thumbs.forEach((t) => { t._w = t._h = size; t.style.height = size + 'px'; });
        } else {
          maxBox = this.justify(sec, W, size * L.galleryRowScale);
        }
        const inner = maxBox - 2 * L.border;
        const tier = Sheets.tierFor(sec.key, inner);
        if (tier !== sec.tier) {
          sec.tier = tier;
          sec.thumbs.forEach((t) => { t.classList.remove('loaded'); t._shown = false; this.io.observe(t); });
        }
        sec.thumbs.forEach((t) => { if (t._shown) this.paint(sec, t); });
      }
    },
    justify(sec, W, target) {
      // justified rows: every row exactly fills the width, items keep their aspect ratio
      const gap = L.gap;
      let row = [], sum = 0, maxW = 0;
      const flush = (last) => {
        const h = last ? Math.min(target, (W - gap * (row.length - 1)) / sum) : (W - gap * (row.length - 1)) / sum;
        for (const { t, a } of row) {
          t._w = Math.floor(a * h * 100) / 100; t._h = h;
          t.style.width = t._w + 'px'; t.style.height = h + 'px'; t.style.flex = 'none';
          maxW = Math.max(maxW, t._w, h);
        }
        row = []; sum = 0;
      };
      sec.items.forEach((it, i) => {
        const a = it.w / it.h;
        row.push({ t: sec.thumbs[i], a }); sum += a;
        if (sum * target + gap * (row.length - 1) >= W) flush(false);
      });
      if (row.length) flush(true);
      return maxW;
    },
    reveal(t) {
      const sec = this.sections[t.closest('.grid').dataset.section];
      const it = sec.items[t.dataset.i];
      const sheet = S.sheets[sec.key].tiers[sec.tier][it.s];
      if (!sheet) return;
      const tier = sec.tier;
      Sheets.load(sheet.url).then(() => {
        if (sec.tier !== tier) return;
        // the whole sheet arrived: show every thumb on it
        sec.thumbs.forEach((th, i) => {
          if (sec.items[i].s === it.s && !th._shown) {
            th._shown = true; this.io.unobserve(th); this.paint(sec, th);
            requestAnimationFrame(() => th.classList.add('loaded'));
          }
        });
      });
    },
    paint(sec, t) {
      const it = sec.items[t.dataset.i];
      const w = t._w - 2 * L.border, h = t._h - 2 * L.border;
      const css = Sheets.css(sec.key, it, sec.tier, w, h);
      if (!css) return;
      const ti = t.firstChild;
      ti.style.backgroundImage = css.backgroundImage;
      ti.style.backgroundSize = css.backgroundSize;
      ti.style.backgroundPosition = css.backgroundPosition;
    },
  };

  // ============================================================ shop: inventory + cart
  const Shop = {
    sold: new Set(),
    live: C.shop.liveInventory && location.protocol.startsWith('http'),
    api(p) { return (C.shop.apiBase || '') + p; },
    async init() {
      await this.refresh();
      if (this.live) setInterval(() => this.refresh(), C.shop.pollSeconds * 1000);
    },
    async refresh() {
      if (!this.live) { this.sold = new Set(C.shop.previewSoldIds || []); return this.apply(); }
      try {
        const r = await fetch(this.api('/api/inventory'), { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        this.sold = new Set(j.sold || []);
        this.apply();
      } catch (e) { console.warn('inventory refresh failed', e); }
    },
    /** asks the server whether the item is still available (falls back to the last known list) */
    async check(id) {
      if (!this.live) return !this.sold.has(id);
      try {
        const r = await fetch(this.api('/api/availability?id=' + encodeURIComponent(id)), { cache: 'no-store' });
        const j = await r.json();
        if (!j.available) { this.sold.add(id); this.apply(); }
        return !!j.available;
      } catch { return !this.sold.has(id); }
    },
    apply() {
      const sec = Grid.sections.collection;
      if (sec) sec.thumbs.forEach((t, i) => {
        const s = this.sold.has(sec.items[i].id);
        t.classList.toggle('sold', s);
      });
      Detail.refreshInfo();
      Cart.render();
    },
  };

  const Cart = {
    ids: store.get('ue-cart', []),
    has(id) { return this.ids.includes(id); },
    add(id) { if (!this.has(id)) { this.ids.push(id); this.save(); } },
    remove(id) { this.ids = this.ids.filter((x) => x !== id); this.save(); },
    save() { store.set('ue-cart', this.ids); this.render(); },
    item(id) { return (S.collection || []).find((x) => x.id === id); },
    init() {
      this.btn = $('.cart-btn');
      this.pane = $('.pane.cart');
      this.btn.addEventListener('click', () => this.open());
      $('.pane-close', this.pane).addEventListener('click', () => this.close());
      $('.cart-scrim').addEventListener('click', () => this.close());
      addEventListener('keydown', (e) => { if (e.key === 'Escape' && !Detail.isOpen) this.close(); });
      this.ids = this.ids.filter((id) => this.item(id));
      this.render();
    },
    open() { Menu.close(); this.pane.classList.add('open'); this.pane.setAttribute('aria-hidden', 'false'); html.classList.add('locked', 'cart-open'); },
    close() { html.classList.remove('cart-open'); this.pane.classList.remove('open'); this.pane.setAttribute('aria-hidden', 'true'); if (!Detail.isOpen) html.classList.remove('locked'); },
    render() {
      if (!this.btn) return;
      this.btn.hidden = !this.ids.length;
      $('.cart-count', this.btn).textContent = this.ids.length;
      const list = $('.cart-list', this.pane);
      if (!this.ids.length) { list.innerHTML = '<p class="cart-empty">your cart is empty</p>'; return; }
      let total = 0;
      list.innerHTML = '';
      for (const id of this.ids) {
        const it = this.item(id);
        const sold = Shop.sold.has(id);
        if (!sold && it.price) total += it.price;
        const row = document.createElement('div');
        row.className = 'cart-item' + (sold ? ' is-sold' : '');
        row.innerHTML = `<button class="thumb loaded" type="button" aria-label="show ${esc(label(it))}"><span class="ti"></span></button>
          <div><div class="ci-ref">${esc(label(it))}</div><div class="ci-desc"></div>${sold ? '<div class="ci-sold">sold — no longer available</div>' : ''}</div>
          <div><div class="ci-price">${money(it.price)}</div><button class="ci-remove" type="button">remove</button></div>`;
        $('.ci-desc', row).textContent = (S.attrs || []).map((a) => it[a.key]).filter(Boolean).join(' · ');
        const th = $('.thumb', row);
        th.style.setProperty('--c', it.c);
        const tier = Sheets.tierFor('collection', 70);
        const css = Sheets.css('collection', it, tier, 70, 70);
        if (css) { Sheets.load(css.url); Object.assign($('.ti', th).style, { backgroundImage: css.backgroundImage, backgroundSize: css.backgroundSize, backgroundPosition: css.backgroundPosition }); }
        th.addEventListener('click', () => { this.close(); Detail.open('collection', S.collection.indexOf(it), true); });
        $('.ci-remove', row).addEventListener('click', () => this.remove(id));
        list.appendChild(row);
      }
      const foot = document.createElement('div');
      foot.innerHTML = `<div class="cart-total"><span>total</span><span>${money(total)}</span></div>
        <button class="btn-cart" type="button" disabled>checkout</button>
        <p class="cart-note">Checkout will be available soon. Every piece is one of a kind: the first to complete payment gets it.</p>`;
      list.appendChild(foot);
    },
  };

  // ============================================================ detail pane
  const Detail = {
    isOpen: false, key: null, i: -1,
    init() {
      this.pane = $('.pane.detail');
      this.media = $('.detail-media', this.pane);
      this.scroller = $('.pane-scroll', this.pane);
      this.ph = $('.detail-ph', this.pane);
      this.img = $('.detail-img', this.pane);
      this.info = $('.detail-info', this.pane);
      this.prev = $('.nav-prev', this.pane);
      this.next = $('.nav-next', this.pane);
      $('.pane-close', this.pane).addEventListener('click', () => this.close(true));
      this.prev.addEventListener('click', () => this.step(-1));
      this.next.addEventListener('click', () => this.step(1));
      this.img.addEventListener('load', () => this.img.classList.add('ready'));
      addEventListener('keydown', (e) => {
        if (!this.isOpen) return;
        if (e.key === 'Escape') this.close(true);
        else if (e.key === 'ArrowLeft') this.step(-1);
        else if (e.key === 'ArrowRight') this.step(1);
      });
      // swipe left / right on touch screens
      let x0 = null, y0 = 0;
      this.media.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      this.media.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.step(dx < 0 ? 1 : -1);
        x0 = null;
      }, { passive: true });
      addEventListener('resize', debounce(() => this.isOpen && this.size(), 100));
    },
    get items() { return S[this.key] || []; },
    get item() { return this.items[this.i]; },
    open(key, i, push) {
      Menu.close();
      const wasOpen = this.isOpen;
      this.key = key; this.i = i;
      this.isOpen = true;
      this.pane.classList.toggle('gallery-mode', key === 'gallery');
      this.render(false);
      this.pane.classList.add('open');
      this.pane.setAttribute('aria-hidden', 'false');
      html.classList.add('pane-open', 'locked');
      const url = '#' + encodeURIComponent(ref(this.item));
      if (location.hash !== url) history[push && !wasOpen ? 'pushState' : 'replaceState'](null, '', url);
    },
    close(updateUrl) {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.pane.classList.remove('open');
      this.pane.setAttribute('aria-hidden', 'true');
      html.classList.remove('pane-open');
      if (!Cart.pane.classList.contains('open')) html.classList.remove('locked');
      const t = document.getElementById('t-' + this.item.id);
      if (updateUrl) history.replaceState(null, '', location.pathname + location.search);
      if (t) { scrollThumbIntoView(t); setTimeout(() => t.focus({ preventScroll: true }), C.animation.paneSeconds * 1000); }
    },
    step(d) {
      const j = this.i + d;
      if (j < 0 || j >= this.items.length) return;
      this.i = j;
      history.replaceState(null, '', '#' + encodeURIComponent(ref(this.item)));
      this.render(true);
    },
    size() {
      const it = this.item;
      const W = innerWidth, H = innerHeight;
      const ms = this.media.style;
      let w, h;
      if (W < 900 && this.key !== 'gallery') {
        // full width of the scroll area. Sized by CSS, not by innerWidth: innerWidth includes the
        // pane's own vertical scrollbar, which made the image wider than the visible area and
        // caused a horizontal scrollbar.
        ms.width = '100%'; ms.height = 'auto'; ms.aspectRatio = '1 / 1';
        w = h = this.media.clientWidth || this.scroller.clientWidth;
      } else {
        const sw = this.scroller.clientWidth || W, sh = this.scroller.clientHeight || H;
        if (this.key === 'gallery') {
          const maxW = W >= 900 ? sw - 160 : sw, maxH = W >= 900 ? sh - 128 : sh; // 128 = the pane's 64 px top + bottom padding
          const a = it.w / it.h;
          w = Math.min(maxW, maxH * a, it.w); h = w / a;
        } else {
          w = h = Math.min(sh - 128, (sw - 128) * 0.58, 1080);
        }
        w = Math.round(w); h = Math.round(h);
        ms.aspectRatio = ''; ms.width = w + 'px'; ms.height = h + 'px';
      }
      this.img.sizes = w + 'px';
      // instant placeholder from the thumbnail sheet that is already loaded
      const tier = Sheets.loadedTier(this.key, it);
      const css = tier && Sheets.css(this.key, it, tier, w, h);
      if (css) Object.assign(this.ph.style, { backgroundImage: css.backgroundImage, backgroundSize: css.backgroundSize, backgroundPosition: css.backgroundPosition });
      else this.ph.style.backgroundImage = 'none';
    },
    render(animate) {
      const it = this.item;
      const swap = () => {
        this.media.style.setProperty('--c', it.c);
        this.img.classList.remove('ready');
        this.img.removeAttribute('src');
        this.size();
        this.img.srcset = it.d.map((v) => `${v.src} ${v.w}w`).join(', ');
        this.img.src = it.d[it.d.length - 1].src;
        this.img.alt = label(it);
        if (this.img.complete && this.img.naturalWidth) this.img.classList.add('ready');
        this.prev.hidden = this.i <= 0;
        this.next.hidden = this.i >= this.items.length - 1;
        this.refreshInfo();
        this.media.classList.remove('fading');
        $('.pane-scroll', this.pane).scrollTop = 0;
      };
      if (animate) { this.media.classList.add('fading'); setTimeout(swap, 180); } else swap();
    },
    refreshInfo() {
      if (!this.isOpen || this.key !== 'collection') { if (this.info) this.info.innerHTML = ''; return; }
      const it = this.item;
      const sold = Shop.sold.has(it.id);
      const inCart = Cart.has(it.id);
      const attrs = (S.attrs || []).filter((a) => it[a.key] != null && it[a.key] !== '');
      this.info.innerHTML = `
        <p class="ref">${esc(label(it))}</p>
        <p class="price">${it.price != null ? money(it.price) : ''}${sold ? '<span class="sold-tag">sold</span>' : ''}</p>
        ${attrs.length ? `<dl>${attrs.map((a) => `<dt>${esc(a.label)}</dt><dd>${esc(it[a.key])}</dd>`).join('')}</dl>` : ''}
        ${it.price != null ? `<button class="btn-cart${sold ? ' is-sold' : inCart ? ' in-cart' : ''}" type="button" ${sold || inCart ? 'disabled' : ''}>
          ${sold ? 'sold' : inCart ? 'in your cart ✓' : 'add to cart'}</button>` : ''}
        <p class="status"></p>`;
      const btn = $('.btn-cart', this.info);
      if (btn && !sold && !inCart) btn.addEventListener('click', async () => {
        btn.classList.add('busy'); btn.disabled = true;
        const ok = await Shop.check(it.id);
        if (ok) { Cart.add(it.id); this.refreshInfo(); $('.status', this.info).textContent = 'added — you can keep browsing'; }
        else { this.refreshInfo(); $('.status', this.info).textContent = 'sorry, this piece has just been sold'; }
      });
    },
  };

  function scrollThumbIntoView(t) {
    const r = t.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 20) {
      html.style.scrollBehavior = 'auto';
      scrollBy(0, r.top - innerHeight / 2 + r.height / 2);
      html.style.scrollBehavior = '';
    }
  }

  // ============================================================ menu
  const Menu = {
    init() {
      this.btn = $('.menu-btn');
      this.nav = $('#menu');
      this.btn.addEventListener('click', () => (html.classList.contains('menu-open') ? this.close() : this.open()));
      $('.menu-scrim').addEventListener('click', () => this.close());
      $$('a', this.nav).forEach((a) => a.addEventListener('click', () => this.close()));
      addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    },
    open() { html.classList.add('menu-open'); this.btn.setAttribute('aria-expanded', 'true'); this.nav.setAttribute('aria-hidden', 'false'); },
    close() { if (!this.btn) return; html.classList.remove('menu-open'); this.btn.setAttribute('aria-expanded', 'false'); this.nav.setAttribute('aria-hidden', 'true'); },
  };

  // ============================================================ #hash routing
  // #collection / #story / ... -> scroll to that section
  // #lisbon                     -> scroll to that product (by name) and open its detail pane
  // #DSC01606                   -> the same for a gallery picture (by file name)
  function route(initial) {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) { Detail.close(false); return; }
    for (const key of ['collection', 'gallery']) {
      const i = (S[key] || []).findIndex((x) => ref(x) === id);
      if (i >= 0) {
        const it = S[key][i];
        const t = document.getElementById('t-' + it.id);
        if (t && initial) { html.style.scrollBehavior = 'auto'; t.scrollIntoView({ block: 'center' }); html.style.scrollBehavior = ''; }
        if (!Detail.isOpen || Detail.item !== it) Detail.open(key, i, false);
        return;
      }
    }
    Detail.close(false);
    const sec = document.getElementById(id);
    if (sec && initial) sec.scrollIntoView();
  }

  // ============================================================ boot
  const onScroll = () => html.classList.toggle('scrolled', scrollY > innerHeight * 0.85);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  Splash.init();
  Menu.init();
  Grid.init();
  Detail.init();
  Cart.init();
  Shop.init();
  addEventListener('popstate', () => route(false));
  if ('scrollRestoration' in history && location.hash) history.scrollRestoration = 'manual';
  route(true);
})();
