#!/usr/bin/env node
// Uri Eugenio webshop — static site generator
//
//   node build.mjs            build / update dist/ (only changed objects are regenerated)
//   node build.mjs --clean    throw away dist/ and the cache, then build from scratch
//   node build.mjs --serve    build, then serve dist/ on http://localhost:8080
//   node build.mjs --serve --lan   the same, and on the local network for a phone (the addresses are printed)
//   node build.mjs --publish  build, then upload the changed objects to the Cloudflare Worker (wrangler.jsonc)
//   options: --sources=<folder>  --out=<folder>   (override config.json)
//
// Everything under the sources folder is only READ, never written.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { marked } from 'marked';
import { collectionKeys, collectionFiles, readAttributes, readCollection, mergeCollection, slugify } from './lib/collection.mjs';
import { renderIndex, renderPage } from './lib/html.mjs';
import { shippingCountries, ratesFor, piecesPerParcel } from './lib/shipping.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = new Set(argv);
const argVal = (k) => { const a = argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const SRC = path.resolve(ROOT, argVal('--sources') || cfg.sourcesDir);
const OUT = path.resolve(ROOT, argVal('--out') || cfg.outDir);
const CACHE = path.resolve(ROOT, cfg.cacheDir);
const IMG_EXT = /\.(jpe?g|png|webp|tiff?)$/i;

sharp.cache(false);
sharp.concurrency(0);
const SHARP_OPTS = { limitInputPixels: false, failOn: 'none' };

// ---------------------------------------------------------------- helpers
const sha = (s, n = 10) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
const produced = new Set(); // every file (relative to OUT) that belongs to this build
const stats = { generated: 0, skipped: 0, written: 0, unchanged: 0, removed: 0 };
const t0 = Date.now();

function log(...a) { console.log(...a); }
function rel(p) { return path.relative(OUT, p).split(path.sep).join('/'); }

function guardSources(p) {
  const r = path.relative(SRC, path.resolve(p));
  if (!r.startsWith('..') && !path.isAbsolute(r)) throw new Error(`refusing to write inside sources: ${p}`);
}

async function ensureDir(d) { await fsp.mkdir(d, { recursive: true }); }

/** Write text/binary only when the content differs, so unchanged files keep their timestamp. */
async function writeIfChanged(relPath, data) {
  const abs = path.join(OUT, relPath);
  guardSources(abs);
  produced.add(relPath);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    const cur = await fsp.readFile(abs);
    if (cur.equals(buf)) { stats.unchanged++; return false; }
  } catch {}
  await ensureDir(path.dirname(abs));
  await fsp.writeFile(abs, buf);
  stats.written++;
  return true;
}

/** Generate an image output only when it does not exist yet (names contain a fingerprint). */
async function generateOnce(relPath, makeBuffer) {
  const abs = path.join(OUT, relPath);
  guardSources(abs);
  produced.add(relPath);
  if (fs.existsSync(abs)) { stats.skipped++; return; }
  await ensureDir(path.dirname(abs));
  const buf = await makeBuffer();
  await fsp.writeFile(abs + '.tmp', buf);
  await fsp.rename(abs + '.tmp', abs);
  stats.generated++;
}

