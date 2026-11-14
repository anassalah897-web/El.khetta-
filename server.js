const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'plans.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);

const CATALOG = {
  'القاهرة': [
    { name: 'المتحف المصري', category: 'تاريخ وثقافة', time: '٩:٠٠ ص', lat: 30.0478, lon: 31.2336 },
    { name: 'غداء في وسط البلد', category: 'أكل محلي', time: '١:٠٠ م', lat: 30.0470, lon: 31.2390 },
    { name: 'جولة في شارع المعز', category: 'تمشية وتاريخ', time: '٤:٠٠ م', lat: 30.0470, lon: 31.2623 },
    { name: 'قعدة على النيل', category: 'منظر النيل', time: '٧:٠٠ م', lat: 30.0430, lon: 31.2230 },
  ],
  'الجيزة': [
    { name: 'منطقة أهرامات الجيزة', category: 'تاريخ وثقافة', time: '٩:٠٠ ص', lat: 29.9792, lon: 31.1342 },
    { name: 'غداء بإطلالة على الأهرامات', category: 'أكل محلي', time: '١:٠٠ م', lat: 29.9850, lon: 31.1370 },
    { name: 'زيارة المتحف المصري الكبير', category: 'ثقافة', time: '٤:٠٠ م', lat: 29.9950, lon: 31.1193 },
    { name: 'عشاء هادئ في الجيزة', category: 'أكل', time: '٧:٣٠ م', lat: 29.9920, lon: 31.1370 },
  ],
  'الإسكندرية': [
    { name: 'قلعة قايتباي', category: 'تاريخ وبحر', time: '٩:٠٠ ص', lat: 31.21375, lon: 29.8854 },
    { name: 'غداء سمك على البحر', category: 'أكل محلي', time: '١٢:٠٠ م', lat: 31.2130, lon: 29.9000 },
    { name: 'مكتبة الإسكندرية', category: 'ثقافة', time: '٣:٠٠ م', lat: 31.2089, lon: 29.9092 },
    { name: 'تمشية على الكورنيش', category: 'بحر وغروب', lat: 31.2050, lon: 29.9150 },
  ],
};

const CITY_BOUNDS = {
  'القاهرة': [29.93, 31.14, 30.17, 31.42],
  'الجيزة': [29.90, 31.04, 30.13, 31.33],
  'الإسكندرية': [31.08, 29.76, 31.30, 30.12],
};
const placesCache = new Map();
const photosCache = new Map();
const PLACES_CACHE_MS = 6 * 60 * 60 * 1000;

async function nearbyPlaces(city) {
  const files = { 'القاهرة': 'cairo', 'الجيزة': 'giza', 'الإسكندرية': 'alexandria' };
  if (!files[city]) throw new Error('المدينة غير مدعومة.');
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'places', `${files[city]}.json`), 'utf8'));
  return data.places || [];
}

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function placePhotos(name, city) {
  const query = `${name} ${city} Egypt`;
  const cacheKey = query.toLowerCase();
  const cached = photosCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 24 * 60 * 60 * 1000) return cached.items;
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: '4',
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '640',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|UsageTerms', format: 'json', origin: '*',
  });
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'user-agent': 'YallaNkhattat/0.1 (place photo discovery)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('مصدر الصور غير متاح حاليًا.');
  const data = await response.json();
  const pages = Object.values(data.query?.pages || {});
  const items = pages.flatMap((page) => {
    const image = page.imageinfo?.[0];
    if (!image?.thumburl?.startsWith('https://upload.wikimedia.org/')) return [];
    const meta = image.extmetadata || {};
    return [{
      title: plainText(page.title?.replace(/^File:/, '')),
      url: image.thumburl,
      pageUrl: image.descriptionurl,
      author: plainText(meta.Artist?.value || meta.Credit?.value || 'غير مذكور'),
      license: plainText(meta.LicenseShortName?.value || meta.UsageTerms?.value || 'راجع صفحة الصورة'),
      licenseUrl: meta.LicenseUrl?.value || image.descriptionurl,
    }];
  }).slice(0, 4);
  photosCache.set(cacheKey, { items, savedAt: Date.now() });
  return items;
}

function readLocalPlans() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeLocalPlans(plans) {
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(plans, null, 2), 'utf8');
  fs.renameSync(tempFile, DATA_FILE);
}

let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, application_name: 'yalla-nkhattat' });
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS travel_plans (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS travel_plans_updated_at_idx ON travel_plans (updated_at DESC)');
}

async function getPlan(id) {
  if (!pool) return readLocalPlans()[id] || null;
  const result = await pool.query('SELECT payload FROM travel_plans WHERE id = $1', [id]);
  return result.rows[0]?.payload || null;
}

