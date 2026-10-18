#!/usr/bin/env node
// Uri Eugenio webshop — printed sticker for the square box a scarf is sold in: 177 x 177 mm, one per scarf.
// The same information as the beanie card (booklet.mjs): the photo in the top half, name, model, material,
// thickness, size, care, how to wear, "stay in touch", a thank you with "Handmade in Amsterdam", and a line for
// Uri's signature.
//
//   node scarf-sticker.mjs                       every scarf in scarves.json, in the order of the site
//   node scarf-sticker.mjs --only=Timoteo,Ripley just these scarves (by name or file)
//   node scarf-sticker.mjs --photo=zoom          the photo zoomed in (see PHOTO below); --photo=fill is the default
//
// Writes to ..\build\print:
//   scarf-sticker-<photo>-A4-proof.pdf   one sticker (+ 5 mm bleed) per A4 sheet, with crop marks, for proofs at home
//   scarf-sticker-<photo>-SRA3-2up.pdf   the same stickers two to a 320 x 450 mm SRA3 sheet, with crop marks
//
// The photos come from sources\scarves-print (Adobe RGB exports for print). They are square and the photo area is
// twice as wide as it is high, so there are two ways to fill it:
//   zoom : the full width of the photo, cut to the height of the area: closer to the scarf, the label stays in view
//          (the area ends at PHOTO.zoom.bottom of the photo's height), the top of the roll is cut off;
//   fill : the whole scarf (the rows PHOTO.fill.top to .bottom of the photo), and the backdrop left and right of the
//          photo extended: its light (per row, from the photo's own edges, a shadow at an edge fading out) and its
//          grain. The backdrop is plain, so this needs no generative AI.
// Either way the pixels stay Adobe RGB and the profile goes into the PDF, as for the beanie card.

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

// styling ideas rather than instructions: the ways the scarf is worn in the gallery
const WEAR = 'Wear it loose, tucked into the loop, knotted at the neck, or improvise.';

// ---------------------------------------------------------------- page geometry (mm, from the top-left of the trim)
const TRIM = { w: 177, h: 177 };
const BLEED = 5;
const MARGIN = 14;                  // left / right text margin
const COL = (TRIM.w - 2 * MARGIN) / 4; // the text is set on four columns
const PHOTO_H = TRIM.h / 2;         // visible photo height below the top edge of the trim: the top half
const PHOTO_DPI = 300;
const PHOTO = {
  zoom: { bottom: 0.90 },             // fractions of the photo's height: the label of every scarf is above 0.86
  fill: { top: 0.04, bottom: 0.96 },
};

const mode = argVal('--photo') || 'fill';
if (!PHOTO[mode]) { console.error(`--photo=${mode}: use ${Object.keys(PHOTO).join(' or ')}`); process.exit(1); }

// ---------------------------------------------------------------- products
const only = argVal('--only')?.split(',').map((s) => s.trim().toLowerCase());
const { products, photos: PHOTOS } = loadProducts(SRC, 'scarves', only);

/** "167 cm" and "7 cm" -> "167 × 7 cm" */
function size(p) {
  const [l, w] = [p.length, p.width].map((s) => String(s ?? '').trim());
  if (!l || !w) return l || w;
  return /cm$/.test(l) && /cm$/.test(w) ? `${l.replace(/\s*cm$/, '')} × ${w}` : `${l} × ${w}`;
}

// ---------------------------------------------------------------- photo
/** the photo area (page width + bleed, PHOTO_H + top bleed) as raw pixels, in the photo's own colour space */
async function photoArea(abs) {
  const W = Math.round(((TRIM.w + 2 * BLEED) / 25.4) * PHOTO_DPI), H = Math.round(((PHOTO_H + BLEED) / 25.4) * PHOTO_DPI);
  const { width: S, height: S2, icc } = await sharp(abs).metadata();
  // the rows of the photo that are shown: zoom fills the width, so its height follows from the shape of the area
  const o = PHOTO[mode];
  const top = mode === 'zoom' ? o.bottom - (S * H) / (W * S2) : o.top;
  const srcTop = Math.max(0, Math.round(top * S2)), srcH = Math.min(S2 - srcTop, Math.round((o.bottom - top) * S2));
  const w = Math.min(W, Math.round((S * H) / srcH));
  // keepIccProfile: the pixels are never converted, they stay Adobe RGB
  const photo = await sharp(abs).extract({ left: 0, top: srcTop, width: S, height: srcH }).resize(w, H)
    .keepIccProfile().raw().toBuffer({ resolveWithObject: true });
  return { ...(w < W ? await extendBackdrop(photo.data, w, W, H) : photo), icc };
}

/**
 * The photo (w x H, 3 channels) in the middle of a W x H area, the backdrop extended to the left and right edges.
 * Per row the backdrop colour at each edge of the photo (a thin strip, smoothed a little up and down) is continued
 * outwards; a shadow there (darker than the other edge) fades into the shadow-free backdrop of that row, and the light
 * falls off a little towards the far edges. Gaussian grain like the photo's own is added, and the last 2 % of the photo
 * at each side blends into the extension, so there is no seam.
 */
