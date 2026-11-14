import { mkdir, writeFile } from 'node:fs/promises';
import { createOSMStream } from 'osm-pbf-parser-node';

const input = new URL('./egypt-latest.osm.pbf', import.meta.url);
const outDir = new URL('../public/places/', import.meta.url);
const cities = {
  'القاهرة': { file: 'cairo.json', bounds: [29.93, 31.14, 30.17, 31.42], center: [30.0444, 31.2357] },
  'الجيزة': { file: 'giza.json', bounds: [29.9, 31.04, 30.13, 31.33], center: [29.987, 31.2118] },
  'الإسكندرية': { file: 'alexandria.json', bounds: [31.08, 29.76, 31.3, 30.12], center: [31.2001, 29.9187] },
};
const itemsByCity = new Map(Object.keys(cities).map((city) => [city, new Map()]));
const ways = [];
const neededNodes = new Set();
const isPlace = (entity) => {
  const tags = entity.tags || {};
  if (!tags.name || !['restaurant', 'cafe'].includes(tags.amenity)) return false;

  // Do not recommend places that OSM explicitly marks as closed, planned, or private.
  if (tags.access === 'private' || tags.access === 'no') return false;
  if (tags['disused:amenity'] || tags['abandoned:amenity'] || tags['demolished:amenity'] || tags.construction || tags.proposed) return false;

  // A cafe/restaurant tag on a building explicitly mapped as a home is too
  // ambiguous for customer recommendations, even if the feature has a name.
  if (['residential', 'house', 'apartments', 'residence', 'static_caravan'].includes(tags.building)) {
    return false;
  }

  // Conflicting non-food business tags usually mean the food category was attached
  // to the wrong object. Food shops such as bakeries remain eligible.
  if (tags.office || tags.craft || (tags.shop && !['bakery', 'confectionery', 'coffee', 'tea'].includes(tags.shop))) return false;
  return true;
};
const haversine = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
function cityFor(lat, lon) {
  const matching = Object.entries(cities).filter(([, city]) => {
    const [south, west, north, east] = city.bounds;
    return lat >= south && lat <= north && lon >= west && lon <= east;
  });
  if (!matching.length) return null;
  return matching.sort((a, b) => haversine(lat, lon, ...a[1].center) - haversine(lat, lon, ...b[1].center))[0][0];
}
function addPlace(entity, lat, lon) {
  const city = cityFor(lat, lon);
  if (!city) return;
  const tags = entity.tags;
  const name = tags['name:ar'] || tags.name;
  const nameHintsCafe = /\b(cafe|café|coffee(?:\s*shop)?|cafeteria)\b|كافيه|كافية|قهوة|مقهى|كافي/i.test(`${tags.name || ''} ${tags['name:ar'] || ''}`);
  const nameHintsRestaurant = /\b(restaurant|resto)\b|مطعم/i.test(`${tags.name || ''} ${tags['name:ar'] || ''}`);
  const type = nameHintsCafe && nameHintsRestaurant ? 'مطعم وكافيه'
    : nameHintsCafe ? 'كافيه'
      : tags.amenity === 'cafe' ? 'كافيه' : 'مطعم';
  const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'] || tags['addr:neighbourhood']].filter(Boolean).join('، ');
  const query = encodeURIComponent(`${name} ${address} ${city}`);
  const searchText = `${name} ${tags.cuisine || ''} ${tags.amenity || ''}`.toLowerCase();
  let priceBand;
  if (type === 'كافيه' || tags.amenity === 'cafe') priceBand = { label: 'كافيه مع مشروب وحلو أو سناك', min: 150, max: 300 };
  else if (/four seasons|marriott|ritz|fairmont|sofitel|hotel|resort|rooftop|fine dining|مطعم راق|مطعم سياح/.test(searchText)) priceBand = { label: 'مطعم راقٍ', min: 700, max: 1200 };
  else if (/seafood|fish|grill|barbecue|steak_house|kebab|مشويات|أسماك|اسماك|سمك|كباب/.test(searchText)) priceBand = { label: 'سمك أو مشويات', min: 350, max: 700 };
  else if (/koshary|koshari|falafel|foul|taameya|shawarma|sandwich|كشري|كشرى|فول|طعمية|فلافل|شاورما|ساندوتش|سندوتش/.test(searchText)) priceBand = { label: 'وجبة شعبية أو ساندوتش', min: 100, max: 220 };
  else priceBand = { label: 'وجبة في مطعم عادي', min: 220, max: 450 };
  const imageUrl = /^https?:\/\//i.test(tags.image || '') ? tags.image : null;
  itemsByCity.get(city).set(`${entity.type}-${entity.id}`, {
    id: `osm-${entity.type}-${entity.id}`, name, lat, lon,
    type,
    cuisine: tags.cuisine || '', address,
    openingHours: tags.opening_hours || '',
    osmUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`,
    googleMapsUri: `https://www.google.com/maps/search/?api=1&query=${query}`,
    estimatedCostMin: priceBand.min, estimatedCost: priceBand.max, priceBand: priceBand.label,
    ...(imageUrl ? { imageUrl, imageAttribution: 'رابط صورة مرتبط ببيانات OpenStreetMap' } : {}),
  });
}

console.log('Pass 1/2: collecting active, public-facing cafes and restaurants…');
for await (const entity of createOSMStream(input)) {
  if (!isPlace(entity)) continue;
  if (entity.type === 'node' && Number.isFinite(entity.lat) && Number.isFinite(entity.lon)) addPlace(entity, entity.lat, entity.lon);
  if (entity.type === 'way' && Array.isArray(entity.refs)) {
    ways.push(entity);
    for (const ref of entity.refs) neededNodes.add(ref);
  }
}

console.log(`Pass 2/2: resolving ${neededNodes.size.toLocaleString()} map points for restaurant/cafe footprints…`);
const nodeCoords = new Map();
for await (const entity of createOSMStream(input)) {
  if (entity.type === 'node' && neededNodes.has(entity.id)) nodeCoords.set(entity.id, [entity.lat, entity.lon]);
}
for (const way of ways) {
  const coords = way.refs.map((ref) => nodeCoords.get(ref)).filter(Boolean);
  if (!coords.length) continue;
  const lat = coords.reduce((sum, p) => sum + p[0], 0) / coords.length;
  const lon = coords.reduce((sum, p) => sum + p[1], 0) / coords.length;
  addPlace(way, lat, lon);
}

await mkdir(outDir, { recursive: true });
for (const [city, config] of Object.entries(cities)) {
  const places = [...itemsByCity.get(city).values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  const payload = {
    city,
    source: 'OpenStreetMap contributors; Geofabrik Egypt extract',
    generatedAt: new Date().toISOString(),
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    places,
  };
  await writeFile(new URL(config.file, outDir), `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`${city}: ${places.length.toLocaleString()} places -> ${config.file}`);
}
