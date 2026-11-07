import {
  OVERPASS_ENDPOINTS,
  OVERPASS_QUERY,
  parseOverpass,
  cityCounts,
  findCityCenter,
  searchDispensaries,
  dispensariesFromCsv,
  mapsUrl,
} from './lib.js';

const CACHE_KEY = 'or-dispensaries:osm:v1';
const IMPORT_KEY = 'or-dispensaries:csv:v1';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OREGON_CENTER = [44.0, -120.5];

const $ = (id) => document.getElementById(id);
const els = {
  form: $('search'), city: $('city'), radius: $('radius'), text: $('text'),
  nearMe: $('near-me'), clear: $('clear'), status: $('status'),
  title: $('result-title'), count: $('result-count'), results: $('results'),
  cityList: $('city-list'), chips: $('city-chips'), dataInfo: $('data-info'),
  refresh: $('refresh'), csv: $('csv'), resetImport: $('reset-import'),
  tpl: $('card-tpl'), map: $('map'),
};

const state = {
  osm: { dispensaries: [], places: [], fetchedAt: 0 },
  imported: null, // { dispensaries, name, importedAt }
  userLocation: null,
  loadError: '',
};

// ---------------------------------------------------------------------------
// Storage helpers (storage can be unavailable in private mode)
// ---------------------------------------------------------------------------
function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore quota/private mode */ }
}
function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

function activeList() {
  return state.imported ? state.imported.dispensaries : state.osm.dispensaries;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function fetchOverpass() {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 100_000);
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: OVERPASS_QUERY }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const parsed = parseOverpass(json);
      if (!parsed.dispensaries.length) throw new Error('no results');
      return parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All map servers failed');
}

