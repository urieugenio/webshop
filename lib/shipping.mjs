// Shipping costs from shipping.json. Used by the build (the countries offered, the shipping page) and by the Worker
// (the amount charged at checkout). site/app.js has a copy of shippingQuote() to show the cost in the cart.

// The countries Stripe Checkout can collect a shipping address for (shipping_address_collection.allowed_countries)
export const STRIPE_COUNTRIES = (
  'AC AD AE AF AG AI AL AM AO AQ AR AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CD CF CG CH CI CK CL CM CN CO CR CV CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FO FR GA GB GD GE ' +
  'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH KI KM ' +
  'KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MK ML MM MN MO MQ MR MS MT MU MV MW MX MY MZ NA ' +
  'NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI ' +
  'SJ SK SL SM SN SO SR SS ST SV SX SZ TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG ' +
  'VN VU WF WS XK YE YT ZA ZM ZW ZZ').split(' ');

// no postal delivery: Antarctica, Bouvet Island, South Georgia, French Southern Territories; ZZ = unknown
const NO_POST = ['AQ', 'BV', 'GS', 'TF', 'ZZ'];

/** the rates of a country (an array per weight band), or null when it is not offered */
export function ratesFor(T, country) {
  if (T.exclude.includes(country) || NO_POST.includes(country) || !STRIPE_COUNTRIES.includes(country)) return null;
  const c = T.aliases[country] || country;
  if (T.rates[c]) return T.rates[c];
  if (country === 'NL') return null; // domestic: only with its own rate
  return T.rates[T.europe.includes(country) ? 'otherEurope' : 'otherWorld'];
}

/** every country offered, as ISO codes */
export const shippingCountries = (T) => STRIPE_COUNTRIES.filter((c) => ratesFor(T, c));

/** the weight band (index into a country's rates) of a parcel with this many pieces */
const band = (T, n) => T.bands.findIndex((max) => n * T.gramsPerPiece <= max);
export const piecesPerParcel = (T) => Math.floor(T.maxParcelGrams / T.gramsPerPiece);

/**
 * Shipping for `pieces` pieces worth `goods` cents to `country`:
 * { cents, parcels, label } or null when the country is not offered.
 */
export function shippingQuote(T, country, pieces, goods) {
  const rates = ratesFor(T, country);
  if (!rates || pieces < 1) return null;
  const per = piecesPerParcel(T);
  const parcels = Math.ceil(pieces / per);
  let cents = 0;
  for (let left = pieces; left > 0; left -= per) cents += Math.round(rates[band(T, Math.min(left, per))] * 100);
  const extra = T.surcharge[country];
  if (extra) cents += Math.round((goods * extra.percentOfGoods) / 100);
  const label = `${T.product}${parcels > 1 ? ` (${parcels} parcels)` : ''}${extra ? `, ${extra.label}` : ''}`;
  return { cents, parcels, label };
}
