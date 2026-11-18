// Analýza okolí: voda, vlak, autobus, záplavová území, dojezd do Prahy/Plzně.
// Zdroje: OpenStreetMap (Overpass), VÚV T.G.M. (záplavová území, vodní útvary), OSRM (trasy autem), Nominatim (geokódování).
// Běží v prohlížeči přihlášeného vlastníka; externí API volá přes api.php?a=proxy (obchází CORS).
(function (root) {
const VUV = 'https://ags.vuv.cz/arcgis/rest/services/isvs_voda/isvs_voda/MapServer';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const GEO_VERSION = 3; // zvýšit při přidání nových údajů → staré inzeráty se samy přepočítají
const TARGETS = { praha: [50.0833, 14.4213], plzen: [49.7475, 13.3776] }; // Můstek, nám. Republiky

const get = async (url, opt = {}, ms = 30000) => {
  const r = await fetch(`api.php?a=proxy&t=${Math.ceil(ms / 1000)}&u=${encodeURIComponent(url)}`, { headers: { 'X-RM': '1' }, signal: AbortSignal.timeout(ms + 10000) });
  if (!r.ok) throw new Error(`${new URL(url).hostname}: HTTP ${r.status}`);
  return r.json();
};

// --- geometrie: lokální rovinná projekce kolem bodu (přesnost ~0,1 % na pár km) ---
function projector(lat0, lng0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 110540;
  return { to: (lat, lng) => [(lng - lng0) * kx, (lat - lat0) * ky], from: (x, y) => [lat0 + y / ky, lng0 + x / kx] };
}
// nejbližší bod lomené čáry [[lat,lng],...] k počátku projekce → {dist, at:[lat,lng]}
function nearestOnLine(pr, coords) {
  let best = { dist: Infinity, at: null };
  const pts = coords.map(([a, b]) => pr.to(a, b));
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1] || pts[i];
    const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len)) : 0;
    const x = x1 + t * dx, y = y1 + t * dy, d = Math.hypot(x, y);
    if (d < best.dist) best = { dist: d, at: pr.from(x, y) };
  }
  return best;
}
const polyArea = (pr, coords) => {
  const p = coords.map(([a, b]) => pr.to(a, b));
  let s = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s / 2);
};
const haversineKm =(a, b) => {
  const R = 6371, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// zmenšení geometrie pro mapu: vynechá body bližší než ~12 m
function thin(coords) {
  const out = [];
  for (const c of coords) {
    const p = out[out.length - 1];
    if (!p || Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) > 0.00015) out.push([+c[0].toFixed(5), +c[1].toFixed(5)]);
  }
  const last = coords[coords.length - 1];
  if (last && out.length > 1) out[out.length - 1] = [+last[0].toFixed(5), +last[1].toFixed(5)];
  return out;
}

function waterKind(t) {
  if (t.waterway === 'river') return 'řeka';
  if (t.waterway === 'stream') return 'potok';
  if (t.waterway === 'canal') return 'kanál';
  if (t.water === 'pond' || t.water === 'fishpond') return 'rybník';
  if (t.water === 'reservoir') return 'nádrž';
  if (t.water === 'lake') return 'jezero';
  if (t.water === 'river') return 'řeka';
  return 'vodní plocha';
}

// --- OpenStreetMap: voda + zastávky v jednom dotazu, zkouší víc serverů ---
async function overpass(lat, lng) {
  const q = `[out:json][timeout:40];
(way(around:3000,${lat},${lng})[waterway~"^(river|stream|canal)$"];
 way(around:3000,${lat},${lng})[natural=water];
 relation(around:3000,${lat},${lng})[natural=water];)->.w;
.w out geom;
(nwr(around:10000,${lat},${lng})[railway~"^(station|halt)$"];
 node(around:3000,${lat},${lng})[highway=bus_stop];
 nwr(around:12000,${lat},${lng})[shop=supermarket];)->.p;
.p out center tags;`;
  // všechny mirrory najednou, vyhrává první úspěšný (veřejné servery bývají přetížené)
  try {
    return await Promise.any(OVERPASS.map(async (url) => {
      const j = await get(`${url}?data=${encodeURIComponent(q)}`, {}, 30000);
      if (!Array.isArray(j.elements)) throw new Error('neplatná odpověď');
      return j;
    }));
  } catch (e) {
    throw new Error('OpenStreetMap (Overpass) nedostupné: ' + e.errors.map((x) => x.message).join('; '));
  }
}

