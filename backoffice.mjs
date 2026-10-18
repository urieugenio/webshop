#!/usr/bin/env node
// Uri Eugenio webshop — backoffice
//
//   node backoffice.mjs        start on http://localhost:8081 and open it in the browser
//   options: --port=<n>  --no-open  --sources=<folder>
//
// One tab per collection of config.json "collections" (beanies, scarves). Each edits its own sources/<key>.json:
// the order, the name, the attributes (sources/<key>-attributes.txt) and the colour (measured from the photo, see
// lib/colors.mjs) of every photo in sources/<key>. Those files are the only ones it ever writes inside the sources
// folder. The "Build site" button runs build.mjs; the built site is shown at /site/.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  collectionKeys, collectionFiles, readAttributes, readCollection, mergeCollection, normalizeEntry, formatCollection, slugify,
} from './lib/collection.mjs';
import { analyseColor } from './lib/colors.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argVal = (k) => { const a = argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const SRC = path.resolve(ROOT, argVal('--sources') || cfg.sourcesDir);
const OUT = path.resolve(ROOT, cfg.outDir);
const CACHE = path.resolve(ROOT, cfg.cacheDir, 'backoffice');
const KEYS = collectionKeys(cfg);
const UI = path.join(ROOT, 'backoffice');
const PORT = Number(argVal('--port')) || 8081;
const IMG_EXT = /\.(jpe?g|png|webp|tiff?)$/i;
const THUMB_WIDTHS = [320, 960];
const PALETTE = cfg.colors?.palette || [];

sharp.cache(false);

const cities = fs.readFileSync(path.join(UI, 'cities.txt'), 'utf8').split(/\r?\n/)
  .map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

const photosDir = (key) => path.join(SRC, collectionFiles(key).photos);
/** where the colour is measured: config.json colors.analysis, with the collection's own colorAnalysis on top */
const analysis = (key) => ({ ...(cfg.colors?.analysis || {}), ...(cfg.collections[key].colorAnalysis || {}) });

