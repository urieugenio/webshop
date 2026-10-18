// Uri Eugenio webshop — the Worker behind uri.fashion.
// The static site (build\dist) is served by Cloudflare without running this code; only /api/* comes here:
//
//   GET  /api/inventory          ids of the pieces that are sold or reserved (the site polls this)
//   GET  /api/availability?id=   is this piece still for sale (before "add to cart")
//   POST /api/checkout           { ids, country, previous? } -> reserves the pieces, returns the Stripe Checkout url
//   POST /api/checkout/cancel    { hold } -> the buyer came back without paying: frees the pieces at once
//   POST /api/stripe-webhook     Stripe tells us a checkout was paid, failed or expired
//   GET  /api/admin/login        a form for the admin key; POST checks it and signs this phone in for a year
//   POST /api/admin/logout       signs this phone out
//   POST /api/admin/sold         { id } -> sold at the market, without Stripe
//   POST /api/admin/undo         { id } -> a market sale was a mistake: available again (online sales stay sold)
//
// First come, first served: a checkout reserves its pieces for as long as its Stripe session is open (30 minutes).
// Whoever tries to buy a reserved piece in that time is told it is being bought. Payment marks the pieces sold;
// an expired, cancelled or failed checkout makes them available again.
// A market sale is an order with status 'market' (session NULL, no shipping); its pieces have hold 'market:<uuid>'.
// Secrets (wrangler secret put): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_KEY. Locally: code\.dev.vars.

import { shippingQuote } from '../lib/shipping.mjs';

const TAX_CODE_CLOTHING = 'txcd_30011000';
const TAX_CODE_SHIPPING = 'txcd_92010001';
const MAX_PIECES = 12;                 // per checkout, so nobody can hold the whole collection
const GRACE = 10 * 60;                 // a reservation outlives its Stripe session by this much (s)
const PENDING_HOLD = 14 * 24 * 3600;   // a payment that takes days (bank debit) keeps its pieces this long

const now = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/inventory': return await inventory(env);
        case 'GET /api/availability': return await availability(env, url.searchParams.get('id') || '');
        case 'POST /api/checkout': return await checkout(req, env, url);
        case 'POST /api/checkout/cancel': return await cancel(req, env);
        case 'POST /api/stripe-webhook': return await webhook(req, env);
        case 'GET /api/admin/login': return loginPage();
        case 'POST /api/admin/login': return await login(req, env);
        case 'POST /api/admin/logout': return logout();
        case 'POST /api/admin/sold': return await admin(req, env, url, markSold);
        case 'POST /api/admin/undo': return await admin(req, env, url, undoSale);
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e.stack || e);
      return json({ error: 'server error' }, 500);
    }
  },
};

// ---------------------------------------------------------------- catalog (written by the build as dist/catalog.json)
let catalogCache = null; // a deploy starts new isolates, so this never outlives the catalog it was read from
async function catalog(env, url) {
  if (!catalogCache) {
    const r = await env.ASSETS.fetch(new URL('/catalog.json', url));
    if (!r.ok) throw new Error('catalog.json missing: ' + r.status);
    catalogCache = await r.json();
  }
  return catalogCache;
}

// ---------------------------------------------------------------- inventory
async function inventory(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, status FROM pieces WHERE status = 'sold' OR until > ?1").bind(now()).all();
  return json({
    sold: results.filter((r) => r.status === 'sold').map((r) => r.id),
    reserved: results.filter((r) => r.status === 'reserved').map((r) => r.id),
  });
}

async function availability(env, id) {
  const row = await env.DB.prepare('SELECT status FROM pieces WHERE id = ?1').bind(id).first();
  // a reserved piece can still go in a cart: the reservation may expire
  return json({ id, available: row?.status !== 'sold' });
}