async function persistPlan(plan) {
  plan.updatedAt = new Date().toISOString();
  if (!pool) {
    const plans = readLocalPlans();
    plans[plan.id] = plan;
    writeLocalPlans(plans);
    return;
  }
  await pool.query(
    `INSERT INTO travel_plans (id, created_at, updated_at, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload`,
    [plan.id, plan.createdAt, plan.updatedAt, JSON.stringify(plan)],
  );
}

function budgetCap(plan) {
  if (plan.budgetMode === 'group') return plan.groupBudget / plan.expectedMembers;
  const budgets = plan.participants.map((member) => member.budget).filter(Number.isFinite);
  return budgets.length ? Math.min(...budgets) : 0;
}

function refreshSelections(plan) {
  let remaining = budgetCap(plan);
  for (const activity of plan.activities) {
    const isSupported = activity.kind === 'catalog' || activity.votes.length > plan.participants.length / 2;
    activity.selected = isSupported && Number.isFinite(activity.cost) && activity.cost <= remaining;
    if (activity.selected) remaining -= activity.cost;
  }
}

function cleanPlan(plan) {
  return {
    ...plan,
    perPersonCost: plan.activities.filter((a) => a.selected).reduce((sum, a) => sum + a.cost, 0),
  };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) reject(new Error('الطلب كبير جدًا.'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('بيانات الطلب غير صالحة.')); }
    });
    req.on('error', reject);
  });
}

