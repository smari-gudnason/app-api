

require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const PORT = Number(process.env.PORT || 4000);

const norm = v => (v ?? '').toString().trim();

// ---------- HEALTH ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
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

// ---------- SEARCH (clean + sorted brand -> name) ----------
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

// ---------- BARCODE LOOKUP ----------
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

    if (!q.rows.length) {
      return res.json({ found: false });
    }

    res.json({ found: true, ...q.rows[0] });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- SKU DETAIL ----------
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

// ---------- START ----------
app.listen(PORT, () => {
  console.log('Backend running on http://localhost:' + PORT);
});
