'use strict';
/**
 * APEX Logistics: Zoho Catalyst Advanced I/O function (Node.js + Express).
 * Same API as the AWS version, so the website works unchanged:
 *
 *   GET   /track/:trackingId            public
 *   POST  /bookings                     public
 *   POST  /admin/login                  public (checks ADMIN_EMAIL / ADMIN_PASSWORD_HASH)
 *   GET   /admin/dashboard              needs X-Apex-Token header
 *   PATCH /admin/shipments/:trackingId  needs X-Apex-Token header
 *
 * Data Store tables: Shipments, Fleet (columns listed in README.md).
 * Environment variables: ADMIN_EMAIL, ADMIN_PASSWORD_HASH, SESSION_SECRET.
 * The server recomputes every price; the cost sent by the browser is ignored.
 */
const express = require('express');
const crypto = require('crypto');
const catalystSDK = require('zcatalyst-sdk-node');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.catalyst = catalystSDK.initialize(req, { scope: 'admin' });
  next();
});

/* ------------------------------------------------------------------ reference data and pricing
   Keep in sync with CONFIG in client/index.html (the browser uses it for instant estimates). */
const HUBS = {
  // id: [name, country, lat, lon, hasPort]
  mumbai: ['Mumbai', 'IN', 19.08, 72.88, true],
  delhi: ['Delhi', 'IN', 28.61, 77.21, false],
  chennai: ['Chennai', 'IN', 13.08, 80.27, true],
  kolkata: ['Kolkata', 'IN', 22.57, 88.36, true],
  bengaluru: ['Bengaluru', 'IN', 12.97, 77.59, false],
  hyderabad: ['Hyderabad', 'IN', 17.39, 78.49, false],
  bhubaneswar: ['Bhubaneswar', 'IN', 20.30, 85.82, false],
  paradeep: ['Paradeep Port', 'IN', 20.26, 86.67, true],
  visakhapatnam: ['Visakhapatnam', 'IN', 17.69, 83.22, true],
  kochi: ['Kochi', 'IN', 9.93, 76.27, true],
  singapore: ['Singapore', 'SG', 1.35, 103.82, true],
  dubai: ['Dubai', 'AE', 25.20, 55.27, true],
  shanghai: ['Shanghai', 'CN', 31.23, 121.47, true],
  hongkong: ['Hong Kong', 'HK', 22.32, 114.17, true],
  rotterdam: ['Rotterdam', 'NL', 51.92, 4.48, true],
  london: ['London', 'GB', 51.51, -0.13, true],
  frankfurt: ['Frankfurt', 'DE', 50.11, 8.68, false],
  losangeles: ['Los Angeles', 'US', 34.05, -118.24, true],
  newyork: ['New York', 'US', 40.71, -74.01, true]
};

const PRICING = {
  gstPct: 0.18,
  modes: {
    road: { base: 1800, perKgPer1000Km: 5.5, minCharge: 3500, fuelPct: 0.09, circuity: 1.25, transitBase: 1, kmPerDay: 450, minKg: 1, maxKg: 40000 },
    ocean: { base: 9000, perKgPer1000Km: 2.2, minCharge: 15000, fuelPct: 0.06, circuity: 1.35, transitBase: 6, kmPerDay: 700, minKg: 100, maxKg: 500000 },
    air: { base: 6000, perKgPer1000Km: 9.0, minCharge: 8000, fuelPct: 0.12, circuity: 1.0, transitBase: 2, kmPerDay: 7000, minKg: 1, maxKg: 5000 }
  }
};