/** content fingerprint of a source file; cached by path + size + modified time so files are only hashed once */
function fingerprint(abs, st) {
  const key = `h|${abs}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (!meta[key]) meta[key] = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  return meta[key];
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && IMG_EXT.test(d.name) && !d.name.startsWith('.'))
    .map((d) => {
      const abs = path.join(dir, d.name);
      return { id: d.name.replace(/\.[^.]+$/, ''), name: d.name, abs, fp: fingerprint(abs, fs.statSync(abs)) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

async function loadJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- image metadata cache
let meta = {};
async function imageMeta(f) {
  const key = `m|${f.fp}`;
  if (meta[key]) return meta[key];
  const img = sharp(f.abs, SHARP_OPTS).rotate();
  const m = await img.metadata();
  let w = m.width, h = m.height;
  if (m.orientation && m.orientation >= 5) [w, h] = [h, w];
  const { dominant } = await sharp(f.abs, SHARP_OPTS).rotate().resize(64, 64, { fit: 'fill' }).stats();
  const color = '#' + [dominant.r, dominant.g, dominant.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  meta[key] = { w, h, color };
  return meta[key];
}

// ---------------------------------------------------------------- colour space
// Photos exported from Lightroom in sRGB stay sRGB (no profile in the output, as browsers assume sRGB).
// Photos with a wider profile (Display P3, AdobeRGB, ...) are converted to Display P3 and keep that profile, so
// colours outside sRGB (turquoise!) show on P3 screens such as iPhones and recent Macs; browsers convert them
// for sRGB screens. sharp would otherwise convert every photo to sRGB and clip those colours.
async function isWideGamut(f) {
  const key = `g|${f.fp}`;
  if (meta[key] === undefined) {
    const { icc } = await sharp(f.abs, SHARP_OPTS).metadata();
    meta[key] = !!icc && !/sRGB/i.test(icc.toString('latin1').replace(/\0/g, ''));
  }
  return meta[key];
}
const toP3 = (img, wide) => (wide ? img.withIccProfile('p3') : img);

// ---------------------------------------------------------------- thumb sheets
// Each item gets a stable "slot" on the sheets. Adding or removing photos only
// changes the sheet(s) that contain those slots; all other sheets stay identical
// and are therefore not regenerated or re-uploaded.
async function buildSheets(section, files, opts) {
  const slotsFile = path.join(CACHE, `slots-${section}.json`);
  const old = await loadJson(slotsFile, {});
  const per = opts.tilesPerRow * opts.tilesPerRow;
  const slots = {};
  const used = new Set();
  for (const f of files) if (old[f.id] !== undefined && !used.has(old[f.id])) { slots[f.id] = old[f.id]; used.add(old[f.id]); }
  let next = 0;
  for (const f of files) {
    if (slots[f.id] !== undefined) continue;
    while (used.has(next)) next++;
    slots[f.id] = next; used.add(next);
  }
  await ensureDir(CACHE);
  await fsp.writeFile(slotsFile, JSON.stringify(slots, null, 1));

  const bySheet = new Map();
  for (const f of files) {
    const s = Math.floor(slots[f.id] / per);
    if (!bySheet.has(s)) bySheet.set(s, []);
    bySheet.get(s).push(f);
  }
  const sheetCount = files.length ? Math.max(...bySheet.keys()) + 1 : 0;
  const pad = cfg.thumbs.pad;
  const out = { cols: opts.tilesPerRow, pad, tiers: {} };

  for (const tile of opts.tileSizes) {
    const cell = tile + pad * 2;
    out.tiers[tile] = [];
    for (let s = 0; s < sheetCount; s++) {
      const members = (bySheet.get(s) || []).map((f) => ({ f, p: slots[f.id] % per }));
      if (!members.length) { out.tiers[tile].push(null); continue; }
      const rows = Math.ceil((Math.max(...members.map((m) => m.p)) + 1) / opts.tilesPerRow);
      // a sheet with at least one wide-gamut photo becomes a Display P3 sheet (its sRGB thumbs look the same)
      const p3 = (await Promise.all(members.map((m) => isWideGamut(m.f)))).some(Boolean);
      const sig = sha(JSON.stringify([tile, pad, opts.fit, cfg.thumbs.quality, cfg.thumbs.sharpen, rows,
        members.map((m) => [m.p, m.f.id, m.f.fp]).sort((a, b) => a[0] - b[0])].concat(p3 ? ['p3'] : [])), 8);
      const file = `thumbs/${section}-${tile}-${String(s).padStart(3, '0')}-${sig}.webp`;
      out.tiers[tile].push({ url: file, rows });
      await generateOnce(file, async () => {
        const comps = [];
        await pool(members, 4, async (m) => {
          let img = sharp(m.f.abs, SHARP_OPTS).rotate().resize(tile, tile, { fit: opts.fit, position: 'centre' });
          if (cfg.thumbs.sharpen) img = img.sharpen({ sigma: 0.55 });
          img = img.extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'copy' });
          const at = { left: (m.p % opts.tilesPerRow) * cell, top: Math.floor(m.p / opts.tilesPerRow) * cell };
          if (!p3) { comps.push({ input: await img.toBuffer(), ...at }); return; }
          // P3 sheet: every thumb as raw Display P3 values, pasted on a P3 canvas whose profile is kept, so the
          // values are not converted a second time
          const { data, info } = await img.withIccProfile('p3').raw().toBuffer({ resolveWithObject: true });
          comps.push({ input: data, raw: info, ...at });
        });
        const canvas = sharp({ create: { width: opts.tilesPerRow * cell, height: rows * cell, channels: 3, background: cfg.theme.bg } });
        const base = p3 ? sharp(await canvas.withIccProfile('p3').png().toBuffer()) : canvas;
        const sheet = base.composite(comps);
        return (p3 ? sheet.keepIccProfile() : sheet).webp({ quality: cfg.thumbs.quality, effort: 5, smartSubsample: true }).toBuffer();
      });
    }
  }
  return { sheets: out, slots, per };
}

// ---------------------------------------------------------------- detail images
// crop (optional): { aspect, position } cuts the picture to that aspect ratio first, e.g. a portrait
// photo to 3:2 landscape, keeping the most interesting part ("attention") or a fixed position ("centre", "top" …)
async function buildDetail(section, f, m, sizes = cfg.detail.widths, quality = cfg.detail.quality, crop = null) {
  const aspect = crop ? crop.aspect : m.w / m.h;
  const fullW = crop ? Math.min(m.w, Math.round(m.h * aspect)) : m.w;
  const widths = [...new Set(sizes.filter((w) => w < fullW).concat([Math.min(fullW, Math.max(...sizes))]))]
    .sort((a, b) => a - b);
  const res = [];
  const key = crop ? `${aspect.toFixed(4)}${crop.position}` : '';
  const wide = await isWideGamut(f);
  for (const w of widths) {
    const h = Math.round(w / aspect);
    const file = `img/${section}/${section === 'content' ? slugOf(f.id) : f.id}-${w}-${sha(f.fp + quality + key, 6)}.webp`;
    await generateOnce(file, () => toP3(sharp(f.abs, SHARP_OPTS).rotate()
      .resize(w, h, crop ? { fit: 'cover', position: crop.position } : {}), wide).webp({ quality, effort: 5 }).toBuffer());
    res.push({ w, h, src: file });
  }
  return res;
}

// ---------------------------------------------------------------- splash
// A splash "slide" is a group of masters of the same picture with different widths, e.g.
//   splash-master.jpg (3:2)  splash-master-wide.jpg (16:9)  splash-master-superwide.jpg (32:9)
// All masters of a group have the same height and the figure in the centre at the same scale.
// For every target aspect (32:9 … 9:16) the narrowest master that is at least that wide is
// cropped left/right only (full height kept), then rendered at each frame scale
// (7680x2160, 3840x1080, 1920x540 by default). The browser picks the narrowest aspect that is
// still at least as wide as the window, so the image is always scaled to the window height
// and only the sides are cut off — never the top or bottom.
const SPLASH_SUFFIX = /-(wide|superwide|ultrawide)$/i;

function parseAspect(s) {
  const [w, h] = String(s).split(/[:x/]/).map(Number);
  return { name: `${w}x${h}`, a: w / h };
}

async function buildSplash() {
  const sc = cfg.splash;
  const dir = path.join(SRC, sc.folder);
  const groups = new Map();
  for (const f of listImages(dir)) {
    const base = f.id.replace(SPLASH_SUFFIX, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(f);
  }
  const bases = [...groups.keys()].sort((a, b) => (b === 'splash-master') - (a === 'splash-master') || a.localeCompare(b));
  const aspects = sc.aspects.map(parseAspect).sort((x, y) => x.a - y.a);
  const [FW, FH] = sc.frame;
  const slides = [];

  for (const base of bases) {
    const masters = [];
    for (const f of groups.get(base)) masters.push({ f, m: await imageMeta(f) });
    masters.forEach((x) => (x.a = x.m.w / x.m.h));
    masters.sort((x, y) => x.a - y.a);
    log(`  splash ${base}: ${masters.map((x) => `${x.f.name} (${x.m.w}x${x.m.h})`).join(', ')}`);
    const main = masters.find((x) => !SPLASH_SUFFIX.test(x.f.id)) || masters[0];

    const V = [];
    for (const asp of aspects) {
      // narrowest master that is (within 0.5 %) at least as wide as the target aspect
      const src = masters.find((x) => x.a >= asp.a * 0.995) || masters[masters.length - 1];
      const { f, m } = src;
      let cw = Math.min(m.w, Math.round(m.h * asp.a)), ch = m.h;
      if (m.h * asp.a > m.w * 1.005) ch = Math.round(m.w / asp.a); // only when no master is wide enough
      const crop = { left: Math.round((m.w - cw) / 2), top: Math.round((m.h - ch) / 2), width: cw, height: ch };
      const fp = sha(f.fp + sc.quality + JSON.stringify(crop), 6);
      const sizes = [];
      for (const s of sc.frameScales) {
        const h = Math.round(Math.min(FH * s, (FW * s) / asp.a));
        const w = Math.round(h * asp.a);
        if (h > ch && sizes.length) continue; // never upscale (keep at least one size)
        if (sizes.some((x) => x.h === h)) continue;
        const file = `img/splash/${base}-${asp.name}-${h}-${fp}.webp`;
        const wide = await isWideGamut(f);
        await generateOnce(file, () => toP3(sharp(f.abs, SHARP_OPTS).rotate().extract(crop)
          .resize(w, h), wide).webp({ quality: sc.quality, effort: 4 }).toBuffer());
        sizes.push({ w, h, src: file });
      }
      sizes.sort((x, y) => x.h - y.h);
      // tiny blurred placeholder in this aspect, inlined in the html
      const phKey = `ph2|${fp}`;
      if (!meta[phKey]) {
        const b = await sharp(f.abs, SHARP_OPTS).rotate().extract(crop).resize(Math.max(8, Math.round(24 * asp.a)), 24)
          .blur(0.6).webp({ quality: 50 }).toBuffer();
        meta[phKey] = 'data:image/webp;base64,' + b.toString('base64');
      }
      V.push({ n: asp.name, a: +asp.a.toFixed(5), from: f.id, sizes, ph: meta[phKey] });
    }
    slides.push({ id: base, V, color: main.m.color });
  }
  return slides;
}

// ---------------------------------------------------------------- logo
async function buildLogo() {
  const file = path.join(SRC, cfg.logo.file);
  if (!fs.existsSync(file)) { log('  ! no logo found'); return null; }
  let svg = await fsp.readFile(file, 'utf8');
  for (const c of cfg.logo.removeClasses || []) {
    // drop every element that carries this class (Illustrator exports one element per glyph)
    svg = svg.replace(new RegExp(`<(path|polygon|rect|circle|ellipse|polyline|line|text)\\b[^>]*class="${c}"[^>]*?(/>|>[\\s\\S]*?</\\1>)`, 'g'), '');
  }
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  if (cfg.logo.trimToContent) {
    const vb = /viewBox="([\d.\s-]+)"/.exec(svg);
    if (vb) {
      const [vx, vy, vw, vh] = vb[1].trim().split(/\s+/).map(Number);
      const scale = 2;
      const W = Math.round(vw * scale), H = Math.round(vh * scale);
      const sized = svg.replace(/<svg\b/, `<svg width="${W}" height="${H}"`);
      const { info } = await sharp(Buffer.from(sized), { density: 72 }).resize(W, H).png()
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 }).toBuffer({ resolveWithObject: true });
      const left = -(info.trimOffsetLeft || 0), top = -(info.trimOffsetTop || 0);
      const nb = [vx + left / scale, vy + top / scale, info.width / scale, info.height / scale].map((v) => +v.toFixed(2));
      svg = svg.replace(vb[0], `viewBox="${nb.join(' ')}"`);
    }
  }
  const vb = /viewBox="([\d.\s-]+)"/.exec(svg)[1].trim().split(/\s+/).map(Number);
  const name = `assets/logo-${sha(svg, 8)}.svg`;
  await writeIfChanged(name, svg);
  return { src: name, aspect: vb[2] / vb[3] };
}

// ---------------------------------------------------------------- collection / gallery
async function buildSection(section, files, opts, catalog = null) {
  log(`  ${section}: ${files.length} images`);
  const metas = [];
  await pool(files, 4, async (f, i) => { metas[i] = await imageMeta(f); });
  const { sheets, slots, per } = await buildSheets(section, files, opts);
  const items = [];
  await pool(files, 3, async (f, i) => {
    const m = metas[i];
    const detail = await buildDetail(section, f, m);
    const it = { id: f.id, w: m.w, h: m.h, c: m.color, s: Math.floor(slots[f.id] / per), p: slots[f.id] % per, d: detail };
    if (catalog) Object.assign(it, catalog.get(f.name));
    items[i] = it;
  });
  return { items, sheets };
}

// sources/<key>.json (written by the backoffice) sets the order, the name and the attributes of every photo of
// the collection. Photos it does not know yet are added at the end with the default attributes.
// usedSlugs is shared by all collections: a name is the link to its piece, so it must be unique on the whole site.
function loadCollection(key, files, usedSlugs) {
  const F = collectionFiles(key);
  const attrs = readAttributes(SRC, key);
  if (!attrs.length) log(`  ! ${F.attributes} not found or empty — ${key} have no price`);
  const { items, added, orphans } = mergeCollection(readCollection(SRC, key), files.map((f) => f.name), attrs);
  if (added.length) log(`  ! ${added.length} new photo(s) in ${F.photos} have no name yet; open the backoffice to give them one`);
  if (orphans.length) log(`  ${orphans.length} entr${orphans.length > 1 ? 'ies' : 'y'} in ${F.data} without a photo (ignored)`);
  const noColor = items.filter((e) => !e.hex).length; // not measured (a multicoloured piece may have no main colour)
  if (noColor) log(`  ! ${noColor} piece(s) in ${F.photos} have no colour yet; open the backoffice to measure them`);
  const byName = new Map(files.map((f) => [f.name, f]));
  const sorted = items.map((e) => byName.get(e.file));
  const catalog = new Map();
  for (const e of items) {
    const { file, name, hex, colorByHand, ...values } = e; // hex and colorByHand are for the backoffice only
    const id = byName.get(file).id;
    let slug = slugify(name) || slugify(id);
    if (usedSlugs.has(slug)) { log(`  ! the name "${name}" is used twice; ${file} gets #${slug}-${id}`); slug += '-' + slugify(id); }
    usedSlugs.add(slug);
    catalog.set(file, { name: name || id, slug, ...values });
  }
  // the pulldowns of the site's filter bar (config.json collections.<key>.filters), each with every value of
  // the attributes file
  const filters = (cfg.collections[key].filters || []).map((k) => attrs.find((a) => a.key === k)).filter(Boolean)
    .map((a) => ({ key: a.key, label: a.label, values: a.values }));
  return { files: sorted, catalog, filters, attrs: attrs.filter((a) => a.key !== 'price').map((a) => ({ key: a.key, label: a.label })) };
}