function text(value, max = 100) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (pool) await pool.query('SELECT 1');
    return sendJson(res, 200, { ok: true, storage: pool ? 'postgres' : 'local-json' });
  }

  if (req.method === 'GET' && url.pathname === '/api/places') {
    const city = text(url.searchParams.get('city'), 40);
    try {
      const places = await nearbyPlaces(city);
      return sendJson(res, 200, { city, source: 'osm-static', attribution: '© OpenStreetMap contributors', places });
    } catch (error) {
      console.error(error.message);
      return sendJson(res, 503, { error: error.message, places: [] });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/photos') {
    const name = text(url.searchParams.get('name'), 80);
    const city = text(url.searchParams.get('city'), 40);
    if (!name || !CITY_BOUNDS[city]) return sendJson(res, 400, { error: 'المكان أو المدينة غير صالح.' });
    try { return sendJson(res, 200, { photos: await placePhotos(name, city) }); }
    catch (error) { return sendJson(res, 503, { error: error.message, photos: [] }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/plans') {
    const body = await readBody(req);
    const city = text(body.city, 40);
    const creatorName = text(body.name, 50);
    const clientId = text(body.clientId, 80);
    const mode = body.budgetMode === 'group' ? 'group' : 'individual';
    const budget = Number(body.budget);
    const expectedMembers = Math.max(1, Math.min(30, Number(body.expectedMembers) || 1));
    if (!CATALOG[city] || !creatorName || !clientId || !(budget > 0)) {
      return sendJson(res, 400, { error: 'املأ الاسم والمدينة والميزانية قبل إنشاء الخطة.' });
    }
    const plan = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      city,
      planType: body.planType === 'trip' ? 'trip' : 'outing',
      date: text(body.date, 20),
      expectedMembers,
      budgetMode: mode,
      groupBudget: mode === 'group' ? budget : null,
      participants: [{ id: clientId, name: creatorName, budget: mode === 'individual' ? budget : null, joinedAt: new Date().toISOString() }],
      activities: CATALOG[city].map((activity, index) => ({
        id: `place-${index + 1}`,
        ...activity,
        ...(Number.isFinite(activity.lat) && Number.isFinite(activity.lon)
          ? { osmUrl: `https://www.openstreetmap.org/?mlat=${activity.lat}&mlon=${activity.lon}#map=17/${activity.lat}/${activity.lon}` }
          : {}),
        kind: 'catalog',
        addedBy: null,
        votes: [],
        selected: false,
      })),
    };
    refreshSelections(plan);
    await persistPlan(plan);
    return sendJson(res, 201, cleanPlan(plan));
  }

  const match = url.pathname.match(/^\/api\/plans\/([0-9a-f-]+)$/i);
  if (match) {
    const id = match[1];
    const plan = await getPlan(id);
    if (!plan) return sendJson(res, 404, { error: 'الخطة غير موجودة.' });
    if (req.method === 'GET') return sendJson(res, 200, cleanPlan(plan));
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'الطريقة غير مدعومة.' });

    const body = await readBody(req);
    const action = text(body.action, 30);
    const clientId = text(body.clientId, 80);
    if (!clientId) return sendJson(res, 400, { error: 'تعذر تحديد العضو.' });

    if (action === 'join') {
      const name = text(body.name, 50);
      const existing = plan.participants.find((member) => member.id === clientId);
      if (!existing) {
        const budget = plan.budgetMode === 'individual' ? Number(body.budget) : null;
        if (!name || (plan.budgetMode === 'individual' && !(budget > 0))) {
          return sendJson(res, 400, { error: 'اكتب اسمك وميزانيتك الفردية للانضمام.' });
        }
        if (plan.participants.length >= 30) return sendJson(res, 400, { error: 'وصلت الخطة للحد الأقصى من الأعضاء.' });
        plan.participants.push({ id: clientId, name, budget, joinedAt: new Date().toISOString() });
        refreshSelections(plan);
        await persistPlan(plan);
      }
      return sendJson(res, 200, cleanPlan(plan));
    }

    if (!plan.participants.some((member) => member.id === clientId)) {
      return sendJson(res, 403, { error: 'انضم للخطة قبل التعديل أو التصويت.' });
    }

    if (action === 'addPlace') {
      const files = { 'القاهرة': 'cairo', 'الجيزة': 'giza', 'الإسكندرية': 'alexandria' };
      const placeFile = files[plan.city];
      if (!placeFile || typeof body.placeId !== 'string') return sendJson(res, 400, { error: 'المكان غير صالح.' });
      const placeData = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'places', `${placeFile}.json`), 'utf8'));
      const place = (placeData.places || []).find((item) => item.id === body.placeId);
      if (!place || !Number.isFinite(place.estimatedCost)) return sendJson(res, 404, { error: 'تعذر تحديد تقدير سعر المكان.' });
      if (plan.activities.some((item) => item.kind === 'place' && item.placeId === place.id)) return sendJson(res, 409, { error: 'المكان موجود بالفعل في الخطة.' });
      plan.activities.push({ id: randomUUID(), placeId: place.id, name: place.name, category: `${place.type} · ${place.priceBand}`, time: 'وقت مقترح', cost: place.estimatedCost, kind: 'place', addedBy: clientId, votes: [clientId], selected: false, lat: place.lat, lon: place.lon, osmUrl: place.osmUrl });
      refreshSelections(plan);
    } else if (action === 'setCost') {
      const activity = plan.activities.find((item) => item.id === body.activityId);
      const cost = Number(body.cost);
      if (!activity) return sendJson(res, 404, { error: 'النشاط غير موجود.' });
      if (body.cost === undefined || String(body.cost).trim() === '' || !Number.isFinite(cost) || cost < 0 || cost > 1_000_000) return sendJson(res, 400, { error: 'أدخل تكلفة تقديرية صحيحة للفرد.' });
      activity.cost = cost;
      refreshSelections(plan);
    } else if (action === 'suggest') {
      const name = text(body.name, 80);
      const cost = Number(body.cost);
      const lat = Number(body.lat);
      const lon = Number(body.lon);
      if (!name || body.cost === undefined || body.cost === null || String(body.cost).trim() === '' || !Number.isFinite(cost) || cost < 0 || cost > 1_000_000) {
        return sendJson(res, 400, { error: 'أدخل اسم المكان وتكلفته التقديرية للفرد.' });
      }
      plan.activities.push({
        id: randomUUID(), name, category: 'اقتراح من المجموعة', time: 'وقت مقترح', cost,
        kind: 'custom', addedBy: clientId, votes: [clientId], selected: false,
        ...(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
          ? { lat, lon, osmUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}` }
          : {}),
      });
      refreshSelections(plan);
    } else if (action === 'vote') {
      const activity = plan.activities.find((item) => item.id === body.activityId);
      if (!activity) return sendJson(res, 404, { error: 'النشاط غير موجود.' });
      activity.votes = activity.votes.includes(clientId)
        ? activity.votes.filter((vote) => vote !== clientId)
        : [...activity.votes, clientId];
      refreshSelections(plan);
    } else {
      return sendJson(res, 400, { error: 'الإجراء غير معروف.' });
    }

    plan.updatedAt = new Date().toISOString();
    await persistPlan(plan);
    return sendJson(res, 200, cleanPlan(plan));
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const file = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': file.length });
    return res.end(file);
  }
  const placeFile = url.pathname.match(/^\/places\/(cairo|giza|alexandria)\.json$/);
  if (req.method === 'GET' && placeFile) {
    const file = fs.readFileSync(path.join(ROOT, 'public', 'places', `${placeFile[1]}.json`));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': file.length, 'cache-control': 'public, max-age=3600' });
    return res.end(file);
  }
  return sendJson(res, 404, { error: 'الصفحة غير موجودة.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: error.message || 'حصل خطأ غير متوقع.' });
    else res.end();
  });
});

initializeDatabase().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Yalla Nkhattat running at http://${HOST}:${PORT} (${pool ? 'Postgres' : 'local JSON'})`);
  });
}).catch((error) => {
  console.error('Database initialization failed:', error);
  process.exitCode = 1;
});
