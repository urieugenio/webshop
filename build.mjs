#!/usr/bin/env node
// Uri Eugenio webshop — static site generator (phase 1)
//
//   node build.mjs            build / update dist/ (only changed objects are regenerated)
//   node build.mjs --clean    throw away dist/ and the cache, then build from scratch
//   node build.mjs --serve    build, then serve dist/ on http://localhost:8080
//   node build.mjs --publish  (phase 2) build and push changed objects to Cloudflare Pages
//   options: --sources=<folder>  --out=<folder>   (override config.json)
//
// Everything under the sources folder is only READ, never written.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { marked } from 'marked';
import { readAttributes, readCollection, mergeCollection, slugify } from './lib/collection.mjs';
import { renderIndex } from './lib/html.mjs';

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
      const sig = sha(JSON.stringify([tile, pad, opts.fit, cfg.thumbs.quality, cfg.thumbs.sharpen, rows,
        members.map((m) => [m.p, m.f.id, m.f.fp]).sort((a, b) => a[0] - b[0])]), 8);
      const file = `thumbs/${section}-${tile}-${String(s).padStart(3, '0')}-${sig}.webp`;
      out.tiers[tile].push({ url: file, rows });
      await generateOnce(file, async () => {
        const comps = [];
        await pool(members, 4, async (m) => {
          let img = sharp(m.f.abs, SHARP_OPTS).rotate().resize(tile, tile, { fit: opts.fit, position: 'centre' });
          if (cfg.thumbs.sharpen) img = img.sharpen({ sigma: 0.55 });
          const buf = await img.extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'copy' }).toBuffer();
          comps.push({ input: buf, left: (m.p % opts.tilesPerRow) * cell, top: Math.floor(m.p / opts.tilesPerRow) * cell });
        });
        return sharp({ create: { width: opts.tilesPerRow * cell, height: rows * cell, channels: 3, background: cfg.theme.bg } })
          .composite(comps).webp({ quality: cfg.thumbs.quality, effort: 5, smartSubsample: true }).toBuffer();
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
  for (const w of widths) {
    const h = Math.round(w / aspect);
    const file = `img/${section}/${section === 'content' ? slugOf(f.id) : f.id}-${w}-${sha(f.fp + quality + key, 6)}.webp`;
    await generateOnce(file, () => sharp(f.abs, SHARP_OPTS).rotate()
      .resize(w, h, crop ? { fit: 'cover', position: crop.position } : {}).webp({ quality, effort: 5 }).toBuffer());
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
        await generateOnce(file, () => sharp(f.abs, SHARP_OPTS).rotate().extract(crop)
          .resize(w, h).webp({ quality: sc.quality, effort: 4 }).toBuffer());
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

// sources/collection.json (written by the backoffice) sets the order, the name and the attributes of
// every collection photo. Photos it does not know yet are added at the end with the default attributes.
function loadCollection(files) {
  const attrs = readAttributes(SRC);
  if (!attrs.length) log('  ! attributes.txt not found or empty — products have no price');
  const { items, added, orphans } = mergeCollection(readCollection(SRC), files.map((f) => f.name), attrs);
  if (added.length) log(`  ! ${added.length} new photo(s) have no name yet; open the backoffice to give them one`);
  if (orphans.length) log(`  ${orphans.length} entr${orphans.length > 1 ? 'ies' : 'y'} in collection.json without a photo (ignored)`);
  const noColor = items.filter((e) => !e.color).length;
  if (noColor) log(`  ! ${noColor} piece(s) have no colour yet; open the backoffice to measure them`);
  const byName = new Map(files.map((f) => [f.name, f]));
  const sorted = items.map((e) => byName.get(e.file));
  const usedSlugs = new Set();
  const catalog = new Map();
  for (const e of items) {
    const { file, name, hex, colorByHand, ...values } = e; // hex and colorByHand are for the backoffice only
    const id = byName.get(file).id;
    let slug = slugify(name) || slugify(id);
    if (usedSlugs.has(slug)) { log(`  ! the name "${name}" is used twice; ${file} gets #${slug}-${id}`); slug += '-' + slugify(id); }
    usedSlugs.add(slug);
    catalog.set(file, { name: name || id, slug, ...values });
  }
  // the whole palette, in palette order, for the colour filter (colours without pieces are shown dimmed)
  const colors = {
    palette: (cfg.colors?.palette || []).map((p) => ({ name: p.name, hex: p.hex })),
    multiLabel: cfg.colors?.multiLabel || 'multicolour',
  };
  return { files: sorted, catalog, colors, attrs: attrs.filter((a) => a.key !== 'price').map((a) => ({ key: a.key, label: a.label, values: a.values })) };
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
// sources/content/<number>_<name>.md, e.g. 3_my_story.md
//   - the number sets the order on the page (not shown); renumber the files to reorder
//   - the first "# Title" line is the section heading and its menu entry; without one the
//     section has no heading and stays out of the menu (used for the intro banner)
//   - "collection" and "gallery" are followed by their thumbnail grid
//   - one optional image per section: any file whose name ENDS with "-<name>" or "_<name>",
//     e.g. ABCDE-contact.jpg or "Uri Eugenio_contact.png". Converted to webp in several widths.
const CONTENT_MD = /^(\d+)[ ._-]+(.+)\.md$/i;
const GRID_SECTIONS = new Set(['collection', 'gallery']);
const IMG_MARKER = '<!--section-image-->\n';

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const capFirst = (s) => s.replace(/^(\s*)(\p{Ll})/u, (_, sp, c) => sp + c.toUpperCase());

async function buildContent() {
  const dir = path.join(SRC, cfg.content?.folder || 'content');
  if (!fs.existsSync(dir)) { log(`  ! content folder not found: ${dir}`); return []; }
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile());
  const images = listImages(dir);
  const sections = [];

  const mds = entries.map((d) => ({ d, m: CONTENT_MD.exec(d.name) })).filter((x) => x.m)
    .map(({ d, m }) => ({ file: d.name, order: Number(m[1]), name: m[2] }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  // each image belongs to the section whose name its file name ends with ("-", "_" and spaces are
  // interchangeable, case is ignored). The longest name wins, so "x-my_story.jpg" goes to my_story, not story.
  const ids = [...new Set(mds.map((s) => slugOf(s.name)))].sort((a, b) => b.length - a.length);
  const imageOwner = new Map();
  for (const f of images) {
    const n = '-' + slugOf(f.id);
    const owner = ids.find((id) => n.endsWith('-' + id));
    if (owner) imageOwner.set(f.name, owner);
  }

  const usedIds = new Set();
  for (const s of mds) {
    let id = slugOf(s.name) || `section-${s.order}`;
    if (usedIds.has(id)) { log(`  ! two sections are called "${id}" — ${s.file} is skipped`); continue; }
    usedIds.add(id);

    let md = (await fsp.readFile(path.join(dir, s.file), 'utf8')).replace(/^﻿/, '');
    let title = null;
    md = md.replace(/^[ \t]*#[ \t]+(.+?)[ \t#]*$/m, (_, t) => { if (title === null) { title = capFirst(t.trim()); return ''; } return _; });

    const matches = images.filter((f) => imageOwner.get(f.name) === id);
    let image = null;
    if (matches.length) {
      if (matches.length > 1) log(`  ! ${id}: more than one image (${matches.map((f) => f.name).join(', ')}); using ${matches[matches.length - 1].name}`);
      const f = matches[matches.length - 1];
      const m = await imageMeta(f);
      const c = cfg.content || {};
      // full column width, always landscape: portrait and square pictures are cropped to cropAspect
      const minA = c.landscapeMinAspect || 1.1;
      const crop = m.w / m.h < minA ? { aspect: c.cropAspect || 1.5, position: c.cropPosition || 'north' } : null;
      const d = await buildDetail('content', f, m, c.imageWidths || [480, 820, 1240, 1640], c.imageQuality || cfg.detail.quality, crop);
      const top = d[d.length - 1];
      image = { name: f.name, w: top.w, h: top.h, color: m.color, cropped: !!crop, d };
    }

    // the picture goes right after the first paragraph (or after the first block if there is no paragraph)
    const tokens = marked.lexer(md.trim());
    if (image) {
      let at = tokens.findIndex((t) => t.type === 'paragraph');
      if (at < 0) at = tokens.findIndex((t) => t.type !== 'space');
      const marker = { type: 'html', block: true, pre: false, raw: IMG_MARKER, text: IMG_MARKER };
      tokens.splice(at + 1, 0, marker);
    }
    const html = marked.parser(tokens);
    sections.push({ id, order: s.order, file: s.file, title, html, image, grid: GRID_SECTIONS.has(id) ? id : null });
    log(`  ${String(s.order).padStart(2)} ${id}${title ? ` "${title}"` : ' (no title)'}${image ? ` + ${image.name}${image.cropped ? ' (cropped to landscape)' : ''}` : ''}${GRID_SECTIONS.has(id) ? ' + grid' : ''}`);
  }
  // the image file names that matched nothing are probably a typo; say so
  for (const f of images) {
    const used = sections.some((s) => s.image && s.image.name === f.name);
    if (!used) log(`  ! ${f.name} does not belong to any section (name it <anything>-<section>.jpg)`);
  }
  return sections;
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
  // remove empty folders
  for (const d of ['thumbs', 'img/collection', 'img/gallery', 'img/splash', 'img/content', 'img', 'assets', 'data', 'fonts']) {
    const p = path.join(OUT, d);
    try { if (fs.existsSync(p) && !(await fsp.readdir(p)).length) await fsp.rmdir(p); } catch {}
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
function serve(port = 8080) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const abs = path.join(OUT, p);
    if (!abs.startsWith(OUT) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(abs)] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  }).listen(port, () => log(`\nServing ${OUT}\n  -> http://localhost:${port}/   (Ctrl+C to stop)`));
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
  const coll = loadCollection(listImages(path.join(SRC, 'collection')));
  const collection = await buildSection('collection', coll.files, cfg.thumbs.collection, coll.catalog);
  const gallery = await buildSection('gallery', listImages(path.join(SRC, 'gallery')), cfg.thumbs.gallery);
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

  const publicCfg = {
    layout: cfg.layout, thumbs: { lazyMargin: cfg.thumbs.lazyMargin }, splash: { slideSeconds: cfg.splash.slideSeconds, fadeSeconds: cfg.splash.fadeSeconds },
    animation: cfg.animation, shop: cfg.shop, theme: cfg.theme,
  };
  const data = { config: publicCfg, splash, attrs: coll.attrs, colors: coll.colors, collection: collection.items, gallery: gallery.items,
    sheets: { collection: collection.sheets, gallery: gallery.sheets } };
  const dataJs = `window.SITE=${JSON.stringify(data)};\n`;
  const dataName = `data/site-${sha(dataJs, 8)}.js`;
  await writeIfChanged(dataName, dataJs);

  const html = renderIndex({ cfg, logo, css, js, dataName, fonts, sections, splash });
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

  if (args.has('--publish')) log('\n--publish: Cloudflare publishing is added in phase 2.');
  if (args.has('--serve')) serve();
}

main().catch((e) => { console.error('\nBUILD FAILED:', e.stack || e); process.exit(1); });
