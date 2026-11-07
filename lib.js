// Pure data + search logic for the Oregon Dispensary Finder.
// No DOM access here so it can be unit-tested with `node --test`.

/** Overpass API endpoints, tried in order until one answers. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/**
 * One query returns every cannabis shop in Oregon plus every named
 * city/town/village/hamlet, so shops without an `addr:city` tag can be
 * assigned to the nearest community.
 */
export const OVERPASS_QUERY = `[out:json][timeout:90];
area["ISO3166-2"="US-OR"][admin_level=4]->.or;
(
  nwr["shop"="cannabis"](area.or);
  nwr["shop"="marijuana"](area.or);
  nwr["healthcare"="cannabis"](area.or);
)->.shops;
.shops out center tags;
node["place"~"^(city|town|village|hamlet)$"]["name"](area.or);
out;`;

const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance in miles. */
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

/** Lower-case, trim, collapse whitespace, drop punctuation and a leading "city of". */
export function normalizeCity(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[.,']/g, '')
    .replace(/^city of\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "SALEM" / "lake oswego" -> "Salem" / "Lake Oswego" */
export function titleCase(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    .trim();
}

const PLACE_RANK = { city: 0, town: 1, village: 2, hamlet: 3 };

/** Find the nearest place to a point. Prefers bigger places when they are about as close. */
export function nearestPlace(lat, lon, places) {
  let best = null;
  let bestScore = Infinity;
  for (const p of places) {
    const d = distanceMiles(lat, lon, p.lat, p.lon);
    // A hamlet must be noticeably closer than a city to win.
    const score = d + (PLACE_RANK[p.type] ?? 3) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = { ...p, distance: d };
    }
  }
  return best;
}

function buildAddress(t) {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const line1 = [street, t['addr:unit'] ? `#${t['addr:unit']}` : ''].filter(Boolean).join(' ');
  return line1 || t['addr:full'] || '';
}

/**
 * Turn a raw Overpass JSON response into `{ dispensaries, places }`.
 * Each dispensary gets a `city` (from its address, or the nearest place) and
 * `cityFromAddress` telling which one it is.
 */
export function parseOverpass(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const places = [];
  const shops = [];

  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === 'node' && t.place && t.name && !t.shop && !t.healthcare) {
      places.push({ name: t.name, type: t.place, lat: el.lat, lon: el.lon });
      continue;
    }
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    shops.push({ el, t, lat, lon });
  }

  const seen = new Set();
  const dispensaries = [];
  for (const { el, t, lat, lon } of shops) {
    const name = t.name || t.brand || t['operator'] || 'Unnamed dispensary';
    // De-duplicate the same shop mapped as both a node and a building.
    const key = `${normalizeCity(name)}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const addrCity = t['addr:city'];
    const near = nearestPlace(lat, lon, places);
    const city = addrCity ? titleCase(addrCity) : near?.name || '';

    dispensaries.push({
      id: `${el.type}/${el.id}`,
      name,
      address: buildAddress(t),
      city,
      cityFromAddress: Boolean(addrCity),
      nearestPlace: near?.name || '',
      zip: t['addr:postcode'] || '',
      phone: t.phone || t['contact:phone'] || '',
      website: t.website || t['contact:website'] || '',
      hours: t.opening_hours || '',
      medical: t['healthcare'] === 'cannabis' || /medical/i.test(t.cannabis || ''),
      delivery: t.delivery === 'yes',
      lat,
      lon,
      source: 'OpenStreetMap',
    });
  }

  dispensaries.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
  return { dispensaries, places };
}

/** Sorted list of `{ name, count }` for every city that has at least one dispensary. */
export function cityCounts(dispensaries) {
  const counts = new Map();
  for (const d of dispensaries) {
    if (!d.city) continue;
    const key = normalizeCity(d.city);
    const entry = counts.get(key) || { name: d.city, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up a place (for radius searches) by name; falls back to the dispensaries' own centroid. */
export function findCityCenter(cityName, places, dispensaries = []) {
  const q = normalizeCity(cityName);
  if (!q) return null;
  const matches = places.filter((p) => normalizeCity(p.name) === q);
  if (matches.length) {
    matches.sort((a, b) => (PLACE_RANK[a.type] ?? 3) - (PLACE_RANK[b.type] ?? 3));
    return { lat: matches[0].lat, lon: matches[0].lon, name: matches[0].name };
  }
  const inCity = dispensaries.filter((d) => normalizeCity(d.city) === q && d.lat != null);
  if (!inCity.length) return null;
  const lat = inCity.reduce((s, d) => s + d.lat, 0) / inCity.length;
  const lon = inCity.reduce((s, d) => s + d.lon, 0) / inCity.length;
  return { lat, lon, name: inCity[0].city };
}

/**
 * Filter dispensaries.
 *  - city: exact (normalized) city match, or a prefix match when no exact match exists.
 *  - radius (miles) + center: everything within the radius instead of the city name.
 *  - text: free-text match on name / address / zip.
 * Results carry `distance` when a center is known, and are sorted by it.
 */
export function searchDispensaries(dispensaries, { city = '', text = '', radius = 0, center = null } = {}) {
  const qCity = normalizeCity(city);
  const qText = String(text).toLowerCase().trim();
  let list = dispensaries;

  if (radius > 0 && center) {
    list = list
      .filter((d) => d.lat != null)
      .map((d) => ({ ...d, distance: distanceMiles(center.lat, center.lon, d.lat, d.lon) }))
      .filter((d) => d.distance <= radius);
  } else if (qCity) {
    const exact = list.filter((d) => normalizeCity(d.city) === qCity);
    list = exact.length ? exact : list.filter((d) => normalizeCity(d.city).startsWith(qCity));
  }

  if (qText) {
    list = list.filter((d) =>
      [d.name, d.address, d.zip, d.city].some((v) => String(v || '').toLowerCase().includes(qText)),
    );
  }

  if (center) {
    list = list
      .map((d) => (d.distance != null ? d : d.lat != null ? { ...d, distance: distanceMiles(center.lat, center.lon, d.lat, d.lon) } : d))
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  } else {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  }
  return list;
}

// ---------------------------------------------------------------------------
// CSV import (e.g. the OLCC licensed-retailer list saved as CSV)
// ---------------------------------------------------------------------------

/** RFC-4180-ish CSV parser: handles quotes, escaped quotes, CRLF and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const COLUMN_PATTERNS = {
  name: [/^(business|trade|dba|store|dispensary)[ _]?name$/i, /business name/i, /^name$/i, /licensee/i, /name/i],
  address: [/^(street|physical|premises|site)?[ _]?address( ?1| line ?1)?$/i, /address/i, /street/i],
  city: [/city/i],
  zip: [/zip|postal ?code|postcode/i],
  phone: [/phone/i],
  website: [/web|url/i],
  license: [/license ?(number|no|#)/i, /license/i],
  lat: [/^lat(itude)?$/i],
  lon: [/^(lon|lng|long|longitude)$/i],
  type: [/license ?type|type/i],
};

function pickColumn(headers, patterns, taken) {
  for (const re of patterns) {
    const idx = headers.findIndex((h, i) => !taken.has(i) && re.test(h.trim()));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Convert a CSV (with a header row) into dispensary records.
 * Columns are detected by header names, so most state/agency exports work as-is.
 * If a license-type column exists, only retail rows are kept.
 */
export function dispensariesFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The CSV file has no data rows.');
  // Some exports have title rows above the header; use the first row that mentions a name and a city.
  let headerIdx = rows.findIndex((r) => r.some((h) => /name/i.test(h)) && r.some((h) => /city/i.test(h)));
  if (headerIdx === -1) headerIdx = 0;
  const headers = rows[headerIdx];
  const taken = new Set();
  const cols = {};
  for (const key of ['license', 'type', 'name', 'city', 'zip', 'phone', 'website', 'lat', 'lon', 'address']) {
    cols[key] = pickColumn(headers, COLUMN_PATTERNS[key], taken);
    if (cols[key] !== -1) taken.add(cols[key]);
  }
  if (cols.name === -1 || cols.city === -1) {
    throw new Error('Could not find a name column and a city column in the CSV header row.');
  }

  const get = (r, key) => (cols[key] === -1 ? '' : String(r[cols[key]] ?? '').trim());
  const out = [];
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const name = get(r, 'name');
    const city = get(r, 'city');
    if (!name || !city) return;
    const type = get(r, 'type');
    if (type && !/retail/i.test(type)) return;
    const lat = parseFloat(get(r, 'lat'));
    const lon = parseFloat(get(r, 'lon'));
    out.push({
      id: `csv/${get(r, 'license') || i}`,
      name,
      address: get(r, 'address'),
      city: titleCase(city),
      cityFromAddress: true,
      nearestPlace: '',
      zip: get(r, 'zip'),
      phone: get(r, 'phone'),
      website: get(r, 'website'),
      hours: '',
      license: get(r, 'license'),
      medical: false,
      delivery: false,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      source: 'Imported CSV',
    });
  });
  if (!out.length) throw new Error('No dispensary rows were found in the CSV.');
  return out;
}

/** Build a Google Maps link for a dispensary. */
export function mapsUrl(d) {
  const q = d.lat != null
    ? `${d.lat},${d.lon}`
    : [d.name, d.address, d.city, 'OR', d.zip].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