function analyzeOsm(json, lat, lng) {
  const pr = projector(lat, lng);
  const water = [], stops = { train: [], bus: [] }, shops = [];
  for (const el of json.elements) {
    const t = el.tags || {};
    if (t.shop === 'supermarket') {
      const p = el.center || el;
      shops.push({ name: t.brand || t.name || 'supermarket', lat: p.lat, lng: p.lon, dist: Math.round(Math.hypot(...pr.to(p.lat, p.lon))) });
      continue;
    }
    if (t.railway || t.highway === 'bus_stop') {
      const p = el.center || el;
      const s = { name: t.name || (t.railway ? 'železniční zastávka' : 'zastávka'), lat: p.lat, lng: p.lon, dist: Math.round(Math.hypot(...pr.to(p.lat, p.lon))) };
      (t.railway ? stops.train : stops.bus).push(s);
      continue;
    }
    const lines = el.type === 'way' ? [el.geometry]
      : (el.members || []).filter((m) => m.geometry).map((m) => m.geometry);
    const kind = waterKind(t);
    if (t.water === 'wastewater') continue; // čistírny odpadních vod nejsou "voda u domu"
    for (const g of lines) {
      const coords = g.map((p) => [p.lat, p.lon]);
      if (el.type === 'way' && t.natural === 'water' && polyArea(pr, coords) < 300) continue; // zahradní jezírka, bazény

      const n = nearestOnLine(pr, coords);
      water.push({ kind, name: t.name || null, area: el.type !== 'way' || t.natural === 'water', dist: Math.round(n.dist), at: n.at, coords: thin(coords) });
    }
  }
  return { water, stops, shops };
}

// --- záloha pro supermarkety, když OSM Overpass neodpovídá: Nominatim (vyhledávání v okolním čtverci) ---
async function nominatimShops(lat, lng) {
  const pr = projector(lat, lng);
  for (const d of [0.06, 0.18]) { // ~5 km, pak ~15 km
    const viewbox = [lng - d * 1.5, lat + d, lng + d * 1.5, lat - d].join(',');
    const j = await get(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: 'supermarket', format: 'json', limit: '40', bounded: '1', viewbox })}`, {}, 20000);
    const out = j.filter((x) => x.type === 'supermarket').map((x) => ({ name: x.name || 'supermarket', lat: +x.lat, lng: +x.lon, dist: Math.round(Math.hypot(...pr.to(+x.lat, +x.lon))) }));
    if (out.length) return out;
  }
  return [];
}

// --- veřejná doprava: Transitous (MOTIS, otevřené jízdní řády ČR) ---
// ponytail: odjezd v nejbližší úterý v 7:00 (+01:00); v letním čase o hodinu posun, pro orientaci nevadí
function nextTuesday7() {
  const d = new Date(Date.now() + 864e5);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10) + 'T07:00:00+01:00';
}
async function plan(from, to, modes) {
  const qs = new URLSearchParams({ fromPlace: from.join(','), toPlace: to.join(','), time: nextTuesday7(), transitModes: modes, numItineraries: '5' });
  let j;
  for (let i = 0; ; i++) { // komunitní server omezuje počet dotazů → při HTTP 429 chvíli počkat
    try { j = await get(`https://api.transitous.org/api/v5/plan?${qs}`, {}, 40000); break; }
    catch (e) { if (i >= 3 || !/429/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  const best = (j.itineraries || []).sort((a, b) => a.duration - b.duration)[0];
  if (!best) return null;
  const legs = best.legs.filter((l) => l.mode !== 'WALK');
  return {
    min: Math.round(best.duration / 60),
    transfers: best.transfers,
    depart: new Date(legs[0]?.startTime || best.startTime).toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }),
    lines: legs.map((l) => l.routeShortName || l.mode),
  };
}
// dojít/dojet na zastávku: do 1,5 km pěšky (75 m/min po cestě), dál autem (~35 km/h)
const access = (dist) => (dist <= 1500 ? { mode: 'pěšky', min: Math.round((dist * 1.25) / 75) } : { mode: 'autem', min: Math.round((dist * 1.35) / 580) + 2 });
async function transit(lat, lng, train, bus) {
  const out = {};
  const settle = (p) => p.then((value) => ({ value }), (reason) => ({ status: 'rejected', reason }));
  for (const [k, to] of Object.entries(TARGETS)) { // postupně, ne paralelně (limit serveru)
    const r = (out[k] = {});
    const tr = await settle(train ? plan([train.lat, train.lng], to, 'RAIL,TRAM,SUBWAY') : Promise.resolve(null));
    const bs = await settle(plan([lat, lng], to, 'BUS,COACH,TRAM,SUBWAY').then((p) => p || (bus && plan([bus.lat, bus.lng], to, 'BUS,COACH,TRAM,SUBWAY').then((q) => q && { ...q, fromStop: true }))));
    if (tr.value) { const a = access(train.dist); r.train = { ...tr.value, from: train.name, access: a, total: tr.value.min + a.min }; }
    if (bs.value) {
      const a = bs.value.fromStop ? access(bus.dist) : null;
      r.bus = { ...bs.value, access: a, total: bs.value.min + (a?.min || 0) };
    }
    if (tr.status === 'rejected' || bs.status === 'rejected') r.error = (tr.reason || bs.reason).message;
  }
  return out;
}

