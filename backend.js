// backend.js (sync upgraded based on old woox-dk patterns)
// - Full sync: paged /api/v1/Product/page/{page}/{perPage}
// - Incremental sync: same endpoint with ?modified=<timestamp>&include=<fields>
// - Manual triggers: /api/sync/full and /api/sync/inc
// - Webhook ingest (optional): /api/webhook/dk (expects { Objects: [...] } or array)
// - Stores cursor in Postgres sync_state table

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || process.env.UI_PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const DK_TOKEN = process.env.DKPLUS_TOKEN;
// Expect base like: https://api.dkplus.is/api/v1/Product  (case matters in old code)
const DK_PRODUCT_BASE = (process.env.DKPLUS_PRODUCT_BASE || process.env.DKPLUS_ENDPOINT || '').replace(/\/$/, '');

// Optional shared secret for manual sync + webhook
const SYNC_SECRET = process.env.SYNC_SECRET || '';

// Default paging (old code used flexible per_page and also 100 in cron paging)
const DK_PAGE_SIZE = Number(process.env.DK_PAGE_SIZE || 500);

// Old code limited fields via include=... to reduce payload
const DK_INCLUDE = process.env.DK_INCLUDE ||
  'RecordModified,ShowItemInWebShop,RecordID,AliasItemCode,ItemCode,Description,Description2,UnitPrice1WithTax,Publication,TotalQuantityInWarehouse,Inactive,Warehouses,AllowDiscount,Discount';

