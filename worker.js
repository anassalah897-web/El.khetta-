const CATALOG = {
  'القاهرة': [
    { name: 'المتحف المصري', category: 'تاريخ وثقافة', time: '٩:٠٠ ص', lat: 30.0478, lon: 31.2336 },
    { name: 'غداء في وسط البلد', category: 'أكل محلي', time: '١:٠٠ م', lat: 30.047, lon: 31.239 },
    { name: 'جولة في شارع المعز', category: 'تمشية وتاريخ', time: '٤:٠٠ م', lat: 30.047, lon: 31.2623 },
    { name: 'قعدة على النيل', category: 'منظر النيل', time: '٧:٠٠ م', lat: 30.043, lon: 31.223 },
  ],
  'الجيزة': [
    { name: 'منطقة أهرامات الجيزة', category: 'تاريخ وثقافة', time: '٩:٠٠ ص', lat: 29.9792, lon: 31.1342 },
    { name: 'غداء بإطلالة على الأهرامات', category: 'أكل محلي', time: '١:٠٠ م', lat: 29.985, lon: 31.137 },
    { name: 'زيارة المتحف المصري الكبير', category: 'ثقافة', time: '٤:٠٠ م', lat: 29.995, lon: 31.1193 },
    { name: 'عشاء هادئ في الجيزة', category: 'أكل', time: '٧:٣٠ م', lat: 29.992, lon: 31.137 },
  ],
  'الإسكندرية': [
    { name: 'قلعة قايتباي', category: 'تاريخ وبحر', time: '٩:٠٠ ص', lat: 31.21375, lon: 29.8854 },
    { name: 'غداء سمك على البحر', category: 'أكل محلي', time: '١٢:٠٠ م', lat: 31.213, lon: 29.9 },
    { name: 'مكتبة الإسكندرية', category: 'ثقافة', time: '٣:٠٠ م', lat: 31.2089, lon: 29.9092 },
    { name: 'تمشية على الكورنيش', category: 'بحر وغروب', time: '٦:٠٠ م', lat: 31.205, lon: 29.915 },
  ],
};
const CITY_BOUNDS = {
  'القاهرة': [29.93, 31.14, 30.17, 31.42],
  'الجيزة': [29.9, 31.04, 30.13, 31.33],
  'الإسكندرية': [31.08, 29.76, 31.3, 30.12],
};
const CITY_CENTERS = {
  'القاهرة': { latitude: 30.0444, longitude: 31.2357 },
  'الجيزة': { latitude: 29.987, longitude: 31.2118 },
  'الإسكندرية': { latitude: 31.2001, longitude: 29.9187 },
};
const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const placesCache = new Map();
const PLACES_CACHE_MS = 6 * 60 * 60 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const text = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const plainText = (value) => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, 160);
const mapUrl = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
const budgetCap = (plan) => plan.budgetMode === 'group'
  ? plan.groupBudget / plan.expectedMembers
  : Math.min(...plan.participants.map((member) => member.budget).filter(Number.isFinite));
