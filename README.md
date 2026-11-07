# Oregon Dispensary Finder

**Live app:** https://capolynx.github.io/oregon-dispensary-finder/

A small, dependency-free web app that lists cannabis dispensaries across Oregon and lets you search them by city.

## Features

- **Search by city.** Type a city (with autocomplete) or tap a city in **Browse by city**, which shows how many dispensaries each city has.
- **Range search.** Choose *Within 5 / 10 / 25 / 50 mi* to include nearby towns. Results are sorted by distance.
- **Near me.** Uses your phone's location to show the closest shops.
- **Filter** by name, street or ZIP.
- **Map + list.** Each result has Directions (Google Maps), tap-to-call and Website links, plus hours when known.
- **Shareable links.** The URL keeps the search, e.g. `?city=Bend&within=10`.
- **Works offline after first load.** Listings are cached on the device for 7 days. Use **Refresh** to update them sooner.

## Where the data comes from

The app downloads every shop tagged `shop=cannabis` inside Oregon from **OpenStreetMap** via the free Overpass API, straight from the browser. There is no server and no API key. If a shop has no city in its address, the app assigns it to the nearest city or town and marks it "City estimated".

OpenStreetMap is community-maintained, so some shops may be missing or out of date. For the **official** list, export the Oregon Liquor and Cannabis Commission (OLCC) licensed-retailer list as CSV and use **Import CSV**. Columns are found by their header names, so any CSV with a *name* column and a *city* column works. Address, ZIP, phone, website, license number and latitude/longitude columns are picked up when present. If the file has a license-type column, only *Retailer* rows are kept. Imported data stays in your browser. **Remove imported list** switches back to OpenStreetMap.

## Run it

The app uses ES modules, so serve it over HTTP instead of opening the file directly:

```bash
python3 -m http.server 8080    # then open http://localhost:8080
```

You can host it on any static host (GitHub Pages, Netlify, S3…). Just upload these files. This repo is published with GitHub Pages from the `main` branch.

## Tests

```bash
node --test test/lib.check.mjs
```

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `styles.css` | Styles (light + dark, mobile first) |
| `app.js` | UI, map, loading/caching, geolocation, CSV import |
| `lib.js` | Pure logic: Overpass parsing, city inference, search, CSV parsing |
| `test/lib.check.mjs` | Unit tests for `lib.js` |
