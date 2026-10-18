// Shared by the printed cards for the boxes: booklet.mjs (beanies, 140 x 200 mm) and scarf-sticker.mjs (177 x 177 mm).
// Products, photos with their own ICC profile, fonts, the text blocks every card has, and the imposition on sheets.

import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, rgb, setCharacterSpacing, setTextRenderingMode, setLineWidth, setStrokingColor, TextRenderingMode } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { collectionFiles } from './collection.mjs';

export const CONTACT = { email: 'uri@uri.eu', website: 'uri.fashion', instagram: '@urieugenio' };
export const CARE = 'Hand wash at max. 30 °C with a wool-safe detergent. Don’t rub or wring; gently press out the water and lay flat to air dry.';
export const MADE = 'Handmade in Amsterdam';

export const mm = (v) => (v * 72) / 25.4;
export const INK = rgb(0.1, 0.1, 0.1);
export const GREY = rgb(0.45, 0.45, 0.45);
export const LINE = rgb(0.72, 0.72, 0.72);
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// line icons on a 24 x 24 grid (SVG paths, y down), drawn as strokes
const ICONS = {
  email: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  website: ['M22 12a10 10 0 1 1-20 0a10 10 0 1 1 20 0z', 'M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20z', 'M2 12h20'],
  instagram: ['M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z', 'M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0z'],
};

// ---------------------------------------------------------------- products
/** the products of a collection in the order of the site; --only=Nancy,Pavia (names or files) picks some of them */
export function loadProducts(srcDir, key, only) {
  const F = collectionFiles(key);
  const photos = path.join(srcDir, F.print);
  const products = JSON.parse(fs.readFileSync(path.join(srcDir, F.data), 'utf8'))
    .filter((p) => !only || only.includes(p.name.toLowerCase()) || only.includes(p.file.toLowerCase()));
  if (!products.length) { console.error('No products selected.'); process.exit(1); }
  const missing = products.filter((p) => !fs.existsSync(path.join(photos, p.file)));
  if (missing.length) { console.error(`Missing in ${F.print}:`, missing.map((p) => p.file).join(' ')); process.exit(1); }
  return { products, photos };
}

// ---------------------------------------------------------------- pdf
/** a new document with the fonts of the cards: Lato light / regular, and Great Vibes for outlines (drawOutlined) */
export async function newDocument(root, title) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title);
  doc.setAuthor('Uri Eugenio');
  const fontFile = (f) => fs.readFileSync(path.join(root, 'assets', 'fonts', f));
  const light = await doc.embedFont(fontFile('lato-300.woff'), { subset: true });
  const regular = await doc.embedFont(fontFile('lato-400.woff'), { subset: true });
  // the script font is drawn as outlines: pdf-lib gets the spacing of its contextual glyphs wrong
  const script = fontkit.create(fontFile('GreatVibes-Regular.ttf'));
  return { doc, fonts: { light, regular, script } };
}

/** Embed a JPEG and point its colour space at the source's ICC profile instead of plain DeviceRGB. */
const iccRefs = new WeakMap(); // doc -> (profile -> its object in that doc)
export async function embedPhoto(doc, { jpg, icc }) {
  const img = await doc.embedJpg(jpg);
  if (icc) {
    if (!iccRefs.has(doc)) iccRefs.set(doc, new Map());
    const refs = iccRefs.get(doc);
    const key = icc.toString('base64');
    if (!refs.has(key)) {
      const stream = doc.context.flateStream(icc, { N: 3, Alternate: 'DeviceRGB' });
      refs.set(key, doc.context.register(stream));
    }
    await img.embed();
    doc.context.lookup(img.ref).dict.set(PDFName.of('ColorSpace'), doc.context.obj([PDFName.of('ICCBased'), refs.get(key)]));
  }
  return img;
}