function refreshSelections(plan) {
  let remaining = budgetCap(plan);
  for (const activity of plan.activities) {
    const supported = activity.kind === 'catalog' || activity.votes.length > plan.participants.length / 2;
    activity.selected = supported && Number.isFinite(activity.cost) && activity.cost <= remaining;
    if (activity.selected) remaining -= activity.cost;
  }
}
function cleanPlan(plan) {
  return { ...plan, perPersonCost: plan.activities.filter((a) => a.selected).reduce((sum, a) => sum + a.cost, 0) };
}
async function readPlan(db, id) {
  const row = await db.prepare('SELECT payload FROM travel_plans WHERE id = ?').bind(id).first();
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}
async function savePlan(db, plan) {
  plan.updatedAt = new Date().toISOString();
  await db.prepare(`INSERT INTO travel_plans (id, created_at, updated_at, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload`)
    .bind(plan.id, plan.createdAt, plan.updatedAt, JSON.stringify(plan)).run();
}
async function nearbyPlacesFromHere(city, apiKey) {
  const center = CITY_CENTERS[city];
  if (!center) throw new Error('المدينة غير مدعومة.');
  const cached = placesCache.get(`here:${city}`);
  if (cached && Date.now() - cached.savedAt < PLACES_CACHE_MS) return cached.items;
  const circle = `circle:${center.latitude},${center.longitude};r=25000`;
  const searches = await Promise.all(['restaurant', 'cafe'].map(async (query) => {
    const params = new URLSearchParams({ q: query, in: circle, lang: 'ar', limit: '15', apiKey });
    const response = await fetch(`https://discover.search.hereapi.com/v1/discover?${params}`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HERE Geocoding and Search أعاد الخطأ ${response.status}.`);
    return response.json();
  }));
  const items = [...new Map(searches.flatMap((data, searchIndex) => (data.items || []).flatMap((item) => {
    const lat = item.position?.lat, lon = item.position?.lng;
    if (!item.id || !item.title || !Number.isFinite(lat) || !Number.isFinite(lon) || item.resultType !== 'place') return [];
    const address = item.address?.label || '';
    const cuisine = (item.foodTypes || []).map((food) => food.name).join('، ');
    const openingHours = (item.openingHours?.[0]?.text || []).join(' · ');
    return [[item.id, {
      id: `here-${item.id}`, name: item.title, lat, lon,
      type: searchIndex === 1 ? 'كافيه' : 'مطعم', cuisine, address, openingHours,
      hereId: item.id,
      googleMapsUri: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.title} ${address}`)}`,
      osmUrl: mapUrl(lat, lon),
    }]];
  })))].map(([, item]) => item);
  placesCache.set(`here:${city}`, { items, savedAt: Date.now() });
  return items;
}
async function nearbyPlacesFromOsm(city) {
  if (!CITY_BOUNDS[city]) throw new Error('المدينة غير مدعومة.');
  const cached = placesCache.get(city);
  if (cached && Date.now() - cached.savedAt < PLACES_CACHE_MS) return cached.items;
  const [south, west, north, east] = CITY_BOUNDS[city];
  const bbox = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:25];(node["amenity"~"cafe|restaurant"]["name"](${bbox});way["amenity"~"cafe|restaurant"]["name"](${bbox});relation["amenity"~"cafe|restaurant"]["name"](${bbox}););out center tags;`;
  let data;
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': 'YallaNkhattat/0.1 (Egypt outing planner)' },
        body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(12000),
      });
      if (response.status === 429 || response.status === 406) {
        throw new Error(`مصدر بيانات الأماكن يطلب تخفيف الطلبات (${response.status}).`);
      }
      if (!response.ok) {
        lastError = new Error(`مصدر بيانات الأماكن غير متاح حاليًا (${response.status}).`);
        if (response.status < 500) break;
        continue;
      }
      data = await response.json();
      break;
    } catch (error) {
      lastError = error;
      if (error.message.includes('(429)') || error.message.includes('(406)')) break;
    }
  }
  if (!data) throw lastError || new Error('مصدر بيانات الأماكن غير متاح حاليًا.');
  const center = city === 'القاهرة' ? [30.05, 31.25] : city === 'الجيزة' ? [30.01, 31.17] : [31.2, 29.91];
  const places = (data.elements || []).flatMap((item) => {
    const tags = item.tags || {}, lat = item.lat ?? item.center?.lat, lon = item.lon ?? item.center?.lon;
    if (!tags.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [{ id: `osm-${item.type}-${item.id}`, name: tags['name:ar'] || tags.name, lat, lon,
      type: tags.amenity === 'cafe' ? 'كافيه' : 'مطعم', cuisine: tags.cuisine || '',
      address: [tags['addr:street'], tags['addr:housenumber'], tags['addr:suburb']].filter(Boolean).join('، '),
      openingHours: tags.opening_hours || '', price: null, osmUrl: mapUrl(lat, lon) }];
  });
  places.sort((a, b) => ((a.lat-center[0])**2+(a.lon-center[1])**2) - ((b.lat-center[0])**2+(b.lon-center[1])**2));
  const result = places.slice(0, 160);
  placesCache.set(city, { items: result, savedAt: Date.now() });
  return result;
}
async function placePhotos(name, city) {
  const params = new URLSearchParams({ action: 'query', generator: 'search', gsrsearch: `${name} ${city} Egypt`, gsrnamespace: '6', gsrlimit: '4', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '640', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|UsageTerms', format: 'json', origin: '*' });
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { 'user-agent': 'YallaNkhattat/0.1' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('مصدر الصور غير متاح حاليًا.');
  const data = await response.json();
  return Object.values(data.query?.pages || {}).flatMap((page) => {
    const image = page.imageinfo?.[0];
    if (!image?.thumburl?.startsWith('https://upload.wikimedia.org/')) return [];
    const meta = image.extmetadata || {};
    return [{ title: plainText(page.title?.replace(/^File:/, '')), url: image.thumburl, pageUrl: image.descriptionurl,
      author: plainText(meta.Artist?.value || meta.Credit?.value || 'غير مذكور'),
      license: plainText(meta.LicenseShortName?.value || meta.UsageTerms?.value || 'راجع صفحة الصورة'),
      licenseUrl: meta.LicenseUrl?.value || image.descriptionurl }];
  }).slice(0, 4);
}

async function handleApi(request, env, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    await env.DB.prepare('SELECT 1').first();
    return json({ ok: true, storage: 'cloudflare-d1' });
  }
  if (request.method === 'GET' && url.pathname === '/api/places') {
    const city = text(url.searchParams.get('city'), 40);
    const files = { 'القاهرة': 'cairo', 'الجيزة': 'giza', 'الإسكندرية': 'alexandria' };
    if (!files[city]) return json({ error: 'المدينة غير مدعومة.', places: [] }, 400);
    const response = await env.ASSETS.fetch(new Request(new URL(`/places/${files[city]}.json`, url)));
    if (!response.ok) return json({ error: 'قائمة الأماكن غير متاحة.', places: [] }, 503);
    const data = await response.json();
    return json({ city, source: 'osm-static', attribution: data.attribution, places: data.places || [] });
  }
  if (request.method === 'GET' && url.pathname === '/api/photos') {
    const name = text(url.searchParams.get('name'), 80), city = text(url.searchParams.get('city'), 40);
    if (!name || !CITY_BOUNDS[city]) return json({ error: 'المكان أو المدينة غير صالح.' }, 400);
    try { return json({ photos: await placePhotos(name, city) }); }
    catch (error) { return json({ error: error.message, photos: [] }, 503); }
  }
  if (request.method === 'POST' && url.pathname === '/api/plans') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'بيانات الطلب غير صالحة.' }, 400); }
    const city = text(body.city, 40), name = text(body.name, 50), clientId = text(body.clientId, 80);
    const budgetMode = body.budgetMode === 'group' ? 'group' : 'individual', budget = Number(body.budget);
    const expectedMembers = Math.max(1, Math.min(30, Number(body.expectedMembers) || 1));
    if (!CATALOG[city] || !name || !clientId || !(budget > 0)) return json({ error: 'املأ الاسم والمدينة والميزانية قبل إنشاء الخطة.' }, 400);
    const now = new Date().toISOString();
    const plan = { id: crypto.randomUUID(), createdAt: now, city, planType: body.planType === 'trip' ? 'trip' : 'outing', date: text(body.date, 20), expectedMembers,
      budgetMode, groupBudget: budgetMode === 'group' ? budget : null,
      participants: [{ id: clientId, name, budget: budgetMode === 'individual' ? budget : null, joinedAt: now }],
      activities: CATALOG[city].map((activity, i) => ({ id: `place-${i+1}`, ...activity, osmUrl: mapUrl(activity.lat, activity.lon), kind: 'catalog', addedBy: null, votes: [], selected: false })) };
    refreshSelections(plan); await savePlan(env.DB, plan); return json(cleanPlan(plan), 201);
  }
  const match = url.pathname.match(/^\/api\/plans\/([0-9a-f-]+)$/i);
  if (!match) return null;
  const plan = await readPlan(env.DB, match[1]);
  if (!plan) return json({ error: 'الخطة غير موجودة.' }, 404);
  if (request.method === 'GET') return json(cleanPlan(plan));
  if (request.method !== 'POST') return json({ error: 'الطريقة غير مدعومة.' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'بيانات الطلب غير صالحة.' }, 400); }
  const action = text(body.action, 30), clientId = text(body.clientId, 80);
  if (!clientId) return json({ error: 'تعذر تحديد العضو.' }, 400);
  if (action === 'join') {
    const name = text(body.name, 50), existing = plan.participants.find((member) => member.id === clientId);
    if (!existing) {
      const budget = plan.budgetMode === 'individual' ? Number(body.budget) : null;
      if (!name || (plan.budgetMode === 'individual' && !(budget > 0))) return json({ error: 'اكتب اسمك وميزانيتك الفردية للانضمام.' }, 400);
      if (plan.participants.length >= 30) return json({ error: 'وصلت الخطة للحد الأقصى من الأعضاء.' }, 400);
      plan.participants.push({ id: clientId, name, budget, joinedAt: new Date().toISOString() });
      refreshSelections(plan); await savePlan(env.DB, plan);
    }
    return json(cleanPlan(plan));
  }
  if (!plan.participants.some((member) => member.id === clientId)) return json({ error: 'انضم للخطة قبل التعديل أو التصويت.' }, 403);
  if (action === 'addPlace') {
    const files = { 'القاهرة': 'cairo', 'الجيزة': 'giza', 'الإسكندرية': 'alexandria' };
    const placeFile = files[plan.city];
    if (!placeFile || typeof body.placeId !== 'string') return json({ error: 'المكان غير صالح.' }, 400);
    const placesResponse = await env.ASSETS.fetch(new Request(new URL(`/places/${placeFile}.json`, url)));
    if (!placesResponse.ok) return json({ error: 'قائمة الأماكن غير متاحة.' }, 503);
    const placeData = await placesResponse.json();
    const place = (placeData.places || []).find((item) => item.id === body.placeId);
    if (!place || !Number.isFinite(place.estimatedCost)) return json({ error: 'تعذر تحديد تقدير سعر المكان.' }, 404);
    if (plan.activities.some((item) => item.kind === 'place' && item.placeId === place.id)) return json({ error: 'المكان موجود بالفعل في الخطة.' }, 409);
    plan.activities.push({ id: crypto.randomUUID(), placeId: place.id, name: place.name, category: `${place.type} · ${place.priceBand}`, time: 'وقت مقترح', cost: place.estimatedCost, kind: 'place', addedBy: clientId, votes: [clientId], selected: false, lat: place.lat, lon: place.lon, osmUrl: place.osmUrl });
    refreshSelections(plan);
  } else if (action === 'setCost') {
    const activity = plan.activities.find((item) => item.id === body.activityId);
    const cost = Number(body.cost);
    if (!activity) return json({ error: 'النشاط غير موجود.' }, 404);
    if (body.cost === undefined || String(body.cost).trim() === '' || !Number.isFinite(cost) || cost < 0 || cost > 1000000) return json({ error: 'أدخل تكلفة تقديرية صحيحة للفرد.' }, 400);
    activity.cost = cost;
    refreshSelections(plan);
  } else if (action === 'suggest') {
    const name = text(body.name, 80), cost = Number(body.cost), lat = Number(body.lat), lon = Number(body.lon);
    if (!name || body.cost === undefined || body.cost === null || String(body.cost).trim() === '' || !Number.isFinite(cost) || cost < 0 || cost > 1000000) return json({ error: 'أدخل اسم المكان وتكلفته التقديرية للفرد.' }, 400);
    plan.activities.push({ id: crypto.randomUUID(), name, category: 'اقتراح من المجموعة', time: 'وقت مقترح', cost, kind: 'custom', addedBy: clientId, votes: [clientId], selected: false,
      ...(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon, osmUrl: mapUrl(lat, lon) } : {}) });
    refreshSelections(plan);
  } else if (action === 'vote') {
    const activity = plan.activities.find((item) => item.id === body.activityId);
    if (!activity) return json({ error: 'النشاط غير موجود.' }, 404);
    activity.votes = activity.votes.includes(clientId) ? activity.votes.filter((vote) => vote !== clientId) : [...activity.votes, clientId];
    refreshSelections(plan);
  } else return json({ error: 'الإجراء غير معروف.' }, 400);
  await savePlan(env.DB, plan);
  return json(cleanPlan(plan));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        const response = await handleApi(request, env, url);
        if (response) return response;
        return json({ error: 'الصفحة غير موجودة.' }, 404);
      } catch (error) {
        console.error(error);
        return json({ error: 'حصل خطأ غير متوقع.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