async function extendBackdrop(src, w, W, H) {
  const x0 = Math.floor((W - w) / 2), sides = [x0, W - w - x0];
  const K = Math.max(4, Math.round(w * 0.006)); // the edge strip, in px
  const edge = (from) => {
    const a = new Float64Array(H * 3);
    for (let y = 0; y < H; y++) for (let x = from; x < from + K; x++) for (let c = 0; c < 3; c++) a[y * 3 + c] += src[(y * w + x) * 3 + c] / K;
    return a;
  };
  const smooth = (a, r) => {
    const o = new Float64Array(a.length);
    for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) {
      let s = 0, n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) { s += a[k * 3 + c]; n++; }
      o[y * 3 + c] = s / n;
    }
    return o;
  };
  const L = smooth(edge(0), 6), R = smooth(edge(w - K), 6);
  // shadow-free backdrop of a row: the lighter of the two edges (a shadow only darkens), smoothed a lot
  const lum = (a, y) => a[y * 3] + a[y * 3 + 1] + a[y * 3 + 2];
  const lighter = new Float64Array(H * 3);
  for (let y = 0; y < H; y++) { const s = lum(L, y) >= lum(R, y) ? L : R; for (let c = 0; c < 3; c++) lighter[y * 3 + c] = s[y * 3 + c]; }
  const clean = smooth(lighter, Math.round(H * 0.04));
  // grain: gaussian noise (a fixed seed, so the same photo always gives the same sticker), blurred a little
  let seed = 0x9e3779b9;
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const nb = Buffer.alloc(W * H);
  for (let i = 0; i < nb.length; i++) nb[i] = Math.max(0, Math.min(255, Math.round(128 + gauss() * 40)));
  const noise = await sharp(nb, { raw: { width: W, height: H, channels: 1 } }).blur(0.6).raw().toBuffer();
  const GRAIN = 0.052;          // noise level 40, lowered by the blur, times this: about the photo's 1.3 levels
  const FADE = H * 0.12;        // a shadow at an edge fades out over this distance
  const FEATHER = Math.round(w * 0.02);
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inX = x - x0, left = inX < 0, right = inX >= w;
      const e = left || (!right && inX < w / 2) ? L : R;
      const d = left ? -inX : right ? inX - w + 1 : 0;             // distance from the photo, px
      const far = left ? d / sides[0] : right ? d / sides[1] : 0;  // 0 at the photo, 1 at the edge of the area
      const t = Math.exp(-d / FADE), light = 1 - 0.14 * far ** 1.6;
      const g = (noise[y * W + x] - 128) * GRAIN;
      for (let c = 0; c < 3; c++) {
        const k = y * 3 + c;
        let v = ((e[k] - clean[k]) * t + clean[k]) * light + g;
        if (!left && !right) {
          const f = Math.min(inX, w - 1 - inX);
          const orig = src[(y * w + inX) * 3 + c];
          v = f >= FEATHER ? orig : orig * (f / FEATHER) + v * (1 - f / FEATHER);
        }
        out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { data: out, info: { width: W, height: H, channels: 3 } };
}

async function photoJpeg(file) {
  const { data, info, icc } = await photoArea(path.join(PHOTOS, file));
  const jpg = await sharp(data, { raw: info }).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
  return { jpg, icc };
}

// ---------------------------------------------------------------- stickers
async function buildStickers() {
  const { doc, fonts } = await newDocument(ROOT, 'Uri Eugenio — scarf stickers');
  const { light } = fonts;
  const col = (n) => MARGIN + n * COL;
  for (const [i, p] of products.entries()) {
    const { page, pageW, X, Y, text, label, contact, thanks } = cardPage(doc, fonts, TRIM, BLEED);

    // photo, bleeding off the top and both sides
    const img = await embedPhoto(doc, await photoJpeg(p.file));
    page.drawImage(img, { x: 0, y: Y(PHOTO_H), width: pageW, height: mm(PHOTO_H + BLEED) });

    // name and attributes, one per column
    const y0 = PHOTO_H;
    text(p.name, MARGIN, y0 + 14, light, 22, INK, 0.6);
    [['Model', cap(p.model)], ['Material', cap(p.material)], ['Thickness', cap(p.thickness)], ['Size', size(p)]]
      .forEach(([k, v], n) => { label(k, col(n), y0 + 22); text(v || '', col(n), y0 + 26.5, light, 8.5); });
    page.drawLine({ start: { x: X(MARGIN), y: Y(y0 + 32) }, end: { x: X(TRIM.w - MARGIN), y: Y(y0 + 32) }, thickness: 0.4, color: LINE });

    // care (two columns) / ways to wear / contact
    const body = y0 + 43.5, step = 3.9;
    [['Care', wrap(CARE, light, 8, 2 * COL - 6), 0], ['Ways to wear', wrap(WEAR, light, 8, COL - 4), 2], ['Stay in touch', [], 3]]
      .forEach(([k, lines, n]) => { label(k, col(n), y0 + 39); lines.forEach((l, j) => text(l, col(n), body + j * step, light, 8)); });
    contact(col(3), body, step);

    // thank you with "handmade in" under it (left), and a line for Uri's signature (right, from the third column)
    thanks(MARGIN, col(2), TRIM.w - MARGIN, TRIM.h - 13.5);
  }
  return doc;
}

console.log(`Scarf stickers (${mode}): ${products.length} scarves from ${PHOTOS}`);
const stickers = await (await buildStickers()).save();
const suffix = (only ? '-' + products.map((p) => p.name.toLowerCase()).join('-').slice(0, 60) : '');
await writeSheets(OUT, stickers, TRIM, BLEED, [
  [`scarf-sticker-${mode}-A4-proof${suffix}.pdf`, { w: 210, h: 297 }, 1, 1, `Uri Eugenio — scarf stickers (${mode}), A4 proof`],
  [`scarf-sticker-${mode}-SRA3-2up${suffix}.pdf`, { w: 320, h: 450 }, 1, 2, `Uri Eugenio — scarf stickers (${mode}), SRA3 2-up`],
]);