/** reserves all of `ids` for `hold`, or none of them: { ok, sold: [...], reserved: [...] } */
async function reserve(env, ids, hold, until) {
  const t = now();
  const upsert = env.DB.prepare(
    `INSERT INTO pieces (id, status, hold, until) VALUES (?1, 'reserved', ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET status = 'reserved', hold = excluded.hold, until = excluded.until
     WHERE pieces.status = 'reserved' AND pieces.until < ?4`);
  const res = await env.DB.batch([
    ...ids.map((id) => upsert.bind(id, hold, until, t)),
    env.DB.prepare("SELECT id FROM pieces WHERE hold = ?1 AND status = 'reserved'").bind(hold),
  ]);
  const got = new Set(res[res.length - 1].results.map((r) => r.id));
  if (got.size === ids.length) return { ok: true, sold: [], reserved: [] };
  await release(env, hold);
  const missing = ids.filter((id) => !got.has(id));
  const { results } = await env.DB.prepare(
    `SELECT id, status FROM pieces WHERE id IN (${missing.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...missing).all();
  const sold = results.filter((r) => r.status === 'sold').map((r) => r.id);
  return { ok: false, sold, reserved: missing.filter((id) => !sold.includes(id)) };
}

const release = (env, hold) => env.DB.prepare("DELETE FROM pieces WHERE hold = ?1 AND status = 'reserved'").bind(hold).run();

// ---------------------------------------------------------------- checkout
async function checkout(req, env, url) {
  const body = await req.json().catch(() => ({}));
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))];
  const country = String(body.country || '').toUpperCase();
  const cat = await catalog(env, url);
  if (!ids.length) return json({ error: 'your cart is empty' }, 400);
  if (ids.length > MAX_PIECES) return json({ error: `at most ${MAX_PIECES} pieces per order` }, 400);
  const items = ids.map((id) => cat.items[id]);
  if (items.some((x) => !x || x.price == null)) return json({ error: 'a piece in your cart is no longer in the shop' }, 400);
  const goods = items.reduce((s, x) => s + Math.round(x.price * 100), 0);
  const ship = cat.shipping.countries.includes(country) && shippingQuote(cat.shipping, country, ids.length, goods);
  if (!ship) return json({ error: 'we do not ship to this country' }, 400);

  // the same visitor trying again (back from Stripe without paying, or a changed cart): drop the earlier checkout first
  if (body.previous) await cancelHold(env, String(body.previous));

  const expires = now() + cat.shop.reserveMinutes * 60 + 60; // Stripe requires at least 30 minutes
  const hold = crypto.randomUUID();
  const r = await reserve(env, ids, hold, expires + GRACE);
  if (!r.ok) return json({ error: 'unavailable', sold: r.sold, reserved: r.reserved }, 409);

  const site = env.SITE_URL || url.origin;
  // back from Stripe to where the visitor came from: uri.fashion, the workers.dev address, or "npm run dev"
  // (which passes --local-upstream, else wrangler dev would report every request as coming from uri.fashion)
  const back = url.origin;
  let session;
  try {
    session = await stripe(env, 'POST', 'checkout/sessions', {
      mode: 'payment',
      locale: 'auto',
      line_items: items.map((x, i) => ({
        quantity: 1,
        price_data: {
          currency: cat.shop.currency.toLowerCase(),
          unit_amount: Math.round(x.price * 100),
          tax_behavior: 'inclusive',
          product_data: { name: x.name, description: x.desc || undefined, images: [`${site}/${x.image}`],
            tax_code: TAX_CODE_CLOTHING, metadata: { piece: ids[i] } },
        },
      })),
      shipping_address_collection: { allowed_countries: [country] },
      shipping_options: [{ shipping_rate_data: {
        type: 'fixed_amount', display_name: ship.label, tax_behavior: 'inclusive', tax_code: TAX_CODE_SHIPPING,
        fixed_amount: { amount: ship.cents, currency: cat.shop.currency.toLowerCase() } } }],
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: !!cat.shop.stripeTax },
      expires_at: expires,
      success_url: `${back}/?checkout=done`,
      cancel_url: `${back}/?checkout=cancel&hold=${hold}`,
      custom_text: { submit: { message: `Every piece is one of a kind and is reserved for you for ${cat.shop.reserveMinutes} minutes. ` +
        `By paying you accept the terms (${site}/terms/); you can return a piece within 14 days (${site}/returns/).` } },
      metadata: { hold, pieces: ids.join(',') },
      payment_intent_data: { metadata: { hold, pieces: ids.join(',') } },
    });
  } catch (e) {
    await release(env, hold);
    throw e;
  }
  await env.DB.prepare(
    "INSERT INTO orders (hold, session, created, pieces, country, goods, shipping, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open')")
    .bind(hold, session.id, now(), JSON.stringify(ids), country, goods, ship.cents).run();
  return json({ url: session.url, hold });
}

async function cancel(req, env) {
  const body = await req.json().catch(() => ({}));
  return json({ cancelled: await cancelHold(env, String(body.hold || '')) });
}

/** ends an open checkout and frees its pieces; false when it is no longer open (paid, or already over) */
async function cancelHold(env, hold) {
  const order = await env.DB.prepare("SELECT session FROM orders WHERE hold = ?1 AND status = 'open'").bind(hold).first();
  if (!order) return false;
  try {
    await stripe(env, 'POST', `checkout/sessions/${order.session}/expire`);
  } catch (e) {
    console.warn('expire failed (paid or expired meanwhile?)', e.message);
    return false; // the webhook settles it
  }
  await release(env, hold);
  await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE hold = ?1 AND status = 'open'").bind(hold).run();
  return true;
}

// ---------------------------------------------------------------- Stripe webhook
async function webhook(req, env) {
  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'invalid signature' }, 400);
  }
  const ev = JSON.parse(payload);
  const s = ev.data?.object || {};
  const hold = s.metadata?.hold;
  if (!hold || !String(ev.type).startsWith('checkout.session.')) return json({ received: true, ignored: true });
  const pieces = String(s.metadata.pieces || '').split(',').filter(Boolean);

  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    if (ev.type === 'checkout.session.completed' && s.payment_status === 'unpaid') {
      // the payment is underway (a bank debit can take days): keep the pieces until it succeeds or fails
      await env.DB.batch([
        env.DB.prepare("UPDATE pieces SET until = ?2 WHERE hold = ?1 AND status = 'reserved'").bind(hold, now() + PENDING_HOLD),
        env.DB.prepare("UPDATE orders SET status = 'pending', total = ?2 WHERE hold = ?1").bind(hold, s.amount_total ?? null),
      ]);
    } else {
      const sold = env.DB.prepare(
        `INSERT INTO pieces (id, status, hold, until) VALUES (?1, 'sold', ?2, NULL)
         ON CONFLICT (id) DO UPDATE SET status = 'sold', hold = excluded.hold, until = NULL`);
      await env.DB.batch([
        ...pieces.map((id) => sold.bind(id, hold)),
        env.DB.prepare("UPDATE orders SET status = 'paid', total = ?2 WHERE hold = ?1").bind(hold, s.amount_total ?? null),
      ]);
    }
  } else if (ev.type === 'checkout.session.expired' || ev.type === 'checkout.session.async_payment_failed') {
    const status = ev.type === 'checkout.session.expired' ? 'expired' : 'failed';
    await release(env, hold);
    await env.DB.prepare("UPDATE orders SET status = ?2 WHERE hold = ?1 AND status IN ('open', 'pending')").bind(hold, status).run();
  }
  return json({ received: true });
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Stripe-Signature: t=<time>,v1=<hmac-sha256 of "t.payload">; at most 5 minutes old */
async function verifySignature(payload, header, secret) {
  if (!header || !secret) return false;
  let t = 0;
  const sigs = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = Number(v);
    else if (k === 'v1') sigs.push(v);
  }
  if (!t || Math.abs(now() - t) > 300) return false;
  const expected = await hmac(secret, `${t}.${payload}`);
  return sigs.some((sig) => same(sig, expected));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** compares in constant time, so the time taken says nothing about how much of a secret was right */
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

// ---------------------------------------------------------------- admin: selling at the market from a phone
// Signing in sets two cookies for a year. "admin" (HttpOnly, only sent to /api/admin) proves it: an HMAC of the
// admin key, so changing ADMIN_KEY signs every phone out. "admin_ui" is readable by the site and only tells it to
// show the admin buttons; it grants nothing. Set by the server, so Safari keeps them (it wipes script-made storage
// after 7 days without a visit).
const ADMIN_DAYS = 365;
// no key, or still the placeholder of .env.worker: no admin at all
const adminReady = (env) => !!env.ADMIN_KEY && !env.ADMIN_KEY.startsWith('replace-me');
const adminToken = (env) => hmac(env.ADMIN_KEY, 'uri.fashion admin cookie');
const cookie = (req, name) => (req.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(name + '='))?.slice(name.length + 1);

function setAdminCookies(headers, token, maxAge) {
  headers.append('Set-Cookie', `admin=${token}; Max-Age=${maxAge}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict`);
  headers.append('Set-Cookie', `admin_ui=${maxAge ? 1 : ''}; Max-Age=${maxAge}; Path=/; Secure; SameSite=Strict`);
}

function loginPage(message = '', status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Admin</title><style>
body{font:17px/1.4 system-ui,sans-serif;margin:0;padding:48px 20px;background:#f6f4f1;color:#222}
form{max-width:340px;margin:auto;display:grid;gap:12px}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #bbb}
button{background:#222;color:#fff;border:0}.msg{color:#b00020;min-height:1.4em;margin:0}
</style></head><body><form method="post" action="/api/admin/login">
<h1>Admin</h1><p>Signs this phone in for a year to mark pieces as sold at the market.</p>
<input type="hidden" name="username" value="admin" autocomplete="username">
<input type="password" name="key" placeholder="admin key" autocomplete="current-password" required autofocus>
<button>Sign in</button><p class="msg">${message}</p></form></body></html>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function login(req, env) {
  if (!adminReady(env)) return loginPage('There is no admin key on the server yet (README 7, "Selling at the market").', 503);
  const key = String((await req.formData().catch(() => null))?.get('key') || '');
  if (!same(key, env.ADMIN_KEY)) {
    await new Promise((r) => setTimeout(r, 1000)); // slows down guessing
    return loginPage('That is not the admin key.', 403);
  }
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  setAdminCookies(headers, await adminToken(env), ADMIN_DAYS * 24 * 3600);
  return new Response(null, { status: 303, headers });
}

function logout() {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  setAdminCookies(headers, '', 0);
  return new Response('{"signedOut":true}', { headers });
}

/** checks the admin cookie and that the request comes from the site itself, then runs `action(env, id, url)` */
async function admin(req, env, url, action) {
  if (!adminReady(env) || !same(cookie(req, 'admin'), await adminToken(env))) return json({ error: 'signed out' }, 401);
  if (req.headers.get('Origin') !== url.origin) return json({ error: 'wrong origin' }, 403);
  const id = String((await req.json().catch(() => ({}))).id || '');
  if (!(await catalog(env, url)).items[id]) return json({ error: 'no such piece' }, 404);
  return action(env, id, url);
}

async function markSold(env, id, url) {
  const row = await env.DB.prepare('SELECT status, hold, until FROM pieces WHERE id = ?1').bind(id).first();
  if (row?.status === 'sold') return json({ error: 'this piece is already sold' }, 409);
  if (row?.status === 'reserved' && row.until > now()) {
    // someone is buying it online: their checkout ends here (all of it, as a checkout is all or nothing) ...
    if (!(await cancelHold(env, row.hold))) {
      // ... unless their payment is already underway
      const order = await env.DB.prepare('SELECT status FROM orders WHERE hold = ?1').bind(row.hold).first();
      if (order?.status === 'pending' || order?.status === 'paid' || order?.status === 'open') {
        return json({ error: 'someone is paying for this piece online right now' }, 409);
      }
    }
  }
  const hold = 'market:' + crypto.randomUUID();
  const cents = Math.round(((await catalog(env, url)).items[id].price || 0) * 100);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO pieces (id, status, hold, until) VALUES (?1, 'sold', ?2, NULL)
      ON CONFLICT (id) DO UPDATE SET status = 'sold', hold = excluded.hold, until = NULL`).bind(id, hold),
    env.DB.prepare(`INSERT INTO orders (hold, session, created, pieces, country, goods, shipping, total, status)
      VALUES (?1, NULL, ?2, ?3, '', ?4, 0, ?4, 'market')`).bind(hold, now(), JSON.stringify([id]), cents),
  ]);
  return json({ id, sold: true });
}

async function undoSale(env, id) {
  const row = await env.DB.prepare('SELECT status, hold FROM pieces WHERE id = ?1').bind(id).first();
  if (row?.status !== 'sold') return json({ error: 'this piece is not sold' }, 409);
  if (!row.hold.startsWith('market:')) return json({ error: 'this piece was sold online: refund it in Stripe instead' }, 409);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pieces WHERE id = ?1 AND hold = ?2').bind(id, row.hold),
    env.DB.prepare("UPDATE orders SET status = 'undone' WHERE hold = ?1").bind(row.hold),
  ]);
  return json({ id, sold: false });
}

// ---------------------------------------------------------------- Stripe API (plain fetch: small and fast on the free plan)
async function stripe(env, method, path, params) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? form(params).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path}: ${j.error?.message || r.status}`);
  return j;
}

/** { a: { b: [x] } } -> a[b][0]=x, the form encoding the Stripe API expects */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}
