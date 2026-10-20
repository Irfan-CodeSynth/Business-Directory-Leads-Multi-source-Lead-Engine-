/**
 * Shared search vocabulary for the structured run form. The web app builds a
 * SearchSpec, stores it on `jobs.search_spec`, and every adapter reads the same
 * fields — so the form's Category/Country/City fields mean one thing across
 * OpenStreetMap, Yelp, HotFrog, and the Google Maps actor planned next.
 */

export interface SearchSpec {
  keyword: string;
  /** A CATEGORIES id, or "any" when the keyword alone should drive the query. */
  category: string;
  /** ISO 3166-1 alpha-2, uppercase. Paid sources route on this; OSM names it. */
  country: string;
  state: string | null;
  city: string;
}

export interface Country {
  code: string;
  name: string;
}

export interface CategoryMeta {
  id: string;
  label: string;
  /**
   * Overpass tag clauses added to the keyword selectors in the OSM adapter.
   * Empty for "any": the keyword map and name pattern carry the whole query.
   */
  osmTags: string[];
}

// Sorted by name — the form renders the list as-is.
const COUNTRY_ROWS: [string, string][] = [
  ["AF", "Afghanistan"],
  ["AL", "Albania"],
  ["DZ", "Algeria"],
  ["AD", "Andorra"],
  ["AO", "Angola"],
  ["AG", "Antigua and Barbuda"],
  ["AR", "Argentina"],
  ["AM", "Armenia"],
  ["AW", "Aruba"],
  ["AU", "Australia"],
  ["AT", "Austria"],
  ["AZ", "Azerbaijan"],
  ["BS", "Bahamas"],
  ["BH", "Bahrain"],
  ["BD", "Bangladesh"],
  ["BB", "Barbados"],
  ["BY", "Belarus"],
  ["BE", "Belgium"],
  ["BZ", "Belize"],
  ["BJ", "Benin"],
  ["BM", "Bermuda"],
  ["BT", "Bhutan"],
  ["BO", "Bolivia"],
  ["BA", "Bosnia and Herzegovina"],
  ["BW", "Botswana"],
  ["BR", "Brazil"],
  ["BN", "Brunei"],
  ["BG", "Bulgaria"],
  ["BF", "Burkina Faso"],
  ["BI", "Burundi"],
  ["CV", "Cabo Verde"],
  ["KH", "Cambodia"],
  ["CM", "Cameroon"],
  ["CA", "Canada"],
  ["KY", "Cayman Islands"],
  ["CF", "Central African Republic"],
  ["TD", "Chad"],
  ["CL", "Chile"],
  ["CN", "China"],
  ["CO", "Colombia"],
  ["KM", "Comoros"],
  ["CG", "Congo"],
  ["CD", "Congo (Democratic Republic)"],
  ["CR", "Costa Rica"],
  ["HR", "Croatia"],
  ["CU", "Cuba"],
  ["CW", "Curaçao"],
  ["CY", "Cyprus"],
  ["CZ", "Czechia"],
  ["DK", "Denmark"],
  ["DJ", "Djibouti"],
  ["DM", "Dominica"],
  ["DO", "Dominican Republic"],
  ["EC", "Ecuador"],
  ["EG", "Egypt"],
  ["SV", "El Salvador"],
  ["GQ", "Equatorial Guinea"],
  ["ER", "Eritrea"],
  ["EE", "Estonia"],
  ["SZ", "Eswatini"],
  ["ET", "Ethiopia"],
  ["FO", "Faroe Islands"],
  ["FJ", "Fiji"],
  ["FI", "Finland"],
  ["FR", "France"],
  ["GA", "Gabon"],
  ["GM", "Gambia"],
  ["GE", "Georgia"],
  ["DE", "Germany"],
  ["GH", "Ghana"],
  ["GI", "Gibraltar"],
  ["GR", "Greece"],
  ["GL", "Greenland"],
  ["GD", "Grenada"],
  ["GP", "Guadeloupe"],
  ["GU", "Guam"],
  ["GT", "Guatemala"],
  ["GG", "Guernsey"],
  ["GN", "Guinea"],
  ["GW", "Guinea-Bissau"],
  ["GY", "Guyana"],
  ["HT", "Haiti"],
  ["HN", "Honduras"],
  ["HK", "Hong Kong"],
  ["HU", "Hungary"],
  ["IS", "Iceland"],
  ["IN", "India"],
  ["ID", "Indonesia"],
  ["IR", "Iran"],
  ["IQ", "Iraq"],
  ["IE", "Ireland"],
  ["IM", "Isle of Man"],
  ["IL", "Israel"],
  ["IT", "Italy"],
  ["CI", "Ivory Coast"],
  ["JM", "Jamaica"],
  ["JP", "Japan"],
  ["JE", "Jersey"],
  ["JO", "Jordan"],
  ["KZ", "Kazakhstan"],
  ["KE", "Kenya"],
  ["KI", "Kiribati"],
  ["KW", "Kuwait"],
  ["KG", "Kyrgyzstan"],
  ["LA", "Laos"],
  ["LV", "Latvia"],
  ["LB", "Lebanon"],
  ["LS", "Lesotho"],
  ["LR", "Liberia"],
  ["LY", "Libya"],
  ["LI", "Liechtenstein"],
  ["LT", "Lithuania"],
  ["LU", "Luxembourg"],
  ["MO", "Macau"],
  ["MG", "Madagascar"],
  ["MW", "Malawi"],
  ["MY", "Malaysia"],
  ["MV", "Maldives"],
  ["ML", "Mali"],
  ["MT", "Malta"],
  ["MH", "Marshall Islands"],
  ["MQ", "Martinique"],
  ["MR", "Mauritania"],
  ["MU", "Mauritius"],
  ["MX", "Mexico"],
  ["FM", "Micronesia"],
  ["MD", "Moldova"],
  ["MC", "Monaco"],
  ["MN", "Mongolia"],
  ["ME", "Montenegro"],
  ["MA", "Morocco"],
  ["MZ", "Mozambique"],
  ["MM", "Myanmar"],
  ["NA", "Namibia"],
  ["NR", "Nauru"],
  ["NP", "Nepal"],
  ["NL", "Netherlands"],
  ["NC", "New Caledonia"],
  ["NZ", "New Zealand"],
  ["NI", "Nicaragua"],
  ["NE", "Niger"],
  ["NG", "Nigeria"],
  ["KP", "North Korea"],
  ["MK", "North Macedonia"],
  ["NO", "Norway"],
  ["OM", "Oman"],
  ["PK", "Pakistan"],
  ["PW", "Palau"],
  ["PS", "Palestine"],
  ["PA", "Panama"],
  ["PG", "Papua New Guinea"],
  ["PY", "Paraguay"],
  ["PE", "Peru"],
  ["PH", "Philippines"],
  ["PF", "French Polynesia"],
  ["PL", "Poland"],
  ["PT", "Portugal"],
  ["PR", "Puerto Rico"],
  ["QA", "Qatar"],
  ["RE", "Réunion"],
  ["RO", "Romania"],
  ["RU", "Russia"],
  ["RW", "Rwanda"],
  ["KN", "Saint Kitts and Nevis"],
  ["LC", "Saint Lucia"],
  ["VC", "Saint Vincent and the Grenadines"],
  ["WS", "Samoa"],
  ["SM", "San Marino"],
  ["SA", "Saudi Arabia"],
  ["SN", "Senegal"],
  ["RS", "Serbia"],
  ["SC", "Seychelles"],
  ["SL", "Sierra Leone"],
  ["SG", "Singapore"],
  ["SK", "Slovakia"],
  ["SI", "Slovenia"],
  ["SB", "Solomon Islands"],
  ["SO", "Somalia"],
  ["ZA", "South Africa"],
  ["KR", "South Korea"],
  ["SS", "South Sudan"],
  ["ES", "Spain"],
  ["LK", "Sri Lanka"],
  ["SD", "Sudan"],
  ["SR", "Suriname"],
  ["SE", "Sweden"],
  ["CH", "Switzerland"],
  ["SY", "Syria"],
  ["TW", "Taiwan"],
  ["TJ", "Tajikistan"],
  ["TZ", "Tanzania"],
  ["TH", "Thailand"],
  ["TL", "Timor-Leste"],
  ["TG", "Togo"],
  ["TO", "Tonga"],
  ["TT", "Trinidad and Tobago"],
  ["TN", "Tunisia"],
  ["TR", "Turkey"],
  ["TM", "Turkmenistan"],
  ["TV", "Tuvalu"],
  ["UG", "Uganda"],
  ["UA", "Ukraine"],
  ["AE", "United Arab Emirates"],
  ["GB", "United Kingdom"],
  ["US", "United States"],
  ["UY", "Uruguay"],
  ["UZ", "Uzbekistan"],
  ["VU", "Vanuatu"],
  ["VA", "Vatican City"],
  ["VE", "Venezuela"],
  ["VN", "Vietnam"],
  ["YE", "Yemen"],
  ["ZM", "Zambia"],
  ["ZW", "Zimbabwe"],
];