// ---------------------------------------------------------------- static assets
async function copyHashed(srcAbs, destDir, baseName) {
  const buf = await fsp.readFile(srcAbs);
  const ext = path.extname(srcAbs);
  const name = `${destDir}/${baseName}-${sha(buf, 8)}${ext}`;
  await writeIfChanged(name, buf);
  return name;
}

// ---------------------------------------------------------------- content sections
// sources/content/site.md holds the whole page below the splash:
//   - every "# Title" line starts a section: its heading, its menu entry and its link (#title, e.g. #my-story)
//   - text before the first "# Title" is the intro banner: no heading, not in the menu
//   - ![description](picture.jpg) places a picture from sources/content/images, converted to webp in several
//     widths; full column width, portrait and square pictures are cropped to landscape
//   - a line with only {{beanies}}, {{scarves}} or {{gallery}} places that grid (a collection with its filters)
// To reorder, add or remove sections: move, add or delete the text in site.md.
const GRIDS = [...collectionKeys(cfg), 'gallery'];
const GRID_TAG = /^\{\{\s*([A-Za-z]+)\s*\}\}$/;

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const capFirst = (s) => s.replace(/^(\s*)(\p{Ll})/u, (_, sp, c) => sp + c.toUpperCase());
const marker = (s) => ({ type: 'html', block: true, pre: false, raw: `<!--${s}-->\n`, text: `<!--${s}-->\n` });