// --- PID (Pražská integrovaná doprava): všechny zastávky Prahy a Středočeského kraje i s linkami ---
// Zmenšený seznam (~0,8 MB) drží server; když chybí nebo je starší 30 dní, stáhne se z data.pid.cz (19 MB) a uloží.
let pidStops = null;
async function loadPid() {
  if (pidStops) return pidStops;
  const r = await fetch('api.php?a=pid');
  if (r.ok) return (pidStops = await r.json());
  const j = await get('https://data.pid.cz/stops/json/stops.json', {}, 120000);
  pidStops = j.stopGroups.map((g) => {
    const lines = { train: new Set(), bus: new Set() };
    for (const s of g.stops) for (const l of s.lines || []) (l.type === 'train' ? lines.train : lines.bus).add(l.name);
    return { name: g.name, lat: g.avgLat, lng: g.avgLon, train: [...lines.train], bus: [...lines.bus] };
  }).filter((s) => s.train.length || s.bus.length);
  await fetch('api.php?a=pid', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RM': '1' }, body: JSON.stringify(pidStops) });
  return pidStops;
}
async function pidNearby(lat, lng) {
  const pr = projector(lat, lng);
  const near = (await loadPid()).map((s) => ({ ...s, dist: Math.round(Math.hypot(...pr.to(s.lat, s.lng))) })).filter((s) => s.dist < 10000);
  const pick = (s, kind) => ({ name: s.name, lat: s.lat, lng: s.lng, dist: s.dist, lines: s[kind].slice(0, 8) });
  return {
    train: near.filter((s) => s.train.length).map((s) => pick(s, 'train')),
    bus: near.filter((s) => s.bus.length && s.dist < 3000).map((s) => pick(s, 'bus')),
  };
}

// --- VÚV: řeky a rybné vody (záloha, když OSM neodpoví) ---
async function vuvWater(lat, lng) {
  const d = 0.04; // ~3–4 km
  const env = JSON.stringify({ xmin: lng - d * 1.5, ymin: lat - d, xmax: lng + d * 1.5, ymax: lat + d, spatialReference: { wkid: 4326 } });
  const out = [];
  const pr = projector(lat, lng);
  for (const [layer, kind] of [[6, 'řeka'], [4, 'potok'], [5, 'vodní plocha']]) {
    const qs = new URLSearchParams({ geometry: env, geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'true', outSR: '4326', geometryPrecision: '5', f: 'json' });
    const j = await get(`${VUV}/${layer}/query?${qs}`);
    for (const f of j.features || []) {
      const name = (f.attributes.NAZ_UTVAR || f.attributes.NAZ_RYBV || '').replace(/ od .*| po .*/, '') || null;
      for (const path of f.geometry.paths || f.geometry.rings || []) {
        const coords = path.map(([x, y]) => [y, x]);
        const n = nearestOnLine(pr, coords);
        out.push({ kind, name, area: layer === 5, dist: Math.round(n.dist), at: n.at, coords: thin(coords) });
      }
    }
  }
  return out;
}

// --- VÚV: záplavová území (bod uvnitř / do 200 m) ---
const FLOOD_LAYERS = { ZaplavUzemi_AktivniZony: 'aktivní zóna', ZaplavUzemi_Q5: 'Q5', ZaplavUzemi_Q20: 'Q20', ZaplavUzemi_Q100: 'Q100', ZaplavUzemi_Q500: 'Q500' };
async function floodIdentify(lat, lng, toleranceM) {
  // mapExtent 0,02° × 1000 px → 1 px ≈ 1,4 m; tolerance se zadává v pixelech
  const w = 0.02, mPerPx = (w * 111320 * Math.cos((lat * Math.PI) / 180)) / 1000;
  const qs = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPoint', sr: '4326',
    layers: 'all:11,12,13,14,15', tolerance: String(Math.round(toleranceM / mPerPx)),
    mapExtent: `${lng - w / 2},${lat - w / 2},${lng + w / 2},${lat + w / 2}`, imageDisplay: '1000,1000,96', returnGeometry: 'false', f: 'json',
  });
  const j = await get(`${VUV}/identify?${qs}`);
  if (j.error) throw new Error('VÚV: ' + j.error.message);
  const zones = [...new Set(j.results.map((r) => FLOOD_LAYERS[r.layerName]).filter(Boolean))];
  const river = j.results.map((r) => r.attributes.NAZ_TOK || r.attributes.Naz_tok).find(Boolean) || null;
  return { zones, river };
}
async function flood(lat, lng) {
  const [inside, near] = await Promise.all([floodIdentify(lat, lng, 0), floodIdentify(lat, lng, 200)]);
  const order = ['aktivní zóna', 'Q5', 'Q20', 'Q100', 'Q500'];
  return { inside: order.filter((z) => inside.zones.includes(z)), near200: order.filter((z) => near.zones.includes(z)), river: inside.river || near.river };
}