/** Text as filled vector outlines, laid out by fontkit (kerning, ligatures and contextual forms included). */
export function drawOutlined(page, font, str, x, y, size, color) {
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

export function wrap(text, font, size, width) {
  const lines = []; let line = '';
  for (const w of text.split(/\s+/)) {
    const t = line ? `${line} ${w}` : w;
    if (line && font.widthOfTextAtSize(t, size) > mm(width)) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A new card page of trim x trim.h mm with its bleed, and drawing helpers that take mm from the top-left of the trim:
 * X / Y (positions), text, label (small grey capitals), icon, contact (the three "stay in touch" lines) and
 * thanks ("Thank you for your support!", "Handmade in Amsterdam" under it, and a line for Uri's signature).
 */
export function cardPage(doc, fonts, trim, bleed) {
  const { light, regular, script } = fonts;
  const pageW = mm(trim.w + 2 * bleed), pageH = mm(trim.h + 2 * bleed);
  const page = doc.addPage([pageW, pageH]);
  page.setBleedBox(0, 0, pageW, pageH);
  page.setTrimBox(mm(bleed), mm(bleed), mm(trim.w), mm(trim.h));
  const X = (x) => mm(bleed + x);
  const Y = (y) => pageH - mm(bleed + y);
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
  /** website (bold), email and instagram, one per line from baseline y */
  const contact = (x, y, step) => {
    [['website', CONTACT.website, true], ['email', CONTACT.email], ['instagram', CONTACT.instagram]].forEach(([k, v, bold], j) => {
      const b = y + j * step;
      icon(k, x, b, GREY);
      // bold: Lato Regular with a thin outline (there is no Lato Bold in assets\fonts)
      if (bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(0.22), setStrokingColor(INK));
      text(v, x + ICON + 1.4, b, bold ? regular : light, 8);
      if (bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
    });
  };
  /** thank you with "handmade in" under it (from x), a signature line from signX to the right margin; the "handmade in"
      line and the name under the signature line share a baseline, signY + 3.5 */
  const thanks = (x, signX, rightX, signY) => {
    const labelY = signY + 3.5;
    drawOutlined(page, script, 'Thank you for your support!', X(x), Y(labelY - 7), 17, INK);
    text(MADE, x + 1, labelY, light, 7.5, GREY);
    page.drawLine({ start: { x: X(signX), y: Y(signY) }, end: { x: X(rightX), y: Y(signY) }, thickness: 0.4, color: GREY });
    label('Uri Eugenio', signX, labelY);
  };
  return { page, pageW, pageH, X, Y, text, label, icon, contact, thanks };
}

/** Cards (with their bleed) cols x rows to a sheet, centred, crop marks on the outer margins. */
export async function impose(cardBytes, trim, bleed, sheetMm, cols, rows, title) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('Uri Eugenio');
  const src = await PDFDocument.load(cardBytes);
  const cards = await doc.embedPdf(cardBytes, src.getPageIndices());
  const cw = trim.w + 2 * bleed, ch = trim.h + 2 * bleed, perSheet = cols * rows;
  const ox = (sheetMm.w - cols * cw) / 2, oy = (sheetMm.h - rows * ch) / 2;
  const trimsX = [...Array(cols).keys()].flatMap((c) => [ox + c * cw + bleed, ox + c * cw + bleed + trim.w]);
  const trimsY = [...Array(rows).keys()].flatMap((r) => [oy + r * ch + bleed, oy + r * ch + bleed + trim.h]);
  const mark = { thickness: 0.25, color: rgb(0, 0, 0) };
  const gap = bleed + 1, len = 8;  // marks start just outside the bleed and stop 2 mm before the edge of the sheet
  const H = mm(sheetMm.h);
  const vline = (x, y1, y2) => ({ start: { x: mm(x), y: H - mm(y1) }, end: { x: mm(x), y: H - mm(y2) }, ...mark });
  const hline = (y, x1, x2) => ({ start: { x: mm(x1), y: H - mm(y) }, end: { x: mm(x2), y: H - mm(y) }, ...mark });
  const top = trimsY[0], bottom = trimsY.at(-1), left = trimsX[0], right = trimsX.at(-1);
  for (let s = 0; s < cards.length; s += perSheet) {
    const sheet = doc.addPage([mm(sheetMm.w), H]);
    if (perSheet === 1) sheet.setTrimBox(mm(left), H - mm(bottom), mm(trim.w), mm(trim.h));
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

/** write the cards imposed on each sheet of outputs: [file name, sheet size in mm, cols, rows, title] */
export async function writeSheets(outDir, cardBytes, trim, bleed, outputs) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, sheet, cols, rows, title] of outputs) {
    const f = path.join(outDir, name);
    fs.writeFileSync(f, await (await impose(cardBytes, trim, bleed, sheet, cols, rows, title)).save());
    console.log(`  ${f}  (${(fs.statSync(f).size / 1e6).toFixed(1)} MB)`);
  }
}
