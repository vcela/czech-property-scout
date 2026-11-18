// Načtení inzerátu z realitního serveru → jednotný objekt. Běží v prohlížeči (HTML se stahuje přes api.php?a=proxy) i v Node (testy).
(function (root) {
// Sreality / Bezrealitky / Realingo čtou data z __NEXT_DATA__ (JSON v HTML), ostatní weby přes OpenGraph/JSON-LD.

async function fetchText(url) {
  const r = await fetch(`api.php?a=proxy&ua=b&t=40&u=${encodeURIComponent(url)}`, { headers: { 'X-RM': '1' } });
  if (!r.ok) throw new Error(r.status === 401 ? 'Nejste přihlášen' : `Web inzerátu vrátil chybu ${r.status}`);
  return r.text();
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

const stripHtml = (s) => (s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

// --- Sreality -------------------------------------------------------------
function parseSreality(html, url) {
  const j = nextData(html);
  const e = j?.props?.pageProps?.dehydratedState?.queries?.find((q) => q.queryKey[0] === 'estate')?.state?.data;
  if (!e) throw new Error('Sreality: v stránce nejsou data inzerátu (inzerát smazán?)');
  const p = e.params || {};
  const names = (arr) => (arr || []).map((x) => x.name || x).filter(Boolean);
  const L = e.locality || {};
  const near = (kind) => {
    const n = (e.nearest || []).find((x) => x.name === kind);
    return n ? { name: n.description, dist: n.distance, lat: n.lat, lng: n.lon } : null;
  };
  return {
    source: 'sreality',
    title: e.name,
    category: [e.categoryMainCb?.name, e.categorySubCb?.name].filter(Boolean).join(' / '),
    price: e.priceCzk || null,
    area: p.usableArea || p.buildingArea || p.floorArea || null,
    landArea: p.estateArea || e.estateArea || null,
    address: [L.street, L.cityPart !== L.city ? L.cityPart : null, L.city, L.district].filter(Boolean).join(', '),
    city: L.city,
    lat: L.latitude, lng: L.longitude,
    description: stripHtml(e.description),
    images: (e.images || []).map((i) => 'https:' + i.url + '?fl=res,1200,1200,1|shr,,20|jpg,80'),
    params: {
      garage: p.garage === true || (p.garageCount > 0) ? true : p.garage === false ? false : null,
      parking: p.parkingLots ?? null,
      water: names(p.waterSet),
      electricity: names(p.electricitySet),
      sewer: names(p.gullySet),
      gas: names(p.gasSet),
      heating: names(p.heatingSet),
      condition: p.buildingCondition?.name,
      cellar: p.cellar ?? null,
    },
    nearestHint: { train: near('train'), bus: near('bus_public_transport') },
  };
}

// --- Bezrealitky ----------------------------------------------------------
function parseBezrealitky(html) {
  const a = nextData(html)?.props?.pageProps?.origAdvert;
  if (!a) throw new Error('Bezrealitky: v stránce nejsou data inzerátu');
  const en = (v) => (v && v !== 'UNDEFINED' ? [String(v).toLowerCase().replace(/_/g, ' ')] : []);
  return {
    source: 'bezrealitky',
    title: a.pageTitle || a.imageAltText,
    category: a.estateType,
    price: a.price || null,
    area: a.surface || null,
    landArea: a.surfaceLand || null,
    address: a.address,
    city: a.city,
    lat: a.gps?.lat, lng: a.gps?.lng,
    description: stripHtml(a.description),
    images: (a.publicImages || []).map((i) => i.url),
    params: {
      garage: a.garage ?? null, parking: a.parking ?? null,
      water: en(a.water), sewer: en(a.sewage), heating: en(a.heating), electricity: [], gas: [],
      condition: a.condition, cellar: a.cellar ?? null,
    },
  };
}

// --- Realingo (agreguje i bazoš, iDNES, …) --------------------------------
const RL_CAT = { HOUSE_FAMILY: 'Rodinný dům', HOUSE_COTTAGE: 'Chata', HOUSE_CHALUPA: 'Chalupa', HOUSE_VILLA: 'Vila', HOUSE_FARM: 'Zemědělská usedlost', HOUSE_RECREATION: 'Rekreační objekt' };
function parseRealingo(html) {
  const d = nextData(html)?.props?.pageProps?.store?.offer?.details;
  const o = d && Object.values(d)[0]?.offer;
  if (!o?.offer) throw new Error('Realingo: v stránce nejsou data inzerátu');
  const of = o.offer, det = o.detail || {};
  if (of.isLocked) throw new Error('Realingo: inzerát je zamčený (nově přidané inzeráty vidí jen přihlášení)');
  const img = (p) => `https://www.realingo.cz/static/images/${p}.jpg?w=1200`;
  return {
    source: 'realingo',
    title: `${RL_CAT[of.category] || 'Prodej'} ${of.area?.main ? of.area.main + ' m²' : ''}${of.area?.plot ? ', pozemek ' + of.area.plot + ' m²' : ''} – ${of.location?.address || ''}`,
    category: of.category,
    price: of.price?.total || null,
    area: of.area?.main || null,
    landArea: of.area?.plot || null,
    address: of.location?.address,
    city: of.location?.addressUrl,
    lat: of.location?.latitude, lng: of.location?.longitude,
    locPrecision: of.location?.locationPrecision,
    description: stripHtml(det.description),
    images: [of.photos?.main, ...(of.photos?.list || [])].filter(Boolean).map(img),
    params: { garage: null, parking: null, water: [], electricity: [], sewer: [], gas: [], heating: [], cellar: det.cellar ?? null, condition: det.buildingStatus },
    originalUrl: det.externalUrl,
  };
}

// --- iDNES Reality: datová vrstva "listing_*" + tabulka parametrů <dt>/<dd> ---
function parseIdnes(html, url) {
  const v = (k) => html.match(new RegExp(`"listing_${k}"\\s*:\\s*"?([^",]*)`))?.[1];
  const dl = {};
  for (const m of html.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) dl[stripHtml(m[1]).replace(/\s+/g, ' ')] = stripHtml(m[2]).replace(/\s+/g, ' ');
  const num = (s) => (s ? +s.replace(/m2|m²/g, '').replace(/[^\d]/g, '') || null : null);
  const list = (s) => (s ? [s] : []);
  const garageKey = Object.keys(dl).find((k) => /garáž/i.test(k));
  const desc = html.match(/<div class="b-desc[^"]*">([\s\S]*?)<\/div>/)?.[1]?.replace(/<h2>[\s\S]*?<\/h2>/, '');
  const address = stripHtml(html.match(/<p class="b-detail__info">([\s\S]*?)<\/p>/)?.[1] || '').replace(/\s+/g, ' ');
  return {
    source: 'idnes',
    title: v('name') || parseGeneric(html, url).title,
    category: v('category') || '',
    price: +v('price') || null,
    area: num(dl['Užitná plocha']) || +v('area') || null,
    landArea: num(dl['Plocha pozemku']),
    address,
    city: address.split(',').map((s) => s.trim()).filter((s) => s && !/^okres|kraj/.test(s)).pop() || '',
    lat: +v('lat') || null, lng: +v('lon') || null,
    description: stripHtml(desc || ''),
    images: [...new Set([...html.matchAll(/href="(https:\/\/sta-reality2\.1gr\.cz\/[^"]+)"[^>]*data-fancybox/g)].map((m) => m[1]))],
    params: {
      garage: garageKey ? true : null, parking: dl['Parkování'] ? true : null,
      water: list(dl['Voda']), electricity: list(dl['Elektřina']), sewer: list(dl['Odpad']), gas: list(dl['Plyn']),
      heating: list(dl['Zdroj vytápění']), condition: dl['Stav budovy'], cellar: null,
    },
  };
}

// --- Obecný web: OpenGraph + JSON-LD + hledání GPS v HTML ----------------
function parseGeneric(html, url) {
  const meta = (prop) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)`, 'i'))?.[1];
  let lat = null, lng = null, price = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const s = m[1];
      lat ??= +s.match(/"latitude"\s*:\s*"?([\d.]+)/)?.[1] || null;
      lng ??= +s.match(/"longitude"\s*:\s*"?([\d.]+)/)?.[1] || null;
      price ??= +s.match(/"price"\s*:\s*"?([\d.]+)/)?.[1] || null;
    } catch {}
  }
  // ponytail: heuristika – první dvojice souřadnic v ČR v HTML; když nesedí, uživatel klikne do mapy
  if (!lat) {
    const m = html.match(/"?(?:lat|latitude|gps_lat)"?\s*[:=]\s*"?(4[89]\.\d{3,}|5[01]\.\d{3,})"?[\s\S]{0,80}?"?(?:lng|lon|longitude|gps_lon)"?\s*[:=]\s*"?(1[2-8]\.\d{3,})/i);
    if (m) { lat = +m[1]; lng = +m[2]; }
  }
  const imgs = [...new Set([...html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/gi)].map((m) => m[1]))];
  return {
    source: new URL(url).hostname.replace(/^www\./, ''),
    title: stripHtml(meta('og:title') || html.match(/<title>([^<]*)/i)?.[1] || url),
    category: '',
    price,
    area: null, landArea: null,
    address: '', city: '',
    lat, lng,
    description: stripHtml(meta('og:description') || meta('description') || ''),
    images: imgs,
    params: { garage: null, parking: null, water: [], electricity: [], sewer: [], gas: [], heating: [], cellar: null },
  };
}

// --- Odvození vlastností: parametry inzerátu + klíčová slova v popisu ------
function detectFeatures(l) {
  const t = `${l.title}\n${l.description}`.toLowerCase();
  const has = (re) => re.test(t);
  const p = l.params;
  const join = (a) => (a && a.length ? a.join(', ') : null);

  const typeText = `${l.category} ${l.title}`.toLowerCase();
  const type = /chalup/.test(typeText) ? 'Chalupa' : /chat|rekrea|cottage/.test(typeText) ? 'Chata'
    : /pozem|land/.test(typeText) && !/dům|domu|dum|house/.test(typeText) ? 'Pozemek'
    : /byt|flat|apart/.test(typeText) ? 'Byt' : 'Dům';

  const ownWater = has(/studn|vlastní (zdroj )?vod|vrt\b|vrtan/) || (p.water || []).some((w) => /studn|vrt|místní|vlastní/i.test(w));
  const publicWater = has(/vodovod|veřejn\S* vod/) || (p.water || []).some((w) => /vodovod|dálkov|veřejn/i.test(w));

  const notOwnLand = has(/pronajat\S*( \S+)? pozem|pozem\S* (je )?(v )?(pronájm|nájm)|cizím pozemku|pozemek není (součástí|v ceně|v majetku)|bez pozemku|pozemek (je )?ve vlastnictví (obce|státu|lesů)/);
  return {
    type,
    // pozemek ≤ plocha stavby → patří jen zastavěná plocha, zahrada/okolí ne (typické u chat na cizím pozemku)
    ownLand: notOwnLand ? false : l.landArea > 0 && l.area && l.landArea <= l.area * 1.1 ? 'jen pod stavbou' : l.landArea > 0 || has(/vlastní(m)? pozem|pozemek o (výměře|rozloze)|pozemek \d/) ? true : null,
    garage: p.garage ?? (has(/bez garáž|garáž (není|chybí)/) ? false : has(/garáž/) ? true : null),
    parking: p.parking ?? (has(/parkování|parkovací stání|stání pro/) ? true : null),
    water: ownWater ? 'vlastní (studna/vrt)' : publicWater ? 'vodovod' : join(p.water) || (has(/bez vody|voda není/) ? 'není' : null),
    ownWater: ownWater || null,
    electricity: (p.electricity || []).length ? join(p.electricity)
      : has(/bez elektři|elektřina není|není elektři/) ? 'není'
      : has(/400\s?v/) ? '400 V' : has(/230\s?v|elektři|elektrick|přípojka el/) ? 'ano' : null,
    sewer: join(p.sewer) || (has(/kanalizac/) ? 'kanalizace' : has(/(?<!\p{L})čov(?!\p{L})|čistírn/u) ? 'ČOV' : has(/septik|jímk|žump/) ? 'septik/jímka' : null),
    gas: join(p.gas) || (has(/(?<!\p{L})plyn(?!ul)/u) ? 'ano' : null),
    heating: join(p.heating) || null,
    cellar: p.cellar ?? (has(/sklep|podsklep/) ? true : null),
  };
}

async function scrape(url) {
  const u = new URL(url);
  const html = await fetchText(url);
  const host = u.hostname;
  const l = host.includes('sreality.cz') ? parseSreality(html, url)
    : host.includes('bezrealitky.cz') ? parseBezrealitky(html)
    : host.includes('realingo.cz') ? parseRealingo(html)
    : host.includes('reality.idnes.cz') ? parseIdnes(html, url)
    : parseGeneric(html, url);
  if (!l.lat || !l.lng) l.lat = l.lng = null;
  l.features = detectFeatures(l);
  return l;
}

const api = { scrape, detectFeatures, parseSreality, parseBezrealitky, parseRealingo, parseGeneric };
if (typeof module !== 'undefined') module.exports = api; else root.Scrape = api;
})(this);