export const COUNTRIES: Country[] = COUNTRY_ROWS.map(([code, name]) => ({ code, name }));

export const CATEGORIES: CategoryMeta[] = [
  {
    id: "home-services",
    label: "Home Services",
    osmTags: [
      '["craft"="plumber"]',
      '["craft"="electrician"]',
      '["craft"="carpenter"]',
      '["craft"="roofer"]',
      '["craft"="painter"]',
      '["craft"="handyman"]',
      '["craft"="locksmith"]',
      '["craft"="cleaning"]',
      '["craft"="landscaping"]',
      '["craft"="tree_surgeon"]',
      '["craft"="glaziery"]',
      '["office"="moving_company"]',
    ],
  },
  {
    id: "health-medical",
    label: "Health & Medical",
    osmTags: [
      '["amenity"="dentist"]',
      '["amenity"="doctors"]',
      '["amenity"="pharmacy"]',
      '["shop"="pharmacy"]',
      '["amenity"="veterinary"]',
      '["healthcare"="physiotherapist"]',
      '["shop"="optician"]',
      '["healthcare"="chiropractic"]',
    ],
  },
  {
    id: "legal-financial",
    label: "Legal & Financial",
    osmTags: [
      '["office"="lawyer"]',
      '["office"="accountant"]',
      '["office"="insurance_agent"]',
      '["office"="financial_advisor"]',
    ],
  },
  {
    id: "real-estate",
    label: "Real Estate",
    osmTags: ['["office"="estate_agent"]', '["amenity"="estate_agent"]', '["office"="property_management"]'],
  },
  {
    id: "beauty-wellness",
    label: "Beauty & Wellness",
    osmTags: [
      '["shop"="beauty"]',
      '["shop"="hairdresser"]',
      '["shop"="barber"]',
      '["shop"="massage"]',
      '["leisure"="spa"]',
      '["tourism"="spa"]',
      '["leisure"="fitness_centre"]',
    ],
  },
  {
    id: "automotive",
    label: "Automotive",
    osmTags: [
      '["shop"="car_repair"]',
      '["shop"="tyres"]',
      '["shop"="car_wash"]',
      '["shop"="car"]',
      '["shop"="car_parts"]',
      '["shop"="motorcycle_repair"]',
    ],
  },
  {
    id: "food-restaurants",
    label: "Food & Restaurants",
    osmTags: [
      '["amenity"="restaurant"]',
      '["amenity"="cafe"]',
      '["amenity"="bar"]',
      '["amenity"="pub"]',
      '["amenity"="fast_food"]',
      '["shop"="bakery"]',
      '["shop"="deli"]',
    ],
  },
  {
    id: "retail",
    label: "Retail & Shopping",
    osmTags: [
      '["shop"="convenience"]',
      '["shop"="clothes"]',
      '["shop"="furniture"]',
      '["shop"="electronics"]',
      '["shop"="hardware"]',
      '["shop"="florist"]',
      '["shop"="pet"]',
      '["shop"="jewelry"]',
    ],
  },
  { id: "any", label: "Any / All", osmTags: [] },
];

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return COUNTRY_BY_CODE.get(code.toUpperCase()) ?? null;
}