async function buildContent() {
  const c = cfg.content || {};
  const dir = path.join(SRC, c.folder || 'content');
  const file = path.join(dir, c.file || 'site.md');
  if (!fs.existsSync(file)) { log(`  ! ${file} not found: the page has no sections`); return []; }
  const imgDir = path.join(dir, c.images || 'images');
  const pictures = new Map(listImages(imgDir).map((f) => [f.name.toLowerCase(), f]));
  const usedPictures = new Set();

  // split at the "# Title" lines (with marked's lexer, so a "#" inside a code block does not count)
  const tokens = marked.lexer((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
  const parts = [{ title: null, tokens: [] }];
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 1) parts.push({ title: capFirst(t.text.trim()), tokens: [] });
    else parts[parts.length - 1].tokens.push(t);
  }

  const sections = [];
  const usedIds = new Set();
  for (const [n, p] of parts.entries()) {
    if (!p.title && !p.tokens.some((t) => t.type !== 'space')) continue; // no intro text
    const base = p.title ? slugOf(p.title) || `section-${n}` : 'intro';
    let id = base;
    for (let k = 2; usedIds.has(id); k++) id = `${base}-${k}`;
    if (id !== base) log(`  ! two sections are called "${p.title}"; the second one links as #${id}`);
    usedIds.add(id);

    // grids: a paragraph that is only {{name}}
    const grids = [];
    const body = [];
    for (const t of p.tokens) {
      const g = t.type === 'paragraph' && GRID_TAG.exec(t.text.trim());
      if (!g) { body.push(t); continue; }
      const name = g[1].toLowerCase();
      if (!GRIDS.includes(name)) { log(`  ! ${id}: unknown grid {{${g[1]}}} (there are: ${GRIDS.map((x) => `{{${x}}}`).join(' ')})`); continue; }
      grids.push(name);
      body.push(marker(`grid:${name}`));
    }

    // pictures: every ![description](file) with a file in the images folder (links to other sites stay as they are)
    const found = [];
    const walk = (list) => { for (const t of list || []) { if (t.type === 'image') found.push(t); walk(t.tokens); if (t.items) for (const it of t.items) walk(it.tokens); } };
    walk(body);
    const images = [];
    for (const t of found) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(t.href)) continue;
      const name = decodeURIComponent(t.href).split(/[\\/]/).pop();
      const f = pictures.get(name.toLowerCase());
      if (!f) {
        log(`  ! ${id}: picture "${name}" not found in ${path.relative(SRC, imgDir)}`);
        Object.assign(t, { type: 'html', block: false, text: '' });
        continue;
      }
      usedPictures.add(f.name);
      const m = await imageMeta(f);
      const crop = m.w / m.h < (c.landscapeMinAspect || 1.1) ? { aspect: c.cropAspect || 1.5, position: c.cropPosition || 'north' } : null;
      const d = await buildDetail('content', f, m, c.imageWidths || [480, 820, 1240, 1640], c.imageQuality || cfg.detail.quality, crop);
      const top = d[d.length - 1];
      images.push({ name: f.name, alt: t.text, w: top.w, h: top.h, color: m.color, cropped: !!crop, d });
      Object.assign(t, { type: 'html', block: false, text: `<!--image:${images.length - 1}-->` });
    }

    body.links = tokens.links; // reference-style links ([text][ref]) defined anywhere in the file
    const html = marked.parser(body);
    sections.push({ id, title: p.title, html, images, grids });
    log(`  ${id}${p.title ? ` "${p.title}"` : ' (intro, no title)'}` +
      images.map((im) => ` + ${im.name}${im.cropped ? ' (cropped to landscape)' : ''}`).join('') +
      grids.map((g) => ` + {{${g}}}`).join(''));
  }
  // pictures that are not used anywhere are probably a typo in site.md; say so
  for (const f of pictures.values()) if (!usedPictures.has(f.name)) log(`  ! ${f.name} is not used in ${path.basename(file)}`);
  return sections;
}

