// Collection data, shared by build.mjs, backoffice.mjs and the print scripts
//
// Every collection (config.json "collections": beanies, scarves, …) has the same four sources, named after it:
//
//   sources/beanies/                 the photos (square, Display P3), shown on the site
//   sources/beanies-print/           the same photos for print (Adobe RGB, same file names)
//   sources/beanies-attributes.txt   the attributes of the products of this collection (see below)
//   sources/beanies.json             order, name and attributes of every product, written by the backoffice
//
// sources/<collection>-attributes.txt   the options for every product attribute, one section per attribute:
//
//     [price]
//     150
//     *180          <- "*" marks the default for new products
//     220
//
//     [size]
//     *54-56 cm
//     56-58 cm
//
//   Every [section] becomes a dropdown in the backoffice and a line in the detail pane of the site.
//   "price" is the only one with a meaning of its own: it is stored as a number and shown as money.
//
// sources/<collection>.json  written by the backoffice: one entry per photo, in display order
//
//     [
//       {"file":"DSC01606.jpg","name":"Lisbon","price":180,"size":"54-56 cm"},
//       ...
//     ]

import fs from 'node:fs';
import path from 'node:path';

const RESERVED_KEYS = new Set(['file', 'name', 'slug', 'id']);

/** the keys of config.json "collections", in the order of the config ("beanies", "scarves") */
export const collectionKeys = (cfg) => Object.keys(cfg.collections || {});

/** the sources of one collection, relative to the sources folder */
export const collectionFiles = (key) => ({
  photos: key, print: `${key}-print`, attributes: `${key}-attributes.txt`, data: `${key}.json`,
});

/** "São Paulo" -> "sao-paulo": used for the #hash in the site url, so names must be unique by slug */
export const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function toNumber(v) {
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** normalise one value for an attribute: prices are numbers, everything else is text */
export function attrValue(attr, v) {
  if (v === undefined || v === null || v === '') return null;
  return attr.key === 'price' ? toNumber(v) : String(v).trim();
}

export function parseAttributes(text) {
  const attrs = [];
  let cur = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const h = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (h) {
      const key = slugify(h[1]).replace(/-/g, '_');
      cur = RESERVED_KEYS.has(key) || !key ? null : { key, label: h[1], values: [], default: null };
      if (cur) attrs.push(cur);
      continue;
    }
    if (!cur) continue;
    const isDefault = line.startsWith('*');
    const v = attrValue(cur, isDefault ? line.slice(1) : line);
    if (v === null || cur.values.includes(v)) continue;
    cur.values.push(v);
    if (isDefault && cur.default === null) cur.default = v;
  }
  return attrs;
}

export function readAttributes(srcDir, key) {
  const file = path.join(srcDir, collectionFiles(key).attributes);
  return fs.existsSync(file) ? parseAttributes(fs.readFileSync(file, 'utf8')) : [];
}

/** the saved entries; throws on a damaged file so nothing ever overwrites it with an empty list */
export function readCollection(srcDir, key) {
  const file = path.join(srcDir, collectionFiles(key).data);
  if (!fs.existsSync(file)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Fix or delete it.`);
  }
  if (!Array.isArray(data)) throw new Error(`${file} should contain a list [ ... ]`);
  return data.filter((e) => e && typeof e.file === 'string');
}

/** one entry with its keys in a fixed order: file, name, then the attributes as listed in attributes.txt */
export function normalizeEntry(e, attrs) {
  const out = { file: e.file, name: typeof e.name === 'string' ? e.name.trim() : '' };
  for (const a of attrs) {
    const v = attrValue(a, e[a.key]);
    out[a.key] = v === null ? a.default : v;
  }
  // keep values of attributes that were removed from attributes.txt, so nothing is lost by accident
  for (const [k, v] of Object.entries(e)) if (!(k in out)) out[k] = v;
  return out;
}

/** one entry per line: readable, and a change shows up as one changed line */
export function formatCollection(entries) {
  return '[\n' + entries.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n';
}

/**
 * Combine the saved entries with the photos that are actually in the collection folder.
 *   items   : one entry per photo, saved order first, new photos at the end, defaults filled in
 *   added   : the entries that were created for new photos (they have no name yet)
 *   orphans : saved entries whose photo is gone (kept by the backoffice so their names survive)
 */
export function mergeCollection(saved, files, attrs) {
  const present = new Set(files);
  const seen = new Set();
  const items = [];
  for (const e of saved) {
    if (!present.has(e.file) || seen.has(e.file)) continue;
    seen.add(e.file);
    items.push(normalizeEntry(e, attrs));
  }
  const added = [];
  for (const f of files) {
    if (seen.has(f)) continue;
    const e = normalizeEntry({ file: f }, attrs);
    items.push(e);
    added.push(e);
  }
  const orphans = saved.filter((e) => !present.has(e.file));
  return { items, added, orphans };
}
