// Colour analysis of the collection photos, used by the backoffice.
//
// Every beanie is photographed the same way, so the colour is measured in fixed areas of the photo
// (config.json colors.analysis, as fractions of width/height):
//   - dominant colour: the front of the crown, above the label. Its pixels are grouped into a few colour
//     clusters (k-means in Lab colour space); the largest one is mapped to the nearest palette colour;
//   - multi: the crown plus the side right of the label, split into two colour groups. A plain piece splits
//     into lit and shaded yarn of one colour, a multicoloured one into two clearly different colours.
// The darkest pixels (the shadows between the stitches) are ignored.
// Calibrated on the first 145 photos: the dominant colour is almost always right; "multi" agrees with a
// human eye for about 9 out of 10 pieces (soft pastel speckles are the usual miss). The backoffice can correct both.

import sharp from 'sharp';

// ---------------------------------------------------------------- colour math
const hexToRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgbToHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

function rgbToLab([r, g, b]) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const gam = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return [gam(3.2406 * X - 1.5372 * Y - 0.4986 * Z), gam(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), gam(0.0557 * X - 0.2040 * Y + 1.0570 * Z)];
}

/**
 * CIEDE2000 colour difference: how different two colours look (≈1 just visible, >30 clearly different colours).
 * kL > 1 counts lightness differences less (a shadow on the same yarn is not another colour).
 */
export function deltaE([L1, a1, b1], [L2, a2, b2], kL = 1) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G), ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (b, a) => { if (!a && !b) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const h1 = hp(b1, ap1), h2 = hp(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dh * rad / 2);
  const Lm = (L1 + L2) / 2, Cpm = (Cp1 + Cp2) / 2;
  let hm = h1 + h2;
  if (Cp1 * Cp2) { hm = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2; }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cpm, SH = 1 + 0.015 * Cpm * T;
  const RT = -2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / (kL * SL)) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

// ---------------------------------------------------------------- clustering
/** k-means on Lab pixels, lightness counted at half weight (folds and shadows change lightness, not colour) */
function kmeans(px, k, iterations = 12) {
  const d2 = (p, c) => ((p[0] - c[0]) * 0.5) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
  // deterministic start: the median pixel, then each time the pixel farthest from all centres so far
  const centres = [px[Math.floor(px.length / 2)].slice()];
  while (centres.length < k) {
    let best = null, bestD = -1;
    for (const p of px) { const d = Math.min(...centres.map((c) => d2(p, c))); if (d > bestD) { bestD = d; best = p; } }
    centres.push(best.slice());
  }
  let assign = new Array(px.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    assign = px.map((p) => { let bi = 0, bd = Infinity; centres.forEach((c, i) => { const d = d2(p, c); if (d < bd) { bd = d; bi = i; } }); return bi; });
    const sums = centres.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => { const s = sums[assign[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; });
    sums.forEach((s, i) => { if (s[3]) centres[i] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = centres.map(() => 0);
  assign.forEach((a) => counts[a]++);
  return centres.map((c, i) => ({ lab: c, share: counts[i] / px.length })).filter((c) => c.share > 0);
}

/** merge clusters that look alike, largest first */
function mergeSimilar(clusters, maxDelta) {
  const out = [];
  for (const c of [...clusters].sort((a, b) => b.share - a.share)) {
    const same = out.find((o) => deltaE(o.lab, c.lab) < maxDelta);
    if (!same) { out.push({ ...c }); continue; }
    const t = same.share + c.share;
    same.lab = same.lab.map((v, i) => (v * same.share + c.lab[i] * c.share) / t);
    same.share = t;
  }
  return out.sort((a, b) => b.share - a.share);
}

// ---------------------------------------------------------------- palette
/** the palette colour that looks most like this Lab colour; a palette entry may list several reference colours */
export function nearestPaletteColor(lab, palette) {
  let best = null, bestD = Infinity;
  for (const p of palette) {
    for (const hex of [].concat(p.refs || p.hex)) {
      const d = deltaE(lab, rgbToLab(hexToRgb(hex)));
      if (d < bestD) { bestD = d; best = p.name; }
    }
  }
  return best;
}

// ---------------------------------------------------------------- analysis
// all positions are fractions of the photo's width/height: [left, top, right, bottom]
export const DEFAULTS = {
  region: [0.30, 0.08, 0.80, 0.22],                                  // dominant colour: front of the crown, above the label
  multiRegions: [[0.30, 0.08, 0.80, 0.22], [0.47, 0.22, 0.80, 0.58]], // multi: the crown plus the side right of the label
  multiDelta: 18.3,    // two colours at least this different (CIEDE2000, lightness at half weight) make a piece "multi"
  multiShare: 0.1,     // ... when the smaller of the two covers at least this part of the area
};

/** the Lab pixels of some areas of the photo, without the darkest part (the shadows between the stitches) */
async function pixels(file, regions, darkCut) {
  const m = await sharp(file, { failOn: 'none' }).metadata();
  const [W, H] = m.orientation >= 5 ? [m.height, m.width] : [m.width, m.height];
  let px = [];
  for (const [x0, y0, x1, y1] of regions) {
    const box = { left: Math.round(x0 * W), top: Math.round(y0 * H), width: Math.round((x1 - x0) * W), height: Math.round((y1 - y0) * H) };
    const scale = 3 * W / 1080; // about 360 px across the whole photo: stitches stay visible, shot noise averages out
    const { data, info } = await sharp(file, { failOn: 'none' }).rotate().extract(box)
      .resize(Math.max(8, Math.round(box.width / scale)), Math.max(8, Math.round(box.height / scale)))
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) px.push(rgbToLab([data[i], data[i + 1], data[i + 2]]));
  }
  px.sort((a, b) => a[0] - b[0]);
  return px.slice(Math.floor(px.length * darkCut));
}

/**
 * Measure one photo.
 *   hex   : the dominant colour as measured
 *   color : the name of the nearest palette colour
 *   multi : true when the piece clearly has (at least) two colours
 */
export async function analyseColor(file, palette, options = {}) {
  const o = { ...DEFAULTS, ...options };
  // dominant: the largest of a few colour clusters of the crown
  const crown = await pixels(file, [o.region], 0.2);
  const main = mergeSimilar(kmeans(crown, 4), 12)[0];
  // multi: split the larger area in two colour groups; a plain piece splits into lit and shaded yarn of the
  // same colour, a multicoloured one into its two colours, which differ much more in colour than in lightness
  const two = kmeans(await pixels(file, o.multiRegions, 0.1), 2).filter((c) => c.share >= o.multiShare);
  const contrast = two.length === 2 ? deltaE(two[0].lab, two[1].lab, 2) : 0;
  return {
    hex: rgbToHex(labToRgb(main.lab)),
    color: nearestPaletteColor(main.lab, palette),
    multi: contrast >= o.multiDelta,
    contrast: +contrast.toFixed(1),
  };
}
