// Reality na mapě – frontend (Leaflet, bez build kroku)
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  water: '<svg viewBox="0 0 24 24"><path d="M12 2.7l5.7 5.6a8 8 0 1 1-11.4 0z"/></svg>',
  train: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 13h.01M15 13h.01M8 20l-2 2M16 20l2 2M9 16l-1 4M15 16l1 4"/></svg>',
  bus: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="15" rx="2"/><path d="M4 11h16M8 18v3M16 18v3M8 14.5h.01M16 14.5h.01"/></svg>',
  car: '<svg viewBox="0 0 24 24"><path d="M5 16h14v-4l-2-5H7l-2 5z"/><path d="M5 12h14"/><circle cx="8" cy="16" r="2"/><circle cx="16" cy="16" r="2"/></svg>',
  flood: '<svg viewBox="0 0 24 24"><path d="M2 10c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 16c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7M10 14 21 3M19 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/></svg>',
  cart: '<svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 7H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/></svg>',
  river: '<svg viewBox="0 0 24 24"><path d="M3 6c3 0 3 3 6 3s3-3 6-3 3 3 6 3M3 14c3 0 3 3 6 3s3-3 6-3 3 3 6 3"/></svg>',
};
const STATUS = { 'nový': 'Nový', 'zajímavý': 'Zajímavý', 'prohlídka': 'Na prohlídku', 'zamítnutý': 'Zamítnutý' };
const TYPES = ['Dům', 'Chata', 'Chalupa', 'Pozemek', 'Byt'];
const PRAHA = [50.0833, 14.4213];

const fmtDist = (m) => (m == null ? '–' : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`);
const fmtPrice = (p) => (p ? `${(p / 1e6).toFixed(p < 1e7 ? 2 : 1).replace('.', ',')} mil. Kč` : 'cena na dotaz');
const fmtPriceShort = (p) => (p ? `${(p / 1e6).toFixed(1).replace('.', ',')} M` : '?');

const pubMin = (g, k) => Math.min(g.transit?.[k]?.train?.total ?? Infinity, g.transit?.[k]?.bus?.total ?? Infinity);
const fmtMin = (m) => (m == null || m === Infinity ? '–' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`);

let listings = [], selectedId = null, pickMode = false;
const markerById = {};
const state = JSON.parse(localStorage.getItem('rm.state') || '{}');
state.f ||= { hideRejected: true, types: [] };
state.sort ||= 'rating';
const persist = () => localStorage.setItem('rm.state', JSON.stringify(state));

// ---------- mapa ----------
const map = L.map('map', { zoomControl: false }).setView([49.95, 14.0], 9);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
// Vlastní dlaždice z ArcGIS MapServeru s přebarvením vrstev (dynamicLayers) → voda výrazně modře
const ArcTiles = L.TileLayer.extend({
  getTileUrl(c) {
    const R = 20037508.342789244, d = (2 * R) / 2 ** c.z, x0 = -R + c.x * d, y1 = R - c.y * d;
    return `${this._url}/export?bbox=${x0},${y1 - d},${x0 + d},${y1}&bboxSR=3857&imageSR=3857&size=512,512&dpi=192&format=png32&transparent=true&f=image&dynamicLayers=${encodeURIComponent(JSON.stringify(this.options.dyn))}`;
  },
});
const line = (color, width, style = 'esriSLSSolid') => ({ type: 'esriSLS', style, color, width });
const fill = (color, outline) => ({ type: 'esriSFS', style: 'esriSFSSolid', color, outline });
const WATER_FILL = fill([28, 126, 214, 235], line([12, 80, 160, 255], 1.2));
const dyn = (id, renderer) => ({ id, source: { type: 'mapLayer', mapLayerId: id }, drawingInfo: { renderer } });
const waterLayer = L.layerGroup([
  // ZABAGED (ČÚZK): každý potok a rybník, zobrazuje se od přiblížení 12
  new ArcTiles('https://ags.cuzk.gov.cz/arcgis/rest/services/ZABAGED_POLOHOPIS/MapServer', {
    minZoom: 12, maxZoom: 19, tileSize: 256, attribution: 'ČÚZK ZABAGED',
    dyn: [
      dyn(132, { type: 'simple', symbol: WATER_FILL }),
      dyn(131, { type: 'simple', symbol: fill([28, 126, 214, 90]) }), // bažiny
      dyn(93, {
        type: 'uniqueValue', field1: 'typtoku_p', field2: 'vydattok_p', fieldDelimiter: ',',
        uniqueValueInfos: [
          { value: 'povrchový splavný,stálý', symbol: line([12, 80, 200, 255], 6) },
          { value: 'povrchový nesplavný,stálý', symbol: line([28, 126, 214, 255], 3) },
          { value: 'povrchový nesplavný,občasný', symbol: line([28, 126, 214, 200], 1.5, 'esriSLSDash') },
        ],
      }),
    ],
  }),
  // VÚV: hlavní řeky a nádrže pro oddálenou mapu
  new ArcTiles('https://ags.vuv.cz/arcgis/rest/services/isvs_voda/isvs_voda/MapServer', {
    minZoom: 5, maxZoom: 11, tileSize: 256, attribution: 'VÚV T.G.M.',
    dyn: [dyn(5, { type: 'simple', symbol: WATER_FILL }), dyn(6, { type: 'simple', symbol: line([28, 126, 214, 230], 1.6) })],
  }),
]);
const base = {
  'Tlumená (voda vynikne)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr, className: 'muted' }),
  'Základní barevná': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr }),
  'Topografická (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap' }),
  'Letecká': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Imagery' }),
  'Turistická / terén': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: osmAttr + ', SRTM | OpenTopoMap' }),
};
const VUV_WMS = 'https://ags.vuv.cz/arcgis/services/isvs_voda/isvs_voda/MapServer/WMSServer';
const overlays = {
  'Voda – řeky, potoky, rybníky (zvýrazněno)': waterLayer,
  'Záplavová území Q5–Q500': L.tileLayer.wms(VUV_WMS, { layers: '12,13,14,15,11', format: 'image/png', transparent: true, opacity: 0.55, minZoom: 12, attribution: 'VÚV T.G.M.' }),
  'Železnice a stanice': L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: 'OpenRailwayMap' }),
};
const lyr = state.layers2 || { base: 'Tlumená (voda vynikne)', on: ['Voda – řeky, potoky, rybníky (zvýrazněno)', 'Záplavová území Q5–Q500'] };
(base[lyr.base] || base['Tlumená (voda vynikne)']).addTo(map);
lyr.on.forEach((n) => overlays[n]?.addTo(map));
L.control.layers(base, overlays, { position: 'topright', collapsed: true }).addTo(map);
const saveLyr = () => { state.layers2 = lyr; persist(); };
map.on('baselayerchange', (e) => { lyr.base = e.name; saveLyr(); });
map.on('overlayadd', (e) => { lyr.on = [...new Set([...lyr.on, e.name])]; saveLyr(); });
map.on('overlayremove', (e) => { lyr.on = lyr.on.filter((n) => n !== e.name); saveLyr(); });