const STATUSES = ['Pending', 'Confirmed', 'In Transit', 'At Hub', 'Out for Delivery', 'Delivered', 'Delayed', 'Cancelled'];
const ACTIVE = new Set(['Confirmed', 'In Transit', 'At Hub', 'Out for Delivery', 'Delayed']);
const TRACKING_RE = /^APX-\d{8}-[A-Z0-9]{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SESSION_SECONDS = 3600;

/* ------------------------------------------------------------------ helpers */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = v => (typeof v === 'string' ? v : '');
const own = (obj, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null);
const log = o => console.log(JSON.stringify(o));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function haversineKm(a, b) {
  const R = 6371, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b[2] - a[2]), dLon = rad(b[3] - a[3]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[2])) * Math.cos(rad(b[2])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function estimate(origin, destination, mode, weightKg) {
  const o = own(HUBS, origin), d = own(HUBS, destination), rule = own(PRICING.modes, mode);
  if (!o || !d) throw new HttpError(400, 'Unknown origin or destination.');
  if (!rule) throw new HttpError(400, 'Transport mode must be road, ocean or air.');
  if (origin === destination) throw new HttpError(400, 'Origin and destination must be different.');
  if (!(weightKg >= rule.minKg && weightKg <= rule.maxKg)) {
    throw new HttpError(400, `Weight for ${mode} freight must be between ${rule.minKg} and ${rule.maxKg} kg.`);
  }
  if (mode === 'road' && !(o[1] === 'IN' && d[1] === 'IN')) throw new HttpError(400, 'Road freight is available for domestic (India) lanes only.');
  if (mode === 'ocean' && !(o[4] && d[4])) throw new HttpError(400, 'Ocean freight needs a port at both ends.');
  const km = Math.round(haversineKm(o, d) * rule.circuity);
  const raw = rule.base + rule.perKgPer1000Km * weightKg * (km / 1000);
  const freight = Math.round(Math.max(rule.minCharge, raw));
  const fuel = Math.round(freight * rule.fuelPct);
  const gst = Math.round((freight + fuel) * PRICING.gstPct);
  return { km, freight, fuel, gst, total: freight + fuel + gst, transitDays: rule.transitBase + Math.ceil(km / rule.kmPerDay) };
}

function newTrackingId(now) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return `APX-${ymd}-${suffix}`;
}

/* ------------------------------------------------------------------ Data Store access
   ZCQL returns every value as a string and nests rows under the table name. */
const SHIP_COLS = 'ROWID, trackingId, shipStatus, customerName, email, origin, destination, currentLocation, transportMode, weightKg, estimatedCost, estimatedDelivery, createdAt, updatedAt';
const FLEET_COLS = 'vehicleId, vehicleType, vehicleName, vehicleStatus, vehicleLocation';

const toShipment = r => ({
  rowId: r.ROWID, trackingId: r.trackingId, status: r.shipStatus, customerName: r.customerName, email: r.email,
  origin: r.origin, destination: r.destination, currentLocation: r.currentLocation, mode: r.transportMode,
  weightKg: Number(r.weightKg) || 0, estimatedCost: Number(r.estimatedCost) || 0,
  estimatedDelivery: r.estimatedDelivery, createdAt: r.createdAt, updatedAt: r.updatedAt
});
const publicView = s => ({
  trackingId: s.trackingId, status: s.status, customerName: s.customerName, origin: s.origin, destination: s.destination,
  currentLocation: s.currentLocation, mode: s.mode, weightKg: s.weightKg, estimatedDelivery: s.estimatedDelivery, createdAt: s.createdAt
});
const adminView = s => ({ ...publicView(s), email: s.email, estimatedCost: s.estimatedCost, updatedAt: s.updatedAt });
const toVehicle = r => ({ vehicleId: r.vehicleId, type: r.vehicleType, name: r.vehicleName, status: r.vehicleStatus, location: r.vehicleLocation });

async function findShipment(catalyst, trackingId) {
  // trackingId was validated against TRACKING_RE, so it only contains A-Z, 0-9 and "-"
  const rows = await catalyst.zcql().executeZCQLQuery(`SELECT ${SHIP_COLS} FROM Shipments WHERE trackingId = '${trackingId}'`);
  return rows.length ? toShipment(rows[0].Shipments) : null;
}

async function scanAll(catalyst, table, cols, map) {
  const PAGE = 300, CAP = 6000; // ZCQL returns at most 300 rows per query
  const out = [];
  for (let offset = 0; offset < CAP; offset += PAGE) {
    const rows = await catalyst.zcql().executeZCQLQuery(`SELECT ${cols} FROM ${table} ORDER BY ROWID LIMIT ${offset}, ${PAGE}`);
    rows.forEach(r => out.push(map(r[table])));
    if (rows.length < PAGE) break;
  }
  return out;
}