// ---------------------------------------------------------------- shop: shipping, the catalog the Worker sells from
// shipping.json (code folder) holds the PostNL rates; the countries offered are worked out here.
function loadShipping() {
  const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'shipping.json'), 'utf8'));
  delete T._about;
  T.countries = shippingCountries(T);
  if (!T.countries.includes('NL')) log('  ! shipping.json has no rate for NL: the Netherlands is not offered at checkout');
  log(`  shipping to ${T.countries.length} countries`);
  return T;
}

// dist/catalog.json: what the Worker sells, read by it after every deploy. Prices come from here, never from the browser.
async function writeCatalog(collections, items, shipping) {
  const pieces = {};
  for (const [key, list] of Object.entries(items)) {
    for (const it of list) {
      if (it.price == null) continue;
      pieces[it.id] = { name: it.name || it.id, price: it.price, collection: key, image: it.d[0].src,
        desc: collections[key].attrs.map((a) => it[a.key]).filter(Boolean).join(' · ') };
    }
  }
  const shop = { currency: cfg.shop.currency, reserveMinutes: cfg.shop.reserveMinutes || 30, stripeTax: !!cfg.shop.stripeTax };
  await writeIfChanged('catalog.json', JSON.stringify({ shop, shipping, items: pieces }));
}

// ---------------------------------------------------------------- legal pages (shipping, returns, terms, privacy)
// The text is code\legal\<page>.md, unless sources\content\legal\<page>.md exists: then that one is used.
// {{name}} in the text is filled in from config.json (site.business, site.contact, shop) and shipping.json.
const LEGAL = ['shipping', 'returns', 'terms', 'privacy'];