const markersLayer = L.layerGroup().addTo(map);
const contextLayer = L.layerGroup().addTo(map);

// ---------- API (api.php na hostingu) ----------
let owner = false, weights = null, pwLogin = false;
async function call(a, body) {
  const r = await fetch(`api.php?a=${a}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RM': '1' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `Server vrátil neplatnou odpověď (HTTP ${r.status})` }));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Chyba'), j);
  return j;
}
function toast(msg, error = false, ms = 4000) {
  const t = $('#toast');
  t.innerHTML = msg; t.className = 'toast' + (error ? ' error' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
// vlastnosti se počítají vždy aktuální logikou z parametrů inzerátu; ruční opravy mají přednost
const prepare = (l) => { if (l.params) l.features = { ...Scrape.detectFeatures(l), ...(l.featureOverrides || {}) }; return l; };
const sc = (l) => score(l, weights);
async function load() {
  let me;
  [listings, me, { weights }] = await Promise.all([call('list'), call('me'), call('settings')]);
  ({ owner, password: pwLogin } = me);
  listings.forEach(prepare);
  document.body.classList.toggle('owner', owner);
  renderAuth();
  render();
  work();
  schedulePoll();
}
// návštěvníci: když vlastník právě něco počítá, obnovovat seznam
function schedulePoll() {
  clearTimeout(schedulePoll.t);
  if (!owner && listings.some((l) => l.geo?.status === 'pending')) schedulePoll.t = setTimeout(async () => {
    const fresh = await call('list').catch(() => null);
    if (fresh) { listings = fresh.map(prepare); render(); }
    schedulePoll();
  }, 15000);
}
function upsert(l) {
  prepare(l);
  const i = listings.findIndex((x) => x.id === l.id);
  if (i >= 0) listings[i] = l; else listings.unshift(l);
  render();
  work();
}
// analýza okolí běží v prohlížeči vlastníka, jedna po druhé; výsledek se uloží na server
let working = false;
async function work() {
  if (!owner || working) return;
  const l = listings.find((x) => x.lat && (x.geo?.status === 'pending' || (x.geo?.v || 1) < Geo.GEO_VERSION));
  if (!l) return;
  working = true;
  if (l.geo?.status !== 'pending') { l.geo = { ...l.geo, status: 'pending' }; render(); }
  let geo;
  try { geo = await Geo.analyze(l.lat, l.lng, l.nearestHint); }
  catch (e) { geo = { status: 'error', v: Geo.GEO_VERSION, errors: [e.message] }; }
  try { upsert(await call('update', { id: l.id, patch: { geo } })); }
  catch (e) { toast('Uložení analýzy selhalo: ' + esc(e.message), true); working = false; return; }
  working = false;
  work();
}
// načtení inzerátu z webu (přes proxy) + případné geokódování adresy
async function scrapeListing(url) {
  const d = await Scrape.scrape(url);
  if (!d.lat && (d.address || d.city || d.title)) {
    const g = await Geo.geocode(d.address || d.city || d.title).catch(() => null);
    if (g) Object.assign(d, g, { locPrecision: 'odhad z adresy' });
  }
  delete d.features;
  return d;
}

// ---------- přihlášení (magic link) ----------
function renderAuth() {
  $('#auth').innerHTML = owner
    ? '<span class="who" title="Jste přihlášen – můžete přidávat a upravovat">● přihlášen</span>'
    : '<button class="link" id="loginBtn">Přihlásit</button>';
  $('#loginBtn')?.addEventListener('click', () => { const f = $('#loginForm'); f.hidden = !f.hidden; $('#loginSwitch').hidden = f.hidden || !pwLogin; loginMode(pwLogin ? 'pw' : 'mail'); });
}
// heslo (když je v config.php), jinak odkaz e-mailem
let loginBy = 'pw';
function loginMode(m) {
  loginBy = m;
  $('#loginPw').hidden = m !== 'pw'; $('#loginEmail').hidden = m === 'pw';
  $('#loginSwitch').textContent = m === 'pw' ? 'nebo poslat odkaz e-mailem' : 'přihlásit heslem';
  (m === 'pw' ? $('#loginPw') : $('#loginEmail')).focus();
}
$('#loginSwitch').onclick = () => loginMode(loginBy === 'pw' ? 'mail' : 'pw');
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    if (loginBy === 'pw') { await call('login_pw', { password: $('#loginPw').value }); location.reload(); return; }
    const r = await call('login', { email: $('#loginEmail').value });
    $('#loginForm').hidden = true;
    toast(esc(r.message) + (r.devLink ? `<br><a href="${esc(r.devLink)}" style="color:#fff">[vývoj] přihlásit</a>` : ''), false, 15000);
  } catch (err) { toast(esc(err.message), true); }
};

// ---------- nastavení vah automatického hodnocení ----------
function openWeights() {
  if (!owner) return;
  const W = { ...score.DEFAULTS, ...(weights || {}) };
  const dlg = $('#weights');
  const rowsHtml = () => score.CRITERIA.map(([k, label, def, pen]) => `
    <label class="wrow ${pen ? 'pen' : ''}"><span>${label}</span><b id="wv_${k}">${pen ? '−' : ''}${W[k]}</b>
      <input type="range" min="0" max="${pen ? 50 : 30}" step="1" value="${W[k]}" data-k="${k}"><small>výchozí ${def}</small></label>`).join('');
  dlg.innerHTML = `<div class="wbox"><h3>Váhy automatického hodnocení</h3>
    <p class="hint">Čím vyšší číslo, tím víc kritérium ovlivní výsledek. Hodnocení se vždy přepočítá na 0–100. Změny vidíte hned v seznamu.</p>
    <div class="wlist">${rowsHtml()}</div>
    <div class="wact"><button class="link" id="wReset">Obnovit výchozí</button><button id="wCancel">Zrušit</button><button class="btn-primary" id="wSave">Uložit</button></div></div>`;
  dlg.hidden = false;
  const before = weights;
  dlg.querySelectorAll('input[type=range]').forEach((inp) => (inp.oninput = () => {
    W[inp.dataset.k] = +inp.value;
    $('#wv_' + inp.dataset.k).textContent = (inp.closest('.pen') ? '−' : '') + inp.value;
    weights = { ...W }; render();
  }));
  $('#wReset').onclick = () => { Object.assign(W, score.DEFAULTS); weights = { ...W }; dlg.querySelector('.wlist').innerHTML = rowsHtml(); openWeightsBind(); render(); };
  const openWeightsBind = () => dlg.querySelectorAll('input[type=range]').forEach((inp) => (inp.oninput = () => {
    W[inp.dataset.k] = +inp.value; $('#wv_' + inp.dataset.k).textContent = (inp.closest('.pen') ? '−' : '') + inp.value; weights = { ...W }; render();
  }));
  $('#wCancel').onclick = () => { weights = before; dlg.hidden = true; render(); };
  $('#wSave').onclick = async () => {
    try { await call('settings', { weights: W }); weights = { ...W }; dlg.hidden = true; render(); toast('Váhy uloženy'); }
    catch (e) { toast(esc(e.message), true); }
  };
  dlg.onclick = (e) => { if (e.target === dlg) $('#wCancel').click(); };
}
$('#weightsBtn').onclick = openWeights;

// ---------- filtry ----------
const F = ['q', 'price', 'land', 'water', 'river', 'train', 'bus', 'praha', 'pub', 'shop', 'score', 'rating'];
const C = ['noflood', 'ownLand', 'garage', 'ownWater', 'electricity', 'hideRejected'];
function initFilters() {
  $('#f_type').innerHTML = TYPES.map((t) => `<button type="button" class="chip" data-t="${t}">${t}</button>`).join('');
  $('#f_type').onclick = (e) => {
    const t = e.target.dataset.t; if (!t) return;
    state.f.types = state.f.types.includes(t) ? state.f.types.filter((x) => x !== t) : [...state.f.types, t];
    syncFilters(); render();
  };
  F.forEach((k) => { const el = $('#f_' + k); el.value = state.f[k] ?? ''; el.oninput = () => { state.f[k] = el.value; render(); }; });
  C.forEach((k) => { const el = $('#f_' + k); el.checked = !!state.f[k]; el.onchange = () => { state.f[k] = el.checked; render(); }; });
  $('#sort').value = state.sort;
  $('#sort').onchange = () => { state.sort = $('#sort').value; render(); };
  $('#resetFilters').onclick = (e) => { e.preventDefault(); state.f = { hideRejected: true, types: [] }; initFilters(); render(); };
  syncFilters();
}
function syncFilters() {
  document.querySelectorAll('#f_type .chip').forEach((c) => c.classList.toggle('on', state.f.types.includes(c.dataset.t)));
  const n = F.filter((k) => state.f[k]).length + C.filter((k) => k !== 'hideRejected' && state.f[k]).length + (state.f.types.length ? 1 : 0);
  $('#filterCount').textContent = n || '';
}
const NO = ['není', 'jen pod stavbou'];
const yes = (v) => v === true || (typeof v === 'string' && !NO.includes(v));
function passes(l) {
  const f = state.f, g = l.geo || {}, ft = l.features || {};
  if (f.hideRejected && l.status === 'zamítnutý') return false;
  if (f.types.length && !f.types.includes(ft.type)) return false;
  if (f.q && !`${l.title} ${l.address} ${l.city} ${l.description} ${l.note}`.toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.price && l.price && l.price > f.price * 1e6) return false;
  if (f.land && !(l.landArea >= +f.land)) return false;
  if (f.water && !(g.water?.nearest?.dist <= +f.water)) return false;
  if (f.river && !(g.water?.river?.dist <= +f.river)) return false;
  if (f.train && !(g.train?.dist <= +f.train)) return false;
  if (f.bus && !(g.bus?.dist <= +f.bus)) return false;
  if (f.praha && !(g.drive?.praha?.min <= +f.praha)) return false;
  if (f.pub && !(pubMin(g, 'praha') <= +f.pub)) return false;
  if (f.shop && !(g.shops?.[0]?.dist <= +f.shop)) return false;
  if (f.rating && !(l.rating >= +f.rating)) return false;
  if (f.score && !(sc(l).total >= +f.score)) return false;
  if (f.noflood && g.flood?.inside?.length) return false;
  for (const k of ['ownLand', 'garage', 'ownWater', 'electricity']) if (f[k] && !yes(ft[k])) return false;
  return true;
}
const INF = 1e12;
const SORTS = {
  score: (a, b) => sc(b).total - sc(a).total,
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || b.addedAt.localeCompare(a.addedAt),
  added: (a, b) => b.addedAt.localeCompare(a.addedAt),
  priceAsc: (a, b) => (a.price || INF) - (b.price || INF),
  priceDesc: (a, b) => (b.price || 0) - (a.price || 0),
  water: (a, b) => (a.geo?.water?.nearest?.dist ?? INF) - (b.geo?.water?.nearest?.dist ?? INF),
  praha: (a, b) => (a.geo?.drive?.praha?.min ?? INF) - (b.geo?.drive?.praha?.min ?? INF),
  prahaPub: (a, b) => Math.min(pubMin(a.geo || {}, 'praha'), INF) - Math.min(pubMin(b.geo || {}, 'praha'), INF),
  shop: (a, b) => (a.geo?.shops?.[0]?.dist ?? INF) - (b.geo?.shops?.[0]?.dist ?? INF),
  train: (a, b) => (a.geo?.train?.dist ?? INF) - (b.geo?.train?.dist ?? INF),
  land: (a, b) => (b.landArea || 0) - (a.landArea || 0),
};

// ---------- seznam + značky ----------
function metricChips(l) {
  const g = l.geo || {};
  if (g.status === 'pending' && !g.updatedAt) return '<span class="m pending"><span class="spin"></span> analyzuji okolí…</span>';
  if (g.status === 'nopos') return '<span class="m floodnear">chybí poloha – zadejte v detailu</span>';
  const out = [];
  if (g.flood?.inside?.length) out.push(`<span class="m flood">${ICON.flood} záplavy ${g.flood.inside.at(-1)}</span>`);
  else if (g.flood?.near200?.length) out.push(`<span class="m floodnear">${ICON.flood} záplavy do 200 m</span>`);
  if (g.water?.nearest) out.push(`<span class="m water" title="${esc(g.water.nearest.kind + ' ' + (g.water.nearest.name || ''))}">${ICON.water} ${fmtDist(g.water.nearest.dist)}</span>`);
  if (g.train) out.push(`<span class="m train" title="${esc(g.train.name)}">${ICON.train} ${fmtDist(g.train.dist)}</span>`);
  if (g.bus) out.push(`<span class="m bus" title="${esc(g.bus.name)}">${ICON.bus} ${fmtDist(g.bus.dist)}</span>`);
  if (g.shops?.[0]) out.push(`<span class="m shop" title="${esc(g.shops[0].name)}">${ICON.cart} ${fmtDist(g.shops[0].dist)}</span>`);
  if (g.drive?.praha) out.push(`<span class="m car" title="Do centra Prahy: autem / veřejnou dopravou">Praha ${ICON.car} ${g.drive.praha.min}${pubMin(g, 'praha') < Infinity ? ` · ${ICON.train} ${pubMin(g, 'praha')}` : ''} min</span>`);
  if (g.status === 'pending') out.push('<span class="m pending"><span class="spin"></span></span>');
  return out.join('');
}
// ---------- automatické hodnocení ----------
const scoreCls = (t) => (t >= 70 ? 'hi' : t >= 50 ? 'mid' : 'lo');
function scoreBadge(l) {
  const r = sc(l);
  return r.pending ? '<span class="score pend" title="Počítám okolí…">…</span>' : `<span class="score ${scoreCls(r.total)}" data-score="${l.id}">${r.total}</span>`;
}
function scoreRows(sc) {
  return `<table class="score-tab">${sc.rows.map((r) => `<tr class="${r.pts == null ? 'unk' : r.pts < 0 ? 'neg' : r.pts === 0 && r.max ? 'zero' : 'pos'}">
    <td>${esc(r.label)}</td><td>${esc(r.value ?? 'neznámé')}</td><td>${r.pts == null ? '?' : (r.pts > 0 ? '+' : r.pts < 0 ? '−' : '') + Math.abs(r.pts)}${r.max ? `<small>/${r.max}</small>` : ''}</td></tr>`).join('')}</table>
    ${sc.unknown ? `<div class="hint">${sc.unknown}× údaj chybí → 0 bodů (doplníte v detailu kliknutím na vybavení).</div>` : ''}`;
}
const pop = $('#scorePop');
document.addEventListener('mouseover', (e) => {
  const b = e.target.closest('[data-score]');
  if (!b) return (pop.hidden = true);
  const l = listings.find((x) => x.id === b.dataset.score), res = sc(l), r = b.getBoundingClientRect();
  pop.innerHTML = `<div class="sp-head"><span class="score ${scoreCls(res.total)}">${res.total}</span><div><b>Automatické hodnocení</b><small>ze 100 bodů · proč tolik:</small></div></div>${scoreRows(res)}`;
  pop.hidden = false;
  const top = Math.min(r.top, innerHeight - pop.offsetHeight - 10);
  pop.style.left = r.right + 10 + 'px'; pop.style.top = Math.max(10, top) + 'px';
});

function render() {
  syncFilters(); persist();
  const vis = listings.filter(passes).sort(SORTS[state.sort]);
  $('#count').textContent = listings.length ? `${vis.length} z ${listings.length} nemovitostí` : '';
  $('#list').innerHTML = vis.length ? vis.map((l) => `
    <div class="card ${l.id === selectedId ? 'sel' : ''} ${l.status === 'zamítnutý' ? 'rejected' : ''}" data-id="${l.id}">
      <button class="del" data-del="${l.id}" title="Smazat ze seznamu">${ICON.trash}</button>
      <div class="thumb" style="background-image:url('${esc(l.imagesLocal?.[0] || '')}')"><span class="type">${esc(l.features?.type || '')}</span>${scoreBadge(l)}</div>
      <div>
        ${l.rating ? `<span class="stars">${'★'.repeat(l.rating)}</span>` : ''}
        <h3 style="padding-right:${l.rating ? l.rating * 12 + 6 : 0}px">${esc(l.title)}</h3>
        <div class="price">${fmtPrice(l.price)}</div>
        <div class="place">${esc(l.address || l.city || '')}${l.landArea ? ` · pozemek ${l.landArea.toLocaleString('cs')} m²` : ''}</div>
        <div class="metrics">${l.features?.ownLand === false ? `<span class="m noland" title="Podle inzerátu není pozemek ve vlastnictví (např. pronájem)">⚠ bez vlastního pozemku</span>` : l.features?.ownLand === 'jen pod stavbou' ? `<span class="m landwarn" title="Pozemek v inzerátu není větší než stavba – okolní pozemek pravděpodobně není váš">⚠ pozemek jen pod stavbou</span>` : ''}${metricChips(l)}</div>
      </div>
    </div>`).join('')
    : listings.length ? '<div class="empty"><b>Nic neodpovídá filtrům</b>Zkuste některý filtr uvolnit.</div>'
      : '<div class="empty"><b>Zatím žádné nemovitosti</b>Vložte nahoře odkaz na inzerát ze Sreality, Bezrealitek, Realinga nebo jiného webu. Aplikace načte údaje, fotky a spočítá vzdálenost k vodě, vlaku, autobusu a do Prahy.</div>';

  markersLayer.clearLayers();
  for (const l of vis) {
    if (!l.lat) continue;
    const cls = [l.rating >= 4 ? 'fav' : '', l.status === 'prohlídka' ? 'view' : '', l.status === 'zamítnutý' ? 'rejected' : '', l.geo?.flood?.inside?.length ? 'flood' : '', l.id === selectedId ? 'sel' : ''].join(' ');
    const m = L.marker([l.lat, l.lng], {
      icon: L.divIcon({ className: '', html: `<div class="pin ${cls}">${l.geo?.water?.nearest?.dist <= 300 ? `<i class="wd" title="voda do 300 m">${ICON.water}</i>` : ''}${l.rating >= 4 ? '★ ' : ''}${fmtPriceShort(l.price)}</div>`, iconSize: [0, 0] }),
      zIndexOffset: l.id === selectedId ? 1000 : l.rating * 10,
    }).on('click', () => select(l.id)).addTo(markersLayer);
    m.bindTooltip(esc(l.title), { direction: 'top', offset: [0, -30] });
    m.on('mouseover', () => hoverCard(l.id, true)).on('mouseout', () => hoverCard(l.id, false));
    markerById[l.id] = m;
  }
  if (selectedId) { renderDetail(); drawContext(); }
}
$('#list').onclick = (e) => {
  const del = e.target.closest('[data-del]');
  if (del) return removeListing(listings.find((x) => x.id === del.dataset.del));
  const c = e.target.closest('.card'); if (c) select(c.dataset.id, true);
};
// najetí myší na kartu → zvýraznit značku na mapě (a naopak)
let hovered = null;
function hoverMarker(id, on) {
  const m = markerById[id], el = m?.getElement()?.firstElementChild;
  if (!el) return;
  el.classList.toggle('hover', on);
  m.setZIndexOffset(on ? 5000 : id === selectedId ? 1000 : 0);
}
function hoverCard(id, on) { document.querySelector(`.card[data-id="${id}"]`)?.classList.toggle('hover', on); }
$('#list').addEventListener('mouseover', (e) => {
  const id = e.target.closest('.card')?.dataset.id || null;
  if (id === hovered) return;
  if (hovered) hoverMarker(hovered, false);
  hovered = id;
  if (id) hoverMarker(id, true);
});
$('#list').addEventListener('mouseleave', () => { if (hovered) hoverMarker(hovered, false); hovered = null; });
async function removeListing(l) {
  if (!owner || !l || !confirm(`Smazat „${l.title}“ ze seznamu včetně stažených fotek?`)) return;
  await call('delete', { id: l.id });
  listings = listings.filter((x) => x.id !== l.id);
  if (selectedId === l.id) { selectedId = null; $('#detail').hidden = true; $('#mapWrap').classList.remove('has-detail'); contextLayer.clearLayers(); }
  render();
  toast('Smazáno');
}

// ---------- výběr: kontext na mapě ----------
function select(id, fly = false) {
  selectedId = id;
  render();
  const l = listings.find((x) => x.id === id);
  if (fly && l?.lat) {
    // posunout střed doleva, aby nemovitost nebyla schovaná pod panelem detailu
    const z = Math.max(map.getZoom(), 14), panel = $('#detail').offsetWidth || 0;
    const c = map.unproject(map.project([l.lat, l.lng], z).add([panel / 2, 0]), z);
    map.flyTo(c, z, { duration: 0.6 });
  }
  document.querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function poiIcon(kind) { return L.divIcon({ className: '', html: `<div class="poi ${kind}">${ICON[kind === 'shop' ? 'cart' : kind]}</div>`, iconSize: [0, 0] }); }
function drawContext() {
  contextLayer.clearLayers();
  const l = listings.find((x) => x.id === selectedId);
  if (!l?.lat) return;
  const g = l.geo || {}, here = [l.lat, l.lng];
  [500, 1000].forEach((r) => L.circle(here, { radius: r, color: '#0b4f71', weight: 1, opacity: 0.35, fill: false, dashArray: '4 6', interactive: false }).addTo(contextLayer));
  for (const w of g.water?.features || []) {
    const style = { color: '#1c7ed6', weight: w.kind === 'řeka' ? 5 : w.kind === 'potok' ? 3 : 2, opacity: 0.9, fillColor: '#4dabf7', fillOpacity: 0.45 };
    (w.area ? L.polygon(w.coords, style) : L.polyline(w.coords, style)).bindTooltip(esc(`${w.kind}${w.name ? ' ' + w.name : ''}`), { sticky: true }).addTo(contextLayer);
  }
  const line = (to, kind, text) => {
    if (!to) return;
    L.polyline([here, to], { color: getComputedStyle(document.documentElement).getPropertyValue('--' + kind), weight: 2.5, dashArray: '6 6' }).addTo(contextLayer)
      .bindTooltip(text, { permanent: true, direction: 'center', className: 'dist-label ' + kind });
  };
  const w = g.water?.nearest;
  if (w?.at) line(w.at, 'water', `${ICON.water.replace('<svg', '<svg style="width:11px;height:11px;vertical-align:-1px"')} ${fmtDist(w.dist)}`);
  const r = g.water?.river;
  if (r?.at && r.dist !== w?.dist) line(r.at, 'water', `${esc(r.name || 'řeka')} ${fmtDist(r.dist)}`);
  if (g.train) { line([g.train.lat, g.train.lng], 'train', `🚆 ${fmtDist(g.train.dist)}`); L.marker([g.train.lat, g.train.lng], { icon: poiIcon('train') }).bindTooltip(esc(g.train.name)).addTo(contextLayer); }
  (g.trainStations || []).slice(1).forEach((s) => L.marker([s.lat, s.lng], { icon: poiIcon('train'), opacity: 0.7 }).bindTooltip(`${esc(s.name)} · ${fmtDist(s.dist)}`).addTo(contextLayer));
  (g.shops || []).forEach((s) => L.marker([s.lat, s.lng], { icon: poiIcon('shop') }).bindTooltip(`${esc(s.name)} · ${fmtDist(s.dist)}${s.carMin ? ` · ${s.carMin} min autem` : ''}`).addTo(contextLayer));
  if (g.bus) { line([g.bus.lat, g.bus.lng], 'bus', `🚌 ${fmtDist(g.bus.dist)}`); L.marker([g.bus.lat, g.bus.lng], { icon: poiIcon('bus') }).bindTooltip(esc(g.bus.name)).addTo(contextLayer); }
}

// ---------- detail ----------
function tripsHtml(g, pending) {
  if (!g.drive && !g.transit) return `<div class="hint">${pending ? '<span class="spin"></span> počítám spojení…' : 'Nezjištěno'}</div>`;
  const cell = (k, mode) => {
    if (mode === 'car') { const d = g.drive?.[k]; return d ? `<b>${fmtMin(d.min)}</b><small>${d.km} km po silnici</small>` : '–'; }
    const t = g.transit?.[k]?.[mode];
    if (!t) return `<b class="na">–</b><small>${pending ? '<span class="spin"></span>' : 'spojení nenalezeno'}</small>`;
    const acc = t.access ? ` · +${t.access.min} min ${t.access.mode} na zastávku` : '';
    return `<b>${fmtMin(t.total)}</b><small title="odjezd ${t.depart}">${esc(t.lines.join(' → '))}${t.from ? ` · ze st. ${esc(t.from)}` : ''}${acc}${t.transfers ? ` · ${t.transfers}× přestup` : ''}</small>`;
  };
  const row = (mode, icon, label) => `<tr><th>${icon} ${label}</th><td>${cell('praha', mode)}</td><td>${cell('plzen', mode)}</td></tr>`;
  return `<table class="trips"><thead><tr><th></th><th>Praha centrum</th><th>Plzeň centrum</th></tr></thead><tbody>
    ${row('car', ICON.car, 'Autem')}${row('train', ICON.train, 'Vlakem')}${row('bus', ICON.bus, 'Autobusem')}</tbody></table>
    <div class="hint">Veřejná doprava = nejrychlejší spojení ve všední den kolem 7:00 (jízdní řády Transitous), vč. cesty na zastávku. Auto bez kolon.</div>`;
}
function tile(cls, icon, k, v, s) { return `<div class="tile ${cls}"><div class="k">${icon || ''} ${k}</div><div class="v">${v}</div>${s ? `<div class="s" title="${esc(s)}">${esc(s)}</div>` : ''}</div>`; }
const FEATS = [['ownLand', 'Vlastní pozemek'], ['garage', 'Garáž'], ['parking', 'Parkování'], ['water', 'Voda'], ['ownWater', 'Vlastní zdroj vody'], ['electricity', 'Elektřina'], ['sewer', 'Odpad'], ['gas', 'Plyn'], ['heating', 'Vytápění'], ['cellar', 'Sklep']];
function featHtml(l) {
  const ov = l.featureOverrides || {};
  return FEATS.map(([k, label]) => {
    const v = l.features?.[k];
    const cls = yes(v) ? 'yes' : v === false || NO.includes(v) ? 'no' : 'unk';
    const txt = v === true ? 'ano' : v === false ? 'ne' : v == null ? 'neuvedeno' : v;
    return `<div class="feat ${cls} ${k in ov ? 'edited' : ''}" data-k="${k}" title="Kliknutím přepnete ano / ne / neuvedeno"><span>${label}</span><span>${esc(txt)}</span></div>`;
  }).join('');
}
function renderDetail() {
  const l = listings.find((x) => x.id === selectedId);
  const el = $('#detail');
  if (!l) { el.hidden = true; return; }
  if (!el.hidden && el.dataset.id === l.id && document.activeElement?.id === 'd_note') return; // nepřepisovat rozepsanou poznámku
  el.dataset.id = l.id;
  const scroll = el.hidden ? 0 : el.scrollTop;
  const g = l.geo || {}, imgs = l.imagesLocal || [];
  const pending = g.status === 'pending';
  const fl = g.flood;
  const floodTile = !fl ? tile('', ICON.flood, 'Záplavové území', pending ? '<span class="spin"></span>' : '?', 'nezjištěno')
    : fl.inside.length ? tile('bad wide', ICON.flood, 'Záplavové území', `UVNITŘ – ${fl.inside.join(', ')}`, `tok ${fl.river || ''} · Q5 = voda jednou za 5 let, Q100 = stoletá voda`)
    : fl.near200.length ? tile('warn wide', ICON.flood, 'Záplavové území', `mimo, ale do 200 m (${fl.near200.join(', ')})`, `tok ${fl.river || ''} – ověřte výškový rozdíl`)
    : tile('good wide', ICON.flood, 'Záplavové území', 'mimo záplavová území', 'dle map VÚV T.G.M. (Q5–Q500)');
  const ws = g.water || {};
  const transit = `https://www.google.com/maps/dir/?api=1&origin=${l.lat},${l.lng}&destination=${PRAHA}&travelmode=transit`;
  const idos = `https://idos.cz/vlakyautobusy/spojeni/?f=${encodeURIComponent(l.city || '')}&t=${encodeURIComponent('Praha')}`;
  const perM2 = l.price && l.area ? Math.round(l.price / l.area).toLocaleString('cs') + ' Kč/m²' : '';

  el.innerHTML = `
    <button class="d-close" title="Zavřít">×</button>
    <div class="gallery">
      <div class="main" style="background-image:url('${esc(imgs[0] || '')}')">${imgs.length ? `<span class="count">${imgs.length} fotek</span>` : ''}</div>
      ${imgs.length > 1 ? `<div class="strip">${imgs.map((s, i) => `<div data-i="${i}" class="${i ? '' : 'on'}" style="background-image:url('${esc(s)}')"></div>`).join('')}</div>` : ''}
    </div>
    <div class="d-body">
      <div class="d-src">${esc(l.source)} · ${esc(l.features?.type || '')}</div>
      <h2>${esc(l.title)}</h2>
      <div class="d-price">${fmtPrice(l.price)}<small>${perM2}</small></div>
      <div class="d-place">${esc(l.address || l.city || '')} ${l.locPrecision ? `<span class="prec">(poloha: ${esc(String(l.locPrecision).toLowerCase())})</span>` : ''}</div>
      <div class="d-row">
        <div class="rate">${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}" class="${n <= l.rating ? 'on' : ''}" title="${n} z 5">★</button>`).join('')}</div>
        <select id="d_status" ${owner ? '' : 'disabled'}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>

      ${(() => { const r = sc(l); return r.pending ? '' : `<h4>Automatické hodnocení <button class="link owner-only" data-weights>upravit váhy</button></h4><div class="score-detail"><span class="score big ${scoreCls(r.total)}">${r.total}</span><div>${scoreRows(r)}</div></div>`; })()}

      <h4>Okolí a doprava ${pending ? '<span class="spin"></span>' : ''}</h4>
      ${g.status === 'nopos' ? '<div class="err">Inzerát neobsahuje polohu. Klikněte na „Upravit polohu“ a označte místo v mapě.</div>' : ''}
      <div class="env">
        ${tile('water', ICON.water, 'Nejbližší voda', ws.nearest ? fmtDist(ws.nearest.dist) : pending ? '<span class="spin"></span>' : '> 3 km', ws.nearest ? `${ws.nearest.kind}${ws.nearest.name ? ' ' + ws.nearest.name : ''}` : '')}
        ${tile('water', ICON.river, 'Řeka / větší voda', ws.river ? fmtDist(ws.river.dist) : pending ? '<span class="spin"></span>' : '> 3 km', ws.river ? `${ws.river.name || ws.river.kind}` : ws.named ? `nejbližší pojmenovaná: ${ws.named.name} (${fmtDist(ws.named.dist)})` : '')}
        ${tile('train', ICON.train, 'Vlak', g.train ? fmtDist(g.train.dist) : pending ? '<span class="spin"></span>' : '> 10 km', g.train ? `${g.train.name}${g.train.lines?.length ? ' · ' + g.train.lines.join(', ') : ''}` : '')}
        ${tile('bus', ICON.bus, 'Autobus', g.bus ? fmtDist(g.bus.dist) : pending ? '<span class="spin"></span>' : '> 3 km', g.bus ? `${g.bus.name}${g.bus.lines?.length ? ' · linky ' + g.bus.lines.join(', ') : ''}${g.busStops500 > 1 ? ` · ${g.busStops500} zastávky do 500 m` : ''}` : '')}
        ${floodTile}
      </div>
      <h4>Cesta do Prahy a Plzně</h4>
      ${tripsHtml(g, pending)}
      <h4>Nákupy</h4>
      ${g.shops?.length ? `<div class="shops">${g.shops.map((s) => `<div class="shop">${ICON.cart}<b>${esc(s.name)}</b><span>${fmtDist(s.dist)}${s.carMin ? ` · ${s.carMin} min autem` : ''}</span></div>`).join('')}</div>` : `<div class="hint">${pending ? '<span class="spin"></span> hledám…' : 'Supermarket do 12 km nenalezen.'}</div>`}
      <div class="links">
        <a href="${transit}" target="_blank" rel="noopener">${ICON.train} MHD/vlak do Prahy (Google)</a>
        ${l.city ? `<a href="${idos}" target="_blank" rel="noopener">${ICON.bus} Spojení IDOS</a>` : ''}
        <a href="https://mapy.com/zakladni?x=${l.lng}&y=${l.lat}&z=16&source=coor&id=${l.lng}%2C${l.lat}" target="_blank" rel="noopener">${ICON.pin} Mapy.com</a>
        <a href="https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}" target="_blank" rel="noopener">${ICON.pin} Google Maps</a>
      </div>
      ${g.errors?.length ? `<div class="err">Část dat se nepodařilo načíst: ${esc(g.errors.join(' · '))} <button class="more owner-only" id="d_regeo">Přepočítat okolí</button></div>` : ''}

      <h4>Pozemek a vybavení</h4>
      <div class="env" style="margin-bottom:8px">
        ${tile('', '', 'Užitná plocha', l.area ? `${l.area.toLocaleString('cs')} m²` : '–')}
        ${tile('', '', 'Pozemek', l.landArea ? `${l.landArea.toLocaleString('cs')} m²` : '–')}
      </div>
      <div class="feats">${featHtml(l)}</div>
      <div class="hint">Údaje jsou z parametrů inzerátu a z popisu. Kliknutím na řádek je opravíte (ano → ne → neuvedeno).</div>

      <h4>Moje poznámka</h4>
      <textarea id="d_note" ${owner ? '' : 'readonly'} placeholder="${owner ? 'Dojmy, otázky na makléře, termín prohlídky…' : ''}">${esc(l.note)}</textarea>

      ${l.description ? `<h4>Popis z inzerátu</h4><div class="desc">${esc(l.description)}</div><button class="more">Zobrazit celý popis</button>` : ''}

      <div class="actions">
        <a href="${esc(l.url)}" target="_blank" rel="noopener">${ICON.ext} Otevřít inzerát</a>
        ${l.originalUrl ? `<a href="${esc(l.originalUrl)}" target="_blank" rel="noopener">${ICON.ext} Původní zdroj</a>` : ''}
        <button id="d_pick" class="owner-only">${ICON.pin} Upravit polohu</button>
        <button id="d_refresh" class="owner-only">${ICON.refresh} Načíst znovu</button>
        <button id="d_delete" class="danger owner-only">${ICON.trash} Smazat</button>
      </div>
      <div class="hint">Přidáno ${new Date(l.addedAt).toLocaleDateString('cs')}${g.updatedAt ? ` · okolí analyzováno ${new Date(g.updatedAt).toLocaleString('cs')}` : ''}${g.waterSource ? ` · voda z ${g.waterSource}` : ''}${g.stopsSource ? ` · zastávky z ${g.stopsSource}` : ''}</div>
    </div>`;
  el.hidden = false;
  $('#mapWrap').classList.add('has-detail');
  el.scrollTop = scroll;

  $('.d-close', el).onclick = () => { selectedId = null; el.hidden = true; $('#mapWrap').classList.remove('has-detail'); contextLayer.clearLayers(); render(); };
  const main = $('.gallery .main', el);
  let cur = 0;
  el.querySelectorAll('.strip div').forEach((d) => (d.onclick = () => {
    cur = +d.dataset.i; main.style.backgroundImage = `url('${imgs[cur]}')`;
    el.querySelectorAll('.strip div').forEach((x) => x.classList.toggle('on', x === d));
  }));
  main.onclick = () => imgs.length && lightbox(imgs, cur);
  el.querySelector('[data-weights]')?.addEventListener('click', openWeights);
  if (!owner) return; // návštěvník jen prohlíží
  el.querySelectorAll('.rate button').forEach((b) => (b.onclick = () => patch(l, { rating: +b.dataset.r === l.rating ? 0 : +b.dataset.r })));
  $('#d_status').onchange = (e) => patch(l, { status: e.target.value });
  $('#d_note').onchange = (e) => patch(l, { note: e.target.value }, true);
  el.querySelectorAll('.feat').forEach((f) => (f.onclick = () => {
    const v = l.features[f.dataset.k];
    const next = yes(v) ? false : v === false || NO.includes(v) ? null : true;
    patch(l, { features: { [f.dataset.k]: next } });
  }));
  $('.more', el)?.addEventListener('click', (e) => { $('.desc', el).classList.add('open'); e.target.remove(); });
  $('#d_pick').onclick = () => startPick(l);
  $('#d_regeo')?.addEventListener('click', () => patch(l, { geo: { ...l.geo, status: 'pending' } }, true));
  $('#d_refresh').onclick = async (e) => {
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> Načítám…';
    try { const d = await scrapeListing(l.url); upsert(await call('update', { id: l.id, patch: { ...d, refreshed: true, geo: { ...l.geo, status: 'pending' } } })); toast('Inzerát aktualizován, okolí se přepočítává'); }
    catch (err) { toast(err.message, true); render(); }
  };
  $('#d_delete').onclick = () => removeListing(l);
}
async function patch(l, body, quiet) {
  try {
    const n = await call('update', { id: l.id, patch: body });
    upsert(n);
    if (!quiet && 'status' in body) toast('Stav uložen', false, 1500);
  } catch (e) { toast(e.message, true); }
}

// ---------- ruční poloha ----------
function startPick(l) {
  pickMode = l.id; document.body.classList.add('picking'); $('#pickHint').hidden = false;
}
function endPick() { pickMode = false; document.body.classList.remove('picking'); $('#pickHint').hidden = true; }
$('#pickCancel').onclick = endPick;
map.on('click', (e) => {
  if (!pickMode) return;
  const l = listings.find((x) => x.id === pickMode);
  endPick();
  if (l) patch(l, { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6), manual: true, geo: { ...l.geo, status: 'pending' } }).then(() => toast('Poloha uložena, přepočítávám okolí…'));
});

// ---------- galerie ----------
function lightbox(imgs, i) {
  const lb = $('#lightbox'), img = $('img', lb);
  const show = () => (img.src = imgs[(i + imgs.length) % imgs.length]);
  show(); lb.hidden = false;
  $('.lb-prev', lb).onclick = () => { i--; show(); };
  $('.lb-next', lb).onclick = () => { i++; show(); };
  $('.lb-close', lb).onclick = () => (lb.hidden = true);
  lb.onclick = (e) => { if (e.target === lb) lb.hidden = true; };
  document.onkeydown = (e) => {
    if (lb.hidden) return;
    if (e.key === 'ArrowLeft') { i--; show(); } else if (e.key === 'ArrowRight') { i++; show(); } else if (e.key === 'Escape') lb.hidden = true;
  };
}

// ---------- přidání ----------
$('#addForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#addBtn'), url = $('#addUrl').value.trim();
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try {
    const known = listings.find((x) => x.url === url);
    if (known) throw Object.assign(new Error('Tento inzerát už máte uložený'), { id: known.id });
    const l = await call('add', { url, data: await scrapeListing(url) });
    $('#addUrl').value = '';
    upsert(l);
    select(l.id, true);
    toast(l.lat ? 'Inzerát přidán – fotky staženy, analyzuji okolí…' : 'Inzerát přidán, ale chybí poloha – označte ji v mapě');
  } catch (err) {
    toast(err.message, true, 6000);
    if (err.id) select(err.id, true);
  } finally { btn.disabled = false; btn.textContent = 'Přidat'; }
};

// ---------- mapa dostupnosti veřejnou dopravou (Praha / Plzeň / obojí) ----------
const reach = { data: null, layer: L.layerGroup().addTo(map), renderer: L.canvas({ padding: 0.3 }), tip: L.tooltip({ className: 'reach-tip', direction: 'top', offset: [0, -6] }) };
state.reach ||= { on: false, p: 90, z: 90 };
const COL = { p: '#4263eb', z: '#f08c00', b: '#2f9e44' };
function drawReach() {
  reach.layer.clearLayers();
  $('#reach').classList.toggle('on', state.reach.on);
  $('#r_pv').textContent = fmtMin(state.reach.p); $('#r_zv').textContent = fmtMin(state.reach.z);
  const d = reach.data;
  if (!state.reach.on || !d?.cells) return;
  let n = 0;
  for (const [i, j, p, z] of d.cells) {
    const okP = p != null && p <= state.reach.p, okZ = z != null && z <= state.reach.z;
    if (!okP && !okZ) continue;
    const k = okP && okZ ? 'b' : okP ? 'p' : 'z';
    if (k === 'b') n++;
    const s = d.bbox.s + i * d.dlat, w = d.bbox.w + j * d.dlng;
    L.rectangle([[s, w], [s + d.dlat, w + d.dlng]], { renderer: reach.renderer, stroke: false, fillColor: COL[k], fillOpacity: k === 'b' ? 0.5 : 0.28, interactive: false }).addTo(reach.layer);
  }
  $('#r_info').innerHTML = `Sweet spot: <b>${n ? '~' + n + ' km²' : 'žádné místo – povolte delší čas'}</b>. Ráno ve všední den, příjezd 7–8 h, vč. chůze na zastávku do 1,5 km.${d.computedAt ? ` Jízdní řády k ${new Date(d.computedAt).toLocaleDateString('cs')}.` : ''}`;
}
async function loadReach() {
  const d = await call('reach').catch(() => null);
  if (d?.cells) { reach.data = d; reach.idx = null; drawReach(); }
  const stale = !d?.cells || Date.now() - new Date(d.computedAt) > 14 * 864e5;
  if (stale && owner && !reach.running) computeReachNow();
  else if (!d?.cells) $('#r_info').textContent = 'Mapa dostupnosti zatím nebyla spočítána (spočítá se, až se přihlásí vlastník).';
}
async function computeReachNow() { // jednou za 14 dní, v prohlížeči vlastníka (~1–2 min)
  reach.running = true;
  try {
    const d = await Reach.computeReach((i, n) => { if (!reach.data) $('#r_info').innerHTML = `<span class="spin"></span> Počítám dostupnost z jízdních řádů… ${i}/${n}`; });
    await call('reach', d);
    reach.data = d; reach.idx = null; drawReach();
  } catch (e) { $('#r_info').textContent = 'Výpočet dostupnosti selhal: ' + e.message; }
  reach.running = false;
}
map.on('mousemove', (e) => { // časy pod kurzorem
  const d = reach.data;
  if (!state.reach.on || !d?.cells) return map.closeTooltip(reach.tip);
  const i = Math.floor((e.latlng.lat - d.bbox.s) / d.dlat), j = Math.floor((e.latlng.lng - d.bbox.w) / d.dlng);
  reach.idx ||= new Map(d.cells.map((c) => [c[0] * 1e4 + c[1], c]));
  const c = reach.idx.get(i * 1e4 + j);
  if (!c) return map.closeTooltip(reach.tip);
  reach.tip.setLatLng(e.latlng).setContent(`Praha ${c[2] != null ? fmtMin(c[2]) : '> 2,5 h'} · Plzeň ${c[3] != null ? fmtMin(c[3]) : '> 2,5 h'}`);
  if (!map.hasLayer(reach.tip)) reach.tip.addTo(map);
});
$('#r_on').checked = state.reach.on;
$('#r_p').value = state.reach.p; $('#r_z').value = state.reach.z;
$('#r_on').onchange = (e) => { state.reach.on = e.target.checked; persist(); drawReach(); };
for (const k of ['p', 'z']) $('#r_' + k).oninput = (e) => { state.reach[k] = +e.target.value; persist(); drawReach(); };
drawReach();

initFilters();
load().then(() => {
  loadReach();
  const pts = listings.filter((l) => l.lat).map((l) => [l.lat, l.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [60, 60], maxZoom: 13 });
});
