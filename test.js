// node test.js  – rychlá kontrola výpočtů a rozpoznání vlastností (bez sítě)
const assert = require('assert');
const { nearestOnLine, projector, haversineKm } = require('./public/geo');
const { detectFeatures } = require('./public/scrape');

// vzdálenost bodu od úsečky: úsečka 0,01° východně (~716 m na 50° s.š.)
const pr = projector(50, 14);
const n = nearestOnLine(pr, [[49.99, 14.01], [50.01, 14.01]]);
assert(Math.abs(n.dist - 716) < 5, 'vzdálenost k úsečce ' + n.dist);
assert(Math.abs(n.at[0] - 50) < 1e-6, 'nejbližší bod');
assert(Math.abs(haversineKm([50.0833, 14.4213], [49.7475, 13.3776]) - 83) < 2, 'Praha–Plzeň vzdušně');

const base = { title: 'Prodej chaty 40 m²', category: '', landArea: null, params: { water: [], electricity: [], sewer: [], gas: [], heating: [] } };
const f1 = detectFeatures({ ...base, description: 'Chata stojí na pronajatém pozemku. Voda ze studny, elektřina 230V. Bez garáže.' });
assert.equal(f1.type, 'Chata');
assert.equal(f1.ownLand, false);
assert.equal(f1.ownWater, true);
assert.equal(f1.electricity, 'ano');
assert.equal(f1.garage, false);
const f2 = detectFeatures({ ...base, title: 'Prodej chalupy', landArea: 900, description: 'Obecní vodovod, kanalizace, garáž pro 2 auta.', params: { ...base.params, garage: null } });
assert.equal(f2.type, 'Chalupa');
assert.equal(f2.ownLand, true);
assert.equal(f2.water, 'vodovod');
assert.equal(f2.sewer, 'kanalizace');
assert.equal(f2.garage, true);
assert.equal(detectFeatures({ ...base, area: 43, landArea: 26, description: 'Chata u řeky.' }).ownLand, 'jen pod stavbou');
assert.equal(detectFeatures({ ...base, area: 43, landArea: 600, description: 'Chata u řeky.' }).ownLand, true);
assert.equal(detectFeatures({ ...base, area: 51, landArea: 51, description: 'Chata na pronajatém obecním pozemku.' }).ownLand, false);
// automatické hodnocení: ideál vs. záplavy + pronájem
const score = require('./public/score');
const ideal = { area: 150, landArea: 1600, features: { ownLand: true, electricity: 'ano', water: 'vodovod', garage: true },
  geo: { water: { nearest: { kind: 'řeka', dist: 150 }, river: { name: 'Berounka', dist: 150 } }, flood: { inside: [], near200: [] },
    transit: { praha: { train: { total: 40 } }, plzen: { bus: { total: 55 } } }, drive: { praha: { min: 25 }, plzen: { min: 28 } },
    train: { name: 'X', dist: 800 }, bus: { name: 'Y', dist: 200 }, shops: [{ name: 'Lidl', dist: 1500 }] } };
assert.equal(score(ideal).total, 100);
const bad = JSON.parse(JSON.stringify(ideal)); bad.geo.flood.inside = ['Q5', 'Q100']; bad.features.ownLand = false;
{ const r = score(bad), lost = 25 + 10 + 10; assert.equal(r.total, Math.round(((r.maxPos - lost) / r.maxPos) * 100)); }
// malá chata 13 m² dostane za velikost 0 bodů, 60 m² zhruba polovinu
const tiny = JSON.parse(JSON.stringify(ideal)); tiny.area = 13;
assert.equal(score(tiny).rows.find((x) => x.key === 'size').pts, 0);
assert(score(tiny).total < score(ideal).total - 10, 'malá stavba výrazně níž');
assert.equal(score(ideal, { water: 0, river: 0 }).total, 100); // váhy: bez vody pořád ideál
assert.equal(score({}).total, 0);
console.log('OK – všechny kontroly prošly');