function summarise(items) {
  const now = new Date(), months = [], revenue = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    months.push({ key, label: `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` });
    revenue[key] = 0;
  }
  const modes = { road: 0, ocean: 0, air: 0 };
  let total = 0, pending = 0, active = 0;
  items.forEach(s => {
    if (own(modes, s.mode) !== null) modes[s.mode] += 1;
    if (s.status === 'Cancelled') return;
    total += s.estimatedCost;
    const key = String(s.createdAt).slice(0, 7);
    if (own(revenue, key) !== null) revenue[key] += s.estimatedCost;
    if (s.status === 'Pending') pending += 1;
    if (ACTIVE.has(s.status)) active += 1;
  });
  return {
    totalRevenue: total, monthRevenue: revenue[months[5].key], pendingCount: pending, activeCount: active,
    modeBreakdown: modes, monthlyRevenue: months.map(m => ({ month: m.label, revenue: revenue[m.key] }))
  };
}

/* ------------------------------------------------------------------ admin auth (signed token, no external service) */
function sessionSecret() {
  const s = process.env.SESSION_SECRET || '';
  return s.length >= 32 ? s : null;
}
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(sessionSecret(), body).toString('base64url')}`;
}
function verifyToken(token) {
  const secret = sessionSecret();
  const [body, sig] = String(token || '').split('.');
  if (!secret || !body || !sig) return null;
  const given = Buffer.from(sig, 'base64url'), expected = hmac(secret, body);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.exp > Math.floor(Date.now() / 1000) ? p : null;
  } catch (e) { return null; }
}
function verifyPassword(password, stored) { // stored = "scrypt:<saltHex>:<hashHex>" from tools/make_admin_hash.js
  const [scheme, saltHex, hashHex] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (!expected.length) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length), expected);
}
const sameText = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

// Best-effort brute-force guard (memory is per function instance). Add Catalyst API Gateway throttling for a hard limit.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const clientIp = req => String(req.get('x-forwarded-for') || req.ip || 'unknown').split(',')[0].trim();
const lockedOut = ip => { const r = failures.get(ip); return !!r && r.count >= 8 && Date.now() - r.first < WINDOW_MS; };
function noteFailure(ip) {
  const now = Date.now(), r = failures.get(ip);
  if (!r || now - r.first >= WINDOW_MS) failures.set(ip, { count: 1, first: now }); else r.count += 1;
  if (failures.size > 1000) failures.clear();
}

function requireAdmin(req, res, next) {
  const payload = verifyToken(req.get('x-apex-token'));
  if (!payload) return next(new HttpError(401, 'Your session has expired. Sign in again.'));
  req.admin = payload.sub;
  next();
}

/* ------------------------------------------------------------------ public routes */
app.get('/track/:trackingId', wrap(async (req, res) => {
  const id = str(req.params.trackingId).trim().toUpperCase();
  if (!TRACKING_RE.test(id)) throw new HttpError(400, 'Tracking IDs look like APX-20261012-AB12CD34.');
  const s = await findShipment(res.locals.catalyst, id);
  if (!s) throw new HttpError(404, 'No shipment found for that tracking ID.');
  res.json(publicView(s));
}));

app.post('/bookings', wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.customerName).trim(), email = str(b.email).trim().toLowerCase();
  const origin = str(b.origin), destination = str(b.destination), mode = str(b.mode);
  const w = typeof b.weightKg === 'number' ? b.weightKg : (typeof b.weightKg === 'string' && b.weightKg.trim() !== '' ? Number(b.weightKg) : NaN);
  if (!Number.isFinite(w)) throw new HttpError(400, 'Weight must be a number.');
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Customer name must be 2-80 characters.');
  if (email.length > 120 || !EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const quote = estimate(origin, destination, mode, w);

  const now = new Date(), iso = nowIso();
  const eta = new Date(now.getTime() + quote.transitDays * 864e5).toISOString().slice(0, 10);
  const table = res.locals.catalyst.datastore().table('Shipments');
  for (let attempt = 0; attempt < 3; attempt++) {
    const trackingId = newTrackingId(now);
    try {
      await table.insertRow({
        trackingId, shipStatus: 'Pending', customerName: name, email, origin, destination,
        currentLocation: HUBS[origin][0], transportMode: mode, weightKg: w, estimatedCost: quote.total,
        estimatedDelivery: eta, createdAt: iso, updatedAt: iso
      });
      log({ level: 'INFO', event: 'booking_created', trackingId, mode, total: quote.total });
      return res.status(201).json({ trackingId, status: 'Pending', estimatedCost: quote.total, estimatedDelivery: eta, createdAt: iso });
    } catch (err) {
      if (!/duplicate|unique/i.test(String((err && err.message) || err))) throw err; // only retry ID collisions
    }
  }
  throw new HttpError(503, 'Could not allocate a tracking reference. Please retry.');
}));

app.post('/admin/login', wrap(async (req, res) => {
  const ip = clientIp(req);
  if (lockedOut(ip)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
  const email = str((req.body || {}).email).trim().toLowerCase(), password = str((req.body || {}).password);
  if (!email || !password) throw new HttpError(400, 'Enter your email and password.');
  const adminEmail = str(process.env.ADMIN_EMAIL).trim().toLowerCase(), hash = process.env.ADMIN_PASSWORD_HASH;
  if (!adminEmail || !hash || !sessionSecret()) {
    log({ level: 'ERROR', event: 'admin_login_not_configured' });
    throw new HttpError(500, 'Admin login is not configured on the server.');
  }
  const okEmail = sameText(email, adminEmail), okPassword = verifyPassword(password, hash); // always run both checks
  if (!(okEmail && okPassword)) {
    noteFailure(ip);
    log({ level: 'WARN', event: 'admin_login_failed' });
    await sleep(400);
    throw new HttpError(401, 'Invalid email or password.');
  }
  const iat = Math.floor(Date.now() / 1000);
  res.json({ idToken: signToken({ sub: adminEmail, iat, exp: iat + SESSION_SECONDS }), expiresIn: SESSION_SECONDS });
}));

/* ------------------------------------------------------------------ admin routes */
app.get('/admin/dashboard', requireAdmin, wrap(async (req, res) => {
  const { catalyst } = res.locals;
  const [shipments, fleet] = await Promise.all([
    scanAll(catalyst, 'Shipments', SHIP_COLS, toShipment),
    scanAll(catalyst, 'Fleet', FLEET_COLS, toVehicle)
  ]);
  shipments.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ summary: summarise(shipments), shipments: shipments.map(adminView), fleet });
}));

app.patch('/admin/shipments/:trackingId', requireAdmin, wrap(async (req, res) => {
  const id = str(req.params.trackingId).trim().toUpperCase();
  if (!TRACKING_RE.test(id)) throw new HttpError(400, 'Invalid tracking ID.');
  const body = req.body || {}, patch = {};
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
    patch.shipStatus = body.status;
  }
  if ('currentLocation' in body) {
    const loc = str(body.currentLocation).trim();
    if (loc.length < 1 || loc.length > 120) throw new HttpError(400, 'Location must be 1-120 characters.');
    patch.currentLocation = loc;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, 'Provide a status and/or currentLocation.');

  const { catalyst } = res.locals;
  const current = await findShipment(catalyst, id);
  if (!current) throw new HttpError(404, 'Shipment not found.');
  patch.updatedAt = nowIso();
  await catalyst.datastore().table('Shipments').updateRow({ ROWID: current.rowId, ...patch });
  log({ level: 'INFO', event: 'shipment_updated', trackingId: id, by: req.admin, status: body.status, location: patch.currentLocation });
  res.json(adminView({
    ...current, status: patch.shipStatus || current.status,
    currentLocation: patch.currentLocation || current.currentLocation, updatedAt: patch.updatedAt
  }));
}));

/* ------------------------------------------------------------------ fallbacks */
app.use((req, res) => res.status(404).json({ message: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Request body must be valid JSON.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ message: 'Request body is too large.' });
  console.error(JSON.stringify({ level: 'ERROR', event: 'unhandled', error: String((err && err.stack) || err) }));
  res.status(500).json({ message: 'Unexpected server error.' });
});

module.exports = app;