async function loadOsm({ force = false } = {}) {
  const cached = load(CACHE_KEY);
  if (cached?.dispensaries?.length) {
    state.osm = cached;
    if (!force && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) return;
  }
  els.refresh.disabled = true;
  setStatus(cached ? 'Checking for updated listings…' : 'Downloading every dispensary in Oregon (this takes a few seconds the first time)…');
  try {
    const parsed = await fetchOverpass();
    state.osm = { ...parsed, fetchedAt: Date.now() };
    save(CACHE_KEY, state.osm);
    state.loadError = '';
  } catch (err) {
    console.error(err);
    const msg = state.osm.dispensaries.length
      ? 'Could not refresh listings right now; showing the saved copy.'
      : 'Could not reach the OpenStreetMap servers. Check your connection and press “Refresh”, or import a CSV list.';
    state.loadError = msg;
    setStatus(msg, true);
    return false;
  } finally {
    els.refresh.disabled = false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
let map = null;
let markerLayer = null;
const markersById = new Map();

function initMap() {
  if (!window.L) {
    els.map.classList.add('no-map');
    els.map.textContent = 'Map unavailable offline — the list still works.';
    return;
  }
  map = L.map(els.map, { scrollWheelZoom: false }).setView(OREGON_CENTER, 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

function renderMap(list, center) {
  if (!map) return;
  markerLayer.clearLayers();
  markersById.clear();
  const pts = [];
  for (const d of list) {
    if (d.lat == null) continue;
    const m = L.circleMarker([d.lat, d.lon], {
      radius: 7, weight: 2, color: '#1f5f3f', fillColor: '#3fae73', fillOpacity: 0.85,
    });
    const popup = document.createElement('div');
    const b = document.createElement('strong');
    b.textContent = d.name;
    popup.append(b, document.createElement('br'), [d.address, d.city].filter(Boolean).join(', '));
    m.bindPopup(popup);
    m.on('click', () => highlightCard(d.id));
    m.addTo(markerLayer);
    markersById.set(d.id, m);
    pts.push([d.lat, d.lon]);
  }
  if (state.userLocation) {
    L.circleMarker([state.userLocation.lat, state.userLocation.lon], {
      radius: 8, weight: 3, color: '#1a5fb4', fillColor: '#62a0ea', fillOpacity: 1,
    }).bindPopup('You are here').addTo(markerLayer);
  }
  if (pts.length) {
    if (center) pts.push([center.lat, center.lon]);
    map.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
  } else if (center) {
    map.setView([center.lat, center.lon], 11);
  } else {
    map.setView(OREGON_CENTER, 6);
  }
}

function highlightCard(id) {
  document.querySelectorAll('.card.active').forEach((c) => c.classList.remove('active'));
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  if (!href.startsWith('tel:')) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
}

function safeWebsite(url) {
  if (!url) return '';
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(u).href; } catch { return ''; }
}

const MAX_CARDS = 300;

function renderList(list) {
  els.results.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No dispensaries found. Try a nearby city or widen the range.';
    els.results.append(li);
    return;
  }
  for (const d of list.slice(0, MAX_CARDS)) {
    const node = els.tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = d.id;
    const h = node.querySelector('.name');
    h.textContent = d.name;
    if (d.medical) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Medical';
      h.append(tag);
    }
    if (d.delivery) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Delivery';
      h.append(tag);
    }
    const cityLine = [d.city, 'OR', d.zip].filter(Boolean).join(' ').replace(' OR', ', OR');
    node.querySelector('.addr').textContent = [d.address, cityLine].filter(Boolean).join(', ');

    const meta = [];
    if (d.distance != null) meta.push(`${d.distance.toFixed(1)} mi away`);
    if (!d.cityFromAddress && d.nearestPlace) meta.push(`City estimated: near ${d.nearestPlace}`);
    if (d.license) meta.push(`License ${d.license}`);
    node.querySelector('.meta').textContent = meta.join(' · ');
    node.querySelector('.hours').textContent = d.hours ? `Hours: ${d.hours}` : '';

    const links = node.querySelector('.card-links');
    links.append(link(mapsUrl(d), 'Directions'));
    if (d.phone) links.append(link(`tel:${d.phone.replace(/[^\d+]/g, '')}`, d.phone));
    const site = safeWebsite(d.website);
    if (site) links.append(link(site, 'Website'));

    node.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const m = markersById.get(d.id);
      if (m && map) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 14)); m.openPopup(); }
      highlightCard(d.id);
    });
    els.results.append(node);
  }
  if (list.length > MAX_CARDS) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Showing the first ${MAX_CARDS} of ${list.length}. Search by city to narrow it down.`;
    els.results.append(li);
  }
}

function renderCities() {
  const counts = cityCounts(activeList());
  els.cityList.replaceChildren(...counts.map((c) => Object.assign(document.createElement('option'), { value: c.name })));
  els.chips.replaceChildren(
    ...counts.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.name;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = c.count;
      b.append(n);
      b.addEventListener('click', () => {
        els.city.value = c.name;
        els.text.value = '';
        state.userLocation = null;
        runSearch();
        els.form.scrollIntoView({ behavior: 'smooth' });
      });
      return b;
    }),
  );
}

function renderDataInfo() {
  if (state.imported) {
    els.dataInfo.textContent = `Showing ${state.imported.dispensaries.length} dispensaries from your imported file “${state.imported.name}” (imported ${new Date(state.imported.importedAt).toLocaleDateString()}).`;
    els.resetImport.hidden = false;
  } else {
    const n = state.osm.dispensaries.length;
    els.dataInfo.textContent = n
      ? `${n} dispensaries from OpenStreetMap, last updated ${new Date(state.osm.fetchedAt).toLocaleString()}.`
      : 'No listings loaded yet.';
    els.resetImport.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function readUrl() {
  const p = new URLSearchParams(location.search);
  els.city.value = p.get('city') || '';
  els.radius.value = ['0', '5', '10', '25', '50'].includes(p.get('within')) ? p.get('within') : '0';
  els.text.value = p.get('q') || '';
}

function writeUrl() {
  const p = new URLSearchParams();
  if (els.city.value.trim()) p.set('city', els.city.value.trim());
  if (els.radius.value !== '0') p.set('within', els.radius.value);
  if (els.text.value.trim()) p.set('q', els.text.value.trim());
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function runSearch() {
  const list = activeList();
  const city = els.city.value.trim();
  const text = els.text.value.trim();
  let radius = Number(els.radius.value);
  let center = null;
  let title;

  if (state.userLocation) {
    center = state.userLocation;
    if (!radius) radius = 10;
    title = `Within ${radius} mi of your location`;
  } else if (city) {
    center = findCityCenter(city, state.osm.places, list);
    title = radius && center ? `Within ${radius} mi of ${center.name}` : `Dispensaries in ${city}`;
    if (radius && !center) {
      radius = 0;
      title = `Dispensaries in ${city}`;
    }
  } else {
    radius = 0;
    title = 'All Oregon dispensaries';
  }

  // For "in city" searches, sort by distance from the city center only if we have it.
  const results = searchDispensaries(list, {
    city: radius ? '' : city,
    text,
    radius,
    center: radius ? center : null,
  });

  els.title.textContent = title;
  els.count.textContent = `${results.length} found`;
  renderList(results);
  renderMap(results, radius ? center : null);
  writeUrl();

  if (list.length) {
    if (city && !radius && !results.length) {
      setStatus(`No dispensaries listed in “${city}”. Try “Within 10 mi” to include nearby towns.`);
    } else {
      setStatus(state.loadError, Boolean(state.loadError));
    }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  state.userLocation = null;
  runSearch();
});
els.radius.addEventListener('change', runSearch);
els.city.addEventListener('change', () => { state.userLocation = null; runSearch(); });

els.clear.addEventListener('click', () => {
  els.city.value = '';
  els.text.value = '';
  els.radius.value = '0';
  state.userLocation = null;
  runSearch();
});

els.nearMe.addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Location is not available in this browser.', true); return; }
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'you' };
      els.city.value = '';
      if (els.radius.value === '0') els.radius.value = '10';
      runSearch();
    },
    () => setStatus('Could not get your location. Allow location access or search by city.', true),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
  );
});

els.refresh.addEventListener('click', async () => {
  const ok = await loadOsm({ force: true });
  if (ok) setStatus(`Updated: ${state.osm.dispensaries.length} dispensaries loaded.`);
  renderCities();
  renderDataInfo();
  if (!state.imported) runSearch();
});

els.csv.addEventListener('change', async () => {
  const file = els.csv.files?.[0];
  if (!file) return;
  try {
    const dispensaries = dispensariesFromCsv(await file.text());
    state.imported = { dispensaries, name: file.name, importedAt: Date.now() };
    save(IMPORT_KEY, state.imported);
    setStatus(`Imported ${dispensaries.length} dispensaries from ${file.name}.`);
    renderCities();
    renderDataInfo();
    runSearch();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, true);
  } finally {
    els.csv.value = '';
  }
});

els.resetImport.addEventListener('click', () => {
  state.imported = null;
  remove(IMPORT_KEY);
  renderCities();
  renderDataInfo();
  runSearch();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function start() {
  initMap();
  readUrl();
  state.imported = load(IMPORT_KEY);
  const cached = load(CACHE_KEY);
  if (cached?.dispensaries?.length) {
    // Show cached data instantly, then refresh in the background if stale.
    state.osm = cached;
    renderCities();
    renderDataInfo();
    runSearch();
  }
  const ok = await loadOsm();
  renderCities();
  renderDataInfo();
  runSearch();
})();
