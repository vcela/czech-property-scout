// Mapa dostupnosti: minuty veřejnou dopravou (vlak/autobus) do centra Prahy a Plzně z každého místa v oblasti.
// Počítá se v prohlížeči vlastníka (Transitous one-to-all přes proxy) a výsledek se uloží na server; ostatní ho jen čtou.
(function (root) {
  const { TARGETS, projector } = root.Geo || require('./geo');
  const BBOX = { s: 49.35, n: 50.65, w: 12.75, e: 15.35 }; // Plzeňsko + Středočeský kraj + Praha
  const DLAT = 0.01, DLNG = 0.015; // buňka ≈ 1,1 × 1,1 km
  const WALK_MAX = 1500; // na zastávku pěšky max 1,5 km
  const MAX_MIN = 150;
  const ARRIVALS = ['07:00', '07:10', '07:20', '07:30', '07:40', '07:50', '08:00']; // nejlepší z více příjezdů → méně čekání na přípoj

  function nextTuesday() {
    const d = new Date(Date.now() + 864e5);
    while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  async function stopTimes([lat, lng], progress) {
    const best = new Map();
    for (const t of ARRIVALS) {
      progress?.();
      const qs = new URLSearchParams({ one: `${lat},${lng}`, time: `${nextTuesday()}T${t}:00+01:00`, maxTravelTime: String(MAX_MIN), arriveBy: 'true', transitModes: 'TRANSIT' });
      const url = `https://api.transitous.org/api/v1/one-to-all?${qs}`;
      const r = await fetch(`api.php?a=proxy&t=120&u=${encodeURIComponent(url)}`, { headers: { 'X-RM': '1' } });
      if (!r.ok) throw new Error('Transitous: HTTP ' + r.status);
      const j = await r.json();
      const arr = new Date(j.one.arrival);
      for (const { place: p } of j.all) {
        if (p.lat < BBOX.s || p.lat > BBOX.n || p.lon < BBOX.w || p.lon > BBOX.e) continue;
        const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
        const min = Math.round((arr - new Date(p.departure)) / 60000);
        const cur = best.get(key);
        if (!cur || min < cur.min) best.set(key, { lat: p.lat, lng: p.lon, min });
      }
      await new Promise((res) => setTimeout(res, 1500)); // šetrně ke komunitnímu serveru
    }
    return [...best.values()];
  }

  // časy zastávek do mřížky: čas = jízda + chůze na zastávku (75 m/min, cesta ~1,25× vzdušnou čarou)
  function toGrid(stops, rows, cols) {
    const g = new Float32Array(rows * cols).fill(Infinity);
    const di = Math.ceil(WALK_MAX / 1100) + 1;
    for (const s of stops) {
      const pr = projector(s.lat, s.lng);
      const i0 = Math.floor((s.lat - BBOX.s) / DLAT), j0 = Math.floor((s.lng - BBOX.w) / DLNG);
      for (let i = i0 - di; i <= i0 + di; i++) for (let j = j0 - di; j <= j0 + di; j++) {
        if (i < 0 || j < 0 || i >= rows || j >= cols) continue;
        const d = Math.hypot(...pr.to(BBOX.s + (i + 0.5) * DLAT, BBOX.w + (j + 0.5) * DLNG));
        if (d > WALK_MAX) continue;
        const t = s.min + (d * 1.25) / 75;
        if (t < g[i * cols + j]) g[i * cols + j] = t;
      }
    }
    return g;
  }

  async function computeReach(onProgress) {
    const rows = Math.round((BBOX.n - BBOX.s) / DLAT), cols = Math.round((BBOX.e - BBOX.w) / DLNG);
    let step = 0;
    const tick = () => onProgress?.(++step, ARRIVALS.length * 2);
    const praha = toGrid(await stopTimes(TARGETS.praha, tick), rows, cols);
    const plzen = toGrid(await stopTimes(TARGETS.plzen, tick), rows, cols);
    const cells = [];
    for (let k = 0; k < rows * cols; k++) {
      const a = praha[k], b = plzen[k];
      if (a <= MAX_MIN || b <= MAX_MIN) cells.push([Math.floor(k / cols), k % cols, a <= MAX_MIN ? Math.round(a) : null, b <= MAX_MIN ? Math.round(b) : null]);
    }
    return { computedAt: new Date().toISOString(), bbox: BBOX, dlat: DLAT, dlng: DLNG, walkMax: WALK_MAX, cells };
  }

  const api = { computeReach, toGrid };
  if (typeof module !== 'undefined') module.exports = api; else root.Reach = api;
})(this);
