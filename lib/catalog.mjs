// Parser for sources/collection.txt
//
// Format (one rule per line, fields separated by "::"):
//   #file::price::material::description      <- optional header, defines column order
//   *::180::merino::default text              <- "*" matches every file
//   1606-1616::180::merino::text              <- numeric range on the trailing digits of the filename
//   1606,1610,1620-1625::...                  <- several identifiers separated by commas
//   01607::...                                <- plain identifier, matches the END of the filename
//
// More specific rules win over less specific ones (exact > range > "*").
// Rules of equal specificity: the later line wins. Empty fields never overwrite.
// If a line has fewer fields than the header, the first field is the identifier,
// the LAST field is the last column (normally "description"), and the fields in
// between fill the columns from the left (so "*::180::text" = price 180, description "text").

const DEFAULT_HEADER = ['file', 'price', 'material', 'description'];

export function parseCatalog(text) {
  let header = null;
  const rules = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, lineNo) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      if (!header && line.includes('::')) {
        header = line.slice(1).split('::').map((s) => s.trim().toLowerCase()).filter(Boolean);
      }
      return;
    }
    const cols = header || DEFAULT_HEADER;
    const parts = line.split('::').map((s) => s.trim());
    const rec = {};
    if (parts.length >= cols.length) {
      cols.forEach((c, i) => {
        rec[c] = i === cols.length - 1 ? parts.slice(i).join('::') : parts[i];
      });
    } else {
      rec[cols[0]] = parts[0];
      if (parts.length > 1) rec[cols[cols.length - 1]] = parts[parts.length - 1];
      for (let i = 1; i < parts.length - 1; i++) rec[cols[i]] = parts[i];
    }
    const spec = rec[cols[0]] || '';
    delete rec[cols[0]];
    for (const s of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
      rules.push({ matcher: makeMatcher(s), fields: rec, line: lineNo + 1, spec: s });
    }
  });
  return rules;
}

function trailingNumber(name) {
  const m = /(\d+)$/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

function makeMatcher(spec) {
  if (spec === '*') return { specificity: 0, test: () => true };
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(spec);
  if (range) {
    let a = parseInt(range[1], 10), b = parseInt(range[2], 10);
    if (a > b) [a, b] = [b, a];
    return {
      specificity: 1,
      test: (id) => {
        const n = trailingNumber(id);
        return n !== null && n >= a && n <= b;
      },
    };
  }
  const s = spec.toLowerCase().replace(/\.(jpe?g|png|webp|tiff?)$/i, '');
  return { specificity: 2, test: (id) => id.toLowerCase().endsWith(s) };
}

export function resolveItem(id, rules) {
  const hits = rules
    .filter((r) => r.matcher.test(id))
    .sort((x, y) => x.matcher.specificity - y.matcher.specificity || x.line - y.line);
  const out = {};
  for (const r of hits) {
    for (const [k, v] of Object.entries(r.fields)) if (v !== undefined && v !== '') out[k] = v;
  }
  if (out.price !== undefined) {
    const n = parseFloat(String(out.price).replace(/[^\d.,-]/g, '').replace(',', '.'));
    out.price = Number.isFinite(n) ? n : null;
  }
  return out;
}
