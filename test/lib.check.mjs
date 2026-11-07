// Run with: node --test dispensary-finder/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOverpass,
  searchDispensaries,
  cityCounts,
  findCityCenter,
  dispensariesFromCsv,
  parseCsv,
  distanceMiles,
  normalizeCity,
  mapsUrl,
} from '../lib.js';

// Coordinates are real city centers; the shops are test fixtures.
const overpass = {
  elements: [
    { type: 'node', id: 1, lat: 45.5152, lon: -122.6784, tags: { place: 'city', name: 'Portland' } },
    { type: 'node', id: 2, lat: 44.0582, lon: -121.3153, tags: { place: 'city', name: 'Bend' } },
    { type: 'node', id: 3, lat: 45.4207, lon: -122.6706, tags: { place: 'city', name: 'Lake Oswego' } },
    { type: 'node', id: 4, lat: 44.2726, lon: -121.1739, tags: { place: 'city', name: 'Redmond' } },
    {
      type: 'node', id: 10, lat: 45.52, lon: -122.68,
      tags: { shop: 'cannabis', name: 'Rose Shop', 'addr:housenumber': '100', 'addr:street': 'SW Main St', 'addr:city': 'PORTLAND', 'addr:postcode': '97204', phone: '+1 503-555-0100', opening_hours: 'Mo-Su 08:00-22:00' },
    },
    {
      type: 'way', id: 11, center: { lat: 45.51, lon: -122.66 },
      tags: { shop: 'cannabis', name: 'Eastside Leaf', website: 'eastside.example' },
    },
    // Same shop mapped twice (node + building) -> deduplicated
    { type: 'way', id: 12, center: { lat: 45.5201, lon: -122.6801 }, tags: { shop: 'cannabis', name: 'Rose Shop', 'addr:city': 'Portland' } },
    { type: 'node', id: 13, lat: 44.06, lon: -121.31, tags: { shop: 'marijuana', name: 'High Desert', 'addr:city': 'Bend' } },
    { type: 'node', id: 14, lat: 45.42, lon: -122.67, tags: { shop: 'cannabis', name: 'Lakeside', 'addr:city': 'Lake Oswego', delivery: 'yes' } },
    { type: 'relation', id: 15, tags: { shop: 'cannabis', name: 'No coords' } },
  ],
};

test('parseOverpass extracts shops, places, dedupes and infers city', () => {
  const { dispensaries, places } = parseOverpass(overpass);
  assert.equal(places.length, 4);
  assert.equal(dispensaries.length, 4);
  const rose = dispensaries.find((d) => d.name === 'Rose Shop');
  assert.equal(rose.city, 'Portland');
  assert.equal(rose.address, '100 SW Main St');
  assert.equal(rose.zip, '97204');
  assert.equal(rose.cityFromAddress, true);
  const east = dispensaries.find((d) => d.name === 'Eastside Leaf');
  assert.equal(east.city, 'Portland');
  assert.equal(east.cityFromAddress, false);
  assert.equal(dispensaries.find((d) => d.name === 'Lakeside').delivery, true);
});

test('parseOverpass tolerates empty / bad input', () => {
  assert.deepEqual(parseOverpass(null), { dispensaries: [], places: [] });
  assert.deepEqual(parseOverpass({ elements: [] }), { dispensaries: [], places: [] });
});

test('search by city is case/whitespace insensitive', () => {
  const { dispensaries } = parseOverpass(overpass);
  assert.equal(searchDispensaries(dispensaries, { city: '  portland ' }).length, 2);
  assert.equal(searchDispensaries(dispensaries, { city: 'BEND' }).length, 1);
  assert.equal(searchDispensaries(dispensaries, { city: 'lake' }).length, 1, 'prefix fallback');
  assert.equal(searchDispensaries(dispensaries, { city: 'Salem' }).length, 0);
});

test('search within radius includes nearby towns and sorts by distance', () => {
  const { dispensaries, places } = parseOverpass(overpass);
  const center = findCityCenter('Portland', places, dispensaries);
  const res = searchDispensaries(dispensaries, { radius: 10, center });
  assert.deepEqual(res.map((d) => d.name), ['Rose Shop', 'Eastside Leaf', 'Lakeside']);
  assert.ok(res.every((d, i) => i === 0 || d.distance >= res[i - 1].distance));
});

test('text filter matches name, street and zip', () => {
  const { dispensaries } = parseOverpass(overpass);
  assert.equal(searchDispensaries(dispensaries, { text: 'main st' }).length, 1);
  assert.equal(searchDispensaries(dispensaries, { text: '97204' }).length, 1);
  assert.equal(searchDispensaries(dispensaries, { city: 'Portland', text: 'eastside' }).length, 1);
});

test('cityCounts groups by normalized city', () => {
  const { dispensaries } = parseOverpass(overpass);
  assert.deepEqual(cityCounts(dispensaries), [
    { name: 'Bend', count: 1 },
    { name: 'Lake Oswego', count: 1 },
    { name: 'Portland', count: 2 },
  ]);
});

test('findCityCenter falls back to dispensary centroid', () => {
  const ds = [{ city: 'Nowhere', lat: 44, lon: -120 }, { city: 'Nowhere', lat: 46, lon: -122 }];
  assert.deepEqual(findCityCenter('nowhere', [], ds), { lat: 45, lon: -121, name: 'Nowhere' });
  assert.equal(findCityCenter('', [], ds), null);
});

test('distanceMiles is about right (Portland to Bend ≈ 117 mi)', () => {
  const d = distanceMiles(45.5152, -122.6784, 44.0582, -121.3153);
  assert.ok(d > 110 && d < 125, String(d));
});

test('normalizeCity', () => {
  assert.equal(normalizeCity('City of  St. Helens'), 'st helens');
});

test('parseCsv handles quotes, commas, newlines and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""","multi\nline"\r\n\r\n1,2,3');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'multi\nline'], ['1', '2', '3']]);
});

test('dispensariesFromCsv detects columns and keeps retail rows only', () => {
  const csv = [
    'Oregon Liquor and Cannabis Commission - Approved Licenses',
    'LICENSE NUMBER,LICENSEE NAME,BUSINESS NAME,LICENSE TYPE,PREMISES ADDRESS,CITY,ZIP,COUNTY',
    '050-1001,ACME LLC,Green Door,Recreational Retailer,"12 Main St, Ste 3",SALEM,97301,Marion',
    '050-1002,FARM LLC,Grow Co,Recreational Producer,1 Farm Rd,ALBANY,97321,Linn',
    '050-1003,BEE LLC,Buzz,Recreational Retailer,9 Oak Ave,eugene,97401,Lane',
  ].join('\n');
  const list = dispensariesFromCsv(csv);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'Green Door');
  assert.equal(list[0].city, 'Salem');
  assert.equal(list[0].address, '12 Main St, Ste 3');
  assert.equal(list[0].license, '050-1001');
  assert.equal(list[1].city, 'Eugene');
  assert.equal(searchDispensaries(list, { city: 'salem' }).length, 1);
});

test('dispensariesFromCsv rejects files without name/city', () => {
  assert.throws(() => dispensariesFromCsv('foo,bar\n1,2'), /name column and a city column/);
});

test('mapsUrl uses coordinates when present, else address', () => {
  assert.match(mapsUrl({ lat: 45.1, lon: -122.2 }), /query=45\.1%2C-122\.2$/);
  assert.match(mapsUrl({ name: 'A', address: '1 B St', city: 'Salem', lat: null }), /query=A%2C%201%20B%20St%2C%20Salem%2C%20OR$/);
});
