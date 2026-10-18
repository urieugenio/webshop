/* Uri Eugenio — front-end. Data comes from window.SITE (generated data/site-*.js). No dependencies. */
(() => {
  'use strict';
  const S = window.SITE;
  const C = S.config;
  const L = C.layout;
  // the collections that are for sale (beanies, scarves, …): their items are S[key], their attributes S.collections[key]
  const SHOPS = Object.keys(S.collections || {});
  const isShop = (key) => SHOPS.includes(key);
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
        if (!items.length) { const n = $(`.empty-note[data-for="${key}"]`); if (n) n.hidden = false; continue; }
        const frag = document.createDocumentFragment();
        items.forEach((it, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'thumb';
          b.id = 't-' + it.id;
          b.dataset.i = i;
          b.style.setProperty('--c', it.c);
          b.setAttribute('aria-label', label(it));
          b.innerHTML = '<span class="ti"></span>' + (isShop(key) ? '<span class="sold-band">sold</span>' : '');
          b.addEventListener('click', () => Detail.open(key, i, true));
          frag.appendChild(isShop(key) ? this.cell(b, it, i, key) : b);
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
    /** a collection for sale: the thumb plus a caption below it: colour dot, name and (on the right) price */
    cell(b, it, i, key) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.setAttribute('aria-hidden', 'true'); // the thumb button already carries the name
      cap.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="pr"></span>';
      const dot = $('.dot', cap);
      const hex = (S.colors?.palette || []).find((p) => p.name === it.color)?.hex;
      if (hex) dot.style.setProperty('--sw', hex);
      if (it.multi) dot.classList.add('multi');
      if (it.multi && !hex) dot.classList.add('all'); // many colours, no main colour: all rainbow
      if (!hex && !it.multi) dot.remove();
      $('.nm', cap).textContent = label(it);
      $('.pr', cap).textContent = money(it.price);
      cap.addEventListener('click', () => Detail.open(key, i, true));
      cell.append(b, cap);
      b._cell = cell;
      return cell;
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
    sold: new Set(), reserved: new Set(), last: 0,
    live: C.shop.liveInventory && location.protocol.startsWith('http'),
    api(p) { return (C.shop.apiBase || '') + p; },
    async init() {
      await this.refresh();
      if (!this.live) return;
      // only while the page is in view: every poll is a request to the Worker (100,000 a day on the free plan)
      setInterval(() => { if (!document.hidden) this.refresh(); }, C.shop.pollSeconds * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && Date.now() - this.last > 15000) this.refresh();
      });
    },
    async refresh() {
      if (!this.live) { this.sold = new Set(C.shop.previewSoldIds || []); return this.apply(); }
      this.last = Date.now();
      try {
        const r = await fetch(this.api('/api/inventory'), { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        this.sold = new Set(j.sold || []);
        this.reserved = new Set(j.reserved || []);
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
      for (const key of SHOPS) {
        const sec = Grid.sections[key];
        if (sec) sec.thumbs.forEach((t, i) => t.classList.toggle('sold', this.sold.has(sec.items[i].id)));
      }
      Detail.refreshInfo();
      Cart.render();
    },
  };

  // shipping costs: a copy of shippingQuote() in lib/shipping.mjs, which the Worker charges; this only shows them
  const Ship = {
    T: S.shipping,
    names: (() => { try { const n = new Intl.DisplayNames(['en'], { type: 'region' }); return (c) => n.of(c); } catch { return (c) => c; } })(),
    offers(c) { return !!this.T && this.T.countries.includes(c); },
    /** { cents, parcels, extra } for `pieces` pieces worth `goods` cents, or null */
    quote(c, pieces, goods) {
      const T = this.T;
      if (!this.offers(c) || pieces < 1) return null;
      const rates = T.rates[T.aliases[c] || c] || T.rates[T.europe.includes(c) ? 'otherEurope' : 'otherWorld'];
      const per = Math.floor(T.maxParcelGrams / T.gramsPerPiece);
      let cents = 0;
      for (let left = pieces; left > 0; left -= per) {
        const n = Math.min(left, per);
        cents += Math.round(rates[T.bands.findIndex((max) => n * T.gramsPerPiece <= max)] * 100);
      }
      const extra = T.surcharge[c];
      if (extra) cents += Math.round((goods * extra.percentOfGoods) / 100);
      return { cents, parcels: Math.ceil(pieces / per), extra };
    },
    /** the visitor's country from the browser language (nl-NL -> NL), if we ship there */
    guess() {
      for (const l of navigator.languages || [navigator.language || '']) {
        const m = /-([A-Z]{2})$/i.exec(l);
        if (m && this.offers(m[1].toUpperCase())) return m[1].toUpperCase();
      }
      return '';
    },
  };

  const Cart = {
    ids: store.get('ue-cart', []),
    country: store.get('ue-country', ''),
    message: '', busy: false,
    has(id) { return this.ids.includes(id); },
    add(id) { if (!this.has(id)) { this.ids.push(id); this.save(); } },
    remove(id) { this.ids = this.ids.filter((x) => x !== id); this.save(); },
    save() { this.message = ''; store.set('ue-cart', this.ids); this.render(); Detail.refreshInfo(); },
    /** the piece with this id and its collection ({ key, i, it }), or null; ids are unique across the collections */
    find(id) {
      for (const key of SHOPS) {
        const i = (S[key] || []).findIndex((x) => x.id === id);
        if (i >= 0) return { key, i, it: S[key][i] };
      }
      return null;
    },
    item(id) { return this.find(id)?.it; },
    init() {
      this.btn = $('.cart-btn');
      this.pane = $('.pane.cart');
      this.btn.addEventListener('click', () => this.open());
      $('.pane-close', this.pane).addEventListener('click', () => this.close());
      $('.cart-scrim').addEventListener('click', () => this.close());
      addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) this.close(); });
      this.ids = this.ids.filter((id) => this.item(id));
      if (!Ship.offers(this.country)) this.country = Ship.guess();
      this.returnFromCheckout();
      this.render();
    },
    /** back from Stripe: ?checkout=done (paid) or ?checkout=cancel&hold=… (came back without paying) */
    returnFromCheckout() {
      const q = new URLSearchParams(location.search);
      const back = q.get('checkout');
      if (!back) return;
      history.replaceState(null, '', location.pathname + location.hash);
      store.set('ue-hold', null);
      if (back === 'done') {
        this.ids = [];
        store.set('ue-cart', this.ids);
        this.message = 'Thank you for your order! You will receive a confirmation by email.';
      } else {
        // frees the pieces at once instead of after the reservation time
        if (q.get('hold')) fetch(Shop.api('/api/checkout/cancel'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hold: q.get('hold') }) }).then(() => Shop.refresh()).catch(() => {});
        this.message = 'Payment cancelled. Your pieces are still in your cart.';
      }
      setTimeout(() => this.open(), 120); // after the first paint, so the pane slides in
    },
    async checkout() {
      const ids = this.ids.filter((id) => !Shop.sold.has(id));
      if (!ids.length || !this.country || this.busy) return;
      this.busy = true; this.message = ''; this.render();
      try {
        const r = await fetch(Shop.api('/api/checkout'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, country: this.country, previous: store.get('ue-hold', null) }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.url) { store.set('ue-hold', j.hold); location.href = j.url; return; }
        if (r.status === 409) {
          const names = (list) => list.map((id) => label(this.item(id))).join(', ');
          (j.sold || []).forEach((id) => Shop.sold.add(id));
          (j.reserved || []).forEach((id) => Shop.reserved.add(id));
          this.message = [
            j.sold?.length && `Sold in the meantime: ${names(j.sold)}. Remove it to continue.`,
            j.reserved?.length && `Someone else is buying ${names(j.reserved)} right now. If they don't complete their payment, ` +
              `it is available again within ${C.shop.reserveMinutes} minutes.`,
          ].filter(Boolean).join(' ');
          Shop.apply();
        } else {
          this.message = j.error ? j.error.charAt(0).toUpperCase() + j.error.slice(1) + '.' : 'Checkout is not available right now. Please try again in a moment.';
        }
      } catch {
        this.message = 'No connection. Please try again.';
      }
      this.busy = false;
      this.render();
    },
    get isOpen() { return !!this.pane && this.pane.classList.contains('open'); },
    open() { Menu.close(); this.pane.classList.add('open'); this.pane.setAttribute('aria-hidden', 'false'); html.classList.add('locked', 'cart-open'); },
    close() { html.classList.remove('cart-open'); this.pane.classList.remove('open'); this.pane.setAttribute('aria-hidden', 'true'); if (!Detail.isOpen) html.classList.remove('locked'); },
    render() {
      if (!this.btn) return;
      this.btn.hidden = !this.ids.length;
      $('.cart-count', this.btn).textContent = this.ids.length;
      const list = $('.cart-list', this.pane);
      const msg = this.message ? `<p class="cart-msg" role="status">${esc(this.message)}</p>` : '';
      if (!this.ids.length) { list.innerHTML = msg + '<p class="cart-empty">your cart is empty</p>'; return; }
      let total = 0, count = 0;
      list.innerHTML = '';
      for (const id of this.ids) {
        const { key, i, it } = this.find(id);
        const sold = Shop.sold.has(id);
        if (!sold && it.price) { total += it.price; count++; }
        const row = document.createElement('div');
        row.className = 'cart-item' + (sold ? ' is-sold' : '');
        row.innerHTML = `<button class="thumb loaded" type="button" aria-label="show ${esc(label(it))}"><span class="ti"></span></button>
          <div><div class="ci-ref">${esc(label(it))}</div><div class="ci-desc"></div>${sold ? '<div class="ci-sold">sold — no longer available</div>' : ''}</div>
          <div><div class="ci-price">${money(it.price)}</div><button class="ci-remove" type="button">remove</button></div>`;
        $('.ci-desc', row).textContent = S.collections[key].attrs.map((a) => it[a.key]).filter(Boolean).join(' · ');
        const th = $('.thumb', row);
        th.style.setProperty('--c', it.c);
        const tier = Sheets.tierFor(key, 70);
        const css = Sheets.css(key, it, tier, 70, 70);
        if (css) { Sheets.load(css.url); Object.assign($('.ti', th).style, { backgroundImage: css.backgroundImage, backgroundSize: css.backgroundSize, backgroundPosition: css.backgroundPosition }); }
        th.addEventListener('click', () => { this.close(); Detail.open(key, i, true); });
        $('.ci-remove', row).addEventListener('click', () => this.remove(id));
        list.appendChild(row);
      }
      const ship = Ship.quote(this.country, count, Math.round(total * 100));
      const options = (Ship.T?.countries || []).map((c) => [c, Ship.names(c)]).sort((a, b) => a[1].localeCompare(b[1], 'en'))
        .map(([c, n]) => `<option value="${c}"${c === this.country ? ' selected' : ''}>${esc(n)}</option>`).join('');
      const shipLabel = !ship ? 'shipping' : `shipping${ship.parcels > 1 ? ` (${ship.parcels} parcels)` : ''}${ship.extra ? ', incl. import duties' : ''}`;
      const ready = Shop.live && ship && count && !this.busy;
      const legal = (S.legal || []).filter((k) => k !== 'privacy').map((k) => `<a href="${k}/">${k}</a>`).join(' · ');
      const foot = document.createElement('div');
      foot.className = 'cart-foot';
      foot.innerHTML = `<label class="cart-country"><span>ship to</span>
          <select><option value="">choose your country</option>${options}</select></label>
        <div class="cart-line"><span>${shipLabel}</span><span>${ship ? money(ship.cents / 100) : '—'}</span></div>
        <div class="cart-total"><span>total</span><span>${money(total + (ship ? ship.cents / 100 : 0))}</span></div>
        ${msg}
        <button class="btn-cart btn-checkout${this.busy ? ' busy' : ''}" type="button"${ready ? '' : ' disabled'}>${this.busy ? 'one moment…' : 'checkout'}</button>
        <p class="cart-note">${Shop.live ? '' : 'Checkout is only available on the website. '}Every piece is one of a kind: ` +
          `the first to complete payment gets it.${legal ? `<br>${legal}` : ''}</p>`;
      $('select', foot).addEventListener('change', (e) => { this.country = e.target.value; store.set('ue-country', this.country); this.message = ''; this.render(); });
      $('.btn-checkout', foot).addEventListener('click', () => this.checkout());
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
        if (!this.isOpen || Cart.isOpen) return; // the cart is on top: its keys first
        if (e.key === 'Escape') this.close(true);
        else if (e.key === 'ArrowLeft') this.step(-1);
        else if (e.key === 'ArrowRight') this.step(1);
      });
      // swipe left / right on touch screens. Not a swipe: a pinch (two fingers, until all are lifted again, else
      // lifting one finger of a pinch looks like a swipe), nor dragging one finger while zoomed in (that pans the photo)
      let x0 = null, y0 = 0, pinch = false;
      const zoomed = () => (window.visualViewport?.scale || 1) > 1.01;
      this.media.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) { pinch = true; x0 = null; }
        else if (!pinch) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }
      }, { passive: true });
      const touchEnd = (e) => {
        if (e.type === 'touchend' && !pinch && x0 !== null && !zoomed()) {
          const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.step(dx < 0 ? 1 : -1);
        }
        x0 = null;
        if (!e.touches.length) pinch = false;
      };
      this.media.addEventListener('touchend', touchEnd, { passive: true });
      this.media.addEventListener('touchcancel', touchEnd, { passive: true });
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
    /** the next piece in direction d that the filter shows (-1 or items.length when there is none) */
    neighbour(d) {
      let j = this.i + d;
      while (j >= 0 && j < this.items.length && !Filters.shows(this.key, this.items[j])) j += d;
      return j;
    },
    step(d) {
      const j = this.neighbour(d);
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
        this.prev.hidden = this.neighbour(-1) < 0;
        this.next.hidden = this.neighbour(1) >= this.items.length;
        this.refreshInfo();
        this.media.classList.remove('fading');
        $('.pane-scroll', this.pane).scrollTop = 0;
      };
      if (animate) { this.media.classList.add('fading'); setTimeout(swap, 180); } else swap();
    },
    refreshInfo() {
      if (!this.isOpen || !isShop(this.key)) { if (this.info) this.info.innerHTML = ''; return; }
      const it = this.item;
      const sold = Shop.sold.has(it.id);
      const inCart = Cart.has(it.id);
      const rows = S.collections[this.key].attrs.filter((a) => it[a.key] != null && it[a.key] !== '').map((a) => [a.label, it[a.key]]);
      this.info.innerHTML = `
        <p class="ref">${esc(label(it))}</p>
        <p class="price">${it.price != null ? money(it.price) : ''}${sold ? '<span class="sold-tag">sold</span>' : ''}</p>
        ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
        ${it.price != null ? `<button class="btn-cart${sold ? ' is-sold' : inCart ? ' in-cart' : ''}" type="button" ${sold ? 'disabled' : ''}>
          ${sold ? 'sold' : inCart ? 'in your cart ✓ · checkout' : 'add to cart'}</button>` : ''}
        <p class="status"></p>`;
      const btn = $('.btn-cart', this.info);
      // in the cart: the same button opens the cart over this page (closing it comes back here)
      if (btn && !sold && inCart) btn.addEventListener('click', () => Cart.open());
      if (btn && !sold && !inCart) btn.addEventListener('click', async () => {
        btn.classList.add('busy'); btn.disabled = true;
        const ok = await Shop.check(it.id);
        if (ok) { Cart.add(it.id); this.refreshInfo(); $('.status', this.info).textContent = 'added — keep browsing, or tap the button to check out'; }
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

  // ============================================================ collection filters
  // Every collection has its own filter bar above its grid.
  // One colour at a time: the colour dots work like radio buttons ("multicolour" shows the multicoloured pieces);
  // clicking the chosen dot again shows all colours. Below them, the attributes in config.json collections.<key>.filters
  // get a pulldown with the values pieces have (in the order of the attributes file); one value only means no pulldown.
  // A piece is shown when it matches the colour and every pulldown.
  const MULTI = '*multi';
  const Filters = {
    bars: {},     // collection key -> its filter
    init() { for (const key of SHOPS) { const f = makeFilter(key); if (f.init()) this.bars[key] = f; } },
    shows(key, it) { const f = this.bars[key]; return !f || f.match(it); },
  };
  const makeFilter = (key) => ({
    color: null,  // palette name, MULTI or null (all colours)
    pick: {},     // attribute key -> chosen value
    /** builds the bar; false when this collection has nothing to filter */
    init() {
      this.bar = $(`.filters[data-section="${key}"]`);
      const items = S[key] || [];
      if (!this.bar || items.length < 2) return false;
      const present = (key) => new Set(items.map((it) => it[key]).filter((v) => v != null && v !== ''));
      let html = '';
      // colour dots, in palette order: only the colours pieces of this collection have (and multicolour when one is)
      const colours = present('color');
      const dot = (value, cls, title, hex) => `<button type="button" role="radio" class="${cls}" data-color="${esc(value)}" ` +
        `title="${esc(title)}" aria-label="${esc(title)}" aria-checked="false"${hex ? ` style="--sw:${hex}"` : ''}></button>`;
      const dots = (S.colors?.palette || []).filter((p) => colours.has(p.name)).map((p) => dot(p.name, 'sw', p.name, p.hex));
      if (items.some((it) => it.multi)) dots.push(dot(MULTI, 'sw multi', S.colors.multiLabel, null));
      if (dots.length > 1) html += `<div class="fgroup" role="radiogroup" aria-label="colour"><span class="flabel">colour</span>${dots.join('')}</div>`;
      // pulldowns, in the order of config.json "filters"; prices from low to high
      this.lists = {};
      for (const f of S.collections[key].filters || []) {
        const have = present(f.key);
        const values = f.values.filter((v) => have.has(v)).concat([...have].filter((v) => !f.values.includes(v)));
        if (f.key === 'price') values.sort((a, b) => a - b);
        if (values.length < 2) continue;
        this.lists[f.key] = values;
        const fmt = f.key === 'price' ? money : String;
        html += `<label class="fgroup"><span class="flabel">${esc(f.label)}</span><select class="fsel" data-key="${esc(f.key)}">` +
          `<option value="">all</option>${values.map((v, i) => `<option value="${i}">${esc(fmt(v))}</option>`).join('')}</select></label>`;
      }
      if (!html) return false;
      this.bar.innerHTML = html + '<div class="fstatus" hidden><span class="fcount"></span><button type="button" class="fclear">show all</button></div>';
      this.bar.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.classList.contains('fclear')) {
          this.color = null; this.pick = {};
          $$('select', this.bar).forEach((s) => { s.value = ''; });
        } else {
          this.color = this.color === b.dataset.color ? null : b.dataset.color;
        }
        this.apply();
      });
      this.bar.addEventListener('change', (e) => {
        const s = e.target, key = s.dataset.key;
        if (s.value === '') delete this.pick[key]; else this.pick[key] = this.lists[key][s.value];
        this.apply();
      });
      this.bar.hidden = false;
      this.empty = $(`.filter-empty[data-for="${key}"]`);
      return true;
    },
    match(it) {
      if (this.color === MULTI ? !it.multi : this.color && it.color !== this.color) return false;
      return Object.entries(this.pick).every(([k, v]) => it[k] === v);
    },
    apply() {
      const sec = Grid.sections[key];
      let n = 0;
      sec.thumbs.forEach((t, i) => { const ok = this.match(sec.items[i]); (t._cell || t).hidden = !ok; n += ok; });
      for (const b of $$('button[data-color]', this.bar)) b.setAttribute('aria-checked', b.dataset.color === this.color);
      $('.fstatus', this.bar).hidden = !this.color && !Object.keys(this.pick).length;
      $('.fcount', this.bar).textContent = `${n} of ${sec.items.length}`;
      if (this.empty) this.empty.hidden = n > 0;
      Grid.layout();
    },
  });

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
  // #beanies / #my-story / ... -> scroll to that section
  // #lisbon                     -> scroll to that product (by name, beanie or scarf) and open its detail pane
  // #DSC01606                   -> the same for a gallery picture (by file name)
  function route(initial) {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) { Detail.close(false); return; }
    for (const key of [...SHOPS, 'gallery']) {
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
  // no link starts a drag, so a click that moves a few px is still a click (site.css does this for all but Firefox)
  for (const a of $$('a[href]')) a.draggable = false;
  const onScroll = () => html.classList.toggle('scrolled', scrollY > innerHeight * 0.85);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  Splash.init();
  Menu.init();
  Grid.init();
  Filters.init();
  Detail.init();
  Cart.init();
  Shop.init();
  addEventListener('popstate', () => route(false));
  if ('scrollRestoration' in history && location.hash) history.scrollRestoration = 'manual';
  route(true);
})();
