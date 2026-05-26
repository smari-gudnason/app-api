
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}


console.log('DATABASE_URL:', process.env.DATABASE_URL);

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


const PORT = Number(process.env.PORT || process.env.UI_PORT || 3000);

const norm = v => (v ?? '').toString().trim();

// ✅ DK config
const DK_API_URL = process.env.DKPLUS_ENDPOINT;
const DK_TOKEN = process.env.DKPLUS_TOKEN;

// ✅ sync state
let lastSync = null;


// ---------- HEALTH ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, lastSync });
});

// ---------- BRANDS ----------
app.get('/api/brands', async (_req, res) => {
  try {
    const q = await pool.query(`
      SELECT DISTINCT brand
      FROM style_product
      WHERE active = true AND brand IS NOT NULL AND brand <> ''
      ORDER BY brand
    `);
    res.json(q.rows.map(r => r.brand));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- SEARCH ----------
app.get('/api/search', async (req, res) => {
  try {
    const q = norm(req.query.q);
    const brand = norm(req.query.brand);

    const params = [];
    let where = 'sv.active = true';

    if (brand) {
      params.push(brand);
      where += ` AND sp.brand = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      const p = params.length;
      where += ` AND (
        sp.name ILIKE $${p} OR
        sp.style_code ILIKE $${p} OR
        sp.parent_sku ILIKE $${p} OR
        sv.sku ILIKE $${p}
      )`;
    }

    const result = await pool.query(`
      SELECT
        sp.parent_sku,
        sp.style_code,
        sp.brand,
        sp.name AS description,
        cv.color,
        sv.size,
        sv.sku,
        sv.price,
        sv.stock_bg1
      FROM size_variant sv
      JOIN color_variant cv ON cv.id = sv.color_variant_id
      JOIN style_product sp ON sp.id = cv.style_product_id
      WHERE ${where}
      LIMIT 200
    `, params);

    res.json({ ok: true, items: result.rows });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- BARCODE ----------
app.get('/api/barcode/:code', async (req, res) => {
  try {
    const code = norm(req.params.code);

    const q = await pool.query(`
      SELECT sb.sku, sp.parent_sku, cv.color, sv.size
      FROM sku_barcode sb
      JOIN size_variant sv ON sv.sku = sb.sku
      JOIN color_variant cv ON cv.id = sv.color_variant_id
      JOIN style_product sp ON sp.id = cv.style_product_id
      WHERE sb.barcode = $1
      LIMIT 1
    `, [code]);

    if (!q.rows.length) return res.json({ found: false });

    res.json({ found: true, ...q.rows[0] });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- SKU ----------
app.get('/api/sku/:sku', async (req, res) => {
  try {
    const sku = norm(req.params.sku);

    const q = await pool.query(`
      SELECT
        sv.sku,
        sv.size,
        sv.price,
        sv.stock_bg1,
        sv.stock_bg5,
        sv.stock_bg6,
        cv.color,
        sp.parent_sku,
        sp.style_code,
        sp.brand,
        sp.name
      FROM size_variant sv
      JOIN color_variant cv ON cv.id = sv.color_variant_id
      JOIN style_product sp ON sp.id = cv.style_product_id
      WHERE sv.sku = $1
      LIMIT 1
    `, [sku]);

    res.json(q.rows[0] || null);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// =====================================================
// ✅ DK SYNC (MINIMAL VERSION - SAFE)
// =====================================================

// ⚠️ einföld lausn: sækjum ALLT (virkar 100%)
async function fetchDKProducts() {


    
  const res = await fetch(`${DK_API_URL}`, {
    headers: {
      Authorization: `Bearer ${DK_TOKEN}`
    }
  });

  console.log('DK STATUS:', res.status);

  const data = await res.json();
  return data.items || data || [];
}

async function upsertProduct(p) {
  const sku = p.sku || p.itemCode;

  if (!sku) return;

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
    p.price || 0,
    p.stockBG1 || 0,
    p.stockBG5 || 0,
    p.stockBG6 || 0
  ]);
}


// 🔵 FULL SYNC
async function syncFull() {
  console.log('🔵 FULL SYNC');
  console.log(proucts[0]);

  const products = await fetchDKProducts();

  for (const p of products) {
    await upsertProduct(p);
   
if (!sku) {
  console.log('NO SKU:', p);
  return;
}
 
  }

  lastSync = new Date();

  console.log('✅ FULL DONE:', products.length);
}


// 🟢 INCREMENTAL (temporarily same as full – safe)
async function syncIncremental() {
  console.log('🟢 INCREMENTAL (fallback = full)');

  await syncFull();
}


// ⏱ scheduler
function startSyncJobs() {

  setInterval(() => {
    syncIncremental().catch(console.error);
  }, 15 * 60 * 1000);

  setInterval(() => {
    syncFull().catch(console.error);
  }, 7 * 24 * 60 * 60 * 1000);

}


// ---------- START ----------
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

  console.log('✅ DB ready');
}



app.listen(PORT, async () => {
  console.log('Backend running on port ' + PORT);
  await initDb();


  await syncFull();
  startSyncJobs();
});
``