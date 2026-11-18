// Automatické hodnocení nemovitosti 0–100 + rozpis, proč tolik.
// Každé kritérium dá podíl 0–1 ze své váhy; srážky (záplavy, pronajatý pozemek) se odečítají.
// Výsledek = (body − srážky) / součet kladných vah × 100 → vždy 0–100, ať jsou váhy jakékoli.
// Běží v prohlížeči i v Node (test.js) – stejný kód.
(function (root) {
  const CRITERIA = [ // klíč, popis, výchozí váha, srážka?
    ['water', 'Voda v okolí', 15], ['river', 'Řeka / větší voda', 5], ['flood', 'Záplavy (srážka)', 25, true],
    ['pubPraha', 'Praha vlakem/busem', 15], ['pubPlzen', 'Plzeň vlakem/busem', 10],
    ['carPraha', 'Praha autem', 5], ['carPlzen', 'Plzeň autem', 5],
    ['signal', 'Signál mobilu (nejlepší operátor, 4G)', 8], ['train', 'Vlak blízko', 8], ['bus', 'Autobus blízko', 5], ['shop', 'Supermarket', 5],
    ['size', 'Velikost stavby (užitná plocha)', 20], ['landSize', 'Velikost pozemku', 10],
    ['land', 'Vlastní pozemek', 10], ['rented', 'Pronajatý / cizí pozemek (srážka)', 10, true],
    ['electricity', 'Elektřina', 5], ['waterHome', 'Voda v domě', 5], ['garage', 'Garáž / parkování', 3],
  ];
  const DEFAULTS = Object.fromEntries(CRITERIA.map(([k, , w]) => [k, w]));

  const frac = (v, table) => { // table: [[limit, podíl], …]; první limit, který v splní
    if (v == null || v === Infinity) return null;
    for (const [lim, f] of table) if (v <= lim) return f;
    return 0;
  };
  const dist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
  const mins = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`);
  const NO = ['není', 'jen pod stavbou'];
  const isYes = (v) => v === true || (typeof v === 'string' && !NO.includes(v));
  const isNo = (v) => v === false || NO.includes(v);
  const SIGNAL = ['žádný', 'slabý', 'dostatečný', 'dobrý', 'velmi dobrý', 'výborný'];
  const CAR = [[30, 1], [45, 0.8], [60, 0.6], [90, 0.2]];

  function score(l, weights) {
    const W = { ...DEFAULTS, ...(weights || {}) };
    const g = l.geo || {}, f = l.features || {}, rows = [];
    // f: podíl 0–1 (null = údaj chybí); u srážek podíl srážky
    const add = (key, value, fr) => {
      const [, label, , penalty] = CRITERIA.find((c) => c[0] === key);
      const w = W[key] || 0;
      rows.push({ key, label: label.replace(' (srážka)', ''), value, pts: fr == null ? null : Math.round((penalty ? -fr : fr) * w * 10) / 10, max: penalty ? 0 : w, penalty: !!penalty });
    };
    const pub = (k) => Math.min(g.transit?.[k]?.train?.total ?? Infinity, g.transit?.[k]?.bus?.total ?? Infinity);

    const w = g.water?.nearest, r = g.water?.river;
    add('water', w ? `${w.kind} ${dist(w.dist)}` : null, w ? frac(w.dist, [[200, 1], [500, 0.8], [1000, 0.53], [2000, 0.27]]) : null);
    add('river', r ? `${r.name || r.kind} ${dist(r.dist)}` : null, r ? frac(r.dist, [[500, 1], [1500, 0.6], [3000, 0.2]]) : null);
    const fl = g.flood;
    if (fl) {
      const z = fl.inside || [];
      add('flood', z.length ? `uvnitř ${z.join(', ')}` : fl.near200?.length ? 'záplavové území do 200 m' : 'mimo záplavová území',
        z.some((x) => ['aktivní zóna', 'Q5', 'Q20'].includes(x)) ? 1 : z.includes('Q100') ? 0.6 : z.includes('Q500') ? 0.2 : fl.near200?.length ? 0.12 : 0);
    } else add('flood', null, null);

    const pP = pub('praha'), pZ = pub('plzen'), dP = g.drive?.praha?.min, dZ = g.drive?.plzen?.min;
    add('pubPraha', pP < Infinity ? mins(pP) : null, frac(pP, [[45, 1], [60, 0.8], [75, 0.6], [90, 0.4], [120, 0.2]]));
    add('pubPlzen', pZ < Infinity ? mins(pZ) : null, frac(pZ, [[60, 1], [75, 0.8], [90, 0.6], [120, 0.3]]));
    add('carPraha', dP != null ? mins(dP) : null, frac(dP, CAR));
    add('carPlzen', dZ != null ? mins(dZ) : null, frac(dZ, CAR));
    add('train', g.train ? `${g.train.name} ${dist(g.train.dist)}` : null, g.train ? frac(g.train.dist, [[1000, 1], [2000, 0.6], [4000, 0.25]]) : null);
    add('bus', g.bus ? `${g.bus.name} ${dist(g.bus.dist)}` : null, g.bus ? frac(g.bus.dist, [[300, 1], [700, 0.6], [1500, 0.2]]) : null);
    const sg = g.signal && Math.max(...Object.values(g.signal).map((o) => o['4g'] || 0));
    add('signal', g.signal ? (sg ? SIGNAL[sg] : 'bez pokrytí') : null, g.signal ? [0, 0.15, 0.35, 0.65, 0.85, 1][sg] : null);
    const s = g.shops?.[0];
    add('shop', s ? `${s.name} ${dist(s.dist)}` : null, s ? frac(s.dist, [[2000, 1], [5000, 0.6], [10000, 0.2]]) : null);

    const land = f.ownLand;
    add('land', land === true ? 'ano' : land === false ? 'ne' : land || null, land === true ? 1 : land === false || land === 'jen pod stavbou' ? 0 : null);
    // velikost: malá chata (pod ~35 m²) dostane jen zlomek, 120 m² a víc plný počet
    add('size', l.area ? `${l.area.toLocaleString('cs')} m²` : null, l.area ? frac(-l.area, [[-120, 1], [-90, 0.85], [-70, 0.7], [-50, 0.5], [-35, 0.3], [-25, 0.12]]) : null);
    // pozemek „jen pod stavbou“ se nepočítá jako zahrada
    const garden = land === 'jen pod stavbou' ? 0 : l.landArea;
    add('landSize', l.landArea ? `${l.landArea.toLocaleString('cs')} m²${land === 'jen pod stavbou' ? ' (jen pod stavbou)' : ''}` : null,
      l.landArea ? frac(-garden, [[-1500, 1], [-1000, 0.85], [-700, 0.7], [-500, 0.55], [-300, 0.35], [-150, 0.15]]) : null);
    if (land === false) add('rented', 'pronájem / cizí pozemek', 1);
    const util = (key, v) => add(key, v === true ? 'ano' : v === false ? 'ne' : v, isYes(v) ? 1 : isNo(v) ? 0 : null);
    util('electricity', f.electricity);
    util('waterHome', f.ownWater ? 'vlastní (studna/vrt)' : f.water);
    add('garage', f.garage ? 'garáž' : f.parking ? 'parkování' : f.garage === false ? 'ne' : null, f.garage ? 1 : f.parking ? 1 / 3 : f.garage === false ? 0 : null);

    const maxPos = CRITERIA.filter((c) => !c[3]).reduce((a, c) => a + (W[c[0]] || 0), 0) || 1;
    const raw = rows.reduce((a, x) => a + (x.pts || 0), 0);
    const total = Math.max(0, Math.min(100, Math.round((raw / maxPos) * 100)));
    return { total, rows, unknown: rows.filter((x) => x.pts == null).length, pending: g.status === 'pending' && !g.updatedAt, maxPos };
  }
  score.CRITERIA = CRITERIA;
  score.DEFAULTS = DEFAULTS;
  score.SIGNAL = SIGNAL;

  if (typeof module !== 'undefined') module.exports = score; else root.score = score;
})(this);
