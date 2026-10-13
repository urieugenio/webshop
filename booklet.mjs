#!/usr/bin/env node
// Uri Eugenio webshop — printed booklet: one page per product, for the back of the box the beanie is sold in
// (the front of the box carries the splash picture with the logo).
//
//   node booklet.mjs                       every product in collection.json, in the order of the site
//   node booklet.mjs --only=Nancy,Pavia    just these products (by name or file)
//
// Writes to ..\build\print:
//   booklet-A4-proof.pdf   one 140 x 200 mm card (+ 5 mm bleed) per A4 sheet, with crop marks, for proofs at home
//   booklet-SRA3-4up.pdf   the same cards four to a 320 x 450 mm SRA3 sheet, with crop marks
//
// The pictures come from sources\collection-print (Adobe RGB exports for print). Each one is embedded as a JPEG
// with its own ICC profile, so the print shop's RIP converts Adobe RGB to the press itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument, PDFName, rgb, setCharacterSpacing, setTextRenderingMode, setLineWidth, setStrokingColor, TextRenderingMode } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argVal = (k) => { const a = argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const SRC = path.resolve(ROOT, argVal('--sources') || cfg.sourcesDir);
const OUT = path.resolve(ROOT, cfg.outDir, '..', 'print');
const PHOTOS = path.join(SRC, 'collection-print');

const CONTACT = { email: 'uri@uri.eu', website: 'uri.fashion', instagram: '@urieugenio' };
const CARE = 'Hand wash at max. 30 °C with a wool-safe detergent. Don’t rub or wring; gently press out the water and lay flat to air dry.';
const WEAR = 'Always wear the beanie with the label on the left side (see picture).';
const MADE = 'Handmade in Amsterdam';

// line icons on a 24 x 24 grid (SVG paths, y down), drawn as strokes
const ICONS = {
  email: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  website: ['M22 12a10 10 0 1 1-20 0a10 10 0 1 1 20 0z', 'M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20z', 'M2 12h20'],
  instagram: ['M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z', 'M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0z'],
};

// ---------------------------------------------------------------- page geometry (mm, from the top-left of the trim)
const mm = (v) => (v * 72) / 25.4;
const TRIM = { w: 140, h: 200 };
const BLEED = 5;
const MARGIN = 12;                 // left / right text margin
const PHOTO_H = 122;               // visible photo height below the top edge of the trim
const PHOTO_DPI = 300;
const PAD = { side: 0.08, top: 0.06 }; // background added around the square photo, as a fraction of its size
const INK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.45, 0.45, 0.45);
const LINE = rgb(0.72, 0.72, 0.72);

// ---------------------------------------------------------------- products
const only = argVal('--only')?.split(',').map((s) => s.trim().toLowerCase());
const products = JSON.parse(fs.readFileSync(path.join(SRC, 'collection.json'), 'utf8'))
  .filter((p) => !only || only.includes(p.name.toLowerCase()) || only.includes(p.file.toLowerCase()));
if (!products.length) { console.error('No products selected.'); process.exit(1); }
const missing = products.filter((p) => !fs.existsSync(path.join(PHOTOS, p.file)));
if (missing.length) { console.error('Missing in collection-print:', missing.map((p) => p.file).join(' ')); process.exit(1); }

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

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

/** Embed a JPEG and point its colour space at the source's ICC profile instead of plain DeviceRGB. */
const iccRefs = new Map();
async function embedPhoto(doc, { jpg, icc }) {
  const img = await doc.embedJpg(jpg);
  if (icc) {
    const key = icc.toString('base64');
    if (!iccRefs.has(key)) {
      const stream = doc.context.flateStream(icc, { N: 3, Alternate: 'DeviceRGB' });
      iccRefs.set(key, doc.context.register(stream));
    }
    await img.embed();
    doc.context.lookup(img.ref).dict.set(PDFName.of('ColorSpace'), doc.context.obj([PDFName.of('ICCBased'), iccRefs.get(key)]));
  }
  return img;
}

