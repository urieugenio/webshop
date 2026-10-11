#!/usr/bin/env node
// Makes backoffice/cities.txt, the names for new products, from the GeoNames list of cities with more than
// 15,000 inhabitants (https://download.geonames.org/export/dump/cities15000.zip, CC BY 4.0).
//
//   node backoffice/make-cities.mjs [path to cities15000.txt] [how many, default 10000]
//
// Only countries whose own names are written in the Latin alphabet, only cities and towns (no city districts),
// each name without accents ("Malmö" -> "Malmo"), only names without spaces, digits or brackets,
// each name once, the largest cities first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || path.resolve(HERE, '../../content/sources/cities15000.txt');
const count = Number(process.argv[3]) || 10000;

// ISO country codes of countries (and territories) that write their own place names in the Latin alphabet
const LATIN = new Set(`
  AD AL AT AX BA BE CH CZ DE DK EE ES FI FO FR GB GG GI HR HU IE IM IS IT JE LI LT LU LV MC MD ME MT NL NO PL PT
  RO SE SI SK SM VA XK TR AZ UZ TM
  US CA MX GT BZ SV HN NI CR PA CU JM HT DO PR BS BB TT AG DM GD KN LC VC CO VE EC PE BO CL AR UY PY BR GY SR GF
  GP MQ AW CW SX BQ BM KY TC VG VI MS AI MF BL PM GL FK
  SN GM GW GN SL LR CI ML BF NE GH TG BJ NG CM TD CF GQ GA CG CD AO ZM ZW MW MZ TZ KE UG RW BI SO DJ MG MU SC KM
  CV ST NA BW ZA LS SZ SS RE YT SH
  ID MY PH VN BN TL
  AU NZ PG FJ SB VU WS TO KI TV NR PW FM MH NC PF GU MP AS CK NU WF
`.trim().split(/\s+/));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const cap = (s) => s[0].toUpperCase() + s.slice(1); // "les Escaldes" -> "Les Escaldes"
const LETTERS = { 'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'ß': 'ss', 'ı': 'i', 'đ': 'd', 'Đ': 'D', 'æ': 'ae', 'Æ': 'Ae', 'œ': 'oe', 'þ': 'th', 'ð': 'd', 'ŀ': 'l' };
/** "Neukölln" -> "Neukolln", "Łódź" -> "Lodz" (GeoNames' own ASCII names would give "Neukoelln") */
const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[łŁøØßıđĐæÆœþðŀ]/g, (c) => LETTERS[c])
  .replace(/[‘’`´]/g, "'").replace(/^City of /, '').trim();

const rows = fs.readFileSync(src, 'utf8').split(/\r?\n/).map((l) => l.split('\t')).filter((c) => c.length > 14)
  .map((c) => ({ name: plain(c[1]), code: c[7], country: c[8], population: Number(c[14]) || 0 }))
  .filter((r) => LATIN.has(r.country) && r.code !== 'PPLX') // PPLX: a district of a city (Upper West Side, Amsterdam-Zuid)
  .filter((r) => /^[A-Za-z][A-Za-z.'-]*$/.test(r.name) && r.name.length <= 24)
  .sort((a, b) => b.population - a.population);

const seen = new Set();
const names = [];
for (const r of rows) {
  const name = cap(r.name);
  const k = slug(name);
  if (!k || seen.has(k)) continue;
  seen.add(k);
  names.push(name);
  if (names.length === count) break;
}
names.sort((a, b) => a.localeCompare(b, 'en'));

const header = [
  '# Names for new products in the backoffice: one is picked at random for every new photo.',
  '# Add or remove names freely; lines starting with # are ignored.',
  `# Made by make-cities.mjs from GeoNames (geonames.org, CC BY 4.0): the ${names.length} largest cities`,
  '# of countries that use the Latin alphabet.',
];
fs.writeFileSync(path.join(HERE, 'cities.txt'), header.join('\n') + '\n' + names.join('\n') + '\n');
console.log(`${names.length} names (of ${rows.length} cities in Latin-alphabet countries) -> backoffice/cities.txt`);