// --- OSRM: dojezd autem (bez dopravní situace) ---
// --- ČTÚ: simulace pokrytí mobilním signálem (venku), třída 0 = nic … 5 = výborný ---
const CTU_WMS = 'https://vportal.ctu.gov.cz/geo/mc10/wms';
const OPERATORS = { tm: ['01', 'T-Mobile'], o2: ['02', 'O2'], vf: ['03', 'Vodafone'] };
async function signalAt(lat, lng, op, tech) {
  const R = 6378137, x = (lng * Math.PI / 180) * R, y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R, d = 150;
  const layer = `mc10:cp_${OPERATORS[op][0]}_${tech}_t`;
  const qs = new URLSearchParams({ service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo', layers: layer, query_layers: layer, styles: '',
    srs: 'EPSG:3857', bbox: [x - d, y - d, x + d, y + d].join(','), width: '101', height: '101', x: '50', y: '50', info_format: 'application/json' });
  const j = await get(`${CTU_WMS}?${qs}`, {}, 20000);
  return Math.max(0, Math.round(j.features?.[0]?.properties?.GRAY_INDEX ?? 0));
}
async function signal(lat, lng) {
  const out = {};
  for (const op of Object.keys(OPERATORS)) {
    const [g4, g5] = await Promise.all([signalAt(lat, lng, op, '4g'), signalAt(lat, lng, op, '5g')]);
    out[op] = { '4g': g4, '5g': g5 };
  }
  return out;
}

async function drive(lat, lng) {
  const pts = [[lat, lng], ...Object.values(TARGETS)].map(([a, b]) => `${b},${a}`).join(';');
  const j = await get(`https://router.project-osrm.org/table/v1/driving/${pts}?sources=0&annotations=duration,distance`);
  const out = {};
  Object.keys(TARGETS).forEach((k, i) => {
    out[k] = { min: Math.round(j.durations[0][i + 1] / 60), km: Math.round(j.distances[0][i + 1] / 1000) };
  });
  return out;
}