/** Text as filled vector outlines, laid out by fontkit (kerning, ligatures and contextual forms included). */
function drawOutlined(page, font, str, x, y, size, color) {
  const run = font.layout(str);
  const k = size / font.unitsPerEm;
  let pen = 0;
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const d = g.path.scale(1, -1).toSVG(); // font outlines are y-up, SVG paths y-down
    if (d) page.drawSvgPath(d, { x: x + (pen + pos.xOffset) * k, y: y + pos.yOffset * k, scale: k, color, borderWidth: 0 });
    pen += pos.xAdvance;
  });
}

function wrap(text, font, size, width) {
  const lines = []; let line = '';
  for (const w of text.split(/\s+/)) {
    const t = line ? `${line} ${w}` : w;
    if (line && font.widthOfTextAtSize(t, size) > mm(width)) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

async function buildBooklet() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('Uri Eugenio — collection booklet');
  doc.setAuthor('Uri Eugenio');
  const fontFile = (f) => fs.readFileSync(path.join(ROOT, 'assets', 'fonts', f));
  const light = await doc.embedFont(fontFile('lato-300.woff'), { subset: true });
  const regular = await doc.embedFont(fontFile('lato-400.woff'), { subset: true });
  // the script font is drawn as outlines: pdf-lib gets the spacing of its contextual glyphs wrong
  const script = fontkit.create(fontFile('GreatVibes-Regular.ttf'));

  const pageW = mm(TRIM.w + 2 * BLEED), pageH = mm(TRIM.h + 2 * BLEED);
  for (const [i, p] of products.entries()) {
    const page = doc.addPage([pageW, pageH]);
    page.setBleedBox(0, 0, pageW, pageH);
    page.setTrimBox(mm(BLEED), mm(BLEED), mm(TRIM.w), mm(TRIM.h));
    // position helpers in mm from the top-left of the trim
    const X = (x) => mm(BLEED + x);
    const Y = (y) => pageH - mm(BLEED + y);
    const text = (s, x, y, font, size, color = INK, spacing = 0) => {
      if (spacing) page.pushOperators(setCharacterSpacing(spacing));
      page.drawText(s, { x: X(x), y: Y(y), font, size, color });
      if (spacing) page.pushOperators(setCharacterSpacing(0));
    };
    const label = (s, x, y) => text(s.toUpperCase(), x, y, regular, 5.8, GREY, 0.9);
    const ICON = 2.9;  // mm
    const icon = (name, x, baseline, color) => {
      const scale = mm(ICON) / 24;
      for (const d of ICONS[name]) page.drawSvgPath(d, { x: X(x), y: Y(baseline - 2.35), scale, borderColor: color, borderWidth: 1.8, borderLineCap: 1 });
      if (name === 'instagram') page.drawCircle({ x: X(x) + 17.5 * scale, y: Y(baseline - 2.35) - 6.5 * scale, size: 1.5 * scale, color });
    };

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
      ['Care', wrap(CARE, light, 8, 37), 41],
      ['How to wear', wrap(WEAR, light, 8, 31), 37],
      ['Stay in touch', [], 38],
    ];
    x = MARGIN;
    for (const [k, lines, w] of cols) {
      label(k, x, 157);
      lines.forEach((l, j) => text(l, x, 161.5 + j * 3.9, light, 8));
      x += w;
    }
    const contactX = MARGIN + 41 + 37;
    [['website', CONTACT.website, true], ['email', CONTACT.email], ['instagram', CONTACT.instagram]].forEach(([k, v, bold], j) => {
      const y = 161.5 + j * 3.9;
      icon(k, contactX, y, GREY);
      // bold: Lato Regular with a thin outline (there is no Lato Bold in assetsonts)
      if (bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(0.22), setStrokingColor(INK));
      text(v, contactX + ICON + 1.4, y, bold ? regular : light, 8);
      if (bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
    });

    // thank you with "handmade in" under it (left), and a line for Uri's signature (right); the "handmade in" line
    // and the name under the signature line share a baseline
    const SIGN_Y = 187, LABEL_Y = SIGN_Y + 3.5;
    drawOutlined(page, script, 'Thank you for your support!', X(MARGIN), Y(LABEL_Y - 7), 17, INK);
    text(MADE, MARGIN + 1, LABEL_Y, light, 7.5, GREY);
    const signX = MARGIN + 72;
    page.drawLine({ start: { x: X(signX), y: Y(SIGN_Y) }, end: { x: X(TRIM.w - MARGIN), y: Y(SIGN_Y) }, thickness: 0.4, color: GREY });
    label('Uri Eugenio', signX, LABEL_Y);
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1} / ${products.length}`);
  }
  return doc;
}

/** Cards (with their bleed) cols x rows to a sheet, centred, crop marks on the outer margins. */
async function impose(cardBytes, sheetMm, cols, rows, title) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Uri Eugenio — collection booklet, ${title}`);
  doc.setAuthor('Uri Eugenio');
  const src = await PDFDocument.load(cardBytes);
  const cards = await doc.embedPdf(cardBytes, src.getPageIndices());
  const cw = TRIM.w + 2 * BLEED, ch = TRIM.h + 2 * BLEED, perSheet = cols * rows;
  const ox = (sheetMm.w - cols * cw) / 2, oy = (sheetMm.h - rows * ch) / 2;
  const trimsX = [...Array(cols).keys()].flatMap((c) => [ox + c * cw + BLEED, ox + c * cw + BLEED + TRIM.w]);
  const trimsY = [...Array(rows).keys()].flatMap((r) => [oy + r * ch + BLEED, oy + r * ch + BLEED + TRIM.h]);
  const mark = { thickness: 0.25, color: rgb(0, 0, 0) };
  const gap = BLEED + 1, len = 8;  // marks start just outside the bleed and stop 2 mm before the edge of the sheet
  const H = mm(sheetMm.h);
  const vline = (x, y1, y2) => ({ start: { x: mm(x), y: H - mm(y1) }, end: { x: mm(x), y: H - mm(y2) }, ...mark });
  const hline = (y, x1, x2) => ({ start: { x: mm(x1), y: H - mm(y) }, end: { x: mm(x2), y: H - mm(y) }, ...mark });
  const top = trimsY[0], bottom = trimsY.at(-1), left = trimsX[0], right = trimsX.at(-1);
  for (let s = 0; s < cards.length; s += perSheet) {
    const sheet = doc.addPage([mm(sheetMm.w), H]);
    if (perSheet === 1) sheet.setTrimBox(mm(left), H - mm(bottom), mm(TRIM.w), mm(TRIM.h));
    cards.slice(s, s + perSheet).forEach((card, k) => {
      const c = k % cols, r = Math.floor(k / cols);
      sheet.drawPage(card, { x: mm(ox + c * cw), y: H - mm(oy + (r + 1) * ch), width: mm(cw), height: mm(ch) });
    });
    for (const x of trimsX) {
      sheet.drawLine(vline(x, top - gap, Math.max(2, top - gap - len)));
      sheet.drawLine(vline(x, bottom + gap, Math.min(sheetMm.h - 2, bottom + gap + len)));
    }
    for (const y of trimsY) {
      sheet.drawLine(hline(y, left - gap, Math.max(2, left - gap - len)));
      sheet.drawLine(hline(y, right + gap, Math.min(sheetMm.w - 2, right + gap + len)));
    }
  }
  return doc;
}

console.log(`Booklet: ${products.length} products from ${PHOTOS}`);
fs.mkdirSync(OUT, { recursive: true });
const cards = await (await buildBooklet()).save();
const suffix = (only ? '-' + products.map((p) => p.name.toLowerCase()).join('-').slice(0, 60) : '');
const outputs = [
  [`booklet-A4-proof${suffix}.pdf`, { w: 210, h: 297 }, 1, 1, 'A4 proof'],
  [`booklet-SRA3-4up${suffix}.pdf`, { w: 320, h: 450 }, 2, 2, 'SRA3 4-up'],
];
for (const [name, sheet, cols, rows, title] of outputs) {
  const f = path.join(OUT, name);
  fs.writeFileSync(f, await (await impose(cards, sheet, cols, rows, title)).save());
  console.log(`  ${f}  (${(fs.statSync(f).size / 1e6).toFixed(1)} MB)`);
}