function shippingTable(T) {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const eur = (n) => new Intl.NumberFormat(cfg.shop.locale, { style: 'currency', currency: cfg.shop.currency }).format(n);
  const per = piecesPerParcel(T);
  const bandOf = (n) => T.bands.findIndex((max) => n * T.gramsPerPiece <= max);
  const own = T.countries.filter((c) => T.rates[T.aliases[c] || c]);
  const rows = own.map((c) => ({ c, name: names.of(c), r: ratesFor(T, c) })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const europe = T.countries.filter((c) => !own.includes(c) && T.europe.includes(c)).map((c) => names.of(c)).sort();
  const row = (name, r, note = '') => `<tr><td>${name}${note}</td><td>${eur(r[bandOf(1)])}</td><td>${eur(r[bandOf(per)])}</td></tr>`;
  const note = (c) => (T.surcharge[c] ? ` <small>+ ${T.surcharge[c].percentOfGoods} % of the order value for import duties and fees</small>` : '');
  return `<table class="ship-table">
<thead><tr><th>destination</th><th>1 piece</th><th>2–${per} pieces</th></tr></thead>
<tbody>
${rows.map((x) => row(x.name, x.r, note(x.c))).join('\n')}
${row(`other countries in Europe <small>(${europe.join(', ')})</small>`, T.rates.otherEurope)}
${row('all other countries', T.rates.otherWorld)}
</tbody>
</table>`;
}

async function buildLegal(css, fonts, shipping) {
  const b = cfg.site.business || {};
  const missing = ['name', 'kvk', 'address'].filter((k) => !b[k] || !String(b[k]).trim());
  if (missing.length) log(`  ! config.json site.business has no ${missing.join(', ')}: the legal pages show [${missing.join('], [')}]`);
  const T = shipping;
  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  const fill = {
    business: b.name || '[name]',
    address: (b.address || ['[address]']).join(', '),
    kvk: b.kvk || '[kvk]',
    email: cfg.site.contact.email,
    site: cfg.site.url,
    shipWithin: b.shipWithin || '3 working days',
    reserveMinutes: cfg.shop.reserveMinutes || 30,
    perParcel: piecesPerParcel(T),
    vat: cfg.shop.stripeTax
      ? 'All prices include VAT. The VAT is calculated at checkout for the country the order is delivered to.'
      : 'Under the Dutch small business scheme (kleineondernemersregeling, KOR) we do not charge VAT; the prices are final.',
    notShipped: T.exclude.map((c) => regions.of(c)).join(' and ') || 'none',
    shippingTable: shippingTable(T),
  };
  const pages = LEGAL.map((key) => {
    const own = path.join(SRC, cfg.content?.folder || 'content', 'legal', `${key}.md`);
    return { key, file: fs.existsSync(own) ? own : path.join(ROOT, 'legal', `${key}.md`) };
  }).filter((p) => fs.existsSync(p.file));
  for (const p of pages) {
    const md = (await fsp.readFile(p.file, 'utf8')).replace(/^﻿/, '')
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in fill ? fill[k] : (log(`  ! ${p.key}.md: unknown {{${k}}}`), m)));
    const title = (md.match(/^#\s+(.+)$/m) || [null, p.key])[1].trim();
    await writeIfChanged(`${p.key}/index.html`, renderPage({ cfg, css, fonts, title, body: marked.parse(md), legal: pages }));
    log(`  ${p.key}/ "${title}"${p.file.startsWith(SRC) ? ' (from sources)' : ''}`);
  }
  return pages;
}

// ---------------------------------------------------------------- cleanup + report
async function walk(dir, base = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) await walk(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc;
}

async function cleanupAndManifest() {
  const all = await walk(OUT);
  for (const f of all) {
    if (!produced.has(f)) { await fsp.rm(path.join(OUT, f)); stats.removed++; }
  }
  // remove empty folders (deepest first, so a folder emptied by removing its subfolders goes too)
  const dirs = [];
  const listDirs = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) if (e.isDirectory()) { await listDirs(path.join(d, e.name)); dirs.push(path.join(d, e.name)); }
  };
  await listDirs(OUT);
  for (const p of dirs) {
    try { if (!(await fsp.readdir(p)).length) await fsp.rmdir(p); } catch {}
  }
  // manifest of the published objects; phase 2 uses the difference to know what to upload
  const manPath = path.join(CACHE, 'dist-manifest.json');
  const prev = await loadJson(manPath, {});
  const now = {};
  for (const f of [...produced].sort()) {
    const abs = path.join(OUT, f);
    const st = fs.statSync(abs);
    const key = `${st.size}-${Math.round(st.mtimeMs)}`;
    now[f] = prev[f] && prev[f].key === key ? prev[f] : { key, sha: sha(await fsp.readFile(abs), 40) };
  }
  const changed = Object.keys(now).filter((f) => !prev[f] || prev[f].sha !== now[f].sha);
  const deleted = Object.keys(prev).filter((f) => !now[f]);
  await fsp.writeFile(manPath, JSON.stringify(now, null, 1));
  return { changed, deleted, total: Object.keys(now).length };
}

