// backend.js (FINAL - Render + Local working, with proper DK parsing)

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DATABASE_URL = process.env.DATABASE_URL;

function needsSsl(dbUrl) {
  if (!dbUrl) return false;
  return !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

const PORT = Number(process.env.PORT || process.env.UI_PORT || 3000);

const DK_API_URL = process.env.DKPLUS_ENDPOINT;
const DK_TOKEN = process.env.DKPLUS_TOKEN;

let lastSync = null;

// ---------- INIT DB ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS size_variant (
      sku TEXT PRIMARY KEY,
      price NUMERIC,
      stock_bg1 INT,
      stock_bg5 INT,
      stock_bg6 INT
    );
  `);

  console.log('DB ready');
}

// ---------- HEALTH ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, lastSync });
});

// ---------- SEARCH ----------
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString();

    const result = await pool.query(`
      SELECT * FROM size_variant
      WHERE sku ILIKE $1
      LIMIT 200
    `, [`%${q}%`]);

    res.json({ ok: true, items: result.rows });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- DK FETCH (ROBUST) ----------
async function fetchDKProducts() {
  const res = await fetch(DK_API_URL, {
    headers: {
      Authorization: `Bearer ${DK_TOKEN}`
    }
  });

  console.log('DK STATUS:', res.status);

  const text = await res.text();
  console.log('RAW DK RESPONSE:', text.substring(0, 500));

  let data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    console.log('FAILED TO PARSE JSON');
    return [];
  }

  // ✅ smart parsing (this is the key fix)
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data)) return data.data;
  if (data.data && Array.isArray(data.data.items)) return data.data.items;

  console.log('UNKNOWN FORMAT:', data);
  return [];
}

// ---------- UPSERT ----------
async function upsertProduct(p) {
  const sku = p.sku || p.itemCode || p.code || p.id;

  if (!sku) {
    console.log('NO SKU:', p);
    return;
  }

  await pool.query(`
    INSERT INTO size_variant (sku, price, stock_bg1, stock_bg5, stock_bg6)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (sku)
    DO UPDATE SET
      price = EXCLUDED.price,
      stock_bg1 = EXCLUDED.stock_bg1,
      stock_bg5 = EXCLUDED.stock_bg5,
      stock_bg6 = EXCLUDED.stock_bg6
  `, [
    sku,
    Number(p.price) || 0,
    Number(p.stockBG1) || 0,
    Number(p.stockBG5) || 0,
    Number(p.stockBG6) || 0
  ]);
}

// ---------- SYNC ----------
async function syncFull() {
  console.log('FULL SYNC');

  const products = await fetchDKProducts();

  console.log('COUNT:', products.length);
  console.log('FIRST PRODUCT:', products[0]);

  for (const p of products) {
    await upsertProduct(p);
  }

  lastSync = new Date();
}

// ---------- START ----------
app.listen(PORT, async () => {
  console.log('Backend running on port ' + PORT);

  await initDb();
  
  // if (!lastSync) {
  // await syncFull();
  //  }

  
app.get('/api/sync', async (req, res) => {
  try {
    await syncFull();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


});