export function categoryById(id: string | null | undefined): CategoryMeta | null {
  if (!id) return null;
  return CATEGORY_BY_ID.get(id) ?? null;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export type ParseSpecResult = { ok: true; spec: SearchSpec } | { ok: false; error: string };

/**
 * Normalises and validates the search spec the web form sends. The API route is
 * the other caller: anything the form missed is rejected here, before a job row
 * exists, instead of surfacing as a zero-lead run.
 */
export function parseSearchSpec(input: unknown): ParseSpecResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "search spec is required" };
  }
  const raw = input as Record<string, unknown>;
  const keyword = clean(raw.keyword);
  const city = clean(raw.city);
  const countryRaw = clean(raw.country);
  if (!keyword) return { ok: false, error: "keyword is required" };
  if (!city) return { ok: false, error: "city is required" };
  if (!countryRaw) return { ok: false, error: "country is required" };
  const country = countryRaw.toUpperCase();
  if (!countryName(country)) return { ok: false, error: `unknown country code: ${countryRaw}` };

  const category = clean(raw.category) ?? "any";
  if (!categoryById(category)) return { ok: false, error: `unknown category: ${category}` };

  return { ok: true, spec: { keyword, category, country, state: clean(raw.state), city } };
}

export function isSearchSpec(value: unknown): value is SearchSpec {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.keyword === "string" && v.keyword.length > 0 &&
    typeof v.category === "string" && v.category.length > 0 &&
    typeof v.country === "string" && /^[A-Z]{2}$/.test(v.country) &&
    (v.state === null || typeof v.state === "string") &&
    typeof v.city === "string" && v.city.length > 0
  );
}

export type LocationStyle = "full" | "short";

/**
 * One line for the adapters' location fields. `full` names the country for
 * Nominatim ("Austin, TX, United States"); `short` omits it for paid actors
 * that take the country as a separate input.
 */
export function locationLine(spec: SearchSpec, style: LocationStyle): string {
  const parts = style === "short" ? [spec.city, spec.state] : [spec.city, spec.state, countryName(spec.country)];
  return parts.filter((p): p is string => !!p).join(", ");
}