function needsSsl(dbUrl) {
  if (!dbUrl) return false;
  return !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

// -------------------- DB INIT --------------------

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS size_variant (
      sku TEXT PRIMARY KEY,
      record_id INT,
      alias_item_code TEXT,
      name TEXT,
      description TEXT,
      price NUMERIC DEFAULT 0,
      sale_price NUMERIC DEFAULT 0,
      allow_discount BOOLEAN DEFAULT FALSE,
      discount NUMERIC DEFAULT 0,
      stock_bg1 INT DEFAULT 0,
      stock_bg5 INT DEFAULT 0,
      stock_bg6 INT DEFAULT 0,
      qty_total INT DEFAULT 0,
      inactive BOOLEAN DEFAULT FALSE,
      show_in_webshop BOOLEAN DEFAULT TRUE,
      record_modified TIMESTAMPTZ,
      brand TEXT,
      color TEXT,
      size TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  console.log('DB ready');
}

async function getState(key, fallback = null) {
  const r = await pool.query('SELECT value FROM sync_state WHERE key=$1', [key]);
  return r.rows[0]?.value ?? fallback;
}

async function setState(key, value) {
  await pool.query(`
    INSERT INTO sync_state(key, value)
    VALUES ($1,$2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, String(value)]);
}

async function dbCount() {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM size_variant');
  return r.rows[0].n;
}

// -------------------- HELPERS --------------------
function dkTimestamp(d = new Date()) {
  // Old PHP passed 'Y-m-d H:i:s' and URL-encoded spaces
  // We'll generate UTC 'YYYY-MM-DD HH:mm:ss'
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function buildDkPageUrl(page, perPage, params = {}) {
  if (!DK_PRODUCT_BASE) throw new Error('Missing DKPLUS_PRODUCT_BASE (or DKPLUS_ENDPOINT)');
  if (!DK_TOKEN) throw new Error('Missing DKPLUS_TOKEN');

  // If user provided full endpoint already containing /page/, keep it as base and only replace page/perPage
  let base = DK_PRODUCT_BASE;

  // Normalise: if ends with /product (lowercase) or /Product, we append /page
  // Expect: .../api/v1/Product
  const hasPage = /\/page\//i.test(base);
  let urlStr;

  if (hasPage) {
    // Replace any trailing /page/x/y with desired values
    urlStr = base.replace(/\/page\/\d+\/\d+.*$/i, `/page/${page}/${perPage}`);
  } else {
    urlStr = `${base}/page/${page}/${perPage}`;
  }

  const url = new URL(urlStr);

  // Apply params
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  // Always include select-fields to reduce payload
  if (!url.searchParams.has('include') && DK_INCLUDE) {
    url.searchParams.set('include', DK_INCLUDE);
  }

  return url.toString();
}

function parseDkJson(text) {
  // Robust parsing: old code assumed array; sometimes APIs return { Objects: [...] }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { items: [], raw: text };
  }

  if (Array.isArray(data)) return { items: data, raw: data };
  if (Array.isArray(data.items)) return { items: data.items, raw: data };
  if (Array.isArray(data.data)) return { items: data.data, raw: data };
  if (data.data && Array.isArray(data.data.items)) return { items: data.data.items, raw: data };
  if (Array.isArray(data.Objects)) return { items: data.Objects, raw: data };

  return { items: [], raw: data };
}

async function dkFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${DK_TOKEN}` }
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`DK HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return parseDkJson(text);
}

function safeBool(v) {
  if (v === true || v === 1 || v === '1') return true;
  return false;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function computeBg1Qty(warehouses) {
  // Mirrors old woox_calculate_dk_quantity: bg1 QuantityInStock - QuantityOnBackOrders
  // and clamp to 0
  if (!Array.isArray(warehouses)) return 0;
  let qty = 0;
  for (const w of warehouses) {
    if (w && String(w.Warehouse).toLowerCase() === 'bg1') {
      qty += safeNum(w.QuantityInStock, 0) - safeNum(w.QuantityOnBackOrders, 0);
    }
  }
  return qty < 0 ? 0 : qty;
}

function extractPublication(p) {
  const pub = p.Publication || {};
  return {
    // Old system used ISBN as color, Publisher as size, Author as brand
    color: pub.ISBN || '',
    size: pub.Publisher || '',
    brand: pub.Author || '',
  };
}

async function upsertFromDk(p) {
  const sku = (p.ItemCode || p.sku || p.itemCode || '').toString().trim();
  if (!sku) return;

  const name = (p.Description2 || p.Description || '').toString();
  const { color, size, brand } = extractPublication(p);

  const allowDiscount = safeBool(p.AllowDiscount);
  const discount = safeNum(p.Discount, 0);

  const price = safeNum(p.UnitPrice1WithTax ?? p.price, 0);
  const salePrice = (allowDiscount && discount > 0)
    ? Math.round(price - (price * discount / 100))
    : 0;

  const bg1 = computeBg1Qty(p.Warehouses);

  const inactive = safeBool(p.Inactive);
  const onweb = safeBool(p.ShowItemInWebShop);

  const recordModified = p.RecordModified ? new Date(p.RecordModified) : null;

  // Store bg1 into stock_bg1 and also keep qty_total as bg1 for now
  await pool.query(`
    INSERT INTO size_variant (
      sku, record_id, alias_item_code, name, description,
      price, sale_price, allow_discount, discount,
      stock_bg1, qty_total,
      inactive, show_in_webshop,
      record_modified,
      brand, color, size,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
    ON CONFLICT (sku)
    DO UPDATE SET
      record_id = EXCLUDED.record_id,
      alias_item_code = EXCLUDED.alias_item_code,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      price = EXCLUDED.price,
      sale_price = EXCLUDED.sale_price,
      allow_discount = EXCLUDED.allow_discount,
      discount = EXCLUDED.discount,
      stock_bg1 = EXCLUDED.stock_bg1,
      qty_total = EXCLUDED.qty_total,
      inactive = EXCLUDED.inactive,
      show_in_webshop = EXCLUDED.show_in_webshop,
      record_modified = EXCLUDED.record_modified,
      brand = EXCLUDED.brand,
      color = EXCLUDED.color,
      size = EXCLUDED.size,
      updated_at = now();
  `, [
    sku,
    p.RecordID ? Number(p.RecordID) : null,
    (p.AliasItemCode || '').toString() || null,
    name || null,
    name || null,
    price,
    salePrice,
    allowDiscount,
    discount,
    bg1,
    bg1,
    inactive,
    onweb,
    recordModified,
    brand || null,
    color || null,
    size || null,
  ]);
}

// -------------------- SYNC ENGINE --------------------
let syncRunning = false;

async function runFullSync({ inactive = 'all', onweb = 'all', startPage = 1, perPage = DK_PAGE_SIZE } = {}) {
  if (syncRunning) return { ok: false, msg: 'sync already running' };
  syncRunning = true;

  try {
    let page = startPage;
    let total = 0;

    while (true) {
      const params = {};
      if (inactive !== 'all') params.inactive = inactive;
      if (onweb !== 'all') params.onweb = onweb;

      const url = buildDkPageUrl(page, perPage, params);
      const { items } = await dkFetch(url);

      if (!items || items.length === 0) break;

      for (const p of items) {
        await upsertFromDk(p);
      }

      total += items.length;
      page += 1;

      // Throttle like old code (sleep/usleep)
      await new Promise(r => setTimeout(r, 250));
    }

    await setState('last_full_sync', new Date().toISOString());
    await setState('last_modified_cursor', new Date().toISOString());

    return { ok: true, total };
  } finally {
    syncRunning = false;
  }
}

async function runIncrementalSync({ lookbackMinutes = 30 } = {}) {
  if (syncRunning) return { ok: false, msg: 'sync already running' };
  syncRunning = true;

  try {
    const cursor = await getState('last_modified_cursor', null);

    // Old cron used now-30m when polling
    const fromDate = cursor ? new Date(cursor) : new Date(Date.now() - lookbackMinutes * 60 * 1000);

    const modifiedParam = dkTimestamp(fromDate);

    // Use big page size like old cron (page/1/30000) but still safe via env
    const perPage = Number(process.env.DK_INCREMENTAL_PAGE_SIZE || 30000);

    const url = buildDkPageUrl(1, perPage, {
      modified: modifiedParam,
      // include already applied by builder
    });

    const { items, raw } = await dkFetch(url);

    // Helpful debug once
    if (process.env.DK_DEBUG === '1') {
      console.log('INCREMENTAL modified=', modifiedParam);
      console.log('INCREMENTAL count=', items.length);
      console.log('INCREMENTAL rawType=', Array.isArray(raw) ? 'array' : typeof raw);
    }

    for (const p of items) {
      await upsertFromDk(p);
    }

    await setState('last_modified_cursor', new Date().toISOString());
    return { ok: true, total: items.length };
  } finally {
    syncRunning = false;
  }
}

// -------------------- AUTH HELPERS --------------------
function requireSecret(req) {
  if (!SYNC_SECRET) return true;
  const key = req.headers['x-sync-key'] || req.query.key;
  return key === SYNC_SECRET;
}

// -------------------- API ROUTES --------------------
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const n = await dbCount();
    const lastFull = await getState('last_full_sync', null);
    const cursor = await getState('last_modified_cursor', null);
    res.json({ ok: true, rows: n, lastFull, cursor });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString();

    const r = await pool.query(`
      SELECT sku, name, brand, color, size, price, sale_price, stock_bg1, inactive, show_in_webshop, record_modified
      FROM size_variant
      WHERE sku ILIKE $1 OR COALESCE(name,'') ILIKE $1
      ORDER BY record_modified DESC NULLS LAST
      LIMIT 200
    `, [`%${q}%`]);

    res.json({ ok: true, items: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual full sync
app.post('/api/sync/full', async (req, res) => {
  if (!requireSecret(req)) return res.status(403).json({ error: 'forbidden' });

  const { inactive = 'all', onweb = 'all', startPage = 1, perPage = DK_PAGE_SIZE } = req.body || {};
  try {
    const out = await runFullSync({ inactive, onweb, startPage, perPage });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual incremental
app.post('/api/sync/inc', async (req, res) => {
  if (!requireSecret(req)) return res.status(403).json({ error: 'forbidden' });

  const { lookbackMinutes = 30 } = req.body || {};
  try {
    const out = await runIncrementalSync({ lookbackMinutes });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Optional webhook ingest (expects { Objects: [...] } like old code)
app.post('/api/webhook/dk', async (req, res) => {
  if (!requireSecret(req)) return res.status(403).json({ error: 'forbidden' });

  try {
    const body = req.body;
    const items = Array.isArray(body) ? body : (Array.isArray(body?.Objects) ? body.Objects : []);

    for (const p of items) {
      await upsertFromDk(p);
    }

    await setState('last_modified_cursor', new Date().toISOString());
    res.json({ ok: true, received: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- STARTUP --------------------
app.listen(PORT, () => {
  console.log('Backend running on port ' + PORT);

  (async () => {
    try {
      
        await pool.query('DROP TABLE IF EXISTS size_variant;');

    
      await initDb();

     

      // Full sync only if DB empty
      const n = await dbCount();
      if (n === 0) {
        
        const out = await runFullSync({});
        console.log('Initial full sync:', out);
      } else {
        console.log('DB has data -> skip initial full sync');
      }

      // Incremental every 15 minutes (adjustable)
      const intervalMin = Number(process.env.DK_INCREMENTAL_EVERY_MIN || 15);
      setInterval(() => {
        runIncrementalSync({ lookbackMinutes: 30 }).catch(err => console.error('incremental sync error:', err));
      }, intervalMin * 60 * 1000);

    } catch (e) {
      console.error('Startup error:', e);
    }
  })();
});
