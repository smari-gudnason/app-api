require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// helper til að formatta stærðir
function groupRows(rows) {
  const grouped = {};

  for (const r of rows) {
    const key = `${r.style}_${r.color}`;

    if (!grouped[key]) {
      grouped[key] = {
        style: r.style,
        color: r.color,
        brand: r.brand,
        name: r.name,
        sizes: []
      };
    }

    grouped[key].sizes.push({
      size: r.size,
      stock: r.stock,
      price: r.price
    });
  }

  return Object.values(grouped);
}

// route
app.get("/", async (req, res) => {
  const result = await pool.query(`
    SELECT 
      sp.style_code AS style,
      cv.color,
      sp.brand,
      sp.name,
      sv.size,
      sv.price,
      sv.stock_selected AS stock
    FROM size_variant sv
    JOIN color_variant cv ON sv.color_variant_id = cv.id
    JOIN style_product sp ON cv.style_product_id = sp.id
    WHERE sv.active = true
    ORDER BY sp.style_code, cv.color, sv.size;
  `);

  const grouped = groupRows(result.rows);

  res.send(`
    <html>
    <head>
      <title>Vörulisti</title>
      <style>
        body { font-family: Arial; padding: 20px; }
        .product { margin-bottom: 20px; padding: 10px; border: 1px solid #ccc; border-radius: 8px; }
        .title { font-weight: bold; font-size: 16px; }
        .meta { color: #555; margin-bottom: 5px; }
        .sizes { margin-top: 5px; }
        .size { display: inline-block; margin-right: 10px; padding: 5px 8px; border: 1px solid #ddd; border-radius: 4px; }
      </style>
    </head>
    <body>
      <h1>Vörulisti</h1>

      ${grouped.map(p => `
        <div class="product">
          <div class="title">${p.name || p.style}</div>
          <div class="meta">${p.brand || ""} – ${p.style}</div>
          <div class="meta">Litur: ${p.color}</div>

          <div class="sizes">
            ${p.sizes.map(s => `
              <span class="size">
                ${s.size} | ${s.stock} stk | ${s.price || "-"} kr
              </span>
            `).join("")}
          </div>
        </div>
      `).join("")}

    </body>
    </html>
  `);
});

// start server
app.listen(4000, () => {
  console.log("🌐 Viewer running: http://localhost:4000");
});