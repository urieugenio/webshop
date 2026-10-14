#!/usr/bin/env node
// Uri Eugenio webshop — the 8-page booklet in the box with the beanie, from content\booklet.md (next to site.md).
//
//   node story-booklet.mjs                 printer flips the sheet on the long edge (the usual duplex setting)
//   node story-booklet.mjs --flip=short    printer flips on the short edge
//
// One A4 sheet, printed on both sides in black only (for a monochrome laser printer), then:
//   1. fold it in half across (the fold parallel to the short edge): this fold is the head of the booklet
//   2. fold it in half again (the fold parallel to the long edge): this is the spine
//   3. cut open the head fold, staple twice through the spine
// The result is an A6 booklet (105 x 148.5 mm) of 8 pages. The top half of each side is printed upside down.
//
// Writes to ..\build\print:
//   story-booklet-A4-duplex.pdf   the two sides of the sheet: print at actual size (100 %, no "fit to page")
//   story-booklet-pages.pdf       the 8 pages in reading order, to check on screen
//
// The logo and the script lines are drawn in Great Vibes, the text in Lato. A picture from gallery or content\images
// is converted to grey with the background pushed to white, so a laser printer prints it clean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { marked } from 'marked';
import { PDFDocument, rgb, degrees, setCharacterSpacing, setTextRenderingMode, setLineWidth, setStrokingColor, TextRenderingMode } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argVal = (k) => { const a = argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const SRC = path.resolve(ROOT, argVal('--sources') || cfg.sourcesDir);
const OUT = path.resolve(ROOT, cfg.outDir, '..', 'print');
const MD = path.join(SRC, cfg.content.folder, 'booklet.md');
const PHOTO_DIRS = [path.join(SRC, 'gallery'), path.join(SRC, cfg.content.folder, cfg.content.images)];
const FLIP_SHORT = argVal('--flip') === 'short';

// ---------------------------------------------------------------- geometry (mm) and type
const mm = (v) => (v * 72) / 25.4;
const ptMm = (pt) => (pt * 25.4) / 72;
const SHEET = { w: 210, h: 297 };
const PAGE = { w: SHEET.w / 2, h: SHEET.h / 2 };
const M = { head: 14, foot: 13, spine: 13, outer: 11 };  // head is the cut edge; foot and outer edge are the edges of the sheet
const W = PAGE.w - M.spine - M.outer, H = PAGE.h - M.head - M.foot;
const BLACK = rgb(0, 0, 0);
const BODY = { size: 8.6, lead: 4.25 };   // pt, mm
const H1 = 25, H2 = 6.4, TAGLINE = 6.2, SCRIPT = 20, CAPTION = 7.4, FOLIO = 6.6;
const PHOTO_DPI = 300;
// grey mix for the picture: mostly blue, so the purple backdrop turns light and the green clothes dark
const PHOTO_MIX = [0.25, 0, 0.75];
const PHOTO_WHITE = 152;   // mixed grey at and above this becomes paper white
const PHOTO_BLACK = 28;    // darkest grey printed: a laser printer fills in deep shadows

// sheet positions: [page number, column, row, upside down] (row 0 is the bottom half)
const SIDES = {
  front: [[8, 0, 0, false], [1, 1, 0, false], [5, 0, 1, true], [4, 1, 1, true]],
  back:  [[2, 0, 0, false], [7, 1, 0, false], [3, 0, 1, true], [6, 1, 1, true]],
};

// ---------------------------------------------------------------- booklet.md
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const typo = (s) => s.replace(/(^|[\s(\[“])"/g, '$1“').replace(/"/g, '”').replace(/'/g, '’').replace(/\.\.\./g, '…');

function inline(tokens, style = 'regular') {
  return tokens.flatMap((t) => {
    if (t.type === 'strong') return inline(t.tokens, 'bold');
    if (t.type === 'em') return inline(t.tokens, 'italic');
    if (t.tokens?.length) return inline(t.tokens, style);  // links, text with children
    if (t.type === 'br') return [{ text: ' ', style }];
    return [{ text: typo(decode(t.text ?? t.raw)), style }];
  });
}

function mdBlocks(text) {
  return marked.lexer(text).flatMap((t) => {
    if (t.type === 'heading') return [{ type: t.depth === 1 ? 'h1' : 'h2', runs: inline(t.tokens) }];
    if (t.type === 'paragraph' || t.type === 'text') return [{ type: 'p', runs: inline(t.tokens) }];
    if (t.type === 'list') return t.items.map((it) => ({ type: 'li', runs: inline(it.tokens.flatMap((x) => x.tokens ?? [x])) }));
    if (t.type === 'space') return [];
    throw new Error(`booklet.md: "${t.type}" is not supported here: ${t.raw.trim().slice(0, 60)}`);
  });
}

function parsePage(src) {
  const blocks = []; let buf = [];
  const flush = () => { if (buf.join('').trim()) blocks.push(...mdBlocks(buf.join('\n'))); buf = []; };
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*\{\{\s*(\w+)\s*(.*?)\s*\}\}\s*(.*)$/);
    if (!m) { buf.push(line); continue; }
    flush();
    const [, type, arg, rest] = m;
    if (!['logo', 'tagline', 'photo', 'script', 'space'].includes(type)) throw new Error(`booklet.md: unknown {{${type}}}`);
    blocks.push({ type, arg, caption: rest ? typo(rest) : '' });
  }
  flush();
  return blocks;
}

const pages = fs.readFileSync(MD, 'utf8').replace(/<!--[\s\S]*?-->/g, '').split(/^\s*---\s*$/m).map(parsePage);
if (pages.length !== 8) { console.error(`booklet.md has ${pages.length} pages; it needs exactly 8 (separated by --- lines).`); process.exit(1); }

// ---------------------------------------------------------------- drawing helpers
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
const scriptWidth = (font, str, size) => ptMm((font.layout(str).advanceWidth * size) / font.unitsPerEm);

/** Grey picture for a laser printer: blue-weighted mix, background to white, shadows lifted, 300 dpi. */
async function laserPhoto(file, wMm) {
  const abs = PHOTO_DIRS.map((d) => path.join(d, file)).find((f) => fs.existsSync(f));
  if (!abs) throw new Error(`booklet.md: picture ${file} not found in ${PHOTO_DIRS.join(' or ')}`);
  const grey = await sharp(abs).rotate().resize(Math.round((wMm / 25.4) * PHOTO_DPI))
    .recomb([PHOTO_MIX, PHOTO_MIX, PHOTO_MIX]).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  const lut = Buffer.alloc(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(PHOTO_BLACK + (255 - PHOTO_BLACK) * Math.min(1, v / PHOTO_WHITE) ** 0.9);
  const px = grey.data;
  for (let i = 0; i < px.length; i++) px[i] = lut[px[i]];
  const { width, height } = grey.info;
  const jpg = await sharp(px, { raw: { width, height, channels: 1 } }).sharpen({ sigma: 0.7 }).jpeg({ quality: 90 }).toBuffer();
  return { jpg, aspect: width / height };
}

// ---------------------------------------------------------------- pages
async function buildPages() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('Uri Eugenio — booklet');
  doc.setAuthor('Uri Eugenio');
  const fontFile = (f) => fs.readFileSync(path.join(ROOT, 'assets', 'fonts', f));
  const fonts = {
    regular: await doc.embedFont(fontFile('lato-400.woff'), { subset: true }),
    italic: await doc.embedFont(fontFile('lato-300i.woff'), { subset: true }),
  };
  fonts.bold = fonts.regular;  // drawn with a thin outline: there is no Lato Bold in assets\fonts
  // the script font is drawn as outlines: pdf-lib gets the spacing of its contextual glyphs wrong
  const script = fontkit.create(fontFile('GreatVibes-Regular.ttf'));
  const spaceW = (style, size) => ptMm(fonts[style].widthOfTextAtSize(' ', size));
  const partW = (p, size) => ptMm(fonts[p.style].widthOfTextAtSize(p.text, size));

  /** Runs to lines; a line is a list of words, a word a list of {text, style} parts (a word can change style). */
  function wrap(runs, width, size) {
    const words = []; let word = [], spaceStyle = 'regular';
    for (const r of runs) {
      r.text.split(/(\s+)/).forEach((piece) => {
        if (!piece) return;
        if (/^\s+$/.test(piece)) { if (word.length) words.push({ parts: word, space: spaceStyle }); word = []; spaceStyle = r.style; }
        else word.push({ text: piece, style: r.style });
      });
    }
    if (word.length) words.push({ parts: word, space: spaceStyle });
    const wordW = (w) => w.parts.reduce((s, p) => s + partW(p, size), 0);
    const lines = []; let line = [], lw = 0;
    for (const w of words) {
      const add = (line.length ? spaceW(w.space, size) : 0) + wordW(w);
      if (line.length && lw + add > width) { lines.push({ words: line, w: lw }); line = [w]; lw = wordW(w); }
      else { line.push(w); lw += add; }
    }
    if (line.length) lines.push({ words: line, w: lw });
    return lines;
  }

  for (const [i, blocks] of pages.entries()) {
    const n = i + 1;
    const page = doc.addPage([mm(PAGE.w), mm(PAGE.h)]);
    const left = n % 2 ? M.spine : M.outer;            // odd pages are right-hand pages: spine on the left
    const centred = blocks.some((b) => b.type === 'logo');
    const X = (x) => mm(left + x);
    const Y = (y) => mm(PAGE.h - M.head - y);
    const plain = (s, x, y, font, size, spacing = 0) => {
      if (spacing) page.pushOperators(setCharacterSpacing(spacing));
      page.drawText(s, { x: X(x), y: Y(y), font, size, color: BLACK });
      if (spacing) page.pushOperators(setCharacterSpacing(0));
    };
    const spacedW = (s, size, spacing) => ptMm(fonts.regular.widthOfTextAtSize(s, size) + spacing * s.length);
    const alignX = (w, indent = 0) => (centred ? (W - w) / 2 : indent);
    const drawLines = (lines, x0, y0, size, lead) => lines.forEach((l, j) => {
      let x = x0 + (centred ? (W - l.w) / 2 : 0);
      const y = y0 + j * lead;
      l.words.forEach((w, k) => {
        if (k) x += spaceW(w.space, size);
        for (const p of w.parts) {
          if (p.style === 'bold') page.pushOperators(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(0.25), setStrokingColor(BLACK));
          page.drawText(p.text, { x: X(x), y: Y(y), font: fonts[p.style], size, color: BLACK });
          if (p.style === 'bold') page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
          x += partW(p, size);
        }
      });
    });

    // measure every block: its height, the gap above it, and how to draw it at a given top
    const items = [];
    let prev = null;
    for (const b of blocks) {
      const gap = !prev || prev === 'space' ? 0
        : { h1: 6, h2: prev === 'h1' ? 1.5 : 4.2, p: prev === 'h2' ? 1.2 : prev === 'h1' ? 2.5 : 2.2, li: prev === 'li' ? 0.8 : 1.5,
            logo: 3, tagline: 2.2, script: 2.5, photo: 3 }[b.type] ?? 0;
      prev = b.type;
      if (b.type === 'space') { items.push({ space: true, h: 0, gap: 0 }); continue; }
      if (b.type === 'p' || b.type === 'li') {
        const indent = b.type === 'li' ? 3.5 : 0;
        const lines = wrap(b.runs, W - indent, BODY.size);
        items.push({ gap, h: lines.length * BODY.lead, draw: (top) => {
          const base = top + ptMm(BODY.size) * 0.85;
          if (indent) plain('–', 0, base, fonts.regular, BODY.size);
          drawLines(lines, indent, base, BODY.size, BODY.lead);
        } });
      } else if (b.type === 'h1') {
        const s = b.runs.map((r) => r.text).join('');
        items.push({ gap, h: ptMm(H1) * 1.05, draw: (top) => drawOutlined(page, script, s, X(alignX(scriptWidth(script, s, H1))), Y(top + ptMm(H1) * 0.78), H1, BLACK) });
      } else if (b.type === 'h2') {
        const s = b.runs.map((r) => r.text).join('').toUpperCase();
        items.push({ gap, h: ptMm(H2) * 1.2, draw: (top) => plain(s, alignX(spacedW(s, H2, 0.9)), top + ptMm(H2) * 0.85, fonts.regular, H2, 0.9) });
      } else if (b.type === 'logo') {
        const name = cfg.site.contact.name;
        const size = (W * 0.92 / scriptWidth(script, name, 10)) * 10;
        items.push({ gap, h: ptMm(size) * 1.25, draw: (top) => drawOutlined(page, script, name, X((W - scriptWidth(script, name, size)) / 2), Y(top + ptMm(size) * 0.82), size, BLACK) });
      } else if (b.type === 'tagline') {
        const s = cfg.site.tagline.toUpperCase();
        items.push({ gap, h: ptMm(TAGLINE) * 1.2, draw: (top) => plain(s, alignX(spacedW(s, TAGLINE, 1.4)), top + ptMm(TAGLINE) * 0.85, fonts.regular, TAGLINE, 1.4) });
      } else if (b.type === 'script') {
        const size = Math.min(SCRIPT, (W / scriptWidth(script, b.arg, SCRIPT)) * SCRIPT);
        items.push({ gap, h: ptMm(size) * 1.3, draw: (top) => drawOutlined(page, script, b.arg, X(alignX(scriptWidth(script, b.arg, size))), Y(top + ptMm(size) * 0.85), size, BLACK) });
      } else if (b.type === 'photo') {
        const { jpg, aspect } = await laserPhoto(b.arg, W);
        const img = await doc.embedJpg(jpg);
        const capLines = b.caption ? wrap([{ text: b.caption, style: 'italic' }], W, CAPTION) : [];
        const capH = capLines.length ? 2.5 + capLines.length * ptMm(CAPTION) * 1.4 : 0;
        items.push({ gap, photo: true, aspect, capH, h: 0, draw: (top, h) => {
          const w = Math.min(W, h * aspect), ph = w / aspect;
          page.drawImage(img, { x: X((W - w) / 2), y: Y(top + ph), width: mm(w), height: mm(ph) });
          drawCaption(capLines, top + ph + 2.5 + ptMm(CAPTION) * 0.85);
        } });
      }
    }
    function drawCaption(lines, y) {
      lines.forEach((l, j) => {
        let x = (W - l.w) / 2;
        l.words.forEach((w, k) => {
          if (k) x += spaceW('italic', CAPTION);
          for (const p of w.parts) { page.drawText(p.text, { x: X(x), y: Y(y + j * ptMm(CAPTION) * 1.4), font: fonts.italic, size: CAPTION, color: BLACK }); x += partW(p, CAPTION); }
        });
      });
    }

    // a picture takes the room that is left (up to its natural height); {{space}} lines share what remains after that
    const fixed = items.reduce((s, it) => s + it.gap + it.h + (it.photo ? it.capH : 0), 0);
    for (const it of items.filter((x) => x.photo)) it.h = Math.min(W / it.aspect, H - fixed);
    const used = items.reduce((s, it) => s + it.gap + it.h + (it.photo ? it.capH : 0), 0);
    const spaces = items.filter((x) => x.space).length;
    if (used > H + 0.01) console.warn(`  page ${n}: ${(used - H).toFixed(1)} mm too long`);
    let y = 0;
    for (const it of items) {
      y += it.gap;
      if (it.space) { y += Math.max(0, H - used) / spaces; continue; }
      it.draw(y, it.h);
      y += it.h + (it.photo ? it.capH : 0);
    }
    if (!spaces && !centred && used < H - 30) console.log(`  page ${n}: ${(H - used).toFixed(0)} mm free`);

    // folio at the foot, on the outside; not on the covers
    if (n > 1 && n < 8) {
      const s = String(n), w = ptMm(fonts.regular.widthOfTextAtSize(s, FOLIO));
      page.drawText(s, { x: mm(n % 2 ? PAGE.w - M.outer - w : M.outer), y: mm(M.foot - 6.5), font: fonts.regular, size: FOLIO, color: BLACK });
    }
  }
  return doc;
}

/** The 8 pages onto the two sides of an A4 sheet; the top row upside down. */
async function impose(pageBytes) {
  const doc = await PDFDocument.create();
  doc.setTitle('Uri Eugenio — booklet, A4 duplex');
  doc.setAuthor('Uri Eugenio');
  const src = await PDFDocument.load(pageBytes);
  const emb = await doc.embedPdf(pageBytes, src.getPageIndices());
  for (const [side, slots] of Object.entries(SIDES)) {
    const sheet = doc.addPage([mm(SHEET.w), mm(SHEET.h)]);
    // with a short-edge flip the printer turns the back of the sheet upside down: compensate on the back side
    const turn = FLIP_SHORT && side === 'back';
    for (const [n, col, row, upsideDown] of slots) {
      const x = col * PAGE.w, y = row * PAGE.h, rot = upsideDown !== turn;
      const [px, py] = turn ? [SHEET.w - x - PAGE.w, SHEET.h - y - PAGE.h] : [x, y];
      sheet.drawPage(emb[n - 1], rot
        ? { x: mm(px + PAGE.w), y: mm(py + PAGE.h), width: mm(PAGE.w), height: mm(PAGE.h), rotate: degrees(180) }
        : { x: mm(px), y: mm(py), width: mm(PAGE.w), height: mm(PAGE.h) });
    }
  }
  return doc;
}

console.log(`Booklet from ${MD}`);
fs.mkdirSync(OUT, { recursive: true });
const pageBytes = await (await buildPages()).save();
const outputs = [['story-booklet-pages.pdf', pageBytes], ['story-booklet-A4-duplex.pdf', await (await impose(pageBytes)).save()]];
for (const [name, bytes] of outputs) {
  const f = path.join(OUT, name);
  fs.writeFileSync(f, bytes);
  console.log(`  ${f}  (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
console.log(`  print the A4 file double-sided, ${FLIP_SHORT ? 'flip on short edge' : 'flip on long edge'}, at actual size`);