async function geocode(q) {
  const j = await get(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, countrycodes: 'cz', format: 'json', limit: '1' })}`);
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}

const nearest = (arr) => arr.reduce((a, b) => (!a || b.dist < a.dist ? b : a), null);

async function analyze(lat, lng, hint = {}) {
  const errors = [];
  // rychlé dotazy napřed, pomalé OSM až potom – sdílený hosting nemusí zvládat mnoho souběžných proxy požadavků
  const [fl, dr, pid, sig] = await Promise.allSettled([flood(lat, lng), drive(lat, lng), pidNearby(lat, lng), signal(lat, lng)]);
  const [osm] = await Promise.allSettled([overpass(lat, lng)]);
  const geo = { v: GEO_VERSION, updatedAt: new Date().toISOString(), errors };

  let water = [], stops = { train: [], bus: [] }, shops = [];
  if (osm.status === 'fulfilled') ({ water, stops, shops } = analyzeOsm(osm.value, lat, lng));
  else {
    errors.push(osm.reason.message);
    try { shops = await nominatimShops(lat, lng); } catch (e) { errors.push('Supermarkety: ' + e.message); }
    try { water = await vuvWater(lat, lng); geo.waterSource = 'VÚV'; } catch (e) { errors.push('VÚV voda: ' + e.message); }
  }
  const named = water.filter((w) => w.name);
  const rivers = water.filter((w) => w.kind === 'řeka' || (w.area && w.name));
  geo.water = {
    nearest: strip(nearest(water)),
    named: strip(nearest(named)),
    river: strip(nearest(rivers)),
    // na mapu jen vodní prvky do 2 km (kvůli velikosti dat)
    features: water.filter((w) => w.dist < 2000).map(({ kind, name, area, coords }) => ({ kind, name, area, coords })),
  };
  // koryto řeky bývá v OSM bez jména → doplnit jméno z nejbližší pojmenované řeky / záplavového toku
  if (geo.water.river && !geo.water.river.name) {
    geo.water.river.name = nearest(rivers.filter((w) => w.name && w.kind === 'řeka'))?.name
      || (fl.status === 'fulfilled' && fl.value.river) || null;
  }
  // v oblasti PID (Praha + Středočeský kraj) mají přednost data PID – obsahují i čísla linek
  if (pid.status === 'fulfilled' && pid.value.bus.some((s) => s.dist < 3000)) { stops = pid.value; geo.stopsSource = 'PID'; }
  else if (pid.status === 'rejected') errors.push('PID zastávky: ' + pid.reason.message);
  if (geo.stopsSource === 'PID' && osm.status === 'rejected') errors.shift(); // OSM chyba už nevadí, data máme
  geo.train = nearest(stops.train) || hint.train || null;
  geo.bus = nearest(stops.bus) || hint.bus || null;
  geo.busStops500 = stops.bus.filter((s) => s.dist <= 500).length;
  geo.trainStations = stops.train.sort((a, b) => a.dist - b.dist).slice(0, 3);

  // 3 nejbližší supermarkety + čas autem (OSRM)
  geo.shops = shops.sort((a, b) => a.dist - b.dist).slice(0, 3);
  if (geo.shops.length) {
    try {
      const pts = [[lat, lng], ...geo.shops.map((s) => [s.lat, s.lng])].map(([a, b]) => `${b},${a}`).join(';');
      const t = await get(`https://router.project-osrm.org/table/v1/driving/${pts}?sources=0&annotations=duration,distance`);
      geo.shops.forEach((s, i) => { s.carMin = Math.max(1, Math.round(t.durations[0][i + 1] / 60)); s.roadKm = +(t.distances[0][i + 1] / 1000).toFixed(1); });
    } catch {}
  }
  try { geo.transit = await transit(lat, lng, geo.train, geo.bus); } catch (e) { errors.push('Jízdní řády: ' + e.message); }
  for (const t of Object.values(geo.transit || {})) if (t.error) { errors.push('Jízdní řády: ' + t.error); delete t.error; }

  if (fl.status === 'fulfilled') geo.flood = fl.value; else errors.push('Záplavová území: ' + fl.reason.message);
  if (sig.status === 'fulfilled') geo.signal = sig.value; else errors.push('Signál (ČTÚ): ' + sig.reason.message);
  if (dr.status === 'fulfilled') geo.drive = dr.value; else errors.push('Trasy autem: ' + dr.reason.message);
  geo.air = Object.fromEntries(Object.entries(TARGETS).map(([k, t]) => [k, Math.round(haversineKm([lat, lng], t))]));
  geo.status = errors.length ? 'partial' : 'ok';
  return geo;
}
const strip = (w) => (w ? { kind: w.kind, name: w.name, dist: w.dist, at: w.at } : null);

const api = { GEO_VERSION, analyze, signal, OPERATORS, geocode, nearestOnLine, projector, haversineKm, analyzeOsm, TARGETS };
if (typeof module !== 'undefined') module.exports = api; else root.Geo = api;
})(this);