function photos(key) {
  const dir = photosDir(key);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => IMG_EXT.test(n) && !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** section links of the site (#beanies, #my-story …, the "# Title" lines of site.md): a product name must not take one */
function sectionSlugs() {
  const c = cfg.content || {};
  const file = path.join(SRC, c.folder || 'content', c.file || 'site.md');
  const ids = fs.existsSync(file) ? [...fs.readFileSync(file, 'utf8').matchAll(/^#[ \t]+(.+?)[ \t#]*$/gm)].map((m) => slugify(m[1])) : [];
  return [...new Set(['intro', 'home', 'gallery', ...KEYS, ...ids])];
}

/** the names of the other collections (with their pieces whose photo is gone): a name is a link, unique on the whole site */
function otherNames(key) {
  return KEYS.filter((k) => k !== key).flatMap((k) => readCollection(SRC, k).map((e) => slugify(e.name || ''))).filter(Boolean);
}

function pickName(used) {
  const free = cities.filter((c) => !used.has(slugify(c)));
  let name = free[Math.floor(Math.random() * free.length)];
  for (let n = 2; !name; n++) {
    const c = `${cities[Math.floor(Math.random() * cities.length)]} ${n}`;
    if (!used.has(slugify(c))) name = c;
  }
  used.add(slugify(name));
  return name;
}

// ---------------------------------------------------------------- colours
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** measure the colour of these entries (sets color, multi, hex; a colour set by hand is no longer by hand) */
async function detectColors(key, entries) {
  if (!entries.length || !PALETTE.length) return;
  console.log(`Measuring the colour of ${entries.length} ${key} photo${entries.length > 1 ? 's' : ''}…`);
  let done = 0;
  await pool(entries, 4, async (e) => {
    const r = await analyseColor(path.join(photosDir(key), e.file), PALETTE, analysis(key));
    Object.assign(e, { color: r.color, multi: r.multi, hex: r.hex });
    delete e.colorByHand;
    if (++done % 20 === 0) console.log(`  ${done}/${entries.length}`);
  });
}

/** the colour fields of an entry sent by the page, checked */
function cleanColor(e) {
  const out = {};
  out.color = PALETTE.some((p) => p.name === e.color) ? e.color : null;
  out.multi = e.multi === true;
  if (typeof e.hex === 'string' && /^#[0-9a-f]{6}$/i.test(e.hex)) out.hex = e.hex;
  if (e.colorByHand === true) out.colorByHand = true;
  return out;
}

// ---------------------------------------------------------------- <key>.json
/** current state; new photos get the default attributes, a free city name and their colour, and are saved straight away */
async function load(key) {
  const attrs = readAttributes(SRC, key);
  const saved = readCollection(SRC, key);
  const { items, added, orphans } = mergeCollection(saved, photos(key), attrs);
  const used = new Set([...sectionSlugs(), ...otherNames(key), ...saved.map((e) => slugify(e.name || '')).filter(Boolean)]);
  const unnamed = items.filter((e) => !e.name);
  for (const e of unnamed) e.name = pickName(used);
  const unmeasured = items.filter((e) => !e.hex);
  await detectColors(key, unmeasured);
  if (added.length || unnamed.length || unmeasured.length) await save(key, items, orphans, attrs);
  return { attrs, items, orphans };
}

/** atomic write (tmp + rename), with the previous version kept in the cache folder */
async function save(key, items, orphans, attrs) {
  const file = path.join(SRC, collectionFiles(key).data);
  const text = formatCollection([...items, ...orphans.map((e) => normalizeEntry(e, attrs))]);
  await fsp.mkdir(CACHE, { recursive: true });
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === text) return;
    await fsp.copyFile(file, path.join(CACHE, `${key}.previous.json`));
  }
  await fsp.writeFile(file + '.tmp', text);
  await fsp.rename(file + '.tmp', file);
}

/** check the list sent by the page; returns an error message or null */
function validate(items, photoSet, sections, others) {
  if (!Array.isArray(items)) return 'expected a list of items';
  const files = new Set(items.map((e) => e && e.file));
  if (files.size !== items.length) return 'a photo is listed twice';
  const missing = [...photoSet].filter((f) => !files.has(f));
  if (missing.length) return `the list is out of date (missing ${missing.slice(0, 3).join(', ')}); reload the page`;
  const seen = new Map();
  for (const e of items) {
    if (!e || !photoSet.has(e.file)) return `unknown photo: ${e && e.file}; reload the page`;
    const slug = slugify(e.name || '');
    if (!slug) return `${e.file} has no name`;
    if (sections.has(slug)) return `"${e.name}" is the name of a section of the site`;
    if (others.has(slug)) return `"${e.name}" is already the name of a piece in another collection`;
    if (seen.has(slug)) return `"${e.name}" is used twice (${seen.get(slug)} and ${e.file})`;
    seen.set(slug, e.file);
  }
  return null;
}

// ---------------------------------------------------------------- thumbnails
async function thumb(key, name, w) {
  const abs = path.join(photosDir(key), path.basename(name));
  if (!IMG_EXT.test(abs) || !fs.existsSync(abs)) return null;
  const st = fs.statSync(abs);
  const out = path.join(CACHE, 'thumbs', `${crypto.createHash('sha1').update(`${key}/${name}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 12)}-${w}.webp`);
  if (!fs.existsSync(out)) {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    // keepIccProfile: a Display P3 photo keeps its colours (sharp would convert it to sRGB)
    const buf = await sharp(abs, { failOn: 'none' }).rotate().resize(w, w, { fit: 'cover' }).keepIccProfile().webp({ quality: 80 }).toBuffer();
    await fsp.writeFile(out + '.tmp', buf);
    await fsp.rename(out + '.tmp', out);
  }
  return out;
}

// ---------------------------------------------------------------- build
let building = false;
function runBuild(res) {
  if (building) { res.writeHead(409); return res.end('a build is already running'); }
  building = true;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const args = [path.join(ROOT, 'build.mjs')];
  if (argVal('--sources')) args.push(`--sources=${SRC}`);
  const p = spawn(process.execPath, args, { cwd: ROOT });
  p.stdout.pipe(res, { end: false });
  p.stderr.pipe(res, { end: false });
  p.on('close', (code) => { building = false; res.end(`\n[${code === 0 ? 'ok' : 'failed, exit code ' + code}]\n`); });
  p.on('error', (e) => { building = false; res.end(`\n[failed: ${e.message}]\n`); });
}

// ---------------------------------------------------------------- http
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

function sendFile(res, abs, cache = 'no-cache') {
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(abs).pipe(res);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** a file below base, or null when the path tries to leave it */
function inside(base, p) {
  const abs = path.join(base, p);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 5e6) throw new Error('request too large'); }
  return JSON.parse(s || '{}');
}

const themeCss = () => ':root{' + Object.entries(cfg.theme).map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${v}`).join(';') + '}';

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);
  // only this page may change things: a web page elsewhere must not be able to post to localhost
  if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); return res.end('forbidden'); }

  // every /api/ call is about one collection: ?c=beanies (the first collection when it is left out)
  const key = url.searchParams.get('c') || KEYS[0];
  if (p.startsWith('/api/') && p !== '/api/build' && !KEYS.includes(key)) return sendJson(res, 400, { error: `unknown collection: ${key}` });

  if (req.method === 'GET' && p === '/api/state') {
    const s = await load(key);
    return sendJson(res, 200, {
      key, collections: KEYS, files: collectionFiles(key),
      attrs: s.attrs, items: s.items, cities,
      palette: PALETTE.map((p) => ({ name: p.name, hex: p.hex })), multiLabel: cfg.colors?.multiLabel || 'multicolour',
      taken: [...sectionSlugs(), ...otherNames(key), ...s.orphans.map((e) => slugify(e.name || '')).filter(Boolean)],
      currency: cfg.shop.currency, locale: cfg.shop.locale,
    });
  }
  if (req.method === 'PUT' && p === '/api/collection') {
    const body = await readBody(req);
    const attrs = readAttributes(SRC, key);
    const { orphans } = mergeCollection(readCollection(SRC, key), photos(key), attrs);
    const orphanSlugs = orphans.map((e) => slugify(e.name || '')).filter(Boolean);
    const err = validate(body.items, new Set(photos(key)), new Set([...sectionSlugs(), ...orphanSlugs]), new Set(otherNames(key)));
    if (err) return sendJson(res, 400, { error: err });
    const items = body.items.map((e) => {
      const { color, multi, hex, colorByHand, ...rest } = e;
      return { ...normalizeEntry(rest, attrs), ...cleanColor(e) };
    });
    await save(key, items, orphans, attrs);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/detect') {
    // measure one photo again; the page decides what to do with the result
    const { file } = await readBody(req);
    if (!photos(key).includes(file)) return sendJson(res, 400, { error: `unknown photo: ${file}` });
    const r = await analyseColor(path.join(photosDir(key), file), PALETTE, analysis(key));
    return sendJson(res, 200, { color: r.color, multi: r.multi, hex: r.hex });
  }
  if (req.method === 'POST' && p === '/api/detect-all') {
    // measure every photo again, except the ones whose colour was set by hand
    const s = await load(key);
    await detectColors(key, s.items.filter((e) => !e.colorByHand));
    await save(key, s.items, s.orphans, s.attrs);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/build') return runBuild(res);

  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  // /thumb/<collection>/<file>
  const t = /^\/thumb\/([^/]+)\/(.+)$/.exec(p);
  if (t) {
    if (!KEYS.includes(t[1])) { res.writeHead(404); return res.end('not found'); }
    const w = THUMB_WIDTHS.includes(Number(url.searchParams.get('w'))) ? Number(url.searchParams.get('w')) : THUMB_WIDTHS[0];
    return sendFile(res, await thumb(t[1], t[2], w), 'max-age=31536000');
  }
  if (p === '/theme.css') { res.writeHead(200, { 'Content-Type': TYPES['.css'] }); return res.end(themeCss()); }
  if (p === '/sortable.js') return sendFile(res, path.join(ROOT, 'node_modules', 'sortablejs', 'Sortable.min.js'));
  if (p === '/site') { res.writeHead(302, { Location: '/site/' }); return res.end(); }
  if (p.startsWith('/site/')) return sendFile(res, inside(OUT, p.slice(6) || 'index.html'));
  if (p === '/') return sendFile(res, path.join(UI, 'index.html'));
  return sendFile(res, inside(UI, p.slice(1)));
}

if (!fs.existsSync(SRC)) { console.error(`sources folder not found: ${SRC}`); process.exit(1); }
if (!KEYS.length) { console.error('config.json has no "collections"'); process.exit(1); }
try { for (const k of KEYS) await load(k); } catch (e) { console.error('\n' + e.message); process.exit(1); }

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message }); else res.end();
  });
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Backoffice for ${SRC} (${KEYS.join(', ')})\n  -> ${url}   (Ctrl+C to stop)`);
  if (!argv.includes('--no-open') && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