// ---------------------------------------------------------------- serve (handy alternative to file://)
// lan: also reachable from other devices on the local network (a phone on the same wifi)
function serve(port = 8080, lan = false) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const abs = path.join(OUT, p);
    if (!abs.startsWith(OUT) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(abs)] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  }).listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
    log(`\nServing ${OUT}\n  -> http://localhost:${port}/   (Ctrl+C to stop)`);
    if (!lan) return;
    // the private (DHCP/NAT) addresses of this computer: open one of these on a phone on the same network
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
      .map((a) => a.address);
    if (!ips.length) log('  ! no local network address found: is this computer connected to a network?');
    for (const ip of ips) log(`  -> http://${ip}:${port}/   (from a phone or tablet on the same network)`);
  });
}

// ---------------------------------------------------------------- main
async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`sources folder not found: ${SRC}`);
  if (args.has('--clean')) {
    log('Cleaning dist and cache…');
    await fsp.rm(OUT, { recursive: true, force: true });
    await fsp.rm(CACHE, { recursive: true, force: true });
  }
  await ensureDir(OUT); await ensureDir(CACHE);
  meta = await loadJson(path.join(CACHE, 'meta.json'), {});
  log(`Sources: ${SRC}\nOutput:  ${OUT}\n`);

  log('Logo');
  const logo = await buildLogo();
  log('Splash');
  const splash = await buildSplash();
  log('Sections');
  // every collection (beanies, scarves, …) the same way: its photos, its data file and its attributes
  const usedSlugs = new Set();
  const collections = {}, items = {}, sheets = {};
  const owner = new Map(); // photo id -> collection: the cart and the inventory know a piece by its id alone
  for (const key of collectionKeys(cfg)) {
    const files = listImages(path.join(SRC, collectionFiles(key).photos));
    for (const f of files) {
      if (owner.has(f.id)) throw new Error(`${f.name} is both in ${owner.get(f.id)} and in ${key}: every photo needs its own file name`);
      owner.set(f.id, key);
    }
    const coll = loadCollection(key, files, usedSlugs);
    const built = await buildSection(key, coll.files, cfg.thumbs.collection, coll.catalog);
    collections[key] = { attrs: coll.attrs, filters: coll.filters };
    items[key] = built.items;
    sheets[key] = built.sheets;
  }
  const gallery = await buildSection('gallery', listImages(path.join(SRC, 'gallery')), cfg.thumbs.gallery);
  // the whole palette, in palette order, for the colour filter (each filter bar shows only the colours its pieces have)
  const colors = {
    palette: (cfg.colors?.palette || []).map((p) => ({ name: p.name, hex: p.hex })),
    multiLabel: cfg.colors?.multiLabel || 'multicolour',
  };
  log('Content');
  const sections = await buildContent();
  await fsp.writeFile(path.join(CACHE, 'meta.json'), JSON.stringify(meta));

  log('Pages');
  const fonts = {};
  for (const f of fs.readdirSync(path.join(ROOT, 'assets', 'fonts'))) {
    fonts[f.replace(/\.[^.]+$/, '')] = await copyHashed(path.join(ROOT, 'assets', 'fonts', f), 'fonts', f.replace(/\.[^.]+$/, ''));
  }
  const css = await copyHashed(path.join(ROOT, 'site', 'site.css'), 'assets', 'site');
  const js = await copyHashed(path.join(ROOT, 'site', 'app.js'), 'assets', 'app');

  log('Shop');
  const shipping = loadShipping();
  await writeCatalog(collections, items, shipping);
  const legal = await buildLegal(css, fonts, shipping);

  const publicCfg = {
    layout: cfg.layout, thumbs: { lazyMargin: cfg.thumbs.lazyMargin }, splash: { slideSeconds: cfg.splash.slideSeconds, fadeSeconds: cfg.splash.fadeSeconds },
    animation: cfg.animation, shop: cfg.shop, theme: cfg.theme,
  };
  // the items of a collection are under its key (SITE.beanies, SITE.scarves), like SITE.gallery
  const data = { config: publicCfg, splash, colors, collections, ...items, gallery: gallery.items,
    sheets: { ...sheets, gallery: gallery.sheets }, shipping, legal: legal.map((p) => p.key) };
  const dataJs = `window.SITE=${JSON.stringify(data)};\n`;
  const dataName = `data/site-${sha(dataJs, 8)}.js`;
  await writeIfChanged(dataName, dataJs);

  const html = renderIndex({ cfg, logo, css, js, dataName, fonts, sections, splash, legal });
  await writeIfChanged('index.html', html);
  await writeIfChanged('_headers', [
    '/assets/*', '  Cache-Control: public, max-age=31536000, immutable',
    '/thumbs/*', '  Cache-Control: public, max-age=31536000, immutable',
    '/img/*', '  Cache-Control: public, max-age=31536000, immutable',
    '/fonts/*', '  Cache-Control: public, max-age=31536000, immutable',
    '/data/*', '  Cache-Control: public, max-age=31536000, immutable', '',
  ].join('\n'));

  const man = await cleanupAndManifest();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\nDone in ${secs}s — images generated ${stats.generated}, reused ${stats.skipped}; ` +
      `files written ${stats.written}, unchanged ${stats.unchanged}; stale removed ${stats.removed}.`);
  log(`Site objects: ${man.total} total, ${man.changed.length} new/changed, ${man.deleted.length} deleted since last run.`);
  if (man.changed.length && man.changed.length <= 15) man.changed.forEach((f) => log(`  + ${f}`));
  log(`\nOpen: ${path.join(OUT, 'index.html')}`);

  if (args.has('--publish')) await publish();
  if (args.has('--serve')) serve(Number(argVal('--port')) || 8080, args.has('--lan'));
}

// ---------------------------------------------------------------- publish (phase 2)
// Uploads dist to the Cloudflare Worker in wrangler.jsonc. Wrangler compares a hash of every file with what is already
// online and uploads only new and changed files; files no longer in dist disappear from the site.
// Sign-in: "npx wrangler login" once (stored in your Windows profile), or CLOUDFLARE_API_TOKEN in code\.env.
async function publish() {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(wrangler)) throw new Error('wrangler is not installed: run "npm install" in the code folder');
  const deployArgs = [wrangler, 'deploy'];
  // wrangler.jsonc publishes ../build/dist; follow --out= when it points elsewhere
  if (OUT !== path.resolve(ROOT, cfg.outDir)) deployArgs.push('--assets', OUT);
  log('\nPublishing to Cloudflare…');
  const code = await new Promise((resolve) => {
    spawn(process.execPath, deployArgs, { cwd: ROOT, stdio: 'inherit' }).on('close', resolve);
  });
  if (code !== 0) throw new Error(`publishing failed (wrangler exited with ${code}); see its message above`);
}

main().catch((e) => { console.error('\nBUILD FAILED:', e.stack || e); process.exit(1); });
