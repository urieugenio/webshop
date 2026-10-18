#!/usr/bin/env node
// Uri Eugenio webshop — printed booklet: one page per product, for the back of the box the beanie is sold in
// (the front of the box carries the splash picture with the logo). The scarves have their own: scarf-sticker.mjs.
//
//   node booklet.mjs                       every product in beanies.json, in the order of the site
//   node booklet.mjs --only=Nancy,Pavia    just these products (by name or file)
//
// Writes to ..\build\print:
//   booklet-A4-proof.pdf   one 140 x 200 mm card (+ 5 mm bleed) per A4 sheet, with crop marks, for proofs at home
//   booklet-SRA3-4up.pdf   the same cards four to a 320 x 450 mm SRA3 sheet, with crop marks
//
// The pictures come from sources\beanies-print (Adobe RGB exports for print). Each one is embedded as a JPEG
// with its own ICC profile, so the print shop's RIP converts Adobe RGB to the press itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CARE, mm, INK, LINE, cap, loadProducts, newDocument, embedPhoto, wrap, cardPage, writeSheets } from './lib/print.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argVal = (k) => { const a = argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const SRC = path.resolve(ROOT, argVal('--sources') || cfg.sourcesDir);
const OUT = path.resolve(ROOT, cfg.outDir, '..', 'print');

const WEAR = 'Always wear the beanie with the label on the left side (see picture).';

// ---------------------------------------------------------------- page geometry (mm, from the top-left of the trim)
const TRIM = { w: 140, h: 200 };
const BLEED = 5;
const MARGIN = 12;                 // left / right text margin
const PHOTO_H = 122;               // visible photo height below the top edge of the trim
const PHOTO_DPI = 300;
const PAD = { side: 0.08, top: 0.06 }; // background added around the square photo, as a fraction of its size

// ---------------------------------------------------------------- products
const only = argVal('--only')?.split(',').map((s) => s.trim().toLowerCase());
const { products, photos: PHOTOS } = loadProducts(SRC, 'beanies', only);

/** The photo cut to the page width (+ bleed) and the visible height (+ top bleed), from the top of the square. */
async function photoJpeg(file) {
  const abs = path.join(PHOTOS, file);
  const { width: w0, height: h0, icc } = await sharp(abs).metadata();
  // some beanies reach almost to the edge of the square: widen the dark background (by repeating its edge pixels)
  // so that the trim never cuts into a beanie
  const side = Math.round(w0 * PAD.side), top = Math.round(h0 * PAD.top);
  const padded = await sharp(abs).extend({ left: side, right: side, top, extendWith: 'copy' }).keepIccProfile().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = padded.info;
  const wMm = TRIM.w + 2 * BLEED, hMm = PHOTO_H + BLEED;
  const cropH = Math.round((width * hMm) / wMm);
  const outW = Math.min(width, Math.round((wMm / 25.4) * PHOTO_DPI));
  const jpg = await sharp(padded.data, { raw: padded.info })
    .extract({ left: 0, top: 0, width, height: Math.min(height, cropH) })
    .resize(outW)
    // the pixels are never converted: they stay Adobe RGB, and embedPhoto() puts the profile in the PDF
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
  return { jpg, icc };
}

async function buildBooklet() {
  const { doc, fonts } = await newDocument(ROOT, 'Uri Eugenio — collection booklet');
  const { light } = fonts;
  for (const [i, p] of products.entries()) {
    const { page, pageW, Y, text, label, contact, thanks, X } = cardPage(doc, fonts, TRIM, BLEED);

    // photo, bleeding off the top and both sides
    const img = await embedPhoto(doc, await photoJpeg(p.file));
    page.drawImage(img, { x: 0, y: Y(PHOTO_H), width: pageW, height: mm(PHOTO_H + BLEED) });

    // name and attributes
    text(p.name, MARGIN, 134, light, 22, INK, 0.6);
    const attrs = [['Model', cap(p.model), 30], ['Material', cap(p.material), 40], ['Thickness', cap(p.thickness), 22], ['Size', p.size, 24]];
    let x = MARGIN;
    for (const [k, v, w] of attrs) { label(k, x, 141.5); text(v, x, 146, light, 8.5); x += w; }
    page.drawLine({ start: { x: X(MARGIN), y: Y(151) }, end: { x: X(TRIM.w - MARGIN), y: Y(151) }, thickness: 0.4, color: LINE });

    // care / how to wear / contact
    const cols = [
      ['Care', wrap(CARE, light, 8, 50), 55],          // wide enough for the care text in three lines
      ['How to wear', wrap(WEAR, light, 8, 31), 37],
      ['Stay in touch', [], 24],                       // starts under SIZE
    ];
    x = MARGIN;
    for (const [k, lines, w] of cols) {
      label(k, x, 157);
      lines.forEach((l, j) => text(l, x, 161.5 + j * 3.9, light, 8));
      x += w;
    }
    contact(MARGIN + 55 + 37, 161.5, 3.9);

    // thank you with "handmade in" under it (left), and a line for Uri's signature (right)
    thanks(MARGIN, MARGIN + 72, TRIM.w - MARGIN, 187);
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1} / ${products.length}`);
  }
  return doc;
}

console.log(`Booklet: ${products.length} products from ${PHOTOS}`);
const cards = await (await buildBooklet()).save();
const suffix = (only ? '-' + products.map((p) => p.name.toLowerCase()).join('-').slice(0, 60) : '');
await writeSheets(OUT, cards, TRIM, BLEED, [
  [`booklet-A4-proof${suffix}.pdf`, { w: 210, h: 297 }, 1, 1, 'Uri Eugenio — collection booklet, A4 proof'],
  [`booklet-SRA3-4up${suffix}.pdf`, { w: 320, h: 450 }, 2, 2, 'Uri Eugenio — collection booklet, SRA3 4-up'],
]);
